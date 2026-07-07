#!/usr/bin/env python3
"""
fetch_data.py  --  Reproducible market-data pipeline for WebSWR.

Downloads two AUTHORITATIVE, public sources and compiles them into a single
bundled data file the browser app loads. Pure Python standard library only
(urllib, html.parser, csv, json) -- no third-party packages, so there is no
dependency that could be compromised. Re-run any time and `git diff` the output
to audit exactly what changed.

Sources
-------
1. Aswath Damodaran (NYU Stern) -- annual TOTAL returns, 1928-present:
   S&P 500 (w/ dividends), US small cap, 3-mo T-Bill, 10-yr T-Bond,
   Baa corporate bond, real estate, gold.
   https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html

2. multpl.com (Robert Shiller's CPI series) -- CPI-U (all items, NSA), monthly:
   used to derive calendar-year (Dec->Dec) inflation. The SAME BLS CPIAUCNS series
   FRED publishes; multpl serves it without FRED's Akamai bot-tarpitting of
   non-browser clients (which hangs urllib on some TLS stacks).
   https://www.multpl.com/cpi/table/by-month

Outputs
-------
  ../js/market-data.js    classic <script> that sets self.SWR_DATA (loads under
                          file:// AND http://, and via importScripts in a Worker)
  ../data/market-data.json  same payload as plain JSON, for diffing/auditing

Usage
-----
  python3 fetch_data.py            # use cached downloads if present, else fetch
  python3 fetch_data.py --refresh  # force re-download from the network
"""

import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import date
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")

DAM_URL = "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html"
# CPI-U (all items, NSA), monthly, from multpl's Shiller series -- the SAME BLS
# CPIAUCNS series FRED publishes (verified: Dec->Dec inflation matches FRED to
# <0.003pp across 1929-2025). We source it here rather than from FRED because
# FRED's Akamai edge TARPITS non-browser TLS clients (it accepts the connection
# then never replies -> read timeout), whereas multpl serves it reliably; the
# sibling fetch_cape.py already pulls this exact page every day.
CPI_URL = "https://www.multpl.com/cpi/table/by-month"

# Pre-1928 extension (Robert Shiller's long history, served as clean HTML by
# multpl.com). We reconstruct annual nominal total returns from these because
# Shiller's own file is binary .xls (unparseable without a third-party lib).
# Note: price is nominal but multpl's *dividend* column is inflation-adjusted,
# so we use the dividend-YIELD page (a pure D/P ratio, identical nominal/real).
EXT_FIRST = 1871           # earliest reconstructed year
EXT_LAST = 1927            # Damodaran takes over at 1928
MULTPL = {
    "price":  "https://www.multpl.com/s-p-500-historical-prices/table/by-year",
    "yield":  "https://www.multpl.com/s-p-500-dividend-yield/table/by-year",
    "cpi":    "https://www.multpl.com/cpi/table/by-year",
    "tnx":    "https://www.multpl.com/10-year-treasury-rate/table/by-year",
}

# Map the Damodaran return columns we keep -> their column index + a header
# substring we assert against, so a silent layout change fails loudly.
COLS = {
    "stocks":   (1, "S&P 500"),
    "smallcap": (2, "Small cap"),
    "cash":     (3, "T.Bill"),
    "bonds":    (4, "T. Bond"),
    "corp":     (5, "Baa Corporate"),
    "reit":     (6, "Real Estate"),
    "gold":     (7, "Gold"),
}
CORE = ("stocks", "bonds", "cash")  # must be fully populated for every year


# --- fetch hardening (may run unattended from cron; treat the network and the
# --- local machine as hostile) -------------------------------------------------
MAX_FETCH_BYTES = 8 * 1024 * 1024  # sources are <1 MB; refuse a streaming-DoS response

# Honest, non-browser User-Agent. Do NOT impersonate a browser ("Mozilla/..."):
# FRED's Akamai edge TARPITS such requests (accepts the TLS connection, then never
# replies -> read timeout) because the browser claim doesn't match a browser TLS
# fingerprint. A truthful tool UA (like curl's) is served instantly by every source.
USER_AGENT = "WebSWR-data-pipeline/1.0 (Python-urllib; reproducible market-data build)"
FETCH_RETRIES = 3


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse ALL redirects, loudly. None of our sources redirect today, so a new
    one means the source moved or is being tampered with (e.g. an https->http
    downgrade or a bounce to an internal address). Re-point the URL deliberately."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        sys.exit(f"FATAL: {req.full_url} redirected ({code}) to {newurl}; refusing to follow.")


_OPENER = urllib.request.build_opener(_NoRedirect())


def fetch(url, cache_name, refresh):
    """Return text of url, caching under tools/.cache ONLY (repo-local). Never a
    world-writable dir like /tmp, where any local process could plant a file the
    pipeline would silently trust."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            print(f"  [cache] {cache_name} <- {path}")
            return f.read()
    last = None
    for attempt in range(1, FETCH_RETRIES + 1):
        print(f"  [http]  {cache_name} <- {url}" + (f"  (attempt {attempt})" if attempt > 1 else ""))
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with _OPENER.open(req, timeout=60) as r:  # TLS verified by default; keep it that way
                data = r.read(MAX_FETCH_BYTES + 1)
            if len(data) > MAX_FETCH_BYTES:
                sys.exit(f"FATAL: {url} sent more than {MAX_FETCH_BYTES} bytes; refusing.")
            raw = data.decode("utf-8", errors="replace")
            with open(path, "w", encoding="utf-8") as f:
                f.write(raw)
            return raw
        except OSError as e:  # timeout / connection reset / DNS -- transient; retry
            last = e
            if attempt < FETCH_RETRIES:
                time.sleep(2 * attempt)
    sys.exit(f"FATAL: could not fetch {url} after {FETCH_RETRIES} attempts: {last!r}")


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.cur, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.cur = []
        elif tag in ("td", "th"):
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.cur.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag == "tr" and self.cur is not None:
            self.rows.append(self.cur)
            self.cur = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def parse_pct(s):
    s = s.replace("%", "").replace(",", "").replace("$", "").strip()
    if s in ("", "-", "NA", "N/A"):
        return None
    v = float(s)
    # float() accepts "Infinity"/"NaN"/"1e999" -- non-finite values would emit as
    # bare `inf`/`nan`, which is INVALID JS and would break the served data file.
    # Returning None routes them into the loud populated-every-year sanity checks.
    return round(v / 100.0, 6) if math.isfinite(v) else None


def parse_damodaran(html):
    p = TableParser()
    p.feed(html)
    year_re = re.compile(r"^(19[2-9]\d|20[0-2]\d)$")

    header = next((r for r in p.rows if "S&P 500" in " ".join(r) and len(r) >= 8), None)
    if not header:
        sys.exit("FATAL: could not locate Damodaran header row")
    for key, (idx, needle) in COLS.items():
        if needle.lower() not in header[idx].lower():
            sys.exit(f"FATAL: column {idx} expected '{needle}', got '{header[idx]}' "
                     f"-- source layout changed, refusing to emit data.")

    years, series = [], {k: [] for k in COLS}
    for r in p.rows:
        if not r or not year_re.match(r[0].strip()):
            continue
        if len(r) <= max(i for i, _ in COLS.values()):
            continue
        years.append(int(r[0]))
        for key, (idx, _) in COLS.items():
            series[key].append(parse_pct(r[idx]))
    return years, series


_MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def parse_cpi(text):
    """multpl 'CPI by-month' HTML table -> {year: Dec->Dec inflation rate}, using
    each year's DECEMBER index level (the calendar-year inflation convention, same
    as the old FRED path)."""
    p = TableParser()
    p.feed(text)
    dec = {}
    for r in p.rows:
        if len(r) < 2:
            continue
        m = re.match(r"([A-Z][a-z]{2})\s+\d{1,2},\s+(\d{4})", r[0])
        if not m or _MONTHS.get(m.group(1)) != 12:
            continue
        try:
            val = float(r[1].replace(",", "").replace("$", "").strip())
        except ValueError:
            continue
        yr = int(m.group(2))
        if math.isfinite(val) and yr not in dec:  # table is newest-first; keep newest
            dec[yr] = val
    infl = {}
    for y in dec:
        if dec.get(y - 1):
            infl[y] = round(dec[y] / dec[y - 1] - 1.0, 6)
    return infl


def multpl_series(text):
    """Parse a multpl.com 'by year' HTML table -> {year: float}, keeping the
    Jan-1 (earliest-listed) value per year."""
    p = TableParser()
    p.feed(text)
    out = {}
    for r in p.rows:
        if len(r) < 2:
            continue
        m = re.search(r"(18[6-9]\d|19\d\d|20[0-2]\d)", r[0])
        if not m:
            continue
        v = r[1].replace(",", "").replace("%", "").replace("$", "").strip()
        try:
            val = float(v)
        except ValueError:
            continue
        if math.isfinite(val):  # see parse_pct: keep non-finite poison out of the JS
            out[int(m.group(1))] = val  # later (Jan 1) row overwrites a partial current-year row
    return out


def bond_total_return(y0, y1, maturity=10):
    """1-year total return of a par `maturity`-yr bond bought at yield y0 and
    repriced a year later as a (maturity-1)-yr bond at yield y1 (decimals)."""
    n = maturity - 1
    if y1 == 0:
        price_end = 1 + y0 * n
    else:
        price_end = y0 * (1 - (1 + y1) ** (-n)) / y1 + (1 + y1) ** (-n)
    return price_end + y0 - 1  # bought at par(1), received coupon y0, sold at price_end


def build_extension(price, dyield, cpi, tnx):
    """Nominal annual stock/bond returns + inflation for EXT_FIRST..EXT_LAST."""
    ext = {"stocks": {}, "bonds": {}, "inflation": {}}
    for y in range(EXT_FIRST, EXT_LAST + 1):
        if any(d.get(y) is None or d.get(y + 1) is None for d in (price, cpi, tnx)) or dyield.get(y) is None:
            sys.exit(f"FATAL: missing extension data near {y}")
        ext["stocks"][y] = round(price[y + 1] / price[y] - 1 + dyield[y] / 100.0, 6)
        ext["bonds"][y] = round(bond_total_return(tnx[y] / 100.0, tnx[y + 1] / 100.0), 6)
        ext["inflation"][y] = round(cpi[y + 1] / cpi[y] - 1, 6)
    return ext


def crosscheck(price, dyield, cpi, tnx, years, series, infl):
    """Guard: the SAME reconstruction must approximate Damodaran on overlap years.
    If multpl ever changes units/format, this fails loudly instead of shipping junk."""
    errs = {"stocks": [], "bonds": [], "inflation": []}
    for y in (1928, 1955, 1974, 1990, 2000, 2008, 2019, 2024):
        if y not in years or y + 1 not in price:
            continue
        i = years.index(y)
        errs["stocks"].append(abs(price[y + 1] / price[y] - 1 + dyield[y] / 100.0 - series["stocks"][i]))
        errs["bonds"].append(abs(bond_total_return(tnx[y] / 100.0, tnx[y + 1] / 100.0) - series["bonds"][i]))
        errs["inflation"].append(abs(cpi[y + 1] / cpi[y] - 1 - infl[y]))
    bounds = {"stocks": 0.05, "bonds": 0.04, "inflation": 0.01}  # mean-abs-error tolerances
    ok = True
    for k in errs:
        m = sum(errs[k]) / len(errs[k]) if errs[k] else 1
        passed = m <= bounds[k]
        ok = ok and passed
        print(f"  [{'PASS' if passed else 'FAIL'}] overlap {k} mean err {m * 100:.2f}pp (<= {bounds[k] * 100:.0f}pp)")
    if not ok:
        sys.exit("FATAL: extension methodology no longer matches Damodaran -- source format may have changed.")


def sanity(years, series, inflation):
    """Loud assertions so a corrupted download cannot silently ship."""
    idx = {y: i for i, y in enumerate(years)}
    S = lambda k, y: series[k][idx[y]]
    I = lambda y: inflation[idx[y]]
    n_ext = EXT_LAST - EXT_FIRST + 1  # reconstructed (pre-1928) span

    checks = [
        ("year count == 155", len(years) == 2025 - EXT_FIRST + 1),
        ("starts 1871", years[0] == EXT_FIRST),
        ("ends 2025", years[-1] == 2025),
        ("contiguous years", years == list(range(years[0], years[-1] + 1))),
        ("1871 stocks present & sane", S("stocks", 1871) is not None and -0.6 < S("stocks", 1871) < 0.7),
        ("1928 stocks ~ +43.8% (Damodaran)", abs(S("stocks", 1928) - 0.4381) < 0.003),
        ("1931 Depression stocks < -40%", S("stocks", 1931) < -0.40),
        ("2008 stocks crash", S("stocks", 2008) < -0.30),
        ("2008 bonds flight-to-safety > +10%", S("bonds", 2008) > 0.10),
        ("stocks & bonds populated every year",
         all(series[k][i] is not None for k in ("stocks", "bonds") for i in range(len(years)))),
        ("gold/cash null pre-1928",
         all(series["gold"][i] is None and series["cash"][i] is None for i in range(n_ext))),
        ("gold/cash present from 1928", series["gold"][n_ext] is not None and series["cash"][n_ext] is not None),
        ("cash never absurd (1928+)", all(-0.05 < v < 0.25 for v in series["cash"][n_ext:])),
        ("1921 post-war deflation < -4%", I(1921) < -0.04),
        ("1932 Depression deflation < -8%", I(1932) < -0.08),
        ("2022 high inflation 5-9%", 0.05 < I(2022) < 0.09),
        ("inflation populated every year", all(v is not None for v in inflation)),
    ]
    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    if not ok:
        sys.exit("FATAL: sanity checks failed -- not writing data.")


def emit(years, series, inflation):
    payload = {
        "meta": {
            "generated": date.today().isoformat(),
            "sources": {
                "returns_1928+": DAM_URL + "  (Aswath Damodaran, NYU Stern; authoritative annual totals)",
                "inflation_1928+": CPI_URL + "  (multpl.com; BLS CPI-U CPIAUCNS series, Dec->Dec)",
                "pre_1928": "https://www.multpl.com  (Robert Shiller series; stocks=price+dividend-yield, bonds from 10yr yield, CPI)",
            },
            "note": ("Annual nominal TOTAL returns (decimals; 0.10 = +10%). "
                     f"{EXT_FIRST}-{EXT_LAST} reconstructed from Shiller data (annual approximation, "
                     "stocks/bonds/inflation only); 1928+ are Damodaran totals + multpl CPI. "
                     "Gold pre-1971 reflects the official/fixed-price era. "
                     "Re-create + audit with tools/fetch_data.py."),
            "firstYear": years[0],
            "lastYear": years[-1],
            "extendedFrom": EXT_FIRST,
            "preciseFrom": EXT_LAST + 1,
            "assets": ["stocks", "bonds", "cash", "gold", "corp", "reit", "smallcap"],
        },
        "years": years,
        "inflation": inflation,
    }
    for k in COLS:
        payload[k] = series[k]

    # Compact, one-array-per-line so diffs are readable.
    def fmt_array(arr):
        return "[" + ",".join("null" if v is None else f"{v:g}" for v in arr) + "]"

    lines = ["{"]
    lines.append('"meta":' + json.dumps(payload["meta"], indent=0).replace("\n", " ") + ",")
    lines.append('"years":' + fmt_array(years) + ",")
    body_keys = ["inflation"] + list(COLS)
    for i, k in enumerate(body_keys):
        comma = "," if i < len(body_keys) - 1 else ""
        lines.append(f'"{k}":' + fmt_array(payload[k]) + comma)
    lines.append("}")
    pretty = "\n".join(lines)

    os.makedirs(os.path.join(ROOT, "js"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)

    banner = (f"// AUTO-GENERATED by tools/fetch_data.py on {payload['meta']['generated']}."
              f"\n// Do NOT edit by hand. Sources: Damodaran (NYU Stern) + multpl CPI (1928+),"
              f"\n// Shiller/multpl reconstruction ({EXT_FIRST}-{EXT_LAST}). Nominal total returns, decimals."
              f"\n// Years {years[0]}-{years[-1]}; gold/cash/corp/reit/smallcap are null before 1928.\n")
    # Atomic replace: a docker build (or anything else) reading concurrently can
    # never observe a half-written, syntactically-broken file.
    def write_atomic(path, text):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)

    js_path = os.path.join(ROOT, "js", "market-data.js")
    write_atomic(js_path, banner + "self.SWR_DATA = " + pretty + ";\n")
    json_path = os.path.join(ROOT, "data", "market-data.json")
    write_atomic(json_path, pretty + "\n")
    return js_path, json_path, payload


def main():
    refresh = "--refresh" in sys.argv
    t0 = time.time()
    print("Fetching sources...")
    dam = fetch(DAM_URL, "dam.html", refresh)
    # Shares the cache file with fetch_cape.py (same URL) -> one download for both.
    cpi = fetch(CPI_URL, "multpl_m_cpi.html", refresh)

    print("Parsing Damodaran (1928+) + multpl CPI...")
    years28, series28 = parse_damodaran(dam)
    infl_cpi = parse_cpi(cpi)
    keep = [i for i, y in enumerate(years28) if y in infl_cpi]  # need CPI for each return year
    years28 = [years28[i] for i in keep]
    for k in series28:
        series28[k] = [series28[k][i] for i in keep]

    print(f"Fetching Shiller pre-1928 extension ({EXT_FIRST}-{EXT_LAST})...")
    ms = {k: multpl_series(fetch(url, f"multpl_{k}.html", refresh)) for k, url in MULTPL.items()}

    print("Cross-check (reconstruction vs Damodaran on overlap years):")
    crosscheck(ms["price"], ms["yield"], ms["cpi"], ms["tnx"], years28, series28, infl_cpi)
    ext = build_extension(ms["price"], ms["yield"], ms["cpi"], ms["tnx"])

    # Merge eras into full 1871-2025 arrays (null pre-1928 for assets we can't reconstruct).
    ext_yrs = list(range(EXT_FIRST, EXT_LAST + 1))
    pad = [None] * len(ext_yrs)
    years = ext_yrs + years28
    series = {}
    for k in COLS:
        series[k] = ([ext[k][y] for y in ext_yrs] if k in ("stocks", "bonds") else pad) + series28[k]
    inflation = [ext["inflation"][y] for y in ext_yrs] + [infl_cpi[y] for y in years28]

    print(f"Merged {len(years)} years: {years[0]}-{years[-1]}")
    print("Sanity checks:")
    sanity(years, series, inflation)

    js_path, json_path, _ = emit(years, series, inflation)
    print("\nWrote:")
    print(" ", os.path.relpath(js_path, ROOT))
    print(" ", os.path.relpath(json_path, ROOT))
    print("\nSample (year: stocks/bonds/cash/gold | infl):")
    idx = {y: i for i, y in enumerate(years)}
    fmt = lambda v: "  null" if v is None else f"{v:+.4f}"
    for y in (1871, 1921, 1929, 1932, 2008, 2022, 2025):
        i = idx[y]
        print(f"  {y}: {fmt(series['stocks'][i])}/{fmt(series['bonds'][i])}/"
              f"{fmt(series['cash'][i])}/{fmt(series['gold'][i])} | {fmt(inflation[i])}")
    print(f"\nDone in {time.time() - t0:.1f}s.")


if __name__ == "__main__":
    main()
