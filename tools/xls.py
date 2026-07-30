"""Minimal reader for legacy Excel .xls files (OLE2 container + BIFF8 records).

Deliberately NOT a general spreadsheet library. It exists so the data pipeline
can read Robert Shiller's `ie_data.xls` -- the primary source that multpl.com
republishes -- with no third-party packages, keeping this project's stdlib-only
rule intact. It reads numbers and nothing else.

What the format needs, and what it does not:
  * OLE2 (Compound File Binary): a FAT of 512-byte sectors, a directory of
    streams. We assemble one stream, `Workbook`, by following its FAT chain.
    The mini-FAT (for streams under 4096 bytes) is deliberately NOT implemented:
    a real workbook always exceeds that cutoff, so it would be dead code.
  * BIFF8: a flat stream of `(type u16, length u16, payload)` records. Unknown
    records are skipped by their length, which is what makes a partial reader
    viable -- we only need the handful of record types that carry numbers.
  * FORMULA cells carry a CACHED result, so no formula evaluation is required.
  * The shared-string table (SST + its CONTINUE records) is NOT implemented.
    It only holds text, and the caller identifies columns by value instead --
    which is also more robust than trusting a header string.

Security note: this parses a file downloaded over the network. Every read is
bounds-checked and every failure raises XlsError, so a caller can treat a
malformed or hostile file as "unavailable" rather than crashing the pipeline.
Sizes taken from the file are clamped before allocation.
"""

import struct

__all__ = ["XlsError", "sheet_names", "read_sheet"]

SECTOR_HEADER = 512          # the OLE2 header occupies sector -1
OLE_SIG = bytes.fromhex("d0cf11e0a1b11ae1")
FREE_SECT, END_OF_CHAIN, FAT_SECT, DIFAT_SECT = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFC
MAX_SECTORS = 4_000_000      # ~2 GB at 512-byte sectors: a sane ceiling on chain walks

# BIFF8 record types we act on. Everything else is skipped by length.
R_BOF, R_EOF = 0x0809, 0x000A
R_BOUNDSHEET = 0x0085
R_NUMBER, R_RK, R_MULRK, R_FORMULA = 0x0203, 0x027E, 0x00BD, 0x0006
R_FILEPASS = 0x002F          # present only in encrypted workbooks


class XlsError(Exception):
    """Any malformed / unsupported / unreadable input."""


# ---------------------------------------------------------------- OLE2 ------
def _u16(b, off):
    if off + 2 > len(b):
        raise XlsError("truncated (u16)")
    return struct.unpack_from("<H", b, off)[0]


def _u32(b, off):
    if off + 4 > len(b):
        raise XlsError("truncated (u32)")
    return struct.unpack_from("<I", b, off)[0]


def _workbook_stream(data):
    """Return the assembled `Workbook` stream from an OLE2 container."""
    if len(data) < SECTOR_HEADER or data[:8] != OLE_SIG:
        raise XlsError("not an OLE2 file (bad signature)")
    ssz = _u16(data, 30)
    if not 7 <= ssz <= 20:
        raise XlsError(f"implausible sector shift {ssz}")
    sec = 1 << ssz
    n_sectors = (len(data) - SECTOR_HEADER) // sec

    def sector(i):
        if not 0 <= i < n_sectors:
            raise XlsError(f"sector {i} out of range")
        off = SECTOR_HEADER + i * sec
        return data[off:off + sec]

    # FAT: the header holds the first 109 FAT-sector numbers; any beyond that
    # live in a chain of DIFAT sectors (needed only for files >~7 MB, but a
    # reader that silently truncates a big file is worse than one that doesn't).
    fat_sectors = [_u32(data, 76 + 4 * i) for i in range(109)]
    difat_next = _u32(data, 68)
    n_difat = _u32(data, 72)
    per = sec // 4
    guard = 0
    while difat_next not in (END_OF_CHAIN, FREE_SECT) and guard <= n_difat + 1:
        blk = sector(difat_next)
        fat_sectors += [struct.unpack_from("<I", blk, 4 * i)[0] for i in range(per - 1)]
        difat_next = struct.unpack_from("<I", blk, 4 * (per - 1))[0]
        guard += 1

    fat = []
    for s in fat_sectors:
        if s in (FREE_SECT, END_OF_CHAIN, DIFAT_SECT):
            continue
        blk = sector(s)
        fat += [struct.unpack_from("<I", blk, 4 * i)[0] for i in range(per)]

    def chain(start, limit=MAX_SECTORS):
        out, cur, seen = [], start, set()
        while cur < FAT_SECT:
            if cur in seen or len(out) > limit:
                raise XlsError("cyclic or over-long sector chain")
            seen.add(cur)
            out.append(cur)
            if cur >= len(fat):
                raise XlsError("chain runs past the FAT")
            cur = fat[cur]
        return out

    dir_data = b"".join(sector(s) for s in chain(_u32(data, 48)))
    for off in range(0, len(dir_data) - 127, 128):
        entry = dir_data[off:off + 128]
        nlen = struct.unpack_from("<H", entry, 64)[0]
        if not 2 <= nlen <= 64:
            continue
        name = entry[:nlen - 2].decode("utf-16-le", "replace")
        if name != "Workbook":
            continue
        start = struct.unpack_from("<I", entry, 116)[0]
        size = struct.unpack_from("<Q", entry, 120)[0]
        if size <= 0 or size > len(data) * 4:
            raise XlsError(f"implausible Workbook size {size}")
        # >4096 bytes, so it lives in the main FAT, never the mini-FAT.
        return b"".join(sector(s) for s in chain(start))[:size]
    raise XlsError("no Workbook stream (not an .xls?)")


# ---------------------------------------------------------------- BIFF8 -----
def _records(stream, start=0):
    """Yield (type, payload) from `start`. Skipping by length is what lets a
    partial reader coexist with the ~130 record types we ignore."""
    pos = start
    n = len(stream)
    while pos + 4 <= n:
        rec, ln = struct.unpack_from("<HH", stream, pos)
        pos += 4
        if pos + ln > n:
            return  # truncated tail: stop cleanly rather than raise
        yield rec, stream[pos:pos + ln]
        pos += ln


def _rk(val):
    """Decode an RK number: 30 significant bits plus two flag bits.
    bit0 = the result is scaled by 100, bit1 = it is a 30-bit signed int
    rather than the top 30 bits of an IEEE-754 double."""
    val &= 0xFFFFFFFF
    if val & 0x02:                       # 30-bit signed integer
        # Reinterpret as signed then arithmetic-shift, so negatives survive.
        num = float(struct.unpack("<i", struct.pack("<I", val & 0xFFFFFFFC))[0] >> 2)
    else:                                # truncated double
        num = struct.unpack("<d", struct.pack("<q", (val & 0xFFFFFFFC) << 32))[0]
    return num / 100.0 if val & 0x01 else num


def _sheets(stream):
    """[(name, stream offset)] from the workbook globals' BOUNDSHEET records."""
    out = []
    for rec, body in _records(stream):
        if rec == R_FILEPASS:
            raise XlsError("workbook is encrypted")
        if rec == R_EOF:
            break                        # end of the globals substream
        if rec != R_BOUNDSHEET or len(body) < 8:
            continue
        off = struct.unpack_from("<I", body, 0)[0]
        cch, grbit = body[6], body[7]
        width = 2 if grbit & 0x01 else 1
        raw = body[8:8 + cch * width]
        name = raw.decode("utf-16-le" if width == 2 else "latin-1", "replace")
        if 0 <= off < len(stream):
            out.append((name, off))
    return out


def sheet_names(data):
    """Sheet names, in workbook order."""
    return [n for n, _ in _sheets(_workbook_stream(data))]


def read_sheet(data, name):
    """Numeric cells of one sheet as {(row, col): float}.

    Text, dates-as-text, booleans and errors are skipped -- this reader is for
    numeric series. Raises XlsError on anything it cannot make sense of.
    """
    stream = _workbook_stream(data)
    match = [off for n, off in _sheets(stream) if n == name]
    if not match:
        raise XlsError(f"no sheet named {name!r}")

    cells = {}
    for rec, body in _records(stream, match[0]):
        try:
            if rec == R_EOF:
                break
            if rec == R_NUMBER and len(body) >= 14:
                row, col = struct.unpack_from("<HH", body, 0)
                cells[(row, col)] = struct.unpack_from("<d", body, 6)[0]
            elif rec == R_RK and len(body) >= 10:
                row, col = struct.unpack_from("<HH", body, 0)
                cells[(row, col)] = _rk(struct.unpack_from("<I", body, 6)[0])
            elif rec == R_MULRK and len(body) >= 6:
                row, first = struct.unpack_from("<HH", body, 0)
                for k in range((len(body) - 6) // 6):
                    raw = struct.unpack_from("<I", body, 4 + k * 6 + 2)[0]
                    cells[(row, first + k)] = _rk(raw)
            elif rec == R_FORMULA and len(body) >= 20:
                row, col = struct.unpack_from("<HH", body, 0)
                # A 0xFFFF tail marks a non-numeric cached result (string,
                # boolean, error, blank); those carry no number to read.
                if struct.unpack_from("<H", body, 12)[0] != 0xFFFF:
                    cells[(row, col)] = struct.unpack_from("<d", body, 6)[0]
        except struct.error as e:
            raise XlsError(f"malformed record 0x{rec:04X}: {e}") from e
    if not cells:
        raise XlsError(f"sheet {name!r} held no numeric cells")
    return cells


def column(cells, col, first_row=0):
    """Sorted [(row, value)] for one column -- convenience for callers."""
    return sorted((r, v) for (r, c), v in cells.items() if c == col and r >= first_row)
