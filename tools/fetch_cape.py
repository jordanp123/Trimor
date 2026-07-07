#!/usr/bin/env python3
"""
fetch_cape.py  --  Reproducible CAPE (Shiller PE) pipeline for WebSWR.

Builds the data the CAPE-based withdrawal strategy needs, from public multpl.com
(Robert Shiller) monthly series. Pure Python standard library only -- no third-
party packages, so there is nothing in the supply chain to compromise. Re-run any
time and `git diff` js/cape-data.js to audit exactly what changed.

Two products
------------
1. capeAnnual[]  -- the STANDARD real Shiller CAPE at each year-end (Dec),
   aligned to js/market-data.js's year axis (1871-2025; null before the first
   full 10-year earnings window ~1881). This drives the HISTORICAL backtest --
   exactly what Big ERN's backtests use: each year's *actual* CAPE.

2. latest{}      -- today's valuation, computed BOTH as the standard Shiller CAPE
   and as Big ERN's "better CAPE" (earlyretirementnow.com/2022/10/05/building-a-
   better-cape-ratio/). The better CAPE applies, to the most recent 10-year
   window, (a) retained-earnings / total-return reinvestment scaling and (b) a
   corporate-tax normalization to the current statutory rate. It runs LOWER than
   the headline number, which is ERN's whole point: today's CAPE overstates, so
   today's safe withdrawal rate can be a bit higher. The app seeds the current-
   CAPE field with `betterCape` and ships `ratio = better/standard` so the in-app
   bookmarklet can convert a freshly-scraped standard CAPE without a redeploy.

The withdrawal rule itself (WR = a + b / CAPE) lives in js/core.js.

Sources (all multpl.com, monthly tables)
  s-p-500-historical-prices, s-p-500-earnings, s-p-500-dividend-yield, cpi,
  shiller-pe (the last is only a CROSS-CHECK target for our own computation).

Usage
  python3 fetch_cape.py            # use cached downloads if present, else fetch
  python3 fetch_cape.py --refresh  # force re-download from the network
"""

import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")

# multpl monthly ("by-month") tables. Newest row first, back to 1871.
SRC = {
    "price":   "https://www.multpl.com/s-p-500-historical-prices/table/by-month",
    "earn":    "https://www.multpl.com/s-p-500-earnings/table/by-month",
    "dyield":  "https://www.multpl.com/s-p-500-dividend-yield/table/by-month",
    "cpi":     "https://www.multpl.com/cpi/table/by-month",
    "shiller": "https://www.multpl.com/shiller-pe/table/by-month",  # cross-check only
}

# Big ERN's own near-daily published numbers: the "Recent CAPE Estimates" block of
# his public SWR-toolbox Google Sheet (linked from SWR Series Part 28/54). CAPE.2
# is his adjusted "better CAPE" -- the exact number his spreadsheet shows -- built
# on S&P Global earnings estimates that Shiller/multpl don't carry. gviz+range
# serves ~150 BYTES of CSV, directly (no redirect), so the strict fetcher applies.
# This source is OPTIONAL: if it's unreachable, stale, malformed, or disagrees
# with our independently computed value by >12%, we fall back to the computed one.
ERN_SHEET = ("https://docs.google.com/spreadsheets/d/"
             "1QGrMm6XSGWBVLI8I_DOAeJV5whoCnSdmaR8toQB2Jz8"
             "/gviz/tq?tqx=out:csv&sheet=CAPE-based%20Rule&range=B1:D12")
ERN_MAX_AGE_DAYS = 45   # if his sheet stops updating, fall back rather than freeze
ERN_MAX_DIVERGENCE = 0.12  # vs our computed better-CAPE (method matches him ~±3%)

# Top U.S. federal statutory corporate income-tax rate by year (step function).
# Used ONLY to normalize the recent 10-year earnings window to today's rate for
# the "better CAPE" (ERN adjustment b). Older entries are for completeness; only
# the last decade affects the shipped current value. Sources: IRS/Tax Foundation.
TAX_STEPS = [
    (2018, 0.21), (1993, 0.35), (1988, 0.34), (1987, 0.40), (1979, 0.46),
    (1971, 0.48), (1968, 0.528), (1965, 0.48), (1952, 0.52), (1950, 0.42),
    (1946, 0.38), (1942, 0.40), (1940, 0.24), (1936, 0.15), (1909, 0.10),
]
TAX_NOW = 0.21

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
WINDOW = 120  # trailing months (10 years) for the CAPE earnings average


def statutory_rate(year):
    for y0, r in TAX_STEPS:
        if year >= y0:
            return r
    return 0.10


# --- fetch hardening (this runs unattended from cron; treat the network and the
# --- local machine as hostile) -------------------------------------------------
MAX_FETCH_BYTES = 8 * 1024 * 1024  # pages are ~30 KB; refuse a streaming-DoS response

# Honest, non-browser User-Agent. Do NOT impersonate a browser ("Mozilla/..."):
# some CDN bot-managers (e.g. FRED's Akamai edge, used by the sibling fetch_data.py)
# TARPIT such requests -- accept the TLS connection, then never reply -- because the
# browser claim doesn't match a browser TLS fingerprint. A truthful tool UA works.
USER_AGENT = "WebSWR-data-pipeline/1.0 (Python-urllib; reproducible market-data build)"
FETCH_RETRIES = 3


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse ALL redirects, loudly. None of our sources redirect today, so a new
    one means the source moved or is being tampered with (e.g. an https->http
    downgrade or a bounce to an internal address). Re-point the URL deliberately."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        sys.exit(f"FATAL: {req.full_url} redirected ({code}) to {newurl}; refusing to follow.")


_OPENER = urllib.request.build_opener(_NoRedirect())


def fetch(url, cache_name, refresh, optional=False):
    """Return text of url, caching under tools/.cache ONLY (repo-local). Never a
    world-writable dir like /tmp, where any local process could plant a file the
    pipeline would silently trust. `optional=True` sources return None on failure
    instead of aborting the pipeline (the caller must have a fallback)."""
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
    if optional:
        print(f"  [warn]  optional source unavailable ({last!r}); continuing without it")
        return None
    sys.exit(f"FATAL: could not fetch {url} after {FETCH_RETRIES} attempts: {last!r}")


def parse_ern_sheet(text):
    """Parse the 'Recent CAPE Estimates' block of ERN's toolbox sheet: rows of
    label/value pairs ('As of:' 7/2/2026, 'CAPE.1' 39.83, 'CAPE.2' 35.39).
    Returns {asOf, cape1, cape2} or None if the layout isn't recognized."""
    got = {}
    for row in csv.reader(io.StringIO(text)):
        for i in range(len(row) - 1):
            label = row[i].strip().rstrip(":")
            val = row[i + 1].replace(",", "").strip()
            if label in ("As of", "CAPE.1", "CAPE.2") and val:
                got[label] = val
    try:
        as_of = datetime.strptime(got["As of"], "%m/%d/%Y").date()
        c1, c2 = float(got["CAPE.1"]), float(got["CAPE.2"])
    except (KeyError, ValueError):
        return None
    if not (math.isfinite(c1) and math.isfinite(c2)):
        return None
    return {"asOf": as_of, "cape1": c1, "cape2": c2}


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


def parse_month_table(text):
    """multpl 'by-month' table -> {(year, month): float}, newest row wins."""
    p = TableParser()
    p.feed(text)
    out = {}
    for r in p.rows:
        if len(r) < 2:
            continue
        m = re.match(r"([A-Z][a-z]{2})\s+\d{1,2},\s+(\d{4})", r[0])
        if not m:
            continue
        mon = MONTHS.get(m.group(1))
        yr = int(m.group(2))
        if mon is None:
            continue
        v = r[1].replace(",", "").replace("%", "").replace("$", "").strip()
        try:
            val = float(v)
        except ValueError:
            continue
        # float() accepts "Infinity"/"NaN"/"1e999" -- non-finite values would emit
        # as bare `inf`/`nan`, which is INVALID JS and would break the served file.
        if not math.isfinite(val):
            continue
        out.setdefault((yr, mon), val)  # table is newest-first; keep the newest
    return out


def ordered_months(present):
    """Sorted oldest->newest list of (year, month) keys."""
    return sorted(present, key=lambda ym: (ym[0], ym[1]))


def ffill(series, months):
    """Forward-fill a {(y,m):v} series along `months` (recent gaps use last known)."""
    out, last = {}, None
    for ym in months:
        if ym in series:
            last = series[ym]
        if last is not None:
            out[ym] = last
    return out


def build(price, earn, dyield, cpi):
    """Return (months, arrays) where arrays hold aligned monthly values.

    Auto-detects whether multpl's earnings column is nominal or already CPI-
    adjusted by trying both against the standard-CAPE cross-check; converts to
    nominal so the total-return math is consistent.
    """
    # Universe = months present in price AND cpi (the always-complete series).
    months = [ym for ym in ordered_months(set(price) & set(cpi))]
    ef = ffill(earn, months)
    yf = ffill(dyield, months)
    P = {ym: price[ym] for ym in months}
    C = {ym: cpi[ym] for ym in months}
    # Trim leading months until earnings + yield are available too.
    months = [ym for ym in months if ym in ef and ym in yf]
    return months, P, ef, yf, C


def standard_cape(months, P, E, C, earnings_are_real):
    """Standard real Shiller CAPE at each month with a full trailing window.

    CAPE_t = P_t / mean_{k=t-119..t}( E_k deflated to month-t dollars ).
    `earnings_are_real`: if True, multpl's E is already present-$ (undo it first).
    Returns {(y,m): cape}.
    """
    idx = {ym: i for i, ym in enumerate(months)}
    c_last = C[months[-1]]
    out = {}
    for i in range(WINDOW - 1, len(months)):
        t = months[i]
        num = P[t]
        s = 0.0
        for j in range(i - WINDOW + 1, i + 1):
            k = months[j]
            e_nom = E[k] * (C[k] / c_last) if earnings_are_real else E[k]
            s += e_nom * (C[t] / C[k])  # deflate to month-t dollars
        avg = s / WINDOW
        if avg > 0:
            out[t] = num / avg
    return out, idx


def reinvestment_index(months, P, E, yld, C, earnings_are_real):
    """Cumulative RETAINED-earnings reinvestment index G (monthly compounding of the
    earnings yield minus the dividend yield), per ERN. G_t/G_k grosses up month-k EPS
    for the retained earnings it would have reinvested between month k and month t."""
    c_last = C[months[-1]]
    G, g = {}, 1.0
    for ym in months:
        e_real = E[ym] if earnings_are_real else E[ym] * (C[ym] / c_last)
        ey = (e_real * C[ym] / c_last) / P[ym]         # nominal earnings yield E/P
        rey = max(ey - yld[ym] / 100.0, 0.0)           # retained = earnings yld - div yld
        g *= (1.0 + rey / 12.0)
        G[ym] = g
    return G


def better_cape(months, P, E, C, earnings_are_real, G, ti):
    """Big ERN 'better CAPE' at month position `ti`:

        better = realPrice_ti / mean_k( realEarnings_k * taxfac_k * G_ti/G_k )

    over the trailing 10-year window. Past EPS is grossed up by the RETAINED-earnings
    yield -- ERN's "earnings yield minus dividend yield" (see reinvestment_index) --
    which is far gentler than a full market-total-return gross-up (it excludes P/E
    expansion and paid-out dividends), and the tax factor renormalizes each year's
    earnings from its era's statutory rate to today's. Validated to reproduce ERN's
    published adjusted CAPE (Oct-2022 ~21, Mar-2026 ~32.4)."""
    if ti < WINDOW - 1:
        return None
    c_last = C[months[-1]]
    t = months[ti]
    realprice = P[t] * c_last / C[t]                    # present-$ price at ti
    win = months[ti - WINDOW + 1:ti + 1]
    s = 0.0
    for k in win:
        e_real = E[k] if earnings_are_real else E[k] * (C[k] / c_last)
        taxfac = (1.0 - TAX_NOW) / (1.0 - statutory_rate(k[0]))
        s += e_real * taxfac * (G[t] / G[k])           # gross up for retained-earnings reinvestment
    avg = s / WINDOW
    return realprice / avg if avg > 0 else None


def market_years():
    """Year axis to align capeAnnual to (from the existing market-data payload)."""
    for cand in (os.path.join(ROOT, "data", "market-data.json"),
                 os.path.join(ROOT, "js", "market-data.js")):
        if os.path.exists(cand):
            txt = open(cand, encoding="utf-8").read()
            m = re.search(r'"years"\s*:\s*\[([0-9,\s]+)\]', txt)
            if m:
                return [int(x) for x in m.group(1).split(",") if x.strip()]
    sys.exit("FATAL: could not read market-data years to align CAPE series.")


def detect_earnings_basis(months, P, earn, C, shiller):
    """Return True if multpl earnings look CPI-adjusted (real), else False, by
    whichever interpretation better matches multpl's own published Shiller PE."""
    ef = ffill(earn, months)
    best = {}
    for real in (False, True):
        cape, _ = standard_cape(months, P, ef, C, real)
        errs = []
        for ym, cv in cape.items():
            # Only trust months with FINAL earnings (>=2 yrs old) for validation.
            if ym in shiller and ym[0] <= date.today().year - 2:
                errs.append(abs(cv - shiller[ym]) / shiller[ym])
        best[real] = sum(errs) / len(errs) if errs else 9.9
    real = best[True] < best[False]
    print(f"  earnings basis: {'REAL (CPI-adj)' if real else 'NOMINAL'} "
          f"(rel err nominal={best[False]*100:.2f}% real={best[True]*100:.2f}%)")
    if min(best.values()) > 0.05:
        sys.exit(f"FATAL: neither earnings interpretation matches multpl Shiller PE "
                 f"(best rel err {min(best.values())*100:.1f}%). Source format changed.")
    return real, min(best.values())


def emit(payload):
    def g(v):
        return "null" if v is None else f"{v:.4g}"
    lines = ["{"]
    lines.append('"meta":' + json.dumps(payload["meta"], indent=0).replace("\n", " ") + ",")
    lines.append('"latest":' + json.dumps(payload["latest"], indent=0).replace("\n", " ") + ",")
    lines.append('"years":[' + ",".join(str(y) for y in payload["years"]) + "],")
    lines.append('"capeAnnual":[' + ",".join(g(v) for v in payload["capeAnnual"]) + "]")
    lines.append("}")
    pretty = "\n".join(lines)
    banner = (f"// AUTO-GENERATED by tools/fetch_cape.py on {payload['meta']['generated']}."
              "\n// Do NOT edit by hand. Source: multpl.com (Robert Shiller CAPE series)."
              "\n// capeAnnual = standard real Shiller CAPE at each year-START (January --"
              "\n// observable when that year's withdrawal is made; no look-ahead);"
              "\n// latest.betterCape = ERN total-return + tax-adjusted current valuation."
              "\n// Also attaches the annual series to SWR_DATA.cape for the engine.\n")
    js = (banner + "self.SWR_CAPE = " + pretty + ";\n"
          "if (typeof self !== 'undefined' && self.SWR_DATA) self.SWR_DATA.cape = self.SWR_CAPE.capeAnnual;\n")
    os.makedirs(os.path.join(ROOT, "js"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)

    # Atomic replace: a docker build (or anything else) reading concurrently can
    # never observe a half-written, syntactically-broken file.
    def write_atomic(path, text):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)

    jsp = os.path.join(ROOT, "js", "cape-data.js")
    write_atomic(jsp, js)
    jsonp = os.path.join(ROOT, "data", "cape-data.json")
    write_atomic(jsonp, pretty + "\n")
    return jsp, jsonp


def main():
    refresh = "--refresh" in sys.argv
    t0 = time.time()
    print("Fetching multpl monthly series...")
    raw = {k: fetch(url, f"multpl_m_{k}.html", refresh) for k, url in SRC.items()}
    price = parse_month_table(raw["price"])
    earn = parse_month_table(raw["earn"])
    dyield = parse_month_table(raw["dyield"])
    cpi = parse_month_table(raw["cpi"])
    shiller = parse_month_table(raw["shiller"])
    print(f"  rows: price={len(price)} earn={len(earn)} dyield={len(dyield)} "
          f"cpi={len(cpi)} shiller={len(shiller)}")

    months, P, E, Y, C = build(price, earn, dyield, cpi)
    print(f"  aligned {len(months)} months: {months[0]} .. {months[-1]}")

    print("Cross-check our CAPE vs multpl's published Shiller PE:")
    real, relerr = detect_earnings_basis(months, P, earn, C, shiller)
    cape, pos = standard_cape(months, P, E, C, real)   # pos = {(y,m): month index}
    G = reinvestment_index(months, P, E, Y, C, real)

    # Annual CAPE aligned to the market-data axis, START-OF-YEAR convention:
    # capeAnnual[y] = the JANUARY CAPE of year y. The engine withdraws at the start
    # of each simulated year, so the valuation it acts on must be observable THEN.
    # (Sampling December would leak that year's crash into its own withdrawal
    # decision -- e.g. a 1929 retiree "seeing" the post-crash CAPE in January.)
    # Requiring month==1 also nulls 1880 naturally: the first full 10-yr window
    # lands at Dec-1880, so the series starts Jan-1881 -- exactly where Shiller's
    # own published CAPE begins.
    years = market_years()
    jan = {y: v for (y, m), v in cape.items() if m == 1}
    capeAnnual = [round(jan[y], 4) if y in jan else None for y in years]

    # Adjustment ratio (better/standard) at the last CPI-complete month.
    last = months[-1]
    std_last = cape[last]
    better_last = better_cape(months, P, E, C, real, G, len(months) - 1)
    ratio = better_last / std_last

    # Freshness (ERN adjustment #1): the shipped CURRENT value uses multpl's most
    # recently PUBLISHED Shiller PE as the standard (it already folds in the latest
    # price and forward-earnings estimates that our own CPI-gated calc lags by a
    # month), then applies the slowly-moving adjustment ratio for the better CAPE.
    fresh_ym = max(shiller)
    std_fresh = shiller[fresh_ym]
    better_fresh = std_fresh * ratio

    # ERN spreadsheet anchors: our method must reproduce his PUBLISHED adjusted CAPE.
    def better_at(y, m):
        return better_cape(months, P, E, C, real, G, pos[(y, m)]) if (y, m) in pos else None
    oct22, mar26 = better_at(2022, 10), better_at(2026, 3)

    # Prefer ERN's OWN published CAPE.2 (his toolbox sheet, near-daily) when it is
    # fresh, sane, and agrees with our independently computed value -- so the app
    # shows exactly what his spreadsheet shows. Our computed number stays as the
    # cross-validator and the fallback if his sheet is unreachable/stale/odd.
    better_used, better_src, as_of, ern = better_fresh, "computed (ERN method)", None, None
    raw_ern = fetch(ERN_SHEET, "ern_sheet.csv", refresh, optional=True)
    if raw_ern is not None:
        ern = parse_ern_sheet(raw_ern)
        if ern is None:
            print("  [warn]  ERN sheet layout not recognized; using computed value")
        elif not (5 < ern["cape2"] < 80 and ern["cape2"] < ern["cape1"]):
            print(f"  [warn]  ERN values implausible (CAPE.1={ern['cape1']}, CAPE.2={ern['cape2']}); using computed")
        elif date.today() - ern["asOf"] > timedelta(days=ERN_MAX_AGE_DAYS):
            print(f"  [warn]  ERN sheet stale (as of {ern['asOf']}); using computed value")
        elif abs(ern["cape2"] / better_fresh - 1) > ERN_MAX_DIVERGENCE:
            print(f"  [warn]  ERN CAPE.2 {ern['cape2']} diverges >{ERN_MAX_DIVERGENCE:.0%} from computed "
                  f"{better_fresh:.2f}; using computed value")
        else:
            better_used, better_src, as_of = ern["cape2"], "ERN published (SWR toolbox sheet)", ern["asOf"]

    latest = {
        "date": as_of.isoformat() if as_of else f"{fresh_ym[0]}-{fresh_ym[1]:02d}",
        "standardCape": round(std_fresh, 2),
        "betterCape": round(better_used, 2),
        "source": better_src,
        "computedBetter": round(better_fresh, 2),
        "ernCape1": round(ern["cape1"], 2) if ern and better_src.startswith("ERN") else None,
        "ratio": round(ratio, 4),
        "computedFrom": f"{last[0]}-{last[1]:02d}",
        "taxRateNow": TAX_NOW,
    }

    # Loud sanity guards -- refuse to ship nonsense.
    checks = [
        ("cross-check rel err < 3%", relerr < 0.03),
        ("standard (fresh) CAPE in 5..80", 5 < std_fresh < 80),
        ("computed better CAPE in 5..80 (validator/fallback)", 5 < better_fresh < 80),
        ("SHIPPED better CAPE in 5..80", 5 < better_used < 80),
        ("better < standard (ERN direction)", better_used < std_fresh),
        ("shipped/standard ratio in 0.7..0.95", 0.7 < better_used / std_fresh < 0.95),
        ("computed-method ratio in 0.7..0.95", 0.7 < ratio < 0.95),
        ("ERN anchor: Oct-2022 adjusted ~21 (got %s)" % (round(oct22, 1) if oct22 else "n/a"),
         oct22 is None or 19.5 < oct22 < 23.0),
        ("ERN anchor: Mar-2026 adjusted ~32.4 (got %s)" % (round(mar26, 1) if mar26 else "n/a"),
         mar26 is None or 30.0 < mar26 < 34.5),
        ("annual series starts 1881 (Shiller's own start)",
         capeAnnual[years.index(1881)] is not None and
         all(capeAnnual[i] is None for i in range(len(years)) if years[i] < 1881)),
        ("annual series contiguous 1881+ (no interior gaps)",
         all(v is not None for v in capeAnnual[years.index(1881):])),
        # Start-of-year (January) anchors vs Shiller's published series -- these
        # FAIL if the sampling ever regresses to year-END values (look-ahead).
        ("Jan-1929 ~27 pre-crash (got %s)" % capeAnnual[years.index(1929)],
         24 < capeAnnual[years.index(1929)] < 30),
        ("Jan-2000 ~43.6 dot-com peak (got %s)" % capeAnnual[years.index(2000)],
         40 < capeAnnual[years.index(2000)] < 47),
        ("Jan-1921 all-time-low region (got %s)" % capeAnnual[years.index(1921)],
         capeAnnual[years.index(1921)] < 7),
        ("annual CAPEs all positive where present", all(v is None or v > 0 for v in capeAnnual)),
    ]
    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    if not ok:
        sys.exit("FATAL: CAPE sanity checks failed -- not writing data.")

    payload = {
        "meta": {
            "generated": date.today().isoformat(),
            "source": "https://www.multpl.com  (Robert Shiller S&P 500 CAPE series, monthly)",
            "method": ("capeAnnual = standard real Shiller CAPE at each year-START (January; "
                       "10-yr real earnings avg) so the backtest only uses information "
                       "observable at withdrawal time. latest.standardCape = "
                       "multpl's freshest published Shiller PE; latest.betterCape = that times "
                       "the ERN adjustment ratio -- EPS grossed up by the retained-earnings "
                       "yield (earnings yield minus dividend yield) and tax-normalized to "
                       "today's %d%% statutory rate. Reproduces ERN's published adjusted CAPE "
                       "(Oct-2022 ~21, Mar-2026 ~32.4). See "
                       "earlyretirementnow.com/2022/10/05/building-a-better-cape-ratio/ and "
                       "his SWR-Series-Part-54 toolbox."
                       % int(TAX_NOW * 100)),
            "window_months": WINDOW,
            "earnings_basis": "real" if real else "nominal",
            "firstYear": years[0],
            "lastYear": years[-1],
        },
        "latest": latest,
        "years": years,
        "capeAnnual": capeAnnual,
    }
    jsp, jsonp = emit(payload)
    print("\nWrote:")
    print(" ", os.path.relpath(jsp, ROOT))
    print(" ", os.path.relpath(jsonp, ROOT))
    print(f"\nLatest ({latest['date']}): standard CAPE {latest['standardCape']} (multpl), "
          f"better CAPE {latest['betterCape']}  [source: {latest['source']}; "
          f"computed-method value {latest['computedBetter']}].")
    print(f"ERN anchors: Oct-2022 adjusted={round(oct22,1) if oct22 else 'n/a'} (ERN ~21), "
          f"Mar-2026 adjusted={round(mar26,1) if mar26 else 'n/a'} (ERN 32.37).")
    ny = [i for i in range(len(years)) if capeAnnual[i] is not None]
    print("Annual sample:", ", ".join(f"{years[i]}={capeAnnual[i]}"
          for i in (ny[0], ny[len(ny)//2]) if True), f", 2025={capeAnnual[-1]}")
    print(f"\nDone in {time.time() - t0:.1f}s.")


if __name__ == "__main__":
    main()
