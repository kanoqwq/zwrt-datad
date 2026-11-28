#!/usr/bin/env python3
"""Delivery safety checks; no device, downloads or compiler required."""
import base64
import gzip
import hashlib
import importlib.util
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deploy_package", ROOT / "scripts/package-deploy-kano.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class DeployPackageTest(unittest.TestCase):
    def test_six_ascii_commands_round_trip_four_chunks_and_pin_hash(self):
        source = b"#!/bin/sh\n" + b"# packaged bootstrap\n" * 100
        commands = package.commands(source, "https://example.invalid/releases")
        self.assertEqual(len(commands), 6)
        self.assertLess(max(map(len, commands)), 2000)
        payload = "".join(shlex.split(c)[2] for c in commands[1:5])
        self.assertEqual(gzip.decompress(base64.b64decode(payload)), source)
        self.assertIn(hashlib.sha256(source).hexdigest(), commands[0])
        "\n".join(commands).encode("ascii")

    def test_empty_url_requires_runtime_configuration_and_special_chars_are_quoted(self):
        self.assertIn('${DATAD_BASE_URL:?Set DATAD_BASE_URL first}', package.commands(b"shell", "")[0])
        url = "https://example.invalid/$path;command"
        self.assertIn("ug_base=" + shlex.quote(url), package.commands(b"shell", url)[0])

    def test_failed_publish_restores_last_working_delivery(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(package, "BUILD", Path(folder)):
            root = Path(folder)
            output, stage, backup = [root / name for name in ("deploy", "stage", "backup")]
            output.mkdir(); (output / "old").write_text("previous verified package")
            stage.mkdir(); (stage / "new").write_text("new package")
            replace = package.os.replace
            def fail_stage(source, target):
                if source == stage:
                    raise OSError("publication interrupted")
                return replace(source, target)
            with patch.object(package.os, "replace", side_effect=fail_stage):
                with self.assertRaises(OSError):
                    package.publish(stage, output, backup)
            self.assertEqual((output / "old").read_text(), "previous verified package")
            self.assertFalse(backup.exists())

    def test_output_cannot_replace_build_root_or_escape_it(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(package, "BUILD", Path(folder)):
            root = Path(folder)
            for output in (root, root / "../outside"):
                with self.assertRaises(ValueError): package.output_path(output)
            self.assertEqual(package.output_path(root / "deploy"), root / "deploy")

    def test_checksums_reject_changed_files_and_parent_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); sums = root / "SHA256SUMS"
            payload = root / "daemon"; payload.write_bytes(b"checked")
            sums.write_text(hashlib.sha256(b"checked").hexdigest() + "  daemon\n")
            package.verify_checksums(sums)
            payload.write_bytes(b"changed")
            with self.assertRaises(ValueError): package.verify_checksums(sums)
            sums.write_text(hashlib.sha256(b"checked").hexdigest() + "  ../outside\n")
            with self.assertRaises(ValueError): package.verify_checksums(sums)


if __name__ == "__main__":
    unittest.main(verbosity=2)
