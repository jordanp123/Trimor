// Headless engine tests. Run with: sh tests/run.sh   (uses macOS JavaScriptCore)
var pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log("  FAIL: " + msg); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function money(x) { return "$" + Math.round(x); }

var data = self.SWR_DATA;
var core = self.SWR.core, stats = self.SWR.stats;
console.log("data: " + data.years[0] + "-" + data.years[data.years.length - 1] +
  " (" + data.years.length + " yrs)");

function P(over) {
  return Object.assign({
    initialValue: 1000000, years: 30,
    allocation: { stocks: 0.75, bonds: 0.25 },
    feeRate: 0, taxRate: 0,
    spending: { strategy: "constant", initial: 40000 },
    incomes: [], adjustments: [],
  }, over || {});
}
// Convenience: build params + run the historical engine against the bundled data.
function H(over) { return core.runHistorical(P(over), data); }

// 1) The classic 4% rule should land in the mid-90s % historically.
var r = H();
console.log("4% 75/25 30yr: success=" + (r.successRate * 100).toFixed(1) + "% over " +
  r.total + " cycles; medianRealEnd=" + money(r.endingReal.median) +
  "; worst start=" + r.representative.worst.startYear);
assert(r.successRate > 0.9 && r.successRate < 0.99, "4% success in 90-99% (" + (r.successRate * 100).toFixed(1) + "%)");
assert(r.total === data.years.length - 30 + 1, "cycle count = N-window+1");
assert(r.bands.median.length === 31, "fan has N+1 points");

// 1b) Extended history (1871+) + allocation-driven start range + 5th percentile.
assert(data.years[0] === 1871 && data.years[data.years.length - 1] === 2025, "data spans 1871-2025");
assert(r.startYears && r.startYears.first === 1871, "stocks/bonds cycles start at 1871 (got " + (r.startYears && r.startYears.first) + ")");
assert(r.endingReal.p5 != null && r.endingReal.p5 <= r.endingReal.p10, "5th percentile present and <= 10th");
var rgold = H({ allocation: { stocks: 0.6, bonds: 0.2, gold: 0.2 } });
console.log("gold-incl allocation: cycles start " + rgold.startYears.first + ", " + rgold.total + " cycles");
assert(rgold.startYears.first === 1928, "gold allocation auto-restricts start to 1928 (got " + rgold.startYears.first + ")");
assert(rgold.total === 98 - 30 + 1, "gold cycle count = 1928-2025 window (69)");

// 2) Zero spending can never fail.
assert(H({ spending: { strategy: "constant", initial: 0 }, allocation: { stocks: 1 } }).successRate === 1,
  "0 spend => 100% success");

// 3) Absurd spending always fails.
assert(H({ spending: { strategy: "constant", initial: 600000 } }).successRate === 0,
  "60% spend => 0% success");

// 4) Percentage-of-portfolio mathematically cannot deplete.
assert(H({ spending: { strategy: "percent", percent: 0.04 } }).successRate === 1,
  "percent-of-portfolio never depletes");

// 5) VPW and Guyton-Klinger run and are also non-depleting / higher-success than constant.
var rv = H({ spending: { strategy: "vpw", vpwReturn: 0.034 } });
assert(rv.successRate === 1, "VPW never depletes (" + (rv.successRate * 100).toFixed(0) + "%)");
var rg = H({ spending: { strategy: "guyton", initial: 40000, guard: 0.2, gkAdjust: 0.1 } });
console.log("Guyton-Klinger 4% start: success=" + (rg.successRate * 100).toFixed(1) + "%");
assert(rg.successRate >= r.successRate, "GK guardrails >= constant success");

// 6) Solver: max 100%-success constant spend (the historical SAFEMAX).
var safe = core.solveSpending(P(), data, 1.0);
console.log("SAFEMAX (100% success, 30yr 75/25)= " + money(safe) +
  " (" + (safe / 1e6 * 100).toFixed(2) + "% SWR)");
assert(safe > 20000 && safe < 50000, "SAFEMAX plausible");

// 6b) Solver against Monte Carlo: deterministic (fixed seed) and harsher than historical.
if (self.SWR.mc) {
  var mcRun = function (pp, dd) { return self.SWR.mc.run(pp, dd, { method: "bootstrap", trials: 1500, seed: 99, successOnly: true }); };
  var safeM1 = core.solveSpending(P(), data, 0.95, mcRun);
  var safeM2 = core.solveSpending(P(), data, 0.95, mcRun);
  var safeH95 = core.solveSpending(P(), data, 0.95);
  console.log("solve 95%: historical " + money(safeH95) + " vs MC-bootstrap " + money(safeM1));
  assert(safeM1 === safeM2, "MC solve deterministic with fixed seed");
  assert(safeM1 > 10000 && safeM1 < 60000, "MC-solved spend plausible");
  assert(safeM1 <= safeH95 + 500, "MC-bootstrap solve <= historical (harsher)");
  var so = self.SWR.mc.run(P(), data, { method: "bootstrap", trials: 800, seed: 1, successOnly: true });
  assert(so.successRate != null && so.bands === undefined, "successOnly returns rate without bands");
}

// 6c) Percent-of-portfolio guardrail solver (the floor/ceiling "work back").
(function () {
  var G = core.solveGuardrail;
  // Engine fix: a percentage strategy WITH a floor can now genuinely fail (the
  // floor forces over-spending in bad sequences). Floorless still never fails.
  assert(H({ spending: { strategy: "percent", percent: 0.04 } }).successRate === 1, "floorless percent never fails (baseline)");
  var floored = H({ spending: { strategy: "percent", percent: 0.04, floor: 80000 } });
  console.log("percent 4% + $80k floor: success=" + (floored.successRate * 100).toFixed(1) + "%");
  assert(floored.successRate < 1, "a high floor on percent can fail (" + (floored.successRate * 100).toFixed(1) + "%)");
  var f1 = H({ spending: { strategy: "percent", percent: 0.04, floor: 50000 } }).successRate;
  var f2 = H({ spending: { strategy: "percent", percent: 0.04, floor: 70000 } }).successRate;
  assert(f2 <= f1, "success is non-increasing in the floor (" + (f1 * 100).toFixed(0) + "% -> " + (f2 * 100).toFixed(0) + "%)");

  // Solve the FLOOR given a ceiling + target (3% of portfolio, $60k cap, 95%).
  var rF = G(P({ spending: { strategy: "percent", percent: 0.03, ceiling: 60000 } }), data, { solveFor: "floor", target: 0.95 });
  console.log("solve floor @95% (3%, $60k cap): feasible=" + rF.feasible +
    " floor=" + money(rF.value) + (rF.atCap ? " (atCap)" : ""));
  assert(rF.feasible && rF.solveFor === "floor", "floor solve is feasible");
  assert(rF.value >= 0 && rF.value <= 60000, "solved floor lands within [0, ceiling]");
  var atF = H({ spending: { strategy: "percent", percent: 0.03, ceiling: 60000, floor: rF.value } }).successRate;
  assert(atF >= 0.95 - 1e-9, "at the solved floor the plan meets the 95% target (" + (atF * 100).toFixed(1) + "%)");
  if (!rF.atCap) {
    var hiF = H({ spending: { strategy: "percent", percent: 0.03, ceiling: 60000, floor: rF.value + 8000 } }).successRate;
    assert(hiF < 0.95, "a meaningfully higher floor drops below target (" + (hiF * 100).toFixed(1) + "%)");
  }

  // Solve the CEILING given a floor + target. Invariants hold for both the
  // bounded answer and the "no cap needed" (unbounded) answer.
  var rC = G(P({ spending: { strategy: "percent", percent: 0.06, floor: 40000 } }), data, { solveFor: "ceiling", target: 0.85 });
  console.log("solve ceiling @85% (6%, $40k floor): feasible=" + rC.feasible +
    " ceiling=" + (rC.unbounded ? "none" : money(rC.value)));
  assert(rC.feasible && rC.solveFor === "ceiling", "ceiling solve is feasible");
  var ceilUsed = rC.unbounded ? 1e12 : rC.value;
  var atC = H({ spending: { strategy: "percent", percent: 0.06, floor: 40000, ceiling: ceilUsed } }).successRate;
  assert(atC >= 0.85 - 1e-9, "at the solved ceiling the plan meets the 85% target (" + (atC * 100).toFixed(1) + "%)");
  if (!rC.unbounded) {
    assert(rC.value >= 40000, "solved ceiling is >= the floor");
    var hiC = H({ spending: { strategy: "percent", percent: 0.06, floor: 40000, ceiling: rC.value + 30000 } }).successRate;
    assert(hiC <= atC + 1e-9, "a higher ceiling never raises success (" + (hiC * 100).toFixed(1) + "%)");
  }

  // Infeasible #1: a no-floor plan that already fails the target (a big fixed
  // expense drains it regardless of the floor) => reason "target".
  var badF = G(P({ spending: { strategy: "percent", percent: 0.04 },
    adjustments: [{ amount: 90000, start: 1, end: 30, cola: true }] }), data, { solveFor: "floor", target: 0.95 });
  console.log("solve floor @95% w/ $90k/yr expense: feasible=" + badF.feasible + " reason=" + (badF.reason || "-"));
  assert(badF.feasible === false && badF.reason === "target", "already-failing plan => floor solve infeasible");

  // Infeasible #2: an absurd floor can't hit a high target even capped at it.
  var badC = G(P({ spending: { strategy: "percent", percent: 0.04, floor: 200000 } }), data, { solveFor: "ceiling", target: 0.95 });
  console.log("solve ceiling @95% w/ $200k floor: feasible=" + badC.feasible + " reason=" + (badC.reason || "-"));
  assert(badC.feasible === false && badC.reason === "floorTooHigh", "absurd floor => ceiling solve infeasible");

  // MC runner path (fixed seed) is deterministic, exactly as the bisection needs.
  if (self.SWR.mc) {
    var mcRun = function (pp, dd) { return self.SWR.mc.run(pp, dd, { method: "bootstrap", trials: 800, seed: 7, successOnly: true }); };
    var g1 = G(P({ spending: { strategy: "percent", percent: 0.04, ceiling: 60000 } }), data, { solveFor: "floor", target: 0.9, runner: mcRun });
    var g2 = G(P({ spending: { strategy: "percent", percent: 0.04, ceiling: 60000 } }), data, { solveFor: "floor", target: 0.9, runner: mcRun });
    assert(g1.value === g2.value, "MC guardrail solve is deterministic with a fixed seed");
  }
})();

// 6b) Monthly withdrawal option (T-bill cash bucket), percentage strategy only.
(function () {
  // (a) The closed-form bucket interest matches a literal 12-step drawdown, and
  // a 0% (pre-1928) rate yields exactly 0 interest.
  function refBucket(spend, rf) {
    var m = Math.pow(1 + rf, 1 / 12) - 1, B = spend;
    for (var k = 0; k < 12; k++) { B -= spend / 12; B *= (1 + m); } // start-of-month draw, then grow
    return B;
  }
  assert(core.bucketInterest(50000, 0) === 0, "bucketInterest: 0% rate => 0 interest");
  assert(core.bucketInterest(0, 0.05) === 0, "bucketInterest: $0 spend => 0 interest");
  [0.01, 0.05, 0.1404].forEach(function (rf) {
    assert(near(core.bucketInterest(50000, rf), refBucket(50000, rf), 1e-6),
      "bucketInterest closed form == 12-step loop (rf=" + (rf * 100).toFixed(2) + "%)");
  });
  assert(core.bucketInterest(50000, 0.05) > 0 && core.bucketInterest(50000, 0.05) < 50000 * 0.05,
    "bucketInterest is positive but < a full year at the rate (drained over the year)");

  // (b) With a 0% T-bill series, monthly mode is byte-identical to annual (the
  // annual path must be untouched by this feature).
  var dataNoCash = Object.assign({}, data, { cash: data.years.map(function () { return 0; }) });
  var aZero = core.runHistorical(P({ spending: { strategy: "percent", percent: 0.04 } }), dataNoCash);
  var mZero = core.runHistorical(P({ spending: { strategy: "percent", percent: 0.04, monthly: true } }), dataNoCash);
  assert(mZero.endingReal.median === aZero.endingReal.median &&
         mZero.endingReal.mean === aZero.endingReal.mean &&
         mZero.successRate === aZero.successRate,
    "monthly @0% T-bill is identical to annual");

  // (c) With the real (positive) T-bill history, monthly ends strictly ahead --
  // the spending bucket earns risk-free interest the annual lump never did.
  var aReal = core.runHistorical(P({ spending: { strategy: "percent", percent: 0.045 } }), data);
  var mReal = core.runHistorical(P({ spending: { strategy: "percent", percent: 0.045, monthly: true } }), data);
  console.log("percent 4.5% monthly vs annual: meanRealEnd $" + Math.round(aReal.endingReal.mean) +
    " -> $" + Math.round(mReal.endingReal.mean));
  assert(mReal.endingReal.mean > aReal.endingReal.mean, "monthly ending > annual (T-bill tailwind)");
  assert(mReal.successRate >= aReal.successRate, "monthly success >= annual (never worse)");

  // (d) The guardrail solver still meets its target with monthly mode on
  // (monotonicity preserved: net draw = spend - interest, still rising in spend).
  var gM = core.solveGuardrail(P({ spending: { strategy: "percent", percent: 0.03, ceiling: 60000, monthly: true } }),
    data, { solveFor: "floor", target: 0.95 });
  assert(gM.feasible, "guardrail floor solve works with monthly mode on");
  var atGM = core.runHistorical(P({ spending: { strategy: "percent", percent: 0.03, ceiling: 60000, floor: gM.value, monthly: true } }), data).successRate;
  assert(atGM >= 0.95 - 1e-9, "monthly guardrail solve meets its 95% target (" + (atGM * 100).toFixed(1) + "%)");

  // (e) Monte Carlo carries the T-bill rate: deterministic with a fixed seed, and
  // (same seed => identical return/inflation draws) monthly ends ahead of annual.
  if (self.SWR.mc) {
    var mcA = self.SWR.mc.run(P({ spending: { strategy: "percent", percent: 0.045 } }), data, { method: "bootstrap", trials: 2000, seed: 5 });
    var mcM = self.SWR.mc.run(P({ spending: { strategy: "percent", percent: 0.045, monthly: true } }), data, { method: "bootstrap", trials: 2000, seed: 5 });
    var mcM2 = self.SWR.mc.run(P({ spending: { strategy: "percent", percent: 0.045, monthly: true } }), data, { method: "bootstrap", trials: 2000, seed: 5 });
    assert(mcM.endingReal.mean === mcM2.endingReal.mean, "MC monthly deterministic with a fixed seed");
    assert(mcM.endingReal.mean > mcA.endingReal.mean, "MC monthly ending > annual (same draws + T-bill interest)");
    var mcP = self.SWR.mc.run(P({ spending: { strategy: "percent", percent: 0.045, monthly: true } }), data, { method: "parametric", trials: 1000, seed: 3 });
    assert(mcP.successRate >= 0 && mcP.successRate <= 1, "MC parametric monthly runs (mean-rate bucket)");
  }
})();

// 7) Social Security inflow lifts success vs. none.
var rss = H({
  spending: { strategy: "constant", initial: 60000 },
  incomes: [{ amount: 25000, start: 1, end: 30, cola: true }],
});
var rno = H({ spending: { strategy: "constant", initial: 60000 } });
assert(rss.successRate > rno.successRate, "income raises success (" +
  (rno.successRate * 100).toFixed(0) + "% -> " + (rss.successRate * 100).toFixed(0) + "%)");

// 8) Fees lower success.
assert(H({ feeRate: 0.01 }).successRate <= r.successRate, "fees <= no fees");

// 9) Stats primitives.
var a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
assert(near(stats.percentileSorted(a, 50), 5.5, 1e-9), "median 1..10 = 5.5");
assert(near(stats.mean(a), 5.5, 1e-9), "mean 1..10 = 5.5");

// 10) Monte Carlo: runs, reproducible, and plausible vs. the historical 95.7%.
var mc = self.SWR.mc;
if (mc) {
  var m1 = mc.run(P(), data, { method: "bootstrap", trials: 3000, seed: 42 });
  var m2 = mc.run(P(), data, { method: "bootstrap", trials: 3000, seed: 42 });
  console.log("MC bootstrap 4%/30yr: success=" + (m1.successRate * 100).toFixed(1) +
    "% (trials=" + m1.trials + ", sampling ret mean=" +
    (m1.sampling.retMean * 100).toFixed(1) + "% sd=" + (m1.sampling.retStdev * 100).toFixed(1) + "%)");
  assert(m1.successRate === m2.successRate, "MC reproducible with same seed");
  assert(m1.successRate > 0.5 && m1.successRate < 1.0, "MC bootstrap success plausible");
  assert(m1.bands.median.length === 31, "MC fan has N+1 points");
  assert(m1.bandsReal && m1.bandsReal.median.length === 31, "MC real fan present");
  assert(m1.bandsReal.median[30] < m1.bands.median[30], "real end < nominal end (inflation deflates)");
  assert(m1.sampleSeries[0].realSeries != null, "sample cycles carry real series");
  var mp = mc.run(P(), data, { method: "parametric", trials: 3000, seed: 7 });
  console.log("MC parametric 4%/30yr: success=" + (mp.successRate * 100).toFixed(1) + "%");
  assert(mp.successRate > 0.4 && mp.successRate <= 1.0, "MC parametric plausible");
  var mb = mc.run(P(), data, { method: "block", trials: 3000, seed: 7, block: 5 });
  console.log("MC block(5) 4%/30yr: success=" + (mb.successRate * 100).toFixed(1) + "%");
  assert(mb.successRate > 0.4 && mb.successRate <= 1.0, "MC block plausible");
}

// 11) Mortality (SSA life table) + Rich/Broke/Dead inputs.
if (self.SWR.mortality && self.SWR_MORTALITY) {
  var surv = self.SWR.mortality.survivalCurve(65, "female", 30);
  var survM = self.SWR.mortality.survivalCurve(65, "male", 30);
  console.log("survival 65->90: female=" + (surv[25] * 100).toFixed(0) + "% male=" + (survM[25] * 100).toFixed(0) + "%");
  assert(surv.length === 31 && surv[0] === 1, "survival curve length N+1, starts at 1");
  assert(surv[30] > 0 && surv[30] < surv[10], "survival decreases with age");
  assert(surv[25] > survM[25], "women outlive men (survival to 90)");
  var le = self.SWR.mortality.lifeExpectancy(65, "female");
  assert(le > 18 && le < 24, "female life expectancy at 65 ~21 (" + le.toFixed(1) + ")");
}
var rb = H();
assert(rb.brokeByYear && rb.brokeByYear.length === 31, "brokeByYear length N+1");
assert(rb.brokeByYear[0] === 0, "nobody broke at year 0");
assert(Math.abs(rb.brokeByYear[30] - (1 - rb.successRate)) < 1e-9, "brokeByYear[N] == 1 - successRate");
assert(rb.brokeByYear[30] >= rb.brokeByYear[15], "brokeByYear non-decreasing");

// 12) Amortization.
if (self.SWR.amortize) {
  var am = self.SWR.amortize.schedule({ principal: 300000, apr: 6, months: 360 });
  console.log("loan 300k/6%/30yr: payment=$" + am.payment.toFixed(2) + " interest=$" + Math.round(am.totalInterest));
  assert(Math.abs(am.payment - 1798.65) < 1, "mortgage payment matches the amortization formula");
  assert(am.payoffMonths === 360 && Math.abs(am.rows[am.rows.length - 1].balance) < 0.01, "pays off to $0 over the term");
  assert(am.totalInterest > 340000 && am.totalInterest < 360000, "total interest plausible");
  var am2 = self.SWR.amortize.schedule({ principal: 300000, apr: 6, months: 360, extra: 200 });
  assert(am2.payoffMonths < 360 && am2.totalInterest < am.totalInterest, "extra payments save time + interest");
  assert(Math.abs(self.SWR.amortize.schedule({ principal: 12000, apr: 0, months: 12 }).payment - 1000) < 1e-6, "0% loan = principal/months");
  assert(self.SWR.amortize.schedule({ principal: 1e9, apr: 5, months: 9999999 }).rows.length <= self.SWR.amortize.MAX_MONTHS, "loan term hard-capped (no hang)");
}

// 13) Spending breakdown (real / today's $).
assert(rb.spending && rb.spending.annual, "summary exposes spending stats");
assert(Math.abs(rb.spending.firstYear - 40000) < 1, "first-year real spend = initial $40k");
assert(Math.abs(rb.spending.annual.p10 - rb.spending.annual.p90) < 1, "constant strategy: real spending is flat");
var rpAnn = H({ spending: { strategy: "percent", percent: 0.04 } }).spending.annual;
console.log("constant spend flat @ $" + Math.round(rb.spending.annual.median) +
  "; percent-of-portfolio range $" + Math.round(rpAnn.p10) + "-$" + Math.round(rpAnn.p90));
assert(rpAnn.p90 - rpAnn.p10 > 5000, "percent-of-portfolio spending varies year to year");
assert(rpAnn.min <= rpAnn.median && rpAnn.median <= rpAnn.max, "spending percentiles ordered");

// 14) Log-scaled ending-balance histogram (fixes the right-skew clustering).
if (core.histogramLog) {
  var lv = [];
  for (var li = 0; li < 60; li++) lv.push(0);               // failures -> first bin
  for (var li = 0; li < 900; li++) lv.push(3e5 + li * 5e4); // $300k .. $45.25M body
  lv.push(8e8);                                             // lone huge survivor (long tail)
  lv.sort(function (a, b) { return a - b; });
  var hl = core.histogramLog(lv, 24);
  var hsum = 0; for (var li = 0; li < hl.counts.length; li++) hsum += hl.counts[li];
  assert(hsum === lv.length, "log hist counts sum to N (" + hsum + "/" + lv.length + ")");
  assert(hl.log === true && hl.edges.length === 25 && hl.edges[0] === 0, "log hist exposes edges[nbins+1], edges[0]=0");
  assert(hl.max === 8e8, "log hist max = largest value");
  assert(hl.loEdge === Math.max(3e5, 8e8 * 1e-4), "loEdge = max(minPositive, hi*1e-4)");
  var inc = true; for (var li = 1; li < hl.edges.length; li++) if (!(hl.edges[li] > hl.edges[li - 1])) inc = false;
  assert(inc, "log hist edges strictly increasing (equal-ratio bins)");
  var nonEmpty = 0; for (var li = 0; li < hl.counts.length; li++) if (hl.counts[li] > 0) nonEmpty++;
  console.log("log hist: " + nonEmpty + "/24 bins populated, loEdge=$" + Math.round(hl.loEdge) + ", max=$" + Math.round(hl.max));
  assert(nonEmpty >= 4, "log bins spread the body across >=4 bars (got " + nonEmpty + ", vs ~1-2 for linear)");
  assert(hl.counts[0] >= 60, "first bin captures the $0 failures (" + hl.counts[0] + ")");
  // A single near-zero survivor must not stretch the axis to absurd width.
  var lv2 = [0, 0, 1, 8e8]; lv2.sort(function (a, b) { return a - b; });
  assert(Math.abs(core.histogramLog(lv2, 24).loEdge - 8e8 * 1e-4) < 1, "near-zero survivor: loEdge capped to hi*1e-4");
}

// 15) CAPE-based (Big ERN) dynamic withdrawal rule: WR = a + b / CAPE.
assert(self.SWR_CAPE && Array.isArray(self.SWR_CAPE.capeAnnual), "cape-data loaded (SWR_CAPE.capeAnnual)");
assert(data.cape && data.cape.length === data.years.length, "cape series attached to SWR_DATA, aligned to years");
assert(Math.abs(core.capeRate(0.015, 0.5, 30) - (0.015 + 0.5 / 30)) < 1e-12, "capeRate = a + b/CAPE (3.17% at CAPE 30)");
assert(core.capeRate(0.015, 0.5, 0) === 0.015, "capeRate falls back to intercept when CAPE invalid");
{
  var capeSp = { strategy: "cape", capeA: 0.015, capeB: 0.5, cape0: self.SWR_CAPE.latest.betterCape };
  var rc = H({ spending: capeSp });
  console.log("CAPE rule 75/25 30yr: success=" + (rc.successRate * 100).toFixed(1) + "%, start=" +
    rc.startYears.first + ", firstSpend=$" + Math.round(rc.spending.firstYear));
  // Floorless CAPE rule can never deplete (spends a fraction of the balance), like %-of-portfolio.
  assert(rc.successRate === 1, "floorless CAPE rule never fails (" + (rc.successRate * 100).toFixed(0) + "%)");
  // Backtest starts where the CAPE series does: Jan-1881, Shiller's own first month.
  assert(rc.startYears.first === 1881, "CAPE backtest starts 1881 (" + rc.startYears.first + ")");
  // Look-ahead regression: capeAnnual must hold START-of-year (January) values. If
  // sampling ever regresses to year-END, 1929 turns post-crash (~22) and 2000
  // drops off its January peak (~37) -- both leak the future into the backtest.
  var iy = function (y) { return data.years.indexOf(y); };
  assert(data.cape[iy(1929)] > 24 && data.cape[iy(1929)] < 30,
    "1929 CAPE is the pre-crash January value (" + data.cape[iy(1929)] + ")");
  assert(data.cape[iy(2000)] > 40,
    "2000 CAPE is the January dot-com peak (" + data.cape[iy(2000)] + ")");
  // Spending swings with valuation year to year (unlike constant dollar).
  assert(rc.spending.annual.p90 - rc.spending.annual.p10 > 3000, "CAPE spending varies year to year");
  // Downside must be visible: a rough retirement's leanest year sits well below the typical one.
  assert(rc.spending.leanestYear.p10 < rc.spending.leanestYear.median * 0.9,
    "CAPE rough-case leanest year (p10) is well below the typical leanest year");
  assert(rc.spending.annual.min < rc.spending.firstYear,
    "CAPE min single-year spend drops below the first year (fluctuates with downturns)");
  // A high real floor CAN break the plan -> ruin registers (not silently clamped).
  var rcFloor = H({ initialValue: 500000, spending: { strategy: "cape", capeA: 0.015, capeB: 0.5, cape0: 35, floor: 60000 } });
  assert(rcFloor.successRate < 1, "CAPE rule with too-high floor can fail (" + (rcFloor.successRate * 100).toFixed(0) + "%)");
  // Forward (MC) mode uses cape0 as the starting valuation: higher CAPE (richer)
  // => lower withdrawal rate => lower first-year spend. (Historical mode instead
  // uses each start year's ACTUAL CAPE, so cape0 doesn't move its first-year spend.)
  var loCape = self.SWR.mc.run(P({ spending: { strategy: "cape", capeA: 0.015, capeB: 0.5, cape0: 15 } }), data, { trials: 200, seed: 3 }).spending.firstYear;
  var hiCape = self.SWR.mc.run(P({ spending: { strategy: "cape", capeA: 0.015, capeB: 0.5, cape0: 45 } }), data, { trials: 200, seed: 3 }).spending.firstYear;
  assert(loCape > hiCape, "forward: lower starting CAPE => higher first-year spend (" + Math.round(loCape) + " vs " + Math.round(hiCape) + ")");
  // Monte Carlo path (no CAPE series) evolves a synthetic CAPE and runs without error.
  var mcCape = self.SWR.mc.run(P({ spending: capeSp }), data, { trials: 500, seed: 7 });
  assert(mcCape.successRate >= 0 && mcCape.successRate <= 1 && mcCape.spending, "MC CAPE path runs & summarizes");
  assert(mcCape.spending.annual.p90 - mcCape.spending.annual.p10 > 1000, "MC CAPE spending varies (synthetic CAPE evolves)");
  // First-year spread: historical cycles each read their OWN start-year CAPE, so
  // year-1 spending is a range; Monte Carlo always starts from cape0, so it isn't.
  assert(rc.spending.firstYearMax > rc.spending.firstYearMin + 1000,
    "historical CAPE: first-year spend varies by start year ($" + Math.round(rc.spending.firstYearMin) +
    " – $" + Math.round(rc.spending.firstYearMax) + ")");
  assert(Math.abs(mcCape.spending.firstYearMax - mcCape.spending.firstYearMin) < 1,
    "MC CAPE: every trial has the same first-year spend (starts at cape0)");
  // A spending ceiling caps the high-spend (cheap-market) start years at exactly
  // the ceiling while richer start years stay below it (the user's $50k scenario).
  var rcCeil = H({ initialValue: 1500000, years: 45,
    spending: { strategy: "cape", capeA: 0.01, capeB: 0.5, cape0: 36, ceiling: 50000 } });
  assert(Math.abs(rcCeil.spending.firstYearMax - 50000) < 1, "ceiling caps year-1 in cheap-market cycles at $50k");
  assert(rcCeil.spending.firstYearMin < 45000, "expensive start years spend under the cap (" +
    Math.round(rcCeil.spending.firstYearMin) + ")");
}

// 16) Withdrawal-timing math: VPW annuity-due factor + tax gross-up semantics.
{
  // VPW with returns exactly equal to the assumed rate must produce the textbook
  // annuity-DUE payment (withdrawals at the START of each year) every year, and
  // amortize to exactly $0 -- the defining property of the PMT(r,n,B,0,1) factor.
  var r5 = 0.05, N5 = 5;
  var pv = P({ years: N5, spending: { strategy: "vpw", vpwReturn: r5 } });
  var cvpw = core.simulateCycle(pv, { __port: [r5, r5, r5, r5, r5] }, [0, 0, 0, 0, 0]);
  var pmtDue = 1000000 * r5 / ((1 - Math.pow(1 + r5, -N5)) * (1 + r5)); // $219,975.7/yr
  var vpwConst = true;
  for (var vi = 0; vi < N5; vi++) if (Math.abs(cvpw.realWithdrawals[vi] - pmtDue) > 0.01) vpwConst = false;
  console.log("VPW due-PMT: withdrawals $" + cvpw.realWithdrawals[0].toFixed(2) + " (want $" + pmtDue.toFixed(2) + "), end=$" + cvpw.endValue.toFixed(4));
  assert(vpwConst, "VPW pays the annuity-due PMT every year when returns match the assumed rate");
  assert(Math.abs(cvpw.endValue) < 0.01, "VPW amortizes to exactly $0 in the final year");

  // Tax gross-up: netting $30k under a 25% effective tax on the gross withdrawal
  // requires drawing 30000/(1-0.25) = $40k -- so it must match a $40k no-tax plan
  // exactly, year for year (fees are 0 in P()).
  var tA = H({ taxRate: 0.25, spending: { strategy: "constant", initial: 30000 } });
  var tB = H({ spending: { strategy: "constant", initial: 40000 } });
  assert(tA.successRate === tB.successRate, "tax gross-up: 30k net @ 25% == 40k gross @ 0% (success)");
  assert(Math.abs(tA.endingReal.median - tB.endingReal.median) < 1e-6, "tax gross-up: identical balance paths");
}

// 17) Compound interest (closed-form future value).
if (self.SWR.compound) {
  var G = self.SWR.compound.grow;
  // Screenshot anchor (classic calculator): $1,500 @ 5%, 5 yrs, annual compounding -> $1,914.42.
  var c1 = G({ principal: 1500, annual: 0, years: 5, rate: 0.05, times: 1, timing: "start" });
  console.log("compound $1500 @5% 5yr annual: FV=$" + c1.fv.toFixed(2));
  assert(Math.abs(c1.fv - 1914.42) < 0.005, "FV matches the classic calculator ($" + c1.fv.toFixed(2) + " vs $1,914.42)");
  assert(Math.abs(G({ principal: 1500, annual: 0, years: 5, rate: 0.05, times: 1, timing: "end" }).fv - c1.fv) < 1e-9,
    "timing irrelevant when additions are $0");
  // Textbook annuity anchor: $100/mo ($1,200/yr over 12 periods) @6%/12 for 10 yrs.
  var cEnd = G({ principal: 0, annual: 1200, years: 10, rate: 0.06, times: 12, timing: "end" });
  var cStart = G({ principal: 0, annual: 1200, years: 10, rate: 0.06, times: 12, timing: "start" });
  assert(Math.abs(cEnd.fv - 16387.93) < 0.02, "ordinary annuity: $100/mo @6% 10yr = $16,387.93 (" + cEnd.fv.toFixed(2) + ")");
  assert(Math.abs(cStart.fv - 16469.87) < 0.02, "annuity due = ordinary x (1+i) (" + cStart.fv.toFixed(2) + ")");
  // 0% rate degenerates to plain accumulation.
  assert(G({ principal: 500, annual: 100, years: 8, rate: 0, times: 12, timing: "end" }).fv === 500 + 800,
    "0% rate: FV = principal + total additions");
  // Series + accounting identity.
  assert(c1.series.length === 6 && c1.series[0].balance === 1500, "series has years+1 points, starts at principal");
  assert(Math.abs(cEnd.fv - (cEnd.contributed + cEnd.interest)) < 1e-9, "fv = contributed + interest");
  var mono = true;
  for (var ci = 1; ci < cEnd.series.length; ci++) if (cEnd.series[ci].balance <= cEnd.series[ci - 1].balance) mono = false;
  assert(mono, "balance strictly grows with positive rate + additions");
  // Hostile inputs are clamped, never NaN/Infinity/hang.
  var cH = G({ principal: Infinity, annual: NaN, years: 1e9, rate: 999, times: 1e9, timing: "x" });
  assert(isFinite(cH.fv) && cH.years <= 200 && cH.times <= 365 && cH.rate <= 1,
    "hostile inputs clamped (years=" + cH.years + ", times=" + cH.times + ", fv finite=" + isFinite(cH.fv) + ")");
}

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
if (fail > 0) throw new Error(fail + " test(s) failed");
