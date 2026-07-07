#!/bin/sh
# All headless tests via macOS JavaScriptCore (no Node, no browser, no deps).
#   tests/run.sh           run engine tests + UI smoke test
# Concatenates the relevant modules into a bundle and runs each with osascript.
DIR=$(cd "$(dirname "$0")/.." && pwd)
fail=0

runbundle() {
  label=$1; shift
  BUNDLE=$(mktemp /tmp/swr_test.XXXXXX.js)
  cat "$@" > "$BUNDLE"
  echo "== $label =="
  osascript -l JavaScript "$BUNDLE"; rc=$?
  rm -f "$BUNDLE"
  [ $rc -ne 0 ] && fail=1
  echo ""
}

runbundle "engine + Monte Carlo" \
  "$DIR/tests/_shim.js" "$DIR/js/market-data.js" "$DIR/js/cape-data.js" "$DIR/js/mortality-data.js" "$DIR/js/stats.js" \
  "$DIR/js/core.js" "$DIR/js/montecarlo.js" "$DIR/js/mortality.js" "$DIR/js/amortize.js" "$DIR/js/compound.js" "$DIR/tests/test_core.js"

runbundle "UI smoke (headless DOM)" \
  "$DIR/tests/dom_shim.js" "$DIR/js/market-data.js" "$DIR/js/cape-data.js" "$DIR/js/mortality-data.js" "$DIR/js/stats.js" \
  "$DIR/js/core.js" "$DIR/js/montecarlo.js" "$DIR/js/mortality.js" "$DIR/js/amortize.js" "$DIR/js/compound.js" "$DIR/js/charts.js" \
  "$DIR/js/ui.js" "$DIR/tests/smoke_ui.js"

runbundle "security (hostile hash + input caps)" \
  "$DIR/tests/_hostile_hash.js" "$DIR/tests/dom_shim.js" "$DIR/js/market-data.js" "$DIR/js/cape-data.js" "$DIR/js/mortality-data.js" "$DIR/js/stats.js" \
  "$DIR/js/core.js" "$DIR/js/montecarlo.js" "$DIR/js/mortality.js" "$DIR/js/amortize.js" "$DIR/js/compound.js" "$DIR/js/charts.js" \
  "$DIR/js/ui.js" "$DIR/tests/security_test.js"

# Guard: every runtime module must actually be referenced by index.html. (The
# headless bundles load them regardless, so only this catches a missing <script>.)
echo "== index.html references all runtime scripts =="
miss=0
for f in market-data cape-data mortality-data stats core montecarlo mortality amortize compound charts ui; do
  grep -q "js/$f.js" "$DIR/index.html" || { echo "  MISSING <script src=\"js/$f.js\"> in index.html"; miss=1; fail=1; }
done
[ $miss -eq 0 ] && echo "  ok: all 11 runtime scripts referenced"
echo ""

[ $fail -eq 0 ] && echo "ALL GREEN" || echo "SOME TESTS FAILED"
exit $fail
