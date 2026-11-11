#!/usr/bin/env python3
"""Info toggles: index.html and js/ui.js must agree, and warnings stay visible.

The headless DOM shim never parses index.html, so it cannot see whether a
button's markup matches the INFO table in ui.js. This does, statically:

  * every INFO pair has a real <button class="info" type="button"> whose
    aria-controls names its hint, starting aria-expanded="false";
  * every hint starts hidden and is marked info-text;
  * no info button or hidden explanation exists outside the table (a button
    that does nothing, or text nobody can open);
  * no warning or live status line is ever behind a toggle -- the
    conservative rule: anything that flags an optimistic or invalid state
    stays on screen.

Pure stdlib, like the other parity checks.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def check(cond, msg):
    print(("  ok: " if cond else "  FAIL: ") + msg)
    if not cond:
        fails.append(msg)


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


ui = read("js", "ui.js")
html = read("index.html")

table = re.search(r"const INFO = \[(.*?)\];", ui, re.S)
pairs = re.findall(r'\["([A-Za-z]+)", "([A-Za-z]+)"\]', table.group(1)) if table else []
check(len(pairs) > 0, "found the INFO table in ui.js (%d pairs)" % len(pairs))


def tag_with_id(i):
    m = re.search(r'<[a-z0-9]+\b[^>]*\bid="%s"[^>]*>' % re.escape(i), html)
    return m.group(0) if m else ""


for btn, hint in pairs:
    b = tag_with_id(btn)
    check(b.startswith("<button") and 'type="button"' in b and 'class="info"' in b
          and 'aria-controls="%s"' % hint in b and 'aria-expanded="false"' in b
          and re.search(r'aria-label="[^"]+"', b) is not None,
          "%s is an info button controlling %s, collapsed, with a label" % (btn, hint))
    h = tag_with_id(hint)
    check(bool(h) and re.search(r"\shidden(\s|>|/)", h) is not None and "info-text" in h,
          "%s exists, starts hidden and is marked info-text" % hint)

buttons = re.findall(r'<button\b[^>]*class="info"[^>]*\bid="([^"]+)"', html)
texts = re.findall(r'<[a-z0-9]+\b[^>]*class="[^"]*\binfo-text\b[^"]*"[^>]*\bid="([^"]+)"', html)
check(sorted(buttons) == sorted(b for b, _ in pairs),
      "every info button in index.html is wired in ui.js (no dead buttons)")
check(sorted(texts) == sorted(h for _, h in pairs),
      "every hidden explanation has a button that opens it")

# Warnings and live status: never behind a toggle, never marked info-text.
PROTECTED = ["ssCutHint", "mcTrialsCap", "fixedInflationHint", "spendRateHint", "capeRateNow",
             "allocSum", "adjBadge", "gsolveResult", "solveResult", "formMsg", "staleNote"]
targets = [h for _, h in pairs]
for pid in PROTECTED:
    check(pid not in targets and "info-text" not in tag_with_id(pid),
          "%s (a warning or live status) is never behind an info toggle" % pid)

print("INFO PARITY: %s" % ("all checks passed" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
