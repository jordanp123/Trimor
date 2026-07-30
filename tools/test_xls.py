#!/usr/bin/env python3
"""Tests for tools/xls.py, the stdlib .xls reader.

Two tiers:
  * Synthetic fixtures built byte-by-byte -- always run, no network, no
    checked-in binary. These cover the decoders that are easy to get subtly
    wrong (the four RK encodings especially) and the malformed-input paths,
    which matter because this parser eats a file downloaded off the internet.
  * Real-file anchors -- run only when tools/.cache/ie_data.xls happens to be
    present from a pipeline run, and skipped with a note otherwise, so the
    suite stays offline-clean.
"""

import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xls  # noqa: E402

CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "ie_data.xls")
fails = []


def check(cond, msg):
    print(("  ok: " if cond else "  FAIL: ") + msg)
    if not cond:
        fails.append(msg)


# --------------------------------------------------------------- fixtures ---
def rec(rtype, payload):
    return struct.pack("<HH", rtype, len(payload)) + payload


def build_workbook(sheet_records, sheet_name=b"Data"):
    """A minimal but structurally real BIFF8 stream: globals substream with one
    BOUNDSHEET, then the sheet substream. Offsets are patched once known."""
    name = struct.pack("<BB", len(sheet_name), 0) + sheet_name  # 8-bit chars
    globals_recs = rec(0x0809, struct.pack("<HH", 0x0600, 0x0005))
    boundsheet_body = struct.pack("<IBB", 0, 0, 0) + name
    globals_recs += rec(0x0085, boundsheet_body) + rec(0x000A, b"")
    offset = len(globals_recs)
    body = rec(0x0809, struct.pack("<HH", 0x0600, 0x0010))
    for r, p in sheet_records:
        body += rec(r, p)
    body += rec(0x000A, b"")
    # patch the real sheet offset into BOUNDSHEET
    fixed = struct.pack("<IBB", offset, 0, 0) + name
    globals_recs = (rec(0x0809, struct.pack("<HH", 0x0600, 0x0005))
                    + rec(0x0085, fixed) + rec(0x000A, b""))
    return globals_recs + body


def wrap_ole(stream):
    """Wrap a stream in a minimal 512-byte-sector OLE2 container."""
    SEC = 512
    payload = stream + b"\0" * (-len(stream) % SEC)
    n_stream = len(payload) // SEC
    # layout: sector 0 = FAT, sector 1 = directory, sectors 2.. = the stream
    fat = [0xFFFFFFFD, 0xFFFFFFFE] + [i + 3 for i in range(n_stream - 1)] + [0xFFFFFFFE]
    fat += [0xFFFFFFFF] * (SEC // 4 - len(fat))
    fat_sec = b"".join(struct.pack("<I", v) for v in fat)

    def dir_entry(name, typ, start, size):
        nb = name.encode("utf-16-le") + b"\0\0"
        e = nb + b"\0" * (64 - len(nb))
        e += struct.pack("<H", len(nb))
        e += bytes([typ, 1]) + struct.pack("<III", 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF)
        e += b"\0" * (116 - len(e))
        e += struct.pack("<I", start) + struct.pack("<Q", size)
        return e + b"\0" * (128 - len(e))

    d = dir_entry("Root Entry", 5, 0xFFFFFFFE, 0) + dir_entry("Workbook", 2, 2, len(stream))
    d += b"\0" * (SEC - len(d))
    hdr = bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 16
    hdr += struct.pack("<HHH", 0x003E, 3, 0xFFFE)
    hdr += struct.pack("<HH", 9, 6)                      # 512-byte / 64-byte sectors
    hdr += b"\0" * 10
    hdr += struct.pack("<I", 1)                          # FAT sector count
    hdr += struct.pack("<I", 1)                          # first directory sector
    hdr += struct.pack("<II", 0, 4096)                   # txn, mini cutoff
    hdr += struct.pack("<II", 0xFFFFFFFE, 0)             # mini FAT
    hdr += struct.pack("<II", 0xFFFFFFFE, 0)             # DIFAT chain
    hdr += struct.pack("<I", 0)                          # DIFAT[0] = FAT at sector 0
    hdr += b"\xff\xff\xff\xff" * 108
    hdr += b"\0" * (SEC - len(hdr))
    return hdr + fat_sec + d + payload


print("== xls reader: synthetic fixtures ==")

# RK: all four encodings of the flag bits (x100 scaling, int vs truncated double)
def rk_bits(value_bits, is_int, div100):
    return (value_bits & 0xFFFFFFFC) | (0x02 if is_int else 0) | (0x01 if div100 else 0)

double_bits = struct.unpack("<Q", struct.pack("<d", 12.5))[0] >> 32  # top 32 bits of 12.5
cases = [
    (rk_bits(100 << 2, True, False), 100.0, "RK int"),
    (rk_bits(100 << 2, True, True), 1.0, "RK int /100"),
    (rk_bits(int(double_bits) << 0, False, False), 12.5, "RK double"),
    (rk_bits(int(double_bits) << 0, False, True), 0.125, "RK double /100"),
    (rk_bits((-250 & 0x3FFFFFFF) << 2, True, False), -250.0, "RK negative int"),
]
recs = [(0x027E, struct.pack("<HHH", 0, i, 0) + struct.pack("<I", bits))
        for i, (bits, _, _) in enumerate(cases)]
cells = xls.read_sheet(wrap_ole(build_workbook(recs)), "Data")
for i, (_, want, label) in enumerate(cases):
    got = cells.get((0, i))
    check(got is not None and abs(got - want) < 1e-9, f"{label}: {got} == {want}")

# NUMBER, MULRK and a FORMULA cached result
mul = struct.pack("<HH", 5, 0) + b"".join(
    struct.pack("<H", 0) + struct.pack("<I", rk_bits(int(v) << 2, True, False)) for v in (7, 8, 9)
) + struct.pack("<H", 2)
recs = [
    (0x0203, struct.pack("<HHH", 1, 0, 0) + struct.pack("<d", 3.25)),
    (0x00BD, mul),
    (0x0006, struct.pack("<HHH", 2, 0, 0) + struct.pack("<d", 42.5) + struct.pack("<HIH", 0, 0, 0)),
    # a non-numeric cached result (0xFFFF tail) must be skipped, not misread
    (0x0006, struct.pack("<HHH", 3, 0, 0) + b"\x00" * 6 + struct.pack("<H", 0xFFFF)
     + struct.pack("<IH", 0, 0)),
]
cells = xls.read_sheet(wrap_ole(build_workbook(recs)), "Data")
check(abs(cells.get((1, 0), 0) - 3.25) < 1e-12, "NUMBER decodes an IEEE-754 double")
check([cells.get((5, i)) for i in range(3)] == [7.0, 8.0, 9.0], "MULRK expands a run of cells")
check(abs(cells.get((2, 0), 0) - 42.5) < 1e-12, "FORMULA yields its cached numeric result")
check((3, 0) not in cells, "FORMULA with a non-numeric cached result is skipped")

print("\n== xls reader: malformed input must raise, never hang or lie ==")
for label, blob in [
    ("empty input", b""),
    ("not OLE2", b"hello world" * 100),
    ("OLE2 header only", bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 500),
    ("truncated container", wrap_ole(build_workbook([]))[:600]),
    ("garbage after a good header", wrap_ole(build_workbook([]))[:512] + os.urandom(2048)),
]:
    try:
        xls.read_sheet(blob, "Data")
        check(False, f"{label}: should have raised")
    except xls.XlsError:
        check(True, f"{label}: raises XlsError")
    except Exception as e:  # noqa: BLE001 -- any other type is itself the failure
        check(False, f"{label}: raised {type(e).__name__} instead of XlsError")

try:
    xls.read_sheet(wrap_ole(build_workbook([(0x0203, struct.pack("<HHH", 0, 0, 0)
                                             + struct.pack("<d", 1.0))])), "NoSuchSheet")
    check(False, "missing sheet: should have raised")
except xls.XlsError:
    check(True, "missing sheet: raises XlsError")

print("\n== xls reader: real Shiller workbook ==")
if not os.path.exists(CACHE_FILE):
    print(f"  skipped: {os.path.relpath(CACHE_FILE)} not present (run tools/fetch_data.py first)")
else:
    raw = open(CACHE_FILE, "rb").read()
    names = xls.sheet_names(raw)
    check("Data" in names, f"finds the Data sheet among {len(names)} sheets")
    cells = xls.read_sheet(raw, "Data")
    check(len(cells) > 30000, f"reads the whole sheet ({len(cells)} numeric cells)")
    # The anchor row verified by hand when this reader was written: Aug 1871,
    # S&P 4.79, dividend 0.26, earnings 0.40, CPI 11.8932314.
    row = [cells.get((15, c)) for c in range(5)]
    want = [1871.08, 4.79, 0.26, 0.40, 11.8932314]
    check(all(v is not None and abs(v - w) < 1e-6 for v, w in zip(row, want)),
          f"1871.08 anchor row reads exactly: {row}")
    dates = [v for (r, c), v in cells.items() if c == 0 and 1871 <= v <= 2100]
    check(len(dates) > 1800 and max(dates) > 2020,
          f"date column spans 1871..{max(dates):.2f} ({len(dates)} months)")

print("\nRESULT: " + ("all passed" if not fails else f"{len(fails)} FAILED"))
sys.exit(1 if fails else 0)
