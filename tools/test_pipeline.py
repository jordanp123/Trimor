#!/usr/bin/env python3
"""The data pipeline must survive the calendar.

Every January a new year of returns is published. The pipeline's sanity checks
once pinned the final year ("ends 2025", "year count == 155"), so the day the
2026 row appeared every nightly run -- and with it every deploy -- would have
aborted. Nothing in the suite could see that, because nothing ran the checks
against any date but today's. These do: the rules are exercised on the dates
that matter (late December, mid-January, March, years ahead), with no network.

Pure stdlib. Run from anywhere: python3 tools/test_pipeline.py
"""
import json
import os
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fetch_data as fd  # noqa: E402  (after the path tweak, deliberately)

fails = []


def check(cond, msg):
    print(("  ok: " if cond else "  FAIL: ") + msg)
    if not cond:
        fails.append(msg)


def passes(years, today):
    return all(ok for _, ok in fd.span_checks(years, today))


def span(last, first=fd.EXT_FIRST):
    return list(range(first, last + 1))


print("== which years may ship ==")
check(passes(span(2025), date(2026, 11, 16)), "today's data (through 2025) passes today")
check(passes(span(2025), date(2027, 1, 5)), "early January, before the new year is published: last year's data still passes")
check(passes(span(2026), date(2027, 1, 20)), "mid-January, 2026 published: accepted with nobody editing the pipeline")
check(passes(span(2029), date(2030, 2, 1)) and passes(span(2030), date(2031, 2, 1)) and passes(span(2040), date(2041, 6, 1)),
      "and so on through 2030 and beyond")
check(not passes(span(2026), date(2026, 12, 31)), "a year still in progress is refused (its partial return would run as a full year)")
check(not passes(span(2027), date(2027, 6, 1)), "...at any point in that year")
check(not passes(span(2024), date(2026, 11, 16)), "a dataset that lost its newest year is refused")
check(not passes(span(2025, 1872), date(2026, 11, 16)), "a dataset that no longer starts in 1871 is refused")
check(not passes(span(1990) + span(2025, 1992), date(2026, 11, 16)), "a gap in the years is refused")
check(not passes([], date(2026, 11, 16)), "an empty dataset is refused")

print("== is the newest year the one we should have? (advisory) ==")
cur = lambda last, today: fd.currency_check(span(last), today)["status"]
check(cur(2025, date(2026, 11, 16)) == "ok", "2025 data is current in November 2026")
check(cur(2025, date(2027, 2, 10)) == "ok", "still acceptable in February 2027, while 2026 is being published")
check(cur(2026, date(2027, 2, 10)) == "ok", "2026 data is current as soon as it arrives")
check(cur(2025, date(2027, 3, 1)) == "stale", "from March 2027, still ending in 2025 is flagged for the site to show")
check("2026" in fd.currency_check(span(2025), date(2027, 6, 1))["detail"], "...and the message names the missing year")

print("== year labels are read past 2029 ==")
head = "<tr><th>Year</th><th>S&amp;P 500 (includes dividends)</th><th>US Small cap</th><th>3-month T.Bill</th>" \
       "<th>US T. Bond (10-year)</th><th>Baa Corporate Bond</th><th>Real Estate</th><th>Gold*</th></tr>"
rows = "".join("<tr><td>%d</td>%s</tr>" % (y, "<td>5.00%</td>" * 7) for y in range(1928, 2036))
years, series = fd.parse_damodaran("<table>" + head + rows + "</table>")
check(years[0] == 1928 and years[-1] == 2035 and len(years) == 108,
      "the returns table parses every row through 2035 (got %s-%s)" % (years[0], years[-1]))
check(all(len(v) == len(years) for v in series.values()), "...with every series the same length")
multpl = "<table>" + "".join("<tr><td>Jan 1, %d</td><td>%d.50</td></tr>" % (y, y - 1800) for y in range(2036, 1869, -1)) + "</table>"
ms = fd.multpl_series(multpl)
check(ms.get(2030) == 230.5 and ms.get(2035) == 235.5 and ms.get(1871) == 71.5,
      "the by-year tables parse 1871 through 2035")

print("== the committed dataset passes its own rules ==")
with open(os.path.join(os.path.dirname(HERE), "data", "market-data.json"), encoding="utf-8") as fh:
    doc = json.load(fh)
check(passes(doc["years"], date.today()), "data/market-data.json (%d-%d) passes today" % (doc["years"][0], doc["years"][-1]))
check(len(doc["years"]) == doc["years"][-1] - doc["years"][0] + 1, "...and has one entry per year")

print("\nRESULT: %s" % ("all passed" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
