// Runs BEFORE the DOM shim. Plants a hostile share-link hash so we can prove the
// app bounds attacker-controlled input (the URL hash) instead of hanging or
// exhausting memory. atob() in the shim is identity, so the raw JSON is fine here.
var _inc = new Array(100000).fill([1e308, 1, 50, 1]); // must NOT spawn 100k rows; amounts must be clamped
// Hostile NOTE: markup + huge length -> must land as an inert, 24-char-capped input value.
_inc[0] = [1e308, 1, 50, 1, "<img src=x onerror=alert(1)>" + new Array(100000).join("A")];
var _adj = new Array(100000).fill([0, 1e308, 1, 50, 1]);
_adj[0] = [0, 1e308, 1, 50, 1, { evil: 1 }]; // non-string note -> must be dropped, not stringified
this.__SWR_TEST_HASH = "#" + JSON.stringify({
  years: "999999999",          // must be rejected, not used to size arrays
  initialValue: "1e400",       // parses to Infinity -> must be rejected
  initialSpend: "1e308",       // must be clamped (buildParams), not just rejected
  mcTrials: "999999999",       // must be capped
  mcSeed: "424242",            // must SURVIVE init()'s seed randomization (share links replay exactly)
  withdrawFreqVal: "monthly",  // percentage monthly-payout flag must round-trip through the hash
  runMonteCarlo: 0,
  inc: _inc,
  adj: _adj,
});
