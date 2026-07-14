// Security: init() has already run with a hostile share-link hash (planted by
// _hostile_hash.js). Reaching this point at all means the app did NOT hang. Now
// confirm the specific bounds held.
var fails = 0;
function A(c, m) { if (c) console.log("  ok: " + m); else { fails++; console.log("  FAIL: " + m); } }

var incRows = document.getElementById("incomeRows").children.length;   // incl. 1 header
var adjRows = document.getElementById("adjustRows").children.length;
A(incRows <= 51, "income rows capped despite 100k in hash (got " + incRows + ")");
A(adjRows <= 51, "adjustment rows capped despite 100k in hash (got " + adjRows + ")");

// A share-link seed must override init()'s load-time randomization (the random
// seed is written BEFORE loadHash), or shared links stop replaying exactly.
A(document.getElementById("mcSeed").value === "424242",
  "hash-restored MC seed survives load-time randomization (got " + document.getElementById("mcSeed").value + ")");

// The monthly-payout flag must round-trip through the share hash and be
// reflected onto the segmented control (hidden input + seg-on button state).
A(document.getElementById("withdrawFreqVal").value === "monthly",
  "hash-restored withdrawal frequency = monthly (got " + document.getElementById("withdrawFreqVal").value + ")");
var _freqBtns = document.getElementById("withdrawFreq").querySelectorAll("button");
A(_freqBtns[1].classList.contains("seg-on") && !_freqBtns[0].classList.contains("seg-on"),
  "restored frequency reflected onto the seg control (Monthly active)");

// years=1e9 / portfolio=Infinity must fail validation, so no simulation ran.
A(document.getElementById("formMsg").textContent.length > 0, "hostile numbers rejected by validate() (no compute)");
A(!/%/.test(document.getElementById("successBig").textContent), "no bogus results rendered from hostile input");

// Engine-level hard cap, independent of the UI: absurd trial counts are bounded.
var p = {
  initialValue: 1e6, years: 30, allocation: { stocks: 1 }, feeRate: 0, taxRate: 0,
  spending: { strategy: "percent", percent: 0.04 }, incomes: [], adjustments: [],
};
var mc = self.SWR.mc.run(p, self.SWR_DATA, { method: "bootstrap", trials: 999999999, seed: 1, successOnly: true });
A(mc.total === 50000, "Monte Carlo trials hard-capped at 50000 (got " + mc.total + ")");

// CAPE rule with absurd constants must stay finite (UI clamps a/b/CAPE; the engine
// clamps spending to the balance, so no input can produce NaN/Infinity or a hang).
var capeP = {
  initialValue: 1e6, years: 30, allocation: { stocks: 1 }, feeRate: 0, taxRate: 0,
  spending: { strategy: "cape", capeA: 999, capeB: 999, cape0: 1 }, incomes: [], adjustments: [],
};
var cr = self.SWR.core.runHistorical(capeP, self.SWR_DATA);
A(isFinite(cr.endingReal.median) && cr.successRate >= 0 && cr.successRate <= 1,
  "CAPE rule stays bounded under absurd a/b (no NaN/Infinity)");

// Recovery run: fix only the fields validate() rejects and re-submit -- the
// hostile initialSpend (1e308, planted by the hash) must be CLAMPED by
// buildParams, and everything rendered must stay finite.
var fire = function (el, type) { (el && el._ev && el._ev[type] || []).forEach(function (fn) { fn({ preventDefault: function () {} }); }); };
document.getElementById("initialValue").value = "1000000";
document.getElementById("years").value = "30";
fire(document.getElementById("inputs"), "submit");
var big = document.getElementById("successBig").textContent;
A(/%$/.test(big), "recovery run renders a success % despite hostile initialSpend (" + big + ")");
function textOf(n) {
  var s = n && n.textContent ? String(n.textContent) : "";
  ((n && n.children) || []).forEach(function (c) { s += textOf(c); });
  return s;
}
var rendered = big + textOf(document.getElementById("headStats")) + textOf(document.getElementById("detailBody"));
A(!/Infinity|NaN/.test(rendered), "no Infinity/NaN anywhere in rendered results");

// Malformed/garbage hashes must be swallowed, never thrown.
A(typeof self.SWR.core.runHistorical === "function", "modules intact after hostile load");

console.log("\nSECURITY: " + (fails ? fails + " FAILED" : "all passed"));
if (fails) throw new Error("security checks failed");
