#!/usr/bin/env python3
"""
worker_parity.py -- the page and the Worker must agree on Monte Carlo options.

A Monte Carlo setting the user types travels through four hops:

    ui.js opts  ->  postMessage({...})  ->  worker.js msg.*  ->  mc.run(opts)

Every hop names its fields explicitly and silently drops the rest, while the
engine tests call mc.run DIRECTLY and never cross a single hop. So a field
missing from any hop is invisible to the entire rest of the suite. That is not
hypothetical: blockMin/blockMax shipped inert for two commits because the
postMessage payload and worker.js both omitted them -- the browser quietly used
montecarlo.js's 2/8 defaults while the UI and the printed report both claimed
the user's Shortest/Longest streak values had been applied. Every test passed.

Rather than hard-code a list that would rot, this derives the contract from the
code: the opts.* keys montecarlo.js actually reads, minus the ones worker.js
legitimately originates itself (onProgress, keepSeries, successOnly). Whatever
is left MUST be plumbed through every hop. Add an option to the engine and this
test tells you exactly where to wire it.
"""
import re
import sys

ROOT = __file__.rsplit("/", 2)[0]
fails = []


def check(cond, msg):
    print(("  ok: " if cond else "  FAIL: ") + msg)
    if not cond:
        fails.append(msg)


def read(rel):
    with open(ROOT + "/" + rel, encoding="utf-8") as fh:
        return fh.read()


def balanced(src, start):
    """Return the {...} object literal beginning at or after `start`."""
    i = src.index("{", start)
    depth, j = 0, i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
        j += 1
    raise ValueError("unbalanced object literal at %d" % start)


def call_args(src, needle):
    """Every object literal passed to calls matching `needle`."""
    out = []
    for m in re.finditer(re.escape(needle), src):
        out.append(balanced(src, m.end() - 1))
    return out


ui = read("js/ui.js")
worker = read("js/worker.js")
mc = read("js/montecarlo.js")

# ---- 1. the contract: what the engine reads -------------------------------
engine_keys = set(re.findall(r"opts\.([A-Za-z_][A-Za-z0-9_]*)", mc))
check(len(engine_keys) >= 6,
      "montecarlo.js exposes a readable opts contract (%d keys: %s)"
      % (len(engine_keys), ", ".join(sorted(engine_keys))))

# ---- 2. which of those the Worker originates rather than forwards ---------
mc_calls = call_args(worker, "SWR.mc.run(")
check(len(mc_calls) >= 1, "worker.js calls mc.run (%d site(s))" % len(mc_calls))

originated = set()
for obj in mc_calls:
    for key in engine_keys:
        # Present but NOT forwarded from msg.* means the Worker supplies it.
        # (Do not try to express this as one negative-lookahead regex: `\s*`
        # backtracks to zero width, so the lookahead always succeeds and every
        # key looks originated.)
        present = re.search(r"\b%s\s*:" % re.escape(key), obj)
        forwarded = re.search(r"\b%s\s*:\s*msg\.%s\b" % (re.escape(key), re.escape(key)), obj)
        if present and not forwarded:
            originated.add(key)

page_keys = sorted(engine_keys - originated)
check(len(page_keys) > 0,
      "options the PAGE owns and must plumb through: %s" % ", ".join(page_keys))
check("blockMin" in page_keys and "blockMax" in page_keys,
      "the streak bounds are page-owned (the field that regressed)")

# ---- 3. hop: worker.js msg.* -> mc.run ------------------------------------
for n, obj in enumerate(mc_calls, 1):
    missing = [k for k in page_keys if not re.search(r"\b%s\s*:\s*msg\.%s\b" % (k, k), obj)]
    check(not missing,
          "worker.js mc.run site %d forwards every page option%s"
          % (n, "" if not missing else " (missing: %s)" % ", ".join(missing)))

# ---- 4. hop: ui.js opts -> postMessage ------------------------------------
# Only payloads aimed at the Monte Carlo engine; a non-MC message need not
# carry sampler options.
payloads = [o for o in call_args(ui, "postMessage(")
            if re.search(r'type:\s*"(montecarlo|solve|gsolve)"', o)]
check(len(payloads) >= 3,
      "found the worker postMessage payloads (%d)" % len(payloads))

for obj in payloads:
    kind = re.search(r'type:\s*"(\w+)"', obj).group(1)
    missing = [k for k in page_keys if not re.search(r"\b%s\s*:" % re.escape(k), obj)]
    check(not missing,
          'ui.js "%s" payload carries every page option%s'
          % (kind, "" if not missing else " (missing: %s)" % ", ".join(missing)))

# ---- 5. the inline (no-Worker) path -------------------------------------
# file:// and a failed Worker fall back to running mc.run on the page. That
# path SPREADS the shared options object (Object.assign({}, opts, ...)), so it
# structurally cannot drop a field -- which is exactly why the bug only ever
# showed up in a browser and never on file://. Pin that pattern: enumerating
# the fields here instead would reintroduce the same silent-drop risk the
# postMessage hops already carry.
inline_sites = [ui[m.end():ui.index("\n", m.end())]
                for m in re.finditer(r"SWR\.mc\.run\s*\(", ui)]
check(len(inline_sites) >= 1, "ui.js has an inline mc.run fallback (%d site(s))" % len(inline_sites))
for n, line in enumerate(inline_sites, 1):
    check("Object.assign(" in line,
          "inline mc.run site %d spreads the shared options rather than "
          "re-listing them (cannot silently drop a field)" % n)

# ---- 6. the solver opts objects feed both paths --------------------------
# Each solver builds one options object and hands it to BOTH the Worker and
# the inline fallback, so the two can never disagree about the sampler.
for key in ("blockMin", "blockMax"):
    check(len(re.findall(r"\b%s\s*:" % key, ui)) >= 3,
          "ui.js sets %s on every options object it builds (%d)"
          % (key, len(re.findall(r"\b%s\s*:" % key, ui))))

print("WORKER PARITY: " + ("all checks passed" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
