#!/usr/bin/env python3
"""Build and verify the complete deploy_kano delivery from an ARMv7 candidate.

Run in Linux/WSL; Windows users can use build-deploy-kano.ps1. Private URLs
are arguments/configuration, never defaults in tracked source files.
"""
import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def output_path(path):
    path = path.absolute()
    if path.is_symlink() or path.resolve() == BUILD.resolve() or BUILD.resolve() not in path.resolve().parents:
        raise ValueError("output must be a non-symlink directory beneath this repository's build/")
    if path.exists() and not path.is_dir():
        raise ValueError("output cannot replace a regular file")
    return path.resolve()


def commands(bootstrap, base_url):
    payload = base64.b64encode(gzip.compress(bootstrap, mtime=0)).decode("ascii")
    width = (len(payload) + 3) // 4
    chunks = [payload[i:i+width] for i in range(0, len(payload), width)]
    if len(chunks) != 4:
        raise ValueError("bootstrap must fit four paste chunks")
    if gzip.decompress(base64.b64decode("".join(chunks))) != bootstrap:
        raise ValueError("paste payload does not round-trip")
    base = shlex.quote(base_url) if base_url else '${DATAD_BASE_URL:?Set DATAD_BASE_URL first}'
    sha = hashlib.sha256(bootstrap).hexdigest()
    result = [f'umask 077; ug_stage=$(mktemp -d /tmp/ugpaste.XXXXXX) && chmod 700 "$ug_stage" && ug_base={base} && ug_sha={sha} && echo Ready']
    result += [f'printf %s \'{part}\' > "${{ug_stage:?}}/p{i}"' for i, part in enumerate(chunks)]
    result += ['cat "${ug_stage:?}/p"? | base64 -d | gzip -d > "$ug_stage/bootstrap.sh" && printf "%s  %s\\n" "$ug_sha" "$ug_stage/bootstrap.sh" | sha256sum -c - && DATAD_BASE_URL="$ug_base" sh "$ug_stage/bootstrap.sh"; ug_rc=$?; rm -f "${ug_stage:?}"/p? "$ug_stage/bootstrap.sh"; rmdir "$ug_stage"; (exit "$ug_rc")']
    if max(map(len, result)) >= 2000:
        raise ValueError("paste command exceeds 2000 characters")
    return result


def verify_checksums(path):
    for line in path.read_text(encoding="ascii").splitlines():
        expected, name = line.split(None, 1)
        item = (path.parent / name).resolve()
        if path.parent.resolve() not in item.parents or digest(item) != expected:
            raise ValueError(f"checksum mismatch in {path.name}")


def publish(stage, output, backup):
    """A failed build/verification never replaces the last working delivery."""
    output_path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    existed = output.exists()
    if existed:
        try:
            os.replace(output, backup)
        except PermissionError:
            # DrvFS can reject directory replacement even when the native
            # Windows operation is allowed. Keep all moves in one native shell.
            if not os.environ.get("WSL_DISTRO_NAME") or not shutil.which("powershell.exe"):
                raise
            def windows(path):
                return subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip()
            subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                            windows(ROOT / "scripts/publish-deploy-kano.ps1"),
                            "-StagePath", windows(stage), "-OutputPath", windows(output), "-BackupPath", windows(backup)], check=True)
            return
    try:
        os.replace(stage, output)
    except OSError:
        if existed:
            os.replace(backup, output)
        raise


def package(args):
    output = output_path(args.output)
    if output.exists() and any(output.iterdir()) and not all((output / name).is_file() for name in
            ("package-verification.json", "zwrt-datad-armv7", "install-datad.sh")):
        raise ValueError("refusing to replace a directory that is not a managed deployment package")
    binary = BUILD / "zwrt-datad-armv7-candidate"
    provenance = json.loads((BUILD / "rust-release-provenance-armv7.json").read_text())
    version = json.loads((ROOT / "version.json").read_text())["datad"]["version"]
    expected = digest(binary)
    if provenance.get("sha256") != expected or provenance.get("version") != version:
        raise ValueError("candidate/provenance/version mismatch; rebuild first")
    if not args.api_only and "web-ui" not in provenance.get("features", []):
        raise ValueError("a Web-enabled candidate is required; use --api-only for an intentional API build")
    for name in ("go", "upx", "sh"):
        if not shutil.which(name):
            raise ValueError(f"missing packaging dependency: {name}")
    for name in ("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"):
        if not (args.adb_dir / name).is_file():
            raise ValueError(f"missing Windows platform-tools file: {name}")
    if not args.tiny_downloader.is_file() or not args.ca_bundle.is_file():
        raise ValueError("tiny downloader and public CA bundle must exist")
    # Share exactly the same URL validation as the installer template.
    spec = importlib.util.spec_from_file_location("shell_package", ROOT / "scripts/package-u50pro.py")
    shell = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shell)
    shell.render_installer(binary.read_bytes(), version, args.base_url)

    def run(*argv):
        subprocess.run(list(map(str, argv)), cwd=ROOT, check=True)

    BUILD.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".deploy-kano-", dir=BUILD))
    published = False
    try:
        stage = work / "package"
        tiny = stage / "tiny-bootstrap"
        for target in (stage, tiny):
            run(sys.executable, ROOT / "scripts/package-u50pro.py", "--output", target,
                "--base-url", args.base_url, "--tiny-downloader", args.tiny_downloader)
        bootstrap = (tiny / "bootstrap-u50pro.sh").read_bytes()
        paste = commands(bootstrap, args.base_url)
        text = ("U50 Pro installation - 6 commands\n\n"
                "Upload the matching install-datad.sh and zwrt-datad-armv7 first.\n"
                "Run adb shell, then paste ONE numbered command at a time.\n"
                "Keep the same shell session. Wait for SUCCESS.\n\n")
        text += "\n\n".join(f"Step {i+1}/6\n{line}" for i, line in enumerate(paste)) + "\n"
        for target in (stage, tiny):
            for name in ("install-steps.txt", "一键安装命令.txt"):
                (target / name).write_bytes(text.encode("ascii"))
            (target / "一键安装说明.txt").write_bytes(b"Upload install-datad.sh and zwrt-datad-armv7 together, then follow install-steps.txt.\n")
            run("sh", "-n", target / "install-datad.sh")
            run("sh", "-n", target / "bootstrap-u50pro.sh")
        helper = stage / "u50get/tiny/u50get-tiny"
        helper.parent.mkdir(parents=True)
        shutil.copyfile(args.tiny_downloader, helper)
        run(sys.executable, ROOT / "scripts/package-u50pro-adb.py", "--output", stage,
            "--adb-dir", args.adb_dir)
        run(sys.executable, ROOT / "scripts/package-u50pro-go.py", "--output", stage,
            "--base-url", args.base_url, "--ca-bundle", args.ca_bundle, "--upx")
        for target in (stage, tiny):
            if digest(target / "zwrt-datad-armv7") != expected:
                raise ValueError("daemon copies differ")
            # Re-rendering verifies the full script, including embedded digest/size.
            actual = (target / "install-datad.sh").read_text(encoding="utf-8")
            if actual != shell.render_installer(binary.read_bytes(), version, args.base_url):
                raise ValueError("installer template mismatch")
            if (target / "bootstrap-u50pro.sh").read_text(encoding="utf-8") != shell.render_bootstrap(actual, helper.read_bytes(), args.base_url):
                raise ValueError("bootstrap mismatch")
        for sums in (stage / "SHA256SUMS", tiny / "SHA256SUMS", stage / "INSTALLER-SHA256SUMS", stage / "U50Pro_ADB/payload/SHA256SUMS"):
            verify_checksums(sums)
        installer = json.loads((stage / "installer-build-info.json").read_text())
        if installer["datad"]["sha256"] != expected:
            raise ValueError("Go installer provenance mismatch")
        generated = (BUILD / "u50pro-go-installer/generated.go").read_text()
        if expected not in generated:
            raise ValueError("Go installer was not regenerated")
        archive = f"U50Pro_ADB_{version}.zip"
        with zipfile.ZipFile(stage / archive) as z:
            if hashlib.sha256(z.read("U50Pro_ADB/payload/zwrt-datad")).hexdigest() != expected:
                raise ValueError("ADB ZIP daemon mismatch")
        (stage / "LATEST_ADB_PACKAGE.txt").write_text(archive + "\n", encoding="ascii")
        report = {"sha256": expected, "bytes": binary.stat().st_size, "version": version,
                  "shell_bootstrap_paste_go_adb_verified": True, "max_paste_command_chars": max(map(len, paste)),
                  "features": provenance.get("features", []), "web_assets_sha256": provenance.get("web_assets_sha256")}
        (stage / "package-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="ascii")
        publish(stage, output, work / "previous")
        published = True
    finally:
        if published or not (work / "previous").exists():
            shutil.rmtree(work)
        else:
            print(f"Previous delivery retained for recovery: {work / 'previous'}", file=sys.stderr)
    print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=BUILD / "deploy_kano")
    parser.add_argument("--base-url", default=os.environ.get("DATAD_BASE_URL", ""))
    parser.add_argument("--adb-dir", type=Path, required=True, help="Windows platform-tools, including DLLs and NOTICE.txt")
    parser.add_argument("--tiny-downloader", type=Path, default=BUILD / "u50get/u50get-tiny")
    parser.add_argument("--ca-bundle", type=Path, default=Path("/etc/ssl/certs/ca-certificates.crt"))
    parser.add_argument("--api-only", action="store_true")
    package(parser.parse_args())
