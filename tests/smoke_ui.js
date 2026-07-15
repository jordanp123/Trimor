// Headless UI smoke test. ui.js's init() has already run (readyState=complete)
// during script load -- driving read-inputs -> historical -> render -> inline
// Monte Carlo -> render -> charts. If init() had thrown, osascript would have
// errored before reaching here. Now assert the rendered DOM looks sane.
var fails = 0;
function A(c, m) { if (c) console.log("  ok: " + m); else { fails++; console.log("  FAIL: " + m); } }

var big = document.getElementById("successBig").textContent;
A(/%$/.test(big), "successBig shows a percent ('" + big + "')");
A(document.getElementById("headStats").children.length >= 3,
  "headStats populated (" + document.getElementById("headStats").children.length + " cards)");
A(document.getElementById("detailBody").children.length >= 4,
  "detailBody populated (" + document.getElementById("detailBody").children.length + " blocks)");
A(document.getElementById("trajCanvas")._chart != null, "trajectory chart rendered");
A(missing.length === 0, "no unknown element ids referenced" + (missing.length ? ": " + missing.join(", ") : ""));
A(document.documentElement.getAttribute("data-theme") === "light" ||
  document.documentElement.getAttribute("data-theme") === "dark", "theme applied");

// Integration: drive the real ui.js "Find max spending, using Monte Carlo" path.
// Worker is undefined in this shim, so solve() takes its inline fallback -- which
// runs the same applySolve()/run() machinery the worker's solveResult triggers.
function fire(el, type) { (el && el._ev && el._ev[type] || []).forEach(function (fn) { fn({ preventDefault: function () {} }); }); }
function unc(v) { return +String(v).replace(/,/g, ""); } // read a comma-formatted money input

// Money inputs live-format with thousands separators (and every parse strips them).
var ivEl = document.getElementById("initialValue");
A(ivEl.value === "1,000,000", "money input formatted on init (" + ivEl.value + ")");
ivEl.value = "2500000"; fire(ivEl, "input");
A(ivEl.value === "2,500,000", "typing reformats with commas (" + ivEl.value + ")");
ivEl.value = "1000000"; fire(ivEl, "input"); // restore the default for the sections below

// The MC seed field starts blank in the HTML; init() must fill it with a
// fresh 6-digit seed each load (users overwrite it to replay a past run).
A(/^[1-9]\d{5}$/.test(document.getElementById("mcSeed").value),
  "MC seed randomized on load (" + document.getElementById("mcSeed").value + ")");

var spendBefore = document.getElementById("initialSpend").value;
var basisBtns = document.getElementById("solveBasis").querySelectorAll("button");
fire(basisBtns[1], "click");                       // select "Monte Carlo" basis
document.getElementById("targetSuccess").value = "90";
document.getElementById("mcSeed").value = "12345"; // pin the now-random seed so this section stays deterministic
fire(document.getElementById("solveBtn"), "click"); // click "Find max spending for"
var spendAfter = document.getElementById("initialSpend").value;
A(spendAfter !== spendBefore && unc(spendAfter) > 25000 && unc(spendAfter) < 70000,
  "MC solver changed spending (" + spendBefore + " -> " + spendAfter + ")");
A(document.getElementById("runMonteCarlo").checked, "MC solve enabled the Monte Carlo view");
A(/%$/.test(document.getElementById("successBig").textContent), "results still render after MC solve");
A(document.getElementById("solveResult").hidden === false &&
  document.getElementById("solveResult").children.length > 0, "solver result box is shown with content");

// Regression: the solve writeback must FLOOR to the $100 grid, never round to
// nearest. The bisection returns the highest VERIFIED-passing spending; success
// only falls as spending rises, so rounding UP can tip a knife-edge cycle and
// re-run below the promised target (seen in prod: "100%" solve re-ran at 98.1%).
// Stub the solver so the raw answer sits in the round-up half of its bracket.
var _realSolve = SWR.core.solveSpending;
SWR.core.solveSpending = function () { return 55555.55; };
fire(basisBtns[0], "click"); // back to Historical basis -> inline solve path
fire(document.getElementById("solveBtn"), "click");
A(document.getElementById("initialSpend").value === "55,500",
  "solve writeback floors, never rounds up (" + document.getElementById("initialSpend").value + ")");
A(document.getElementById("spendRateHint").textContent.indexOf("5.55") >= 0,
  "Initial-rate hint refreshed to the written-back value (" + document.getElementById("spendRateHint").textContent + ")");
SWR.core.solveSpending = _realSolve;

// Integration: percent-of-portfolio guardrail solver. Set a ceiling, leave the
// floor blank, then solve the floor (historical basis => inline path in this shim).
document.getElementById("strategy").value = "percent";
document.getElementById("spendCeiling").value = "60000";
document.getElementById("spendFloor").value = "";
fire(document.getElementById("gsolveBtn"), "click");
var solvedFloor = document.getElementById("spendFloor").value;
A(solvedFloor !== "" && unc(solvedFloor) > 0 && unc(solvedFloor) <= 60000,
  "guardrail solve set a floor within (0, ceiling] (" + solvedFloor + ")");
A(document.getElementById("gsolveResult").hidden === false &&
  document.getElementById("gsolveResult").children.length > 0, "guardrail result box shown with content");
A(document.getElementById("strategy").value === "percent", "guardrail solve kept the percentage strategy");

// Integration: monthly withdrawal frequency (percentage strategy only). The
// segmented control is wired, selecting Monthly updates the persisted hidden
// value + hint, and a run still renders results.
document.getElementById("strategy").value = "percent";
fire(document.getElementById("strategy"), "change"); // syncStrategy reveals the percentage fields
var freqBtns = document.getElementById("withdrawFreq").querySelectorAll("button");
A(freqBtns.length === 2, "withdrawFreq exposes Annual/Monthly buttons");
A(document.getElementById("withdrawFreqVal").value === "annual", "frequency defaults to Annual");
fire(freqBtns[1], "click"); // Monthly
A(document.getElementById("withdrawFreqVal").value === "monthly", "clicking Monthly sets the persisted freq value");
A(document.getElementById("withdrawFreqHint").textContent.indexOf("T-bill") >= 0,
  "monthly hint mentions the T-bill cash bucket");
document.getElementById("spendFloor").value = ""; document.getElementById("spendCeiling").value = "";
fire(document.getElementById("inputs"), "submit");
A(/%$/.test(document.getElementById("successBig").textContent), "monthly percentage run renders a success %");
fire(freqBtns[0], "click"); // back to Annual
A(document.getElementById("withdrawFreqVal").value === "annual", "clicking Annual restores the annual value");

// Integration: CAPE-based (Big ERN) strategy uses the shipped, auto-updated CAPE
// (no user input); switching to it and re-running renders results off the rule.
A(/Current CAPE/.test(document.getElementById("capeRateNow").textContent),
  "CAPE readout shows the auto CAPE + rate (" + document.getElementById("capeRateNow").textContent + ")");
A(/ERN/.test(document.getElementById("capeRateNow").textContent),
  "CAPE readout names its data source (ERN sheet vs computed)");
document.getElementById("strategy").value = "cape";
document.getElementById("spendFloor").value = "";
document.getElementById("spendCeiling").value = "";
fire(document.getElementById("inputs"), "submit");
A(/%$/.test(document.getElementById("successBig").textContent), "CAPE strategy runs & renders a success %");

// Rich/Broke/Dead overlay rendered (mortality data is loaded in this bundle).
A(document.getElementById("rbdCard").hidden === false, "rich/broke/dead card shown");
A(/year/.test(document.getElementById("rbdSub").textContent), "rbd subtitle has life-table info");

// Switch to the Loan calculator tab and verify it computes.
var vtabs = document.getElementById("viewTabs").querySelectorAll("button");
fire(vtabs[1], "click");
A(/\$/.test(document.getElementById("loanPayment").textContent),
  "loan tab computes a payment (" + document.getElementById("loanPayment").textContent + ")");
A(document.getElementById("loanStats").children.length >= 3, "loan stats populated");
A(document.getElementById("loanSchedule").children.length > 0, "loan yearly schedule rendered");

// Switch to the Compound interest tab: defaults ($1,500 @5%, 5yr, annual, start)
// must reproduce the classic calculator's $1,914.42 to the cent.
fire(vtabs[2], "click");
var fvText = document.getElementById("compFv").textContent;
A(fvText.indexOf("1,914.42") >= 0, "compound tab FV = $1,914.42 exactly (" + fvText + ")");
A(document.getElementById("compStats").children.length >= 3, "compound stats populated");
A(document.getElementById("compSchedule").children.length > 0, "compound yearly breakdown rendered");
// Flip timing to End + heavier inputs, recalc via the real submit handler.
var timingBtns = document.getElementById("compTiming").querySelectorAll("button");
fire(timingBtns[1], "click"); // "End"
document.getElementById("compAddition").value = "1200";
document.getElementById("compTimes").value = "12";
document.getElementById("compRate").value = "6";
document.getElementById("compYears").value = "10";
document.getElementById("compPrincipal").value = "0";
fire(document.getElementById("compoundInputs"), "submit");
A(document.getElementById("compFv").textContent.indexOf("16,387.93") >= 0,
  "compound recompute: $100/mo @6% 10yr end = $16,387.93 (" + document.getElementById("compFv").textContent + ")");

// Integration: flow-row notes + the print report. Add an income with a note
// longer than the cap, run, then print -- the report must carry the truncated
// note, the results, and chart snapshots, and must invoke window.print().
fire(vtabs[0], "click"); // back to the Retirement view
fire(document.getElementById("addIncome"), "click");
var noteRows = document.getElementById("incomeRows").querySelectorAll(".flowrow");
A(noteRows.length === 1, "addIncome created a flow row (got " + noteRows.length + ")");
noteRows[0].querySelector(".f-amt").value = "12000";
noteRows[0].querySelector(".f-start").value = "1";
noteRows[0].querySelector(".f-end").value = "10";
noteRows[0].querySelector(".f-note").value = "abcdefghijklmnopqrstuvwxyz"; // 26 chars; read-side cap = 24
fire(document.getElementById("inputs"), "submit");
A(/%$/.test(document.getElementById("successBig").textContent), "run with a noted income still renders");
function textOf(n) {
  var s = n && n.textContent ? String(n.textContent) : "";
  ((n && n.children) || []).forEach(function (c) { s += " " + textOf(c); });
  return s;
}
fire(document.getElementById("printBtn"), "click");
A(_printed >= 1, "print report invoked window.print()");
var rpt = document.getElementById("report");
A(rpt.children.length > 0, "report populated");
var rtxt = textOf(rpt);
A(rtxt.indexOf("abcdefghijklmnopqrstuvwx") >= 0, "report lists the income note");
A(rtxt.indexOf("abcdefghijklmnopqrstuvwxy") < 0, "note truncated to 24 chars in the report");
A(rtxt.indexOf("Success rate") >= 0 && rtxt.indexOf("%") >= 0, "report carries the results stats");
A(rtxt.indexOf("$12,000/yr") >= 0, "report shows the income amount");
A(rpt.querySelectorAll("img").length >= 2, "report embeds chart snapshots (" + rpt.querySelectorAll("img").length + ")");

// Chart hover redraw paths must run without throwing (measureText/draw stubbed).
["histCanvas", "rbdCanvas"].forEach(function (id) {
  var c = document.getElementById(id);
  if (c && c._redraw) { c._redraw(220); c._redraw(null); }
});
A(true, "histogram + mortality hover redraw paths run without error");

console.log("\nUI SMOKE: " + (fails ? fails + " FAILED" : "all passed"));
if (fails) throw new Error("ui smoke failed");
