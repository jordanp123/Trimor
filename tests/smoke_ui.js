// Headless UI smoke test. ui.js's init() has already run (readyState=complete)
// during script load -- driving read-inputs -> historical -> render -> inline
// Monte Carlo -> render -> charts. If init() had thrown, osascript would have
// errored before reaching here. Now assert the rendered DOM looks sane.
var fails = 0;
function A(c, m) { if (c) console.log("  ok: " + m); else { fails++; console.log("  FAIL: " + m); } }

// The hero number is a success % for constant/Guyton plans but a dollar income
// for variable ones, so "did it render" must not assume a unit -- it asserts a
// value is present AND that the eyebrow names which metric it is.
function rendered(what) {
  var big = document.getElementById("successBig").textContent;
  var kind = document.getElementById("successKind").textContent;
  A(big && big !== "\u2014" && kind.length > 0, what + " (" + kind + ": " + big + ")");
}
rendered("results rendered on load");
A(document.getElementById("headStats").children.length >= 3,
  "headStats populated (" + document.getElementById("headStats").children.length + " cards)");
A(document.getElementById("detailBody").children.length >= 4,
  "detailBody populated (" + document.getElementById("detailBody").children.length + " blocks)");
// Lowest-balance block exists and sits BEFORE the case blocks (top-row slot).
(function () {
  function tx(n) { var s = n.textContent || ""; (n.children || []).forEach(function (c) { s += tx(c); }); return s; }
  var t = tx(document.getElementById("detailBody"));
  var iLow = t.indexOf("Lowest portfolio balance"), iWorst = t.indexOf("Worst case");
  A(iLow >= 0 && t.indexOf("Typical lowest (median)") >= 0 && t.indexOf("Lowest average") >= 0,
    "lowest-balance block renders with its three rows");
  A(iWorst > iLow, "lowest-balance block precedes the Worst-case block (top-row placement)");
})();
A(document.getElementById("trajCanvas")._chart != null, "trajectory chart rendered");
A(missing.length === 0, "no unknown element ids referenced" + (missing.length ? ": " + missing.join(", ") : ""));
A(document.documentElement.getAttribute("data-theme") === "light" ||
  document.documentElement.getAttribute("data-theme") === "dark", "theme applied");
// Deployment stamp: identifies which build a bug report came from.
A(/^Updated \d{4}-\d{2}-\d{2}$/.test(document.getElementById("buildStamp").textContent),
  "build stamp shows the data-generation date (" + document.getElementById("buildStamp").textContent + ")");
A(document.getElementById("buildStamp").title.indexOf(SWR_DATA.meta.generated) >= 0,
  "build stamp tooltip carries the data vintage");

// Data-health banner: silent when the shipped data verified clean, loud when it
// did not. A warning that never fires is as useless as one that always does, so
// both directions are pinned by injecting a failed check and re-rendering.
(function () {
  var box = document.getElementById("dataWarning");
  A(box.hidden === true, "data-health banner hidden when the build's checks passed");
  var savedV = SWR_DATA.meta.validation, savedC = SWR_CAPE && SWR_CAPE.latest && SWR_CAPE.latest.source;
  SWR_DATA.meta.validation = [{ name: "BLS CPI cross-check", status: "diverged",
    detail: "Our 2025 inflation differs from the BLS by 0.50 percentage points." }];
  SWR.ui.renderDataHealth();
  A(box.hidden === false, "banner appears when a cross-check diverged");
  A(textOf(box).indexOf("0.50 percentage points") >= 0, "banner states the specific problem");
  A(textOf(box).indexOf("Simulations still run normally") >= 0,
    "banner distinguishes a data-verification issue from a maths error");
  // A degraded CAPE source (ERN sheet unreachable) must surface too.
  SWR_DATA.meta.validation = [];
  if (SWR_CAPE && SWR_CAPE.latest) {
    SWR_CAPE.latest.source = "computed (ERN sheet unavailable)";
    SWR.ui.renderDataHealth();
    A(box.hidden === false && textOf(box).indexOf("own estimate") >= 0,
      "banner also surfaces a CAPE fallback to a computed estimate");
    SWR_CAPE.latest.source = savedC;
  }
  SWR_DATA.meta.validation = savedV;
  SWR.ui.renderDataHealth();
  A(box.hidden === true, "banner hides again once the checks pass");
})();

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
// The solver defaults to 95%, not 100%: targeting 100% fits the plan to the
// single worst historical sequence, which is overfitting, not safety.
A(document.getElementById("targetSuccess").value === "95",
  "solver target defaults to 95% (" + document.getElementById("targetSuccess").value + ")");

var basisBtns = document.getElementById("solveBasis").querySelectorAll("button");
fire(basisBtns[1], "click");                       // select "Monte Carlo" basis
document.getElementById("targetSuccess").value = "90";
document.getElementById("mcSeed").value = "12345"; // pin the now-random seed so this section stays deterministic
fire(document.getElementById("solveBtn"), "click"); // click "Find max spending for"
var spendAfter = document.getElementById("initialSpend").value;
A(spendAfter !== spendBefore && unc(spendAfter) > 25000 && unc(spendAfter) < 70000,
  "MC solver changed spending (" + spendBefore + " -> " + spendAfter + ")");
A(document.getElementById("runMonteCarlo").checked, "MC solve enabled the Monte Carlo view");
rendered("results still render after MC solve");
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
// Targeting 100% must carry the overfitting caveat next to the number itself.
(function () {
  function solveAt(t) {
    document.getElementById("targetSuccess").value = String(t);
    fire(document.getElementById("solveBtn"), "click");
    var box = document.getElementById("solveResult");
    var s = box.textContent || "";
    (box.children || []).forEach(function (c) { s += c.textContent || ""; });
    return s;
  }
  A(solveAt(100).indexOf("single worst stretch") >= 0,
    "solving for 100% warns that it fits the worst single sequence");
  A(solveAt(95).indexOf("single worst stretch") < 0,
    "solving for 95% shows no such warning");
})();
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

// The headline swaps for self-limiting strategies: a percentage plan cannot run
// out, so showing "100% success" would be content-free. It must show the income
// floor instead, and a reckless rate must NOT render as green.
(function () {
  function runWith(pct) {
    document.getElementById("strategy").value = "percent";
    document.getElementById("spendPercent").value = String(pct);
    document.getElementById("spendFloor").value = ""; document.getElementById("spendCeiling").value = "";
    fire(document.getElementById("inputs"), "submit");
    return { big: document.getElementById("successBig").textContent,
             kind: document.getElementById("successKind").textContent,
             cls: document.getElementById("successCard").className,
             lbl: document.getElementById("successLabel").textContent };
  }
  var r4 = runWith(4), r8 = runWith(8);
  A(r4.kind === "Lowest income \u00b7 rough case" && /^\$/.test(r4.big),
    "percentage plan headlines the income in DOLLARS, labelled so it can't be read as a success rate ("
    + r4.kind + ": " + r4.big + ")");
  // Floorless: reports the observed outcome, never a claim of impossibility.
  A(r4.lbl.indexOf("ran out of money") >= 0 && r4.lbl.indexOf("cuts your income rather than running dry") >= 0,
    "floorless plan states what happened and that it cuts income instead");
  // Compare the "% of your first year" figure carried in the label, since the
  // hero number is now a dollar income.
  function pctOfYearOne(lbl) { var m = /(\d+)% of your first year/.exec(lbl); return m ? +m[1] : NaN; }
  A(pctOfYearOne(r8.lbl) < pctOfYearOne(r4.lbl),
    "a reckless 8%/yr keeps less of year-one income than 4%/yr ("
    + pctOfYearOne(r8.lbl) + "% vs " + pctOfYearOne(r4.lbl) + "%)");
  A(r8.cls.indexOf("bad") >= 0,
    "the 8%/yr plan is coloured red (" + r8.cls.trim() + ")");
  // ...and a sane 4% is amber, not red: bands that paint every reasonable plan
  // red would just train people to ignore the colour.
  A(r4.cls.indexOf("warn") >= 0,
    "a 4%/yr plan is amber, not red (" + r4.cls.trim() + ")");

  // A spending FLOOR makes a percentage/VPW/CAPE plan able to run dry (the
  // floor forces the draw up in bad sequences), so the headline must never
  // claim it cannot -- that contradiction is what confused users.
  function runFloored(pct, fl) {
    document.getElementById("strategy").value = "percent";
    document.getElementById("spendPercent").value = String(pct);
    document.getElementById("spendFloor").value = String(fl);
    document.getElementById("spendCeiling").value = "";
    fire(document.getElementById("inputs"), "submit");
    return { big: document.getElementById("successBig").textContent,
             lbl: document.getElementById("successLabel").textContent,
             stats: textOf(document.getElementById("headStats")) };
  }
  var survived = runFloored(4, 30000);   // floor set, but nothing failed
  A(survived.lbl.indexOf("can't run out of money") < 0 && survived.lbl.indexOf("cuts your income rather than running dry") < 0,
    "floored plan never claims it cannot run out");
  A(survived.lbl.indexOf("spending floor forces the draw up") >= 0,
    "floored plan warns the floor could exhaust it in a worse sequence");
  A(survived.lbl.indexOf("ran out of money") >= 0,
    "floored plan still reports the observed outcome (none ran out)");

  var ruined = runFloored(4, 80000);     // floor high enough to cause real ruin
  A(parseInt(ruined.big, 10) < 100 && ruined.lbl.indexOf("lasted") >= 0,
    "a floored plan that DID fail headlines the success rate (" + ruined.big + ")");
  // With a binding floor the draw never falls, so the ratio is 100% -- saying
  // "it fell to 100%" would be nonsense; the constant draw is the cause here.
  A(ruined.lbl.indexOf("held the draw at its year-one level") >= 0
    || ruined.lbl.indexOf("Spending is variable too") >= 0,
    "...and still explains the spending side of the failure");
  A(ruined.lbl.indexOf("fell to 100% of year one") < 0,
    "never says spending 'fell to 100%' (a binding floor means it did not fall)");
  A(ruined.stats.indexOf("% of yr 1") >= 0,
    "...with the rough-case income kept as a stat card");
  // A floor ABOVE the ceiling is contradictory (the ceiling would silently win
  // every year), so the run must refuse with a message, not produce results.
  document.getElementById("spendFloor").value = "33000";
  document.getElementById("spendCeiling").value = "27000";
  var beforeBig = document.getElementById("successBig").textContent;
  fire(document.getElementById("inputs"), "submit");
  A(document.getElementById("formMsg").textContent.indexOf("above the ceiling") >= 0,
    "floor > ceiling blocks the run with a message (" + document.getElementById("formMsg").textContent + ")");
  A(document.getElementById("successBig").textContent === beforeBig,
    "...and no new results were rendered");
  document.getElementById("spendFloor").value = "";
  document.getElementById("spendCeiling").value = "";

  // A floor typed for a percentage plan must NOT keep steering other strategies
  // from its now-hidden field: the engine clamps Guyton spending too, so
  // readInputs may only pass floor/ceiling for strategies whose panel shows
  // the boxes.
  function guytonSuccess() {
    document.getElementById("strategy").value = "guyton";
    document.getElementById("initialSpend").value = "55000";
    fire(document.getElementById("inputs"), "submit");
    return document.getElementById("successBig").textContent + "|" +
           document.getElementById("successLabel").textContent;
  }
  var gClean = guytonSuccess();
  document.getElementById("spendFloor").value = "80000"; // stale, hidden for guyton
  var gStale = guytonSuccess();
  A(gClean === gStale, "a stale hidden floor does not change Guyton results");
  document.getElementById("spendFloor").value = "";
  document.getElementById("initialSpend").value = "40000";

  // Constant-dollar keeps the classic success-rate headline.
  document.getElementById("strategy").value = "constant";
  document.getElementById("initialSpend").value = "40000";
  fire(document.getElementById("inputs"), "submit");
  A(document.getElementById("successLabel").textContent.indexOf("lasted") >= 0,
    "constant-dollar still headlines the success rate");
})();

// Variable-length block bootstrap: the new default MC method. Its two streak
// fields must show only for that method, and contradictory bounds must be
// refused rather than silently swapped (same rule as the spending floor/ceiling).
(function () {
  var meth = document.getElementById("mcMethod");
  A(meth.value === "varblock", "variable-streak block bootstrap is the default method (" + meth.value + ")");
  A(document.getElementById("mcVarBlockWrap").hidden === false &&
    document.getElementById("mcBlockWrap").hidden === true,
    "streak min/max shown for varblock; fixed-length field hidden");
  meth.value = "block"; fire(meth, "change");
  A(document.getElementById("mcVarBlockWrap").hidden === true &&
    document.getElementById("mcBlockWrap").hidden === false,
    "switching to fixed block swaps which field is shown");
  meth.value = "varblock"; fire(meth, "change");

  var before = document.getElementById("successBig").textContent;
  document.getElementById("mcBlockMin").value = "9";
  document.getElementById("mcBlockMax").value = "3";
  fire(document.getElementById("inputs"), "submit");
  A(document.getElementById("formMsg").textContent.indexOf("longer than the longest") >= 0,
    "min > max streak refuses the run (" + document.getElementById("formMsg").textContent + ")");
  A(document.getElementById("successBig").textContent === before,
    "...and renders no new results");
  document.getElementById("mcBlockMin").value = "2";
  document.getElementById("mcBlockMax").value = "8";
  fire(document.getElementById("inputs"), "submit");
  A(document.getElementById("formMsg").textContent === "", "valid streak bounds clear the message");
})();

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
rendered("monthly percentage run renders results");
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
rendered("CAPE strategy runs & renders results");

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
rendered("run with a noted income still renders");
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
A(rpt.querySelectorAll(".rpt-qr").length === 1, "report embeds the share-link QR figure");
A(textOf(rpt).indexOf("contains your portfolio, spending and income figures") >= 0,
  "printed QR warns that it encodes the user's financial figures");
// When the payload exceeds QR capacity, dataURL returns null and the report
// must still build with the text fallback and no QR figure.
var _realQR = SWR.qr.dataURL;
SWR.qr.dataURL = function () { return null; };
fire(document.getElementById("printBtn"), "click");
A(rpt.querySelectorAll(".rpt-qr").length === 0 && textOf(rpt).indexOf("are listed above") >= 0,
  "over-capacity URL: report still builds, QR absent, text fallback present");
SWR.qr.dataURL = _realQR;

// Slim share-hash: fields still at their load-time defaults are omitted (the
// hash was just refreshed by the report build above -- shim atob is identity,
// so the payload is inspectable). mcSeed must ALWAYS survive; touched fields
// (strategy, targetSuccess, the income row) must be present.
var slim = decodeURIComponent(history._last.slice(1));
A(slim.indexOf("mcSeed") >= 0, "slim hash always carries mcSeed");
// Assert only on fields the tests above definitively left non-default:
// strategy (cape vs the "constant" default) and the income row. Anything the
// preceding blocks happen to restore to its default (targetSuccess,
// initialSpend, spendPercent, spendFloor) is CORRECTLY omitted, so pinning
// those here would just make this test brittle against unrelated edits.
A(slim.indexOf("strategy") >= 0 && slim.indexOf("inc") >= 0,
  "slim hash carries the touched fields + flows");
A(slim.indexOf("vpwReturn") < 0 && slim.indexOf("gkGuard") < 0 && slim.indexOf("allocGold") < 0 && slim.indexOf("adj") < 0,
  "slim hash omits untouched fields and empty flow lists");

// The Print button AUTO-RUNS first: edit an input WITHOUT submitting, print,
// and the report must reflect the edit (WYSIWYG). In this shim the inline MC
// path is synchronous, so the print fires on the same tick.
document.getElementById("initialValue").value = "2222222";
fire(document.getElementById("initialValue"), "input");
var printsBefore = _printed;
fire(document.getElementById("printBtn"), "click");
A(_printed === printsBefore + 1, "print button auto-ran and printed (" + (_printed - printsBefore) + " print call)");
A(textOf(document.getElementById("report")).indexOf("2,222,222") >= 0,
  "report reflects the un-submitted edit (auto-run before print)");

// Cmd/Ctrl+P prints the ACTIVE view's report: loan and compound tabs get
// their own reports (recomputed synchronously, so never stale).
function fireBeforePrint() { (window._ev.beforeprint || []).forEach(function (f) { f(); }); }
fire(vtabs[1], "click"); // Loan tab
fireBeforePrint();
var rptText = textOf(document.getElementById("report"));
A(rptText.indexOf("loan amortization report") >= 0 && rptText.indexOf("2,212.24") >= 0,
  "Cmd+P on the Loan tab builds the loan report with the exact payment");
fire(vtabs[2], "click"); // Compound tab
fireBeforePrint();
rptText = textOf(document.getElementById("report"));
A(rptText.indexOf("compound interest report") >= 0 && rptText.indexOf("16,387.93") >= 0,
  "Cmd+P on the Compound tab builds the compound report with the exact FV");
fire(vtabs[0], "click"); // back to Retirement
fireBeforePrint();
A(textOf(document.getElementById("report")).indexOf("retirement simulation report") >= 0,
  "Cmd+P back on the Retirement tab builds the simulation report");

// Chart hover redraw paths must run without throwing (measureText/draw stubbed).
["histCanvas", "rbdCanvas"].forEach(function (id) {
  var c = document.getElementById(id);
  if (c && c._redraw) { c._redraw(220); c._redraw(null); }
});
A(true, "histogram + mortality hover redraw paths run without error");

console.log("\nUI SMOKE: " + (fails ? fails + " FAILED" : "all passed"));
if (fails) throw new Error("ui smoke failed");
