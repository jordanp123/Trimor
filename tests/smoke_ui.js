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
var spendBefore = document.getElementById("initialSpend").value;
var basisBtns = document.getElementById("solveBasis").querySelectorAll("button");
fire(basisBtns[1], "click");                       // select "Monte Carlo" basis
document.getElementById("targetSuccess").value = "90";
fire(document.getElementById("solveBtn"), "click"); // click "Find max spending for"
var spendAfter = document.getElementById("initialSpend").value;
A(spendAfter !== spendBefore && +spendAfter > 25000 && +spendAfter < 70000,
  "MC solver changed spending (" + spendBefore + " -> " + spendAfter + ")");
A(document.getElementById("runMonteCarlo").checked, "MC solve enabled the Monte Carlo view");
A(/%$/.test(document.getElementById("successBig").textContent), "results still render after MC solve");
A(document.getElementById("solveResult").hidden === false &&
  document.getElementById("solveResult").children.length > 0, "solver result box is shown with content");

// Integration: percent-of-portfolio guardrail solver. Set a ceiling, leave the
// floor blank, then solve the floor (historical basis => inline path in this shim).
document.getElementById("strategy").value = "percent";
document.getElementById("spendCeiling").value = "60000";
document.getElementById("spendFloor").value = "";
fire(document.getElementById("gsolveBtn"), "click");
var solvedFloor = document.getElementById("spendFloor").value;
A(solvedFloor !== "" && +solvedFloor > 0 && +solvedFloor <= 60000,
  "guardrail solve set a floor within (0, ceiling] (" + solvedFloor + ")");
A(document.getElementById("gsolveResult").hidden === false &&
  document.getElementById("gsolveResult").children.length > 0, "guardrail result box shown with content");
A(document.getElementById("strategy").value === "percent", "guardrail solve kept the percentage strategy");

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

// Chart hover redraw paths must run without throwing (measureText/draw stubbed).
["histCanvas", "rbdCanvas"].forEach(function (id) {
  var c = document.getElementById(id);
  if (c && c._redraw) { c._redraw(220); c._redraw(null); }
});
A(true, "histogram + mortality hover redraw paths run without error");

console.log("\nUI SMOKE: " + (fails ? fails + " FAILED" : "all passed"));
if (fails) throw new Error("ui smoke failed");
