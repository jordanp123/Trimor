// Runs BEFORE the DOM shim. Plants a hostile share-link hash so we can prove the
// app bounds attacker-controlled input (the URL hash) instead of hanging or
// exhausting memory. atob() in the shim is identity, so the raw JSON is fine here.
this.__SWR_TEST_HASH = "#" + JSON.stringify({
  years: "999999999",          // must be rejected, not used to size arrays
  initialValue: "1e400",       // parses to Infinity -> must be rejected
  initialSpend: "1e308",       // must be clamped (buildParams), not just rejected
  mcTrials: "999999999",       // must be capped
  runMonteCarlo: 0,
  inc: new Array(100000).fill([1e308, 1, 50, 1]),    // must NOT spawn 100k rows; amounts must be clamped
  adj: new Array(100000).fill([0, 1e308, 1, 50, 1]),
});
