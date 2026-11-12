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
// The Monte Carlo solver searches on the SAME trials the run uses (up to
// 10,000), so the re-run it triggers must meet the target it promised. It used
// to search on 5,000 while the run used more, and the re-run then came in
// under target more often than not.
(function () {
  function boxText() {
    var box = document.getElementById("solveResult"), s = box.textContent || "";
    (box.children || []).forEach(function (c) { s += c.textContent || ""; });
    return s;
  }
  var mcNow = SWR.ui.__mc();
  A(mcNow && mcNow.successRate >= 0.90,
    "the re-run after a 90% Monte Carlo solve meets 90% on its own trials (" + (mcNow ? (mcNow.successRate * 100).toFixed(2) : "none") + "%)");
  A(boxText().indexOf("came in at") < 0, "...so the solver box carries no shortfall note");
  // When the full run does land under the promise (possible above 10,000
  // trials, where the search is a subset), the box that made the promise says so.
  SWR.ui.__solveCheck({ target: 0.999, box: "solveResult", what: "spending", ready: true });
  A(/came in at \d+\.\d%, just under the 100% target/.test(boxText()) && boxText().indexOf("Lower spending a little") >= 0,
    "a full run under the solver's target is called out in the solver's own box");
  var before = boxText();
  SWR.ui.__solveCheck({ target: 0.5, box: "solveResult", what: "spending", ready: true });
  A(boxText() === before, "...and a run that meets its target adds nothing");
})();

// Success rates are FLOORED to a tenth, never rounded, and read 100 only when
// nothing failed: "100%" used to appear over runs that contained failures.
(function () {
  var f = SWR.ui.__fmtRate;
  A(f(1) === "100" && f(0.99996) === "99.9" && f(0.9996) === "99.9" && f(0.9995) === "99.9",
    "a run with any failure never reads 100% (" + [f(1), f(0.99996), f(0.9996)].join(", ") + ")");
  A(f(0.9496) === "94.9" && f(0.95) === "95.0" && f(0.94999) === "94.9",
    "94.96% reads 94.9%, not a rounded-up 95.0% (" + [f(0.9496), f(0.95)].join(", ") + ")");
  A(f(122 / 126) === "96.8" && f(19 / 20) === "95.0" && f(0) === "0.0" && f(1 / 3) === "33.3",
    "ordinary rates are unchanged (" + [f(122 / 126), f(19 / 20), f(0), f(1 / 3)].join(", ") + ")");
})();

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

// Long horizons: the caption must disclose the start years that cannot be
// judged, because they are excluded from the success-rate denominator. Without
// this the rate looks like it covers all of history when it cannot -- a 60-year
// plan can only be fully observed from starts up to 1966.
(function () {
  var yearsEl = document.getElementById("years");
  var before = yearsEl.value;
  yearsEl.value = "60";
  document.getElementById("strategy").value = "constant";
  fire(document.getElementById("strategy"), "change");
  document.getElementById("initialSpend").value = "40000";
  fire(document.getElementById("inputs"), "submit");
  var lbl = document.getElementById("successLabel").textContent;
  A(lbl.indexOf("can't be judged yet") >= 0,
    "60yr caption discloses the unjudgeable later starts (" + lbl.slice(0, 120) + ")");
  A(/every start from 18\d\d–1966/.test(lbl),
    "the caption's range is the contiguous, fully-judged one (" + lbl.slice(0, 90) + ")");
  A(/plus \d+ later starts? that ran out of money before the data ends/.test(lbl),
    "...and the later starts that ran dry are named, not folded into the range");
  yearsEl.value = before;
  fire(document.getElementById("inputs"), "submit");
})();

// The worst start year of the run currently on screen, read the way a user
// would see it: from the picker's own "Worst case — YYYY" option.
function state_worst() {
  var o = document.getElementById("ybyStart").children[0].children[0];
  return +String(o.textContent).replace(/\D+/g, " ").trim().split(" ").pop();
}

// ===== 1-4: income tax, Social Security cut, partner, year-by-year =====
// Each feature's DEFAULT must be the conservative one: when we don't know, assume
// the outcome that can only make a plan look worse.
(function () {
  var g = function (id) { return document.getElementById(id); };
  function submit() { fire(g("inputs"), "submit"); }
  function hl() { return g("successBig").textContent; }
  g("strategy").value = "constant"; fire(g("strategy"), "change");
  g("initialSpend").value = "70000"; g("taxRate").value = "20"; g("years").value = "30";

  // --- 1) income source + tax ---
  g("addIncome") && fire(g("addIncome"), "click");
  var rows = g("incomeRows").querySelectorAll(".flowrow");
  var row = rows[rows.length - 1];
  var src = row.querySelector(".f-src");
  A(src && src.value === "ss", "a new income row defaults to Soc. Sec. (taxed and cut): the conservative source");
  row.querySelector(".f-amt").value = "30000";
  g("ssCutOn").checked = false; fire(g("ssCutOn"), "change");
  src.value = "taxfree"; submit(); var free = parseFloat(hl());
  src.value = "pension"; submit(); var taxedPension = parseFloat(hl());
  A(taxedPension < free, "a taxed pension scores lower than the same amount tax-free (" +
    free + "% -> " + taxedPension + "%)");

  // old share links carry no source: they must read as Soc. Sec.
  var slim = decodeURIComponent(history._last.slice(1));
  A(/"inc":\[\[30000,1,30,1,"",1\]\]/.test(slim), "the share link records the row's source (" +
    (slim.match(/"inc":\[\[[^\]]*\]\]/) || ["?"])[0] + ")");

  // --- 2) the Social Security cut ---
  src.value = "ss";
  g("ssCutOn").checked = false; fire(g("ssCutOn"), "change"); submit(); var noCut = parseFloat(hl());
  A(g("ssCutFields").hidden === true && g("ssCutHint").textContent.indexOf("optimistic") >= 0,
    "with the cut off, its fields hide and the hint calls that the optimistic choice");
  g("ssCutOn").checked = true; fire(g("ssCutOn"), "change"); submit(); var withCut = parseFloat(hl());
  A(g("ssCutOn").checked && withCut <= noCut, "the Social Security cut can only lower results (" +
    noCut + "% -> " + withCut + "%)");
  A(/retirement year \d+, since it starts in 20\d\d/.test(g("ssCutHint").textContent),
    "the hint states exactly which retirement year the cut lands in (" +
    (g("ssCutHint").textContent.match(/retirement year \d+[^—]*/) || ["?"])[0] + ")");
  A(/"planYear":"?20\d\d/.test(decodeURIComponent(history._last.slice(1))),
    "the share link carries the plan's start year, so a link opened later reproduces it");
  // A start year in the past lands the cut LATER in retirement than a plan
  // starting now would -- the optimistic direction -- so it must be flagged.
  var thisYear = new Date().getFullYear();
  g("planYear").value = String(thisYear - 3); fire(g("planYear"), "input");
  A(g("ssCutHint").textContent.indexOf("before this year") >= 0 &&
    g("ssCutHint").textContent.indexOf("the optimistic direction") >= 0,
    "a past start year is flagged in the hint as the optimistic direction");
  submit(); var stale = parseFloat(hl());
  g("planYear").value = String(thisYear); fire(g("planYear"), "input"); submit(); var fresh = parseFloat(hl());
  A(fresh <= stale, "moving the start year to today brings the cut earlier, never raising success (" +
    stale + "% -> " + fresh + "%)");
  A(g("ssCutHint").textContent.indexOf("before this year") < 0, "...and the warning clears");
  g("ssCutPct").value = "150"; submit();
  A(g("formMsg").textContent.indexOf("between 0% and 100%") >= 0, "an impossible benefit share refuses the run");
  g("ssCutPct").value = "78"; submit();

  // --- 3) partner + longevity ---
  g("partnerOn").checked = false; fire(g("partnerOn"), "change"); submit();
  A(g("rbdTitle").textContent === "Will your money outlast you?", "single-person title by default");
  var sub = function () { return g("rbdSub").textContent; };
  var deadPct = function () { return parseFloat((sub().match(/(\d+)% chance deceased/) || [0, "NaN"])[1]); };
  A(g("longevity").value === "2" && sub().indexOf("read 2 years younger") >= 0,
    "by default the life table is read 2 years younger, and the caption says so");
  A(sub().indexOf("conservative") < 0 && sub().indexOf("may still understate how long you live") >= 0,
    "...and even adjusted, the caption never claims to be conservative");
  var deadAt2 = deadPct();
  g("longevity").value = "0"; fire(g("longevity"), "change");
  A(sub().indexOf("as published") >= 0 && sub().indexOf("likely optimistic") >= 0 && sub().indexOf("likely conservative") < 0,
    "the raw table is labelled as published and as erring OPTIMISTIC (it used to claim the opposite)");
  var deadAt0 = deadPct();
  A(/"longevity":"?0/.test(decodeURIComponent(history._last.slice(1))), "a non-default longevity is carried in the share link");
  g("longevity").value = "6"; fire(g("longevity"), "change");
  var deadAt6 = deadPct();
  A(deadAt0 > deadAt2 && deadAt2 > deadAt6,
    "each step younger lowers the chance of having died by the end (" + deadAt0 + "% -> " + deadAt2 + "% -> " + deadAt6 + "%)");
  var ageNow = Math.round(+g("currentAge").value);
  var leAt6 = +(sub().match(/life expectancy ≈ age (\d+)/) || [0, NaN])[1];
  A(leAt6 === Math.round(ageNow + SWR.mortality.lifeExpectancy(ageNow - 6, g("sex").value)),
    "the quoted life expectancy is the setback table's, added to your REAL age (" + leAt6 + ")");
  g("longevity").value = "2"; fire(g("longevity"), "change");
  A(!/"longevity"/.test(decodeURIComponent(history._last.slice(1))), "...and the default stays out of the link, like every default");
  var singleDead = deadPct();
  g("partnerOn").checked = true; fire(g("partnerOn"), "change"); submit();
  A(g("partnerFields").hidden === false && g("rbdTitle").textContent === "Will your money outlast you both?",
    "with a partner, the fields show and the chart asks about both of you");
  var bothDead = parseFloat((g("rbdSub").textContent.match(/(\d+)% chance you've both died/) || [0, "NaN"])[1]);
  A(bothDead < singleDead, "a couple is less likely to have BOTH died by the end, so the money must last longer (" +
    singleDead + "% -> " + bothDead + "%)");
  g("partnerOn").checked = false; fire(g("partnerOn"), "change");

  // --- 4) year by year + CSV ---
  submit();
  var hist = SWR.ui.__yby();
  A(g("ybyCard").hidden === false && hist && hist.rows.length > 0, "the year-by-year card shows after a run");
  A(g("ybyStart").value === "worst" && hist.startYear === state_worst(),
    "it opens on the CURRENT plan's worst case (" + hist.startYear + ")");
  // Change the plan so its worst case moves: the default must follow it, or the
  // table would show a milder scenario than the real worst (seen in a browser).
  var before = hist.startYear;
  g("initialSpend").value = "95000"; submit();
  var moved = SWR.ui.__yby().startYear;
  A(g("ybyStart").value === "worst" && moved === state_worst(),
    "after an edit the table still shows the worst case of the NEW plan (" + before + " -> " + moved + ")");
  // A year the reader deliberately picks is kept across runs.
  g("ybyStart").value = "1929"; fire(g("ybyStart"), "change");
  submit();
  A(SWR.ui.__yby().startYear === 1929, "a year the reader chose is kept across a re-run");
  g("ybyStart").value = "worst"; fire(g("ybyStart"), "change");
  g("initialSpend").value = "70000"; submit();
  hist = SWR.ui.__yby();
  var csv = SWR.ui.__ybyCsvText(hist, 65), lines = csv.trim().split("\r\n");
  A(lines.length === hist.rows.length + 1 && lines[0].indexOf("year,market_year,age") === 0,
    "the CSV has a header and one line per year (" + (lines.length - 1) + " rows)");
  A(lines[0].indexOf("end_nominal") >= 0 && lines[0].indexOf("end_real") >= 0,
    "the CSV carries both nominal and today's-dollar columns");
  var evil = SWR.ui.__ybyCsvText({ startYear: 1966, years: 1, rows: [{ year: 1, start: 1, spend: 1, income: 1,
    expense: 1, incomeTax: 0, withdrawalTax: 0, withdrawal: -5, fee: 0, bucket: 0, end: 1, ret: 0, infl: 0,
    deflStart: 1, deflEnd: 1, ranOut: "=HYPERLINK(\"http://x\")" }] }, 65);
  // No field carries free text into the CSV today: even a hostile value in the
  // one text column is replaced by a fixed yes/no. That is the real guarantee.
  A(evil.indexOf("HYPERLINK") < 0, "no field passes free text into the CSV (a planted formula never appears)");
  A(evil.indexOf(",-5,") >= 0, "...and a negative NUMBER stays a number, not text");
  // Defence in depth for any future text column: the sanitiser itself.
  var c = SWR.ui.__csvCell;
  A(c("=SUM(A1)") === "'=SUM(A1)" && c("+1") === "'+1" && c("@x") === "'@x" && c("-cmd") === "'-cmd",
    "text a spreadsheet would run as a formula is defused with a leading apostrophe");
  A(c(-5) === "-5" && c(1234.567) === "1234.57", "numbers are written as numbers, rounded to cents");
  A(c('a,"b"') === '"a,""b"""', "commas and quotes are escaped");
  g("taxRate").value = "0"; g("initialSpend").value = "40000";
  clearAllRows: { var r2 = g("incomeRows").querySelectorAll(".flowrow"); for (var k = 0; k < r2.length; k++) r2[k].remove(); }
  submit();
})();

// Guyton cuts spending like the other adaptive strategies, so its pay cut must
// be on screen too, never just a success rate that can rise as plans worsen.
(function () {
  var g = function (id) { return document.getElementById(id); };
  g("strategy").value = "guyton"; fire(g("strategy"), "change");
  g("initialSpend").value = "75000"; g("years").value = "30";
  fire(g("inputs"), "submit");
  var lbl = g("successLabel").textContent, stats = textOf(g("headStats"));
  A(/fell to \d+% of year one|never fell below/.test(lbl) || stats.indexOf("% of yr 1") >= 0,
    "a Guyton plan shows how far spending fell, not only a success rate (" + lbl.slice(0, 80) + ")");
  A(lbl.indexOf("Your spending floor") < 0,
    "...and never blames a spending floor, which Guyton does not have");
  g("strategy").value = "constant"; fire(g("strategy"), "change");
  g("initialSpend").value = "40000"; fire(g("inputs"), "submit");
})();

// Review findings, pinned.
(function () {
  var g = function (id) { return document.getElementById(id); };
  function submit() { fire(g("inputs"), "submit"); }
  // #2: Guyton can run dry, so it must never take the headline that says a plan
  // "cuts your income rather than running dry" -- even with zero failures.
  g("strategy").value = "guyton"; fire(g("strategy"), "change");
  g("initialSpend").value = "45000"; g("years").value = "30"; submit();
  A(g("successKind").textContent === "Success rate" && g("successLabel").textContent.indexOf("rather than running dry") < 0,
    "a Guyton plan with no failures keeps the success-rate headline and never claims it can't run dry");
  // #3: rates keep their precision in the CSV
  var c = SWR.ui.__csvCell;
  A(c(0.0349, 6) === "0.0349" && c(0.004, 6) === "0.004" && c(1234.567) === "1234.57",
    "CSV rates keep 6 decimals while money rounds to cents");
  var tr = SWR.ui.__yby(), csv = SWR.ui.__ybyCsvText(tr, 65).trim().split("\r\n");
  var head = csv[0].split(","), ri = head.indexOf("return"), r1 = csv[1].split(",")[ri];
  A(Math.abs(+r1 - tr.rows[0].ret) < 1e-6, "the exported return matches the engine's to 6 decimals (" + r1 + ")");
  // #5: adjustment Income is taxed; Tax-free is explicit
  g("strategy").value = "constant"; fire(g("strategy"), "change");
  g("initialSpend").value = "70000"; g("taxRate").value = "20";
  var rs = g("adjustRows").querySelectorAll(".flowrow");
  for (var k = 0; k < rs.length; k++) rs[k].remove();
  fire(g("addAdjust"), "click");
  var row = g("adjustRows").querySelector(".flowrow");
  row.querySelector(".f-amt").value = "30000"; row.querySelector(".f-end").value = "10";
  A(row.querySelector(".f-kind").value === "expense", "a new adjustment row still starts as Expense");
  row.querySelector(".f-kind").value = "taxfree"; submit(); var free = parseFloat(g("successBig").textContent);
  row.querySelector(".f-kind").value = "income"; submit(); var taxed = parseFloat(g("successBig").textContent);
  A(taxed < free, "adjustment Income is taxed, Tax-free is not (" + free + "% -> " + taxed + "%)");
  var slim = decodeURIComponent(history._last.slice(1));
  A(/"adj":\[\[1,30000/.test(slim), "the link records taxed Income as code 1");
  row.querySelector(".f-kind").value = "taxfree"; submit();
  A(/"adj":\[\[2,30000/.test(decodeURIComponent(history._last.slice(1))), "...and Tax-free as code 2");
  row.remove(); g("taxRate").value = "0"; g("initialSpend").value = "40000"; submit();
})();

// Adjustments must say only what actually reached the results. The dangerous
// case is a PESSIMISTIC haircut on an asset the portfolio doesn't hold: if the
// note announced it as applied, the user would believe they had stress-tested
// a plan they hadn't. Cash is the exception -- it also sets the monthly
// bucket's rate, because that money sits in the same T-bills.
(function () {
  var note = document.getElementById("adjNote");
  var ids = ["adjStocks", "adjBonds", "adjGold", "adjCash", "adjCorp", "adjReit", "adjSmallcap"];
  function clear() { ids.forEach(function (id) { document.getElementById(id).value = "0"; }); }
  function runWith(setup) {
    clear(); setup();
    fire(document.getElementById("inputs"), "submit");
    return { big: document.getElementById("successBig").textContent, txt: note.textContent, hidden: note.hidden };
  }
  document.getElementById("strategy").value = "constant";
  fire(document.getElementById("strategy"), "change");
  document.getElementById("initialSpend").value = "45000";

  var base = runWith(function () {});
  // Gold -5% on 75/25: holds no gold, so NOTHING changes...
  var gold = runWith(function () { document.getElementById("adjGold").value = "-5"; });
  A(gold.big === base.big, "a gold haircut on a portfolio with no gold changes nothing (" + gold.big + ")");
  // ...and the note must not claim a stress test that never ran.
  A(!gold.hidden && gold.txt.indexOf("Returns adjusted") < 0 && gold.txt.indexOf("no effect") >= 0,
    "...and the note says it had no effect instead of claiming it applied (" + gold.txt.slice(0, 80) + ")");
  A(gold.txt.indexOf("unadjusted history") >= 0,
    "...and says these are unadjusted results");

  // A held asset still reports as applied.
  var stk = runWith(function () { document.getElementById("adjStocks").value = "-1"; });
  A(stk.txt.indexOf("Returns adjusted: stocks") >= 0 && parseFloat(stk.big) < parseFloat(base.big),
    "a haircut on a held asset applies and is reported as applied (" + base.big + " -> " + stk.big + ")");

  // Mixed: one reached, one did not -- both stated, neither overstated.
  var mix = runWith(function () {
    document.getElementById("adjStocks").value = "-1";
    document.getElementById("adjGold").value = "-5";
  });
  A(mix.txt.indexOf("Returns adjusted: stocks") >= 0 && mix.txt.indexOf("gold") >= 0 &&
    mix.txt.indexOf("no effect") >= 0,
    "a mix reports what applied and what did not");

  // Cash at 0% with ANNUAL withdrawals: no path to the results, so no effect.
  var cashAnnual = runWith(function () { document.getElementById("adjCash").value = "-2"; });
  A(cashAnnual.big === base.big && cashAnnual.txt.indexOf("no effect") >= 0,
    "cash offset at 0% cash with annual withdrawals has no effect, and says so");

  // Cash at 0% with the MONTHLY bucket: reaches the results through the bucket.
  document.getElementById("strategy").value = "percent";
  fire(document.getElementById("strategy"), "change");
  document.getElementById("withdrawFreqVal").value = "monthly";
  var mBase = runWith(function () {});
  var mCash = runWith(function () { document.getElementById("adjCash").value = "-2"; });
  A(mCash.txt.indexOf("through the monthly T-bill bucket") >= 0,
    "a cash offset with the monthly bucket names that path (" + mCash.txt.slice(0, 90) + ")");
  A(mCash.txt.indexOf("no effect") < 0,
    "...and is NOT described as having no effect, because it reaches the results");

  clear();
  document.getElementById("withdrawFreqVal").value = "annual";
  document.getElementById("strategy").value = "constant";
  fire(document.getElementById("strategy"), "change");
  document.getElementById("initialSpend").value = "40000";
  fire(document.getElementById("inputs"), "submit");
  A(note.hidden === true, "clearing every offset hides the note again");
})();

// Share-link gate. A link carries every input and opening it runs at once, so
// a crafted URL could otherwise force the heaviest Monte Carlo run on whoever
// clicks it (measured: 200k trials x 155yr = ~52s and 2.4GB). Above a budget a
// LINK must wait for the reader to press Run -- but the reader's own Run must
// never be held back.
(function () {
  var mcStarted = 0, realRunMC = null;
  // Count Monte Carlo starts through the same hook the page uses.
  var trialsEl = document.getElementById("mcTrials"), yearsEl = document.getElementById("years");
  var savedT = trialsEl.value, savedY = yearsEl.value;
  document.getElementById("runMonteCarlo").checked = true;
  trialsEl.value = "200000"; yearsEl.value = "155";
  document.getElementById("strategy").value = "constant";
  fire(document.getElementById("strategy"), "change");

  // Drive run() exactly as init() does for a share link.
  SWR.ui.__runForTest(true);
  A(document.getElementById("formMsg").textContent.indexOf("wasn't started automatically") >= 0,
    "a heavy share link does not auto-start Monte Carlo (" +
    document.getElementById("formMsg").textContent.slice(0, 70) + ")");
  A(SWR.ui.__mcPending() === false,
    "...and no Monte Carlo run is in flight");

  // The reader pressing Run is explicit consent: it must run normally.
  SWR.ui.__runForTest(false);
  A(document.getElementById("formMsg").textContent.indexOf("wasn't started automatically") < 0,
    "the reader's own Run is never deferred");

  // A light share link (the defaults) still auto-runs as before.
  trialsEl.value = "10000"; yearsEl.value = "30";
  SWR.ui.__runForTest(true);
  A(document.getElementById("formMsg").textContent.indexOf("wasn't started automatically") < 0,
    "an ordinary share link still runs Monte Carlo automatically");

  trialsEl.value = savedT; yearsEl.value = savedY;
  fire(document.getElementById("inputs"), "submit");
})();

// Trial cap. The reported confusion was that typing 90,000 ran 50,000 with no
// indication, so the number on screen and the number simulated must never
// disagree in silence.
(function () {
  var el = document.getElementById("mcTrials"), cap = document.getElementById("mcTrialsCap");
  var LIMIT = SWR.mc.MAX_TRIALS;
  A(LIMIT === 200000, "engine trial cap is 200,000 (" + LIMIT + ")");
  A(String(el.max) === String(LIMIT),
    "the input's max advertises the engine limit (" + el.max + ")");

  el.value = "10000"; fire(el, "input");
  A(cap.hidden === true, "no cap notice at a normal trial count");

  el.value = "90000"; fire(el, "input");
  A(cap.hidden === true, "90,000 now runs as asked — no notice, because nothing is clamped");

  el.value = "250000"; fire(el, "input");
  A(cap.hidden === false && cap.textContent.indexOf("200,000") >= 0,
    "over the limit, the notice states what will actually run (" + cap.textContent.slice(0, 60) + ")");
  A(cap.textContent.indexOf("under 0.1 points") >= 0,
    "...and says why more trials would not help");
  A(cap.textContent.length < 90,
    "...in one short line, since it sits in a narrow column (" + cap.textContent.length + " chars)");

  // The engine must honour the same limit it advertises.
  var capped = SWR.mc.run(
    { initialValue: 1e6, years: 30, allocation: { stocks: 0.75, bonds: 0.25 },
      feeRate: 0.001, taxRate: 0, spending: { strategy: "constant", initial: 40000 },
      incomes: [], adjustments: [] },
    SWR_DATA, { method: "bootstrap", trials: 999999, seed: 1, successOnly: true });
  A(capped.total === LIMIT, "the engine clamps to its own limit (" + capped.total + ")");

  el.value = "10000"; fire(el, "input");
  A(cap.hidden === true, "returning under the limit clears the notice");
})();

// Length-dependent strategies (VPW, Guyton) get a comparability disclaimer,
// but only where it is true: the draw depends on the plan length AND failures
// are reachable. A floorless VPW plan cannot run dry, so warning there would
// be crying wolf -- a caveat that always fires is one nobody reads.
(function () {
  var note = document.getElementById("horizonNote");
  function runStrat(strat, setup) {
    document.getElementById("strategy").value = strat;
    fire(document.getElementById("strategy"), "change");
    if (setup) setup();
    fire(document.getElementById("inputs"), "submit");
    return note;
  }
  // Constant dollar: draw is length-independent, so no caveat.
  runStrat("constant", function () { document.getElementById("initialSpend").value = "45000"; });
  A(note.hidden === true, "constant-dollar shows no comparability caveat");

  // VPW with a floor: length-dependent AND able to fail -> caveat.
  runStrat("vpw", function () {
    document.getElementById("vpwReturn").value = "5";
    document.getElementById("spendFloor").value = "60000";
  });
  A(note.hidden === false && note.textContent.indexOf("years you have left") >= 0,
    "floored VPW explains that the length is part of the spending rule");
  A(note.textContent.indexOf("roughly comparable") >= 0 &&
    note.textContent.indexOf("under 2 percentage points") >= 0,
    "...and quantifies the effect rather than just hand-waving");

  // Floorless VPW cannot run dry, so nothing can be reclassified: no caveat.
  runStrat("vpw", function () {
    document.getElementById("vpwReturn").value = "3.4";
    document.getElementById("spendFloor").value = "";
  });
  A(note.hidden === true,
    "floorless VPW (which cannot fail) shows no caveat — the warning is not reflexive");

  // Guyton at a rate that does fail -> caveat. $55k survives every cycle at
  // 75/25, so the gate correctly suppresses it there; $65k fails 5 of 126.
  runStrat("guyton", function () { document.getElementById("initialSpend").value = "55000"; });
  A(note.hidden === true, "Guyton at a rate that never fails gets no caveat either");
  runStrat("guyton", function () { document.getElementById("initialSpend").value = "65000"; });
  A(note.hidden === false && note.textContent.indexOf("Guyton-Klinger") >= 0,
    "Guyton gets its own wording when failures are reachable");

  document.getElementById("strategy").value = "constant";
  fire(document.getElementById("strategy"), "change");
  document.getElementById("initialSpend").value = "40000";
  document.getElementById("spendFloor").value = "";
  fire(document.getElementById("inputs"), "submit");
  A(note.hidden === true, "switching back to constant-dollar clears the caveat");
})();

// Return adjustments. These change every number on the page, so the run must
// reflect them, out-of-range values must be refused rather than clamped, and
// an active adjustment must be impossible to miss (badge + results note).
(function () {
  var note = document.getElementById("adjNote"), badge = document.getElementById("adjBadge");
  A(note.hidden === true && badge.hidden === true,
    "no adjustment note or badge when every offset is 0");

  function runAdj(stocks, bonds) {
    document.getElementById("adjStocks").value = String(stocks);
    document.getElementById("adjBonds").value = String(bonds);
    document.getElementById("strategy").value = "constant";
    fire(document.getElementById("strategy"), "change");
    document.getElementById("initialSpend").value = "45000";
    fire(document.getElementById("inputs"), "submit");
    return document.getElementById("successBig").textContent;
  }
  var before = runAdj(0, 0);
  var cut = runAdj(-1, 0);
  // parseFloat, not unc(): unc strips commas but not the trailing "%", so it
  // returns NaN on "78.7%" and every comparison would silently pass.
  A(parseFloat(cut) < parseFloat(before),
    "a -1%/yr equity haircut lowers the headline (" + before + " -> " + cut + ")");
  A(note.hidden === false && note.textContent.indexOf("stocks −1%/yr") >= 0,
    "the results note names the active adjustment (" + note.textContent.slice(0, 80) + ")");
  A(note.textContent.indexOf("not the historical record") >= 0,
    "...and says plainly these are not historical results");
  A(badge.hidden === false, "the collapsed section carries a badge");

  // Both directions, the user's stated case.
  runAdj(-0.25, 0.25);
  A(note.textContent.indexOf("stocks −0.25%/yr") >= 0 &&
    note.textContent.indexOf("bonds +0.25%/yr") >= 0,
    "an opposing tilt is spelled out with signs (" + note.textContent.slice(0, 90) + ")");

  // Share links must carry the offsets, or a shared scenario silently reverts
  // to unadjusted history.
  var slim = decodeURIComponent(history._last.slice(1));
  A(slim.indexOf("adjStocks") >= 0 && slim.indexOf("adjBonds") >= 0,
    "share hash carries the return adjustments");

  // Out of range is refused, not silently clamped.
  var good = document.getElementById("successBig").textContent;
  document.getElementById("adjStocks").value = "-99";
  fire(document.getElementById("inputs"), "submit");
  A(document.getElementById("formMsg").textContent.indexOf("Return adjustments must be between") >= 0,
    "an out-of-range offset refuses the run (" + document.getElementById("formMsg").textContent + ")");
  A(document.getElementById("successBig").textContent === good, "...and renders no new results");

  // Back to clean: the note and badge must disappear again.
  runAdj(0, 0);
  A(note.hidden === true && badge.hidden === true,
    "clearing the offsets hides the note and badge again");
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

// ===== input panel: a fold may hide inputs, never their effect =====
(function () {
  var g = function (id) { return document.getElementById(id); };
  A(!g("moreAssets").open && g("sumMoreAssets").textContent === "",
    "More asset classes starts folded, with nothing set inside to report");
  g("allocGold").value = "10"; fire(g("allocGold"), "input");
  A(g("sumMoreAssets").textContent === "gold 10%",
    "a non-zero gold allocation shows in the closed fold's summary (got '" + g("sumMoreAssets").textContent + "')");
  SWR.ui.__openFolds();
  A(g("moreAssets").open === true, "...and the fold opens on load, as it would for a share link carrying it");
  g("allocGold").value = "0"; fire(g("allocGold"), "input"); g("moreAssets").open = false;
  A(g("sumMoreAssets").textContent === "", "...and the summary clears when the allocation goes back to 0%");

  // Every fold's summary line tracks its fields through the form-level listener.
  var sync = function () { fire(g("inputs"), "input"); };
  var adjIds = ["adjStocks", "adjBonds", "adjGold", "adjCash", "adjCorp", "adjReit", "adjSmallcap"];
  var yr = new Date().getFullYear();
  g("feeRate").value = "0.10"; g("taxRate").value = "0"; g("inflationMode").value = "cpi"; g("longevity").value = "2";
  adjIds.forEach(function (id) { g(id).value = "0"; });
  g("ssCutOn").checked = true; g("ssCutPct").value = "78"; g("ssCutYear").value = "2032"; g("planYear").value = String(yr);
  g("runMonteCarlo").checked = true; g("mcMethod").value = "varblock"; g("mcTrials").value = "2000";
  g("mcBlockMin").value = "2"; g("mcBlockMax").value = "8";
  ["foldIncome", "foldAssumptions", "foldMc", "adjBox"].forEach(function (id) { g(id).open = false; });
  sync();
  A(g("sumAssumptions").textContent === "Fees 0.10% · tax 0% · historical inflation · life table 2 years younger · no return adjustments",
    "Assumptions summary at the defaults (got '" + g("sumAssumptions").textContent + "')");
  A(/^(No income added|\d+ incomes?) · /.test(g("sumIncome").textContent) &&
    g("sumIncome").textContent.indexOf("Social Security cut to 78% from 2032") >= 0,
    "Income summary counts the rows and states the Social Security cut (got '" + g("sumIncome").textContent + "')");
  A(g("sumMc").textContent === "On · variable streaks 2–8 years · 2,000 trials",
    "Monte Carlo summary names the method, streaks and trials (got '" + g("sumMc").textContent + "')");
  SWR.ui.__openFolds();
  A(!g("foldAssumptions").open && !g("foldMc").open && !g("adjBox").open,
    "folds holding only default values stay closed on load");

  g("feeRate").value = "0.25"; g("taxRate").value = "15"; g("inflationMode").value = "fixed"; g("fixedInflation").value = "4";
  g("longevity").value = "0"; g("adjStocks").value = "-0.25"; g("adjBonds").value = "0.25";
  sync();
  A(g("sumAssumptions").textContent === "Fees 0.25% · tax 15% · fixed 4% inflation · life table as published · " +
    "returns adjusted: stocks −0.25%/yr, bonds +0.25%/yr",
    "Assumptions summary reflects every change, signs included (got '" + g("sumAssumptions").textContent + "')");
  SWR.ui.__openFolds();
  A(g("foldAssumptions").open === true && g("adjBox").open === true,
    "a link that sets an assumption or a return adjustment opens both folds on load");

  g("planYear").value = String(yr - 1); sync();
  A(g("sumIncome").textContent.indexOf("plan starts in " + (yr - 1) + ", before this year (optimistic)") >= 0,
    "a past start year is flagged as optimistic in the closed Income summary");
  g("ssCutOn").checked = false; sync();
  A(g("sumIncome").textContent.indexOf("no Social Security cut (optimistic)") >= 0 && g("sumIncome").textContent.indexOf("plan starts") < 0,
    "dropping the cut is flagged as optimistic, and the start year then no longer matters");
  SWR.ui.__openFolds();
  A(g("foldIncome").open === true, "a link that changes the Social Security settings opens Income and expenses");

  g("mcMethod").value = "block"; g("mcBlock").value = "5"; sync();
  A(g("sumMc").textContent === "On · fixed 5-year streaks · 2,000 trials", "fixed-streak method shows its block length");
  g("runMonteCarlo").checked = false; sync();
  A(g("sumMc").textContent === "Off", "Monte Carlo summary reads Off when unticked");
  SWR.ui.__openFolds();
  A(g("foldMc").open === true, "a link that changes Monte Carlo settings opens its fold");
  [g("sumIncome"), g("sumAssumptions"), g("sumMc")].forEach(function (s) {
    A(!/NaN|undefined|\[object/.test(s.textContent), "summary text is clean: '" + s.textContent + "'");
  });

  // Find max spending: its fold names the target and basis, including a basis
  // chosen by segment click (which fires no input event of its own).
  A(g("sumSolve").textContent === "target 95% · historical",
    "Find max spending summary at the defaults (got '" + g("sumSolve").textContent + "')");
  g("targetSuccess").value = "90"; sync();
  fire(g("solveBasis").querySelectorAll("button")[1], "click");
  A(g("sumSolve").textContent === "target 90% · Monte Carlo",
    "...and follows the target and the basis segment (got '" + g("sumSolve").textContent + "')");
  g("foldSolve").open = false; SWR.ui.__openFolds();
  A(g("foldSolve").open === true, "a link carrying a non-default target opens the Find max spending fold");
  fire(g("solveBasis").querySelectorAll("button")[0], "click");
  g("targetSuccess").value = "95";

  // Back to the defaults for anything that runs after this block.
  g("feeRate").value = "0.10"; g("taxRate").value = "0"; g("inflationMode").value = "cpi"; g("longevity").value = "2";
  adjIds.forEach(function (id) { g(id).value = "0"; });
  g("ssCutOn").checked = true; g("planYear").value = String(yr);
  g("runMonteCarlo").checked = true; g("mcMethod").value = "varblock";
  sync();
})();

// ===== out-of-range inputs are refused, never run and never silently clamped =====
// Run as typed, several of these scored "100%" on a plan that fails 4 cycles in
// 10 (a negative fee, a negative ceiling, a -10% withdrawal rate, a 250%
// guardrail cut, a -100% VPW return via NaN), and a crafted share link can
// carry any of them.
(function () {
  var g = function (id) { return document.getElementById(id); };
  function reset() {
    g("strategy").value = "constant"; g("initialSpend").value = "60000"; g("years").value = "30"; g("initialValue").value = "1000000";
    g("feeRate").value = "0.10"; g("taxRate").value = "0"; g("allocStocks").value = "75"; g("allocBonds").value = "25";
    ["allocGold", "allocCash", "allocCorp", "allocReit", "allocSmallcap"].forEach(function (id) { g(id).value = "0"; });
    g("spendPercent").value = "4"; g("spendFloor").value = ""; g("spendCeiling").value = "";
    g("vpwReturn").value = "3.4"; g("gkGuard").value = "20"; g("gkAdjust").value = "10"; g("capeA").value = "1.75"; g("capeB").value = "0.5";
    g("inflationMode").value = "cpi"; g("fixedInflation").value = "3";
    g("runMonteCarlo").checked = false; g("mcMethod").value = "varblock"; g("mcBlock").value = "5";
    fire(g("strategy"), "change");
  }
  function refused(label, setup, expect) {
    reset(); setup(); g("successBig").textContent = "UNTOUCHED";
    fire(g("inputs"), "submit");
    var m = g("formMsg").textContent;
    A(m.indexOf(expect) >= 0 && g("successBig").textContent === "UNTOUCHED",
      label + " is refused and nothing is rendered (" + (m || "ran: " + g("successBig").textContent) + ")");
  }
  var strat = function (s) { g("strategy").value = s; fire(g("strategy"), "change"); };
  refused("a negative fee", function () { g("feeRate").value = "-5"; }, "Annual fees must be between 0% and 100%");
  refused("a tax rate above 90%", function () { g("taxRate").value = "95"; }, "Tax rate must be between 0% and 90%");
  refused("a negative tax rate", function () { g("taxRate").value = "-30"; }, "Tax rate must be between 0% and 90%");
  refused("a leveraged 150/-50 allocation", function () { g("allocStocks").value = "150"; g("allocBonds").value = "-50"; },
    "Each asset allocation must be between 0% and 100%");
  refused("a negative total-spending rate", function () { strat("percent"); g("spendPercent").value = "-10"; }, "Total spending must be between 0% and 100%");
  refused("a negative spending ceiling", function () { strat("percent"); g("spendCeiling").value = "-50000"; }, "Spending floor and ceiling must be dollar amounts");
  refused("a negative spending floor", function () { strat("vpw"); g("spendFloor").value = "-1"; }, "Spending floor and ceiling must be dollar amounts");
  refused("a -100% VPW return", function () { strat("vpw"); g("vpwReturn").value = "-100"; }, "Assumed real return must be between -50% and 50%");
  refused("a 250% guardrail cut", function () { strat("guyton"); g("gkAdjust").value = "250"; }, "Spending cut/raise must be between 0% and 50%");
  refused("a negative guardrail band", function () { strat("guyton"); g("gkGuard").value = "-5"; }, "Guardrail band must be between 0% and 100%");
  refused("a negative CAPE base rate", function () { strat("cape"); g("capeA").value = "-1"; }, "Base rate (a) must be between 0% and 50%");
  refused("negative fixed inflation", function () { g("inflationMode").value = "fixed"; g("fixedInflation").value = "-2"; }, "Fixed inflation must be between 0% and 50%");
  refused("a zero-year block length", function () { g("runMonteCarlo").checked = true; g("mcMethod").value = "block"; g("mcBlock").value = "0"; },
    "Block length must be between 1 years and 30 years");
  refused("a blank spending figure", function () { g("initialSpend").value = ""; }, "Enter your annual spending");
  refused("an unreadable spending figure", function () { g("initialSpend").value = "1e999"; }, "Enter your annual spending");
  // A field that is not in use is not checked: a stale value hidden under
  // another strategy must not block the run.
  reset(); g("spendPercent").value = "-10"; g("vpwReturn").value = "-100"; g("gkAdjust").value = "250"; g("fixedInflation").value = "-2"; g("mcBlock").value = "0";
  fire(g("inputs"), "submit");
  A(g("formMsg").textContent === "" && /^\d+\.\d%$/.test(g("successBig").textContent),
    "out-of-range values in fields that are not in use do not block a constant-dollar run (" + g("successBig").textContent + ")");
  // The edges themselves are valid.
  reset(); g("feeRate").value = "0"; g("taxRate").value = "90"; g("inflationMode").value = "fixed"; g("fixedInflation").value = "0";
  fire(g("inputs"), "submit");
  A(g("formMsg").textContent === "", "the range edges (0% fee, 90% tax, 0% fixed inflation) are accepted");
  reset(); g("initialSpend").value = "40000"; fire(g("inputs"), "submit");
  A(g("formMsg").textContent === "" && /^\d+(\.\d)?%$/.test(g("successBig").textContent),
    "and an in-range plan still runs (" + g("successBig").textContent + ")");
  g("runMonteCarlo").checked = true;
})();

// ===== results always say which inputs they belong to =====
// Results belong to the inputs they were RUN with. Editing the form afterwards
// used to leave them on screen with nothing saying so, and the browser's own
// Print (Cmd/Ctrl+P cannot re-run) put the edited inputs above the old results
// on paper: a $70k / 45-year / 2%-fee plan printed over "96.8% ... 30 years".
(function () {
  var g = function (id) { return document.getElementById(id); };
  var sync = function () { fire(g("inputs"), "input"); };
  function reportText() { (window._ev.beforeprint || []).forEach(function (f) { f(); }); return textOf(g("report")); }
  g("runMonteCarlo").checked = false; g("strategy").value = "constant"; fire(g("strategy"), "change");
  g("initialSpend").value = "40000"; g("years").value = "30"; g("feeRate").value = "0.10"; g("taxRate").value = "0";
  g("partnerOn").checked = false; fire(g("partnerOn"), "change");
  fire(g("inputs"), "submit");
  var headline = g("successBig").textContent;
  A(g("formMsg").textContent === "" && g("staleNote").hidden === true && SWR.ui.__stale() === false,
    "right after a run the results match the inputs and no note shows");

  // Settings that redraw live or only feed the solvers do not make results stale.
  g("currentAge").value = "62"; fire(g("currentAge"), "input"); sync();
  g("targetSuccess").value = "90"; sync();
  A(g("staleNote").hidden === true, "changing age or the solver target does not mark the results out of date");

  // The partner settings redraw the mortality chart at once, like age and sex.
  A(g("rbdTitle").textContent === "Will your money outlast you?", "single-person chart before ticking Plan for two");
  g("partnerOn").checked = true; fire(g("partnerOn"), "change");
  A(g("rbdTitle").textContent === "Will your money outlast you both?" && g("partnerFields").hidden === false,
    "ticking Plan for two redraws the chart for two immediately, with no re-run");
  var both = parseFloat((g("rbdSub").textContent.match(/(\d+)% chance you've both died/) || [0, "NaN"])[1]);
  g("partnerAge").value = "50"; fire(g("partnerAge"), "input");
  var bothYounger = parseFloat((g("rbdSub").textContent.match(/(\d+)% chance you've both died/) || [0, "NaN"])[1]);
  A(bothYounger < both, "...and a younger partner updates it again (" + both + "% -> " + bothYounger + "%)");
  A(g("staleNote").hidden === true, "...none of which marks the simulation results out of date");
  g("partnerOn").checked = false; fire(g("partnerOn"), "change");
  A(g("rbdTitle").textContent === "Will your money outlast you?", "unticking it goes straight back to one life");

  // Edit real inputs WITHOUT running.
  g("initialSpend").value = "70000"; g("years").value = "45"; g("feeRate").value = "2"; sync();
  A(g("staleNote").hidden === false && SWR.ui.__stale() === true,
    "editing an input shows the out-of-date note beside the results");
  A(g("successBig").textContent === headline, "...while the old results stay as they were (never faded or hidden)");
  var rpt = reportText();
  A(/Inputs were changed after this simulation was run/.test(rpt), "browser print says the inputs were changed after the run");
  A(/Retirement length\s*30 years/.test(rpt) && rpt.indexOf("$40,000/yr") >= 0 && /Fees \/ effective tax rate\s*0\.1% \/ 0%/.test(rpt),
    "...and describes the plan that was RUN: 30 years, $40,000, 0.1% fees");
  A(rpt.indexOf("70,000") < 0 && rpt.indexOf("45 years") < 0,
    "...with none of the edited figures above the old results");
  var url = SWR.ui.__runShareUrl();
  A(url.indexOf("70000") < 0 && url.indexOf('"years"') < 0 && url.indexOf("#") > 0,
    "the report's QR link reopens the simulation that was run, not the edited form");

  // An edit that is typed back to what was run is not stale.
  g("initialSpend").value = "40000"; g("years").value = "30"; g("feeRate").value = "0.10"; sync();
  A(g("staleNote").hidden === true, "typing the inputs back to what was run clears the note");
  A(!/Inputs were changed/.test(reportText()), "...and the report no longer carries the warning");

  // Running clears it and the report follows the new run.
  g("initialSpend").value = "70000"; sync();
  fire(g("inputs"), "submit");
  A(g("staleNote").hidden === true && reportText().indexOf("$70,000/yr") >= 0 && !/Inputs were changed/.test(reportText()),
    "after Run the note is gone and the report describes the new plan");
  // A refused run leaves the old results up, so the note has to stay.
  g("feeRate").value = "-1"; sync(); fire(g("inputs"), "submit");
  A(g("formMsg").textContent.length > 0 && g("staleNote").hidden === false,
    "a refused run keeps the note: the results on screen are still the earlier plan's");
  g("feeRate").value = "0.10"; sync();

  // "Total spending": the percentage plan's rate is what the plan spends.
  g("strategy").value = "percent"; fire(g("strategy"), "change"); g("spendPercent").value = "4";
  fire(g("inputs"), "submit");
  A(reportText().indexOf("Total spending of 4% of the portfolio each year") >= 0,
    "the report calls a percentage plan's rate total spending, not a withdrawal rate");
  g("strategy").value = "constant"; fire(g("strategy"), "change"); g("initialSpend").value = "40000"; g("currentAge").value = "65";
  g("targetSuccess").value = "95"; g("runMonteCarlo").checked = true;
  fire(g("inputs"), "submit");
})();

// ===== percentage of portfolio: years at the spending floor =====
(function () {
  var g = function (id) { return document.getElementById(id); };
  function details() { return textOf(g("detailBody")); }
  function report() { (window._ev.beforeprint || []).forEach(function (f) { f(); }); return textOf(g("report")); }
  g("runMonteCarlo").checked = false;
  g("strategy").value = "percent"; fire(g("strategy"), "change");
  g("spendPercent").value = "4"; g("spendFloor").value = "35000"; g("spendCeiling").value = "";
  fire(g("inputs"), "submit");
  var d = details();
  A(g("formMsg").textContent === "" && /Years at floor \(average\)\s*\d+\.\d of 30/.test(d) && /Years at floor \(std\. dev\.\)\s*\d+\.\d years/.test(d),
    "a floored percentage plan shows years at the floor (average and std. dev.) under Annual spending");
  A(/Years at the spending floor \(average \/ std\. dev\.\)\s*\d+\.\d of 30 \/ \d+\.\d years/.test(report()),
    "...and the printed report carries the same figures");
  g("spendFloor").value = ""; fire(g("inputs"), "submit");
  A(details().indexOf("Years at floor") < 0 && report().indexOf("spending floor (average") < 0,
    "without a floor, neither the panel nor the report shows them");
  g("strategy").value = "vpw"; fire(g("strategy"), "change"); g("spendFloor").value = "35000"; fire(g("inputs"), "submit");
  A(details().indexOf("Years at floor") < 0, "they are shown for percentage of portfolio only, as asked");
  g("spendFloor").value = ""; g("strategy").value = "constant"; fire(g("strategy"), "change");
  g("runMonteCarlo").checked = true; fire(g("inputs"), "submit");
})();

// ===== info toggles: explanations fold away, warnings never do =====
(function () {
  var g = function (id) { return document.getElementById(id); };
  var pairs = SWR.ui.__info();
  A(pairs.length === 12, "12 info toggles are wired (got " + pairs.length + ")");
  pairs.forEach(function (p) {
    var b = g(p[0]), h = g(p[1]);
    h.hidden = true; b.setAttribute("aria-expanded", "false"); // as index.html ships them (info_parity.py)
    fire(b, "click");
    var opened = h.hidden === false && b.getAttribute("aria-expanded") === "true";
    fire(b, "click");
    A(opened && h.hidden === true && b.getAttribute("aria-expanded") === "false",
      p[0] + " opens and closes " + p[1] + ", keeping aria-expanded in step");
  });
  // Switching away from variable streaks puts that explanation away; switching
  // back never forces it open (only its own button does).
  fire(g("mcBlockInfoBtn"), "click");
  g("mcMethod").value = "block"; fire(g("mcMethod"), "change");
  A(g("mcVarBlockHint").hidden === true && g("mcBlockInfoBtn").getAttribute("aria-expanded") === "false",
    "leaving variable streaks hides their explanation and resets its button");
  g("mcMethod").value = "varblock"; fire(g("mcMethod"), "change");
  A(g("mcVarBlockHint").hidden === true, "...and returning to them does not force it open");
  // The Social Security status line keeps every warning on screen.
  g("ssCutOn").checked = false; fire(g("ssCutOn"), "change");
  A(g("ssCutHint").hidden !== true && g("ssCutHint").textContent.indexOf("optimistic") >= 0,
    "with the cut off, the visible status line still says it is the optimistic choice");
  g("ssCutOn").checked = true; fire(g("ssCutOn"), "change");
  A(/^This plan pays \d+% of scheduled benefits from \d+ — retirement year \d+, since it starts in \d+/.test(g("ssCutHint").textContent),
    "with the cut on, the status line states exactly when it lands (got '" + g("ssCutHint").textContent.slice(0, 80) + "')");
})();

// Chart hover redraw paths must run without throwing (measureText/draw stubbed).
["histCanvas", "rbdCanvas"].forEach(function (id) {
  var c = document.getElementById(id);
  if (c && c._redraw) { c._redraw(220); c._redraw(null); }
});
A(true, "histogram + mortality hover redraw paths run without error");

console.log("\nUI SMOKE: " + (fails ? fails + " FAILED" : "all passed"));
if (fails) throw new Error("ui smoke failed");
