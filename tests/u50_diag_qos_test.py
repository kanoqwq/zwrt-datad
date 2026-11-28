#!/usr/bin/env python3
"""Run the production DIAG callback/parser, using synthetic NAS (no modem).

Optional: U50_QOS_CAPTURE=/path/to/private/capture.bin also replays a local
real capture; it must contain the tested 5QI 9 / 1 Gbps / 200 Mbps data session.
Raw captures and subscriber identifiers are never fixtures or printed.
"""
import json
import os
from pathlib import Path
import random
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = r'''
#define main diag_worker_main
#include "u50_diag_worker.c"
#undef main
int main(int argc, char **argv) {
    if (argc != 2) return 64;
    unsigned char head[4], packet[65535];
    while (fread(head,1,4,stdin)==4) {
        unsigned n=(unsigned)head[0]|((unsigned)head[1]<<8)|((unsigned)head[2]<<16)|((unsigned)head[3]<<24);
        if (!n) { if (S.window_start > 2) S.window_start-=2; continue; }
        if (n>sizeof(packet) || fread(packet,1,n,stdin)!=n) return 65;
        logs_cb(packet,(int)n);
        printf("{\"available\":true,\"total\":%lu,\"dropped\":%lu",S.total,S.dropped);
        nq_write(stdout); printf("}\n");
    }
    return write_status(argv[1],7,"running","") ? 66 : 0;
}
'''

# Synthetic TS 24.501 Establishment Accept: default QFI 9, 5QI 9,
# with three flow parameters (5QI, averaging window and guaranteed rate).
NR = bytes.fromhex(
    "2e0100c211000901000631300101ff09060b00010600c8"
    "290501c000020175000750000451010109"
    "79000e0920430101090701500203060064"
    "7b000880000d0401010101250908696e7465726e6574"
)
EPS = bytes.fromhex("5200c101090908696e7465726e65740501c00002015e04fefec56c")


def packet(nas, code=0xB800, vendor=None):
    if vendor is None:
        vendor = bytes.fromhex("010000000f0400") if code in (0xB800, 0xB801, 0xB80A, 0xB80B) else bytes.fromhex("01000000")
    payload = vendor + nas
    return struct.pack("<HHQ", 12 + len(payload), code, 1) + payload


def nr_accept(apn="internet", session=1, qi=9):
    result = bytearray(NR)
    result[1] = session
    result[result.index(bytes.fromhex("092043010109")) + 5] = qi
    encoded = bytes([len(apn)]) + apn.encode("ascii")
    return bytes(result[:-11]) + b"\x25" + bytes([len(encoded)]) + encoded


def wrapped_request(session=1, outer=None, pti=1):
    inner = bytes([0x2E, session, pti, 0xC1, 0xFF, 0xFF])
    return bytes.fromhex("7e0067010006") + inner + bytes([0x12, session if outer is None else outer]) + bytes.fromhex("250908696e7465726e6574")


class QosTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="u50-nas-qos-")
        cls.path = Path(cls.temp.name)
        source = cls.path / "harness.c"
        source.write_text(HARNESS)
        cls.worker = cls.path / "worker"
        cls.sanitized = cls.path / "worker-sanitized"
        common = ["cc", "-std=gnu11", "-g", "-O1", "-Wall", "-Wextra", "-Werror", "-pthread",
                  "-I", str(ROOT / "rust"), str(source), "-ldl"]
        subprocess.run(common + ["-o", str(cls.worker)], check=True)
        subprocess.run(common + ["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-fno-pie", "-no-pie", "-o", str(cls.sanitized)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def replay(self, packets, sanitized=False):
        wire = b"".join(struct.pack("<I", len(p)) + p for p in packets)
        status = self.path / "status.json"
        result = subprocess.run([str(self.sanitized if sanitized else self.worker), str(status)],
                                input=wire, capture_output=True, timeout=20,
                                env={**os.environ, "ASAN_OPTIONS": "detect_leaks=0:halt_on_error=1", "UBSAN_OPTIONS": "halt_on_error=1"})
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertFalse(result.stderr, result.stderr.decode(errors="replace"))
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        actual = json.loads(status.read_text())
        if rows:
            self.assertEqual(actual["qos_sessions"], rows[-1]["qos_sessions"])
        return rows

    def test_nr_mandatory_ambr_and_default_flow(self):
        at = NR.index(bytes.fromhex("79000e"))
        # Append a second QFI with 5QI 7; only the rule's default QFI is selected.
        multi = NR[:at] + bytes.fromhex("790014") + NR[at+3:at+17] + bytes.fromhex("082041010107") + NR[at+17:]
        rows = self.replay([packet(NR), packet(multi)])
        row = rows[0]
        session = row["qos_sessions"][0]
        self.assertEqual((session["qci"], session["ambr_dl_bps"], session["ambr_ul_bps"]), (9, 1_000_000_000, 200_000_000))
        self.assertEqual((session["apn"], session["domain"], session["id"]), ("internet", "5gs", 1))
        self.assertEqual(row["five_qi"], [9])
        self.assertEqual(rows[1]["qos_sessions"][0]["qci"], 9)

    def test_eps_default_bearer_and_ambr_units(self):
        rows = self.replay([packet(EPS, 0xB0E2), packet(bytes.fromhex("6200c5010500"), 0xB0E2),
                            packet(bytes.fromhex("5200c95e06fefefa6c0100"), 0xB0E2), packet(bytes.fromhex("5200cd24"), 0xB0E2)])
        self.assertEqual(rows[0]["qos_domain"], "eps")
        session = rows[0]["qos_sessions"][0]
        self.assertEqual((session["qci"], session["ambr_dl_bps"], session["ambr_ul_bps"]), (9, 150_000_000, 50_000_000))
        self.assertEqual(rows[1]["qos_sessions"], rows[0]["qos_sessions"])
        self.assertEqual(rows[2]["qos_sessions"][0]["ambr_dl_bps"], 512_000_000)
        self.assertEqual(rows[3]["qos_sessions"], [])

    def test_ims_and_data_stay_separate_release_clears_only_one(self):
        rows = self.replay([packet(NR), packet(nr_accept("ims", 2, 5)), packet(bytes.fromhex("2e0200d324")), packet(bytes.fromhex("2e0100d4"))])
        self.assertEqual([s["qci"] for s in rows[1]["qos_sessions"]], [9, 5])
        self.assertEqual(rows[1]["five_qi"], [9])
        self.assertEqual(len(rows[2]["qos_sessions"]), 1)
        self.assertEqual(rows[3]["qos_sessions"], [])

    def test_transport_dnn_is_bound_to_request_pti_and_session(self):
        accept = bytearray(NR[:-11]); accept[2] = 1
        good = self.replay([packet(wrapped_request(), 0xB80B), packet(accept)])[1]["qos_sessions"][0]
        self.assertEqual(good["apn"], "internet")
        bad = self.replay([packet(wrapped_request(outer=2), 0xB80B), packet(accept)])[1]["qos_sessions"][0]
        self.assertEqual(bad["apn"], "")
        accept[2] = 2
        bad = self.replay([packet(wrapped_request(), 0xB80B), packet(accept)])[1]["qos_sessions"][0]
        self.assertEqual(bad["apn"], "")

    def test_modification_duplicate_and_new_request_lifecycle(self):
        rows = self.replay([packet(NR), packet(NR), packet(bytes.fromhex("2e0100cb2a06060064060032")),
                            packet(bytes.fromhex("2e0101c1ffff")), packet(bytes.fromhex("2e0101c326"))])
        self.assertEqual(rows[0]["qos_sessions"][0]["ambr_dl_bps"], rows[1]["qos_sessions"][0]["ambr_dl_bps"])
        self.assertEqual(rows[2]["qos_sessions"][0]["ambr_dl_bps"], 100_000_000)
        self.assertEqual(rows[2]["qos_sessions"][0]["qci"], 9)
        self.assertEqual(rows[3]["qos_sessions"], [])
        self.assertEqual(rows[4]["qos_sessions"], [])

    def test_modification_flow_before_rules_uses_new_default_qfi(self):
        modification = bytes.fromhex("2e0100cb7900060820410101077a000901000631300101ff08")
        rows = self.replay([packet(NR), packet(modification)])
        self.assertEqual(rows[1]["qos_sessions"][0]["qci"], 7)
        self.assertEqual(rows[1]["qos_sessions"][0]["ambr_dl_bps"], 1_000_000_000)

    def test_domain_switch_and_deregistration_clear_old_sessions(self):
        rows = self.replay([packet(NR), packet(EPS, 0xB0E2), packet(bytes.fromhex("7e0042"), 0xB80A),
                            packet(NR), packet(bytes.fromhex("7e0045"), 0xB80B)])
        self.assertEqual([s["domain"] for s in rows[1]["qos_sessions"]], ["eps"])
        self.assertEqual(rows[2]["qos_sessions"], [])
        self.assertEqual(rows[4]["qos_sessions"], [])

    def test_invalid_headers_encryption_units_and_truncation_do_not_invent_qos(self):
        invalid = bytearray(NR); invalid[17] = 0
        packets = [packet(NR, vendor=b"\x00" * 7), packet(b"\xff" * 20 + NR),
                   packet(bytes.fromhex("7e0268") + NR, 0xB80A), packet(invalid)]
        # Every truncation before the mandatory Session-AMBR ends must be rejected.
        packets += [packet(NR[:n]) for n in range(23)]
        malformed = bytearray(packet(NR)); malformed[0] ^= 1; packets.append(malformed)
        rows = self.replay(packets, sanitized=True)
        self.assertTrue(all(row["qos_sessions"] == [] for row in rows))

    def test_valid_zero_and_largest_unit_are_exact(self):
        zero = bytearray(NR); zero[18:20] = b"\0\0"; zero[21:23] = b"\0\0"
        large = bytearray(NR); large[17:23] = bytes.fromhex("0fffff0fffff")
        rows = self.replay([packet(zero), packet(large)])
        self.assertEqual(rows[0]["qos_sessions"][0]["ambr_dl_bps"], 0)
        self.assertEqual(rows[1]["qos_sessions"][0]["ambr_dl_bps"], 65535 * 256_000_000_000)

    def test_rate_limit_recovers_and_never_drops_nas_lifecycle(self):
        filler = packet(b"", 0xB821, vendor=b"")
        rows = self.replay([filler] * 550 + [packet(NR), packet(bytes.fromhex("2e0100d4")), b"", filler])
        self.assertGreater(rows[550]["dropped"], 0)
        self.assertEqual(rows[550]["qos_sessions"][0]["qci"], 9)
        self.assertEqual(rows[551]["qos_sessions"], [])
        self.assertEqual(rows[-1]["total"], 501)

    def test_bounded_parser_random_and_truncated_packets_under_sanitizers(self):
        rng = random.Random(20261128)
        packets = [packet(NR[:n]) for n in range(len(NR) + 1)]
        for _ in range(3000):
            data = rng.randbytes(rng.randrange(0, 256))
            packets.append(packet(data, rng.choice((0xB800, 0xB80A, 0xB0E2, 0xB0EC))))
        self.replay(packets, sanitized=True)

    @unittest.skipUnless(os.environ.get("U50_QOS_CAPTURE"), "optional private real capture")
    def test_private_real_capture(self):
        raw = Path(os.environ["U50_QOS_CAPTURE"]).read_bytes()
        packets = []; at = 0
        while at < len(raw):
            self.assertGreaterEqual(len(raw) - at, 4)
            n, = struct.unpack_from("<I", raw, at); at += 4
            self.assertTrue(12 <= n <= 65535 and n <= len(raw) - at)
            packets.append(raw[at:at+n]); at += n
        rows = self.replay(packets, sanitized=True)
        sessions = [s for row in rows for s in row["qos_sessions"] if s["domain"] == "5gs" and s["id"] == 1 and s["apn"] and s["apn"].split(".")[0] != "ims"]
        self.assertTrue(sessions, "No identified data session decoded from local capture")
        self.assertTrue(any((s["qci"], s.get("ambr_dl_bps"), s.get("ambr_ul_bps")) == (9, 1_000_000_000, 200_000_000) for s in sessions))


if __name__ == "__main__":
    unittest.main(verbosity=2)
