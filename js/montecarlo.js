/*
 * montecarlo.js -- Monte Carlo engine (pure, DOM-free; runs in the Worker too).
 *
 * Because the portfolio is rebalanced annually, each year's portfolio return is
 * the allocation-weighted sum of the asset returns. So every method below only
 * needs to produce a (portfolioReturn, inflation) pair per year -- which keeps
 * the important return<->inflation relationship intact and is exact for our
 * annually-rebalanced model.
 *
 * Methods:
 *   bootstrap   -- resample whole historical years at random (IID). Preserves
 *                  the real cross-asset/inflation co-movement of each year.
 *   block       -- circular block bootstrap: resample runs of consecutive years
 *                  so sequence-of-returns risk (bad streaks) is preserved.
 *   parametric  -- draw from a bivariate normal fit to history (portfolio return
 *                  & inflation, with their covariance). Smooth, but assumes
 *                  normal, serially-independent years.
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});
  const core = SWR.core, stats = SWR.stats;

  const METHODS = ["bootstrap", "block", "parametric"];

  // Allocation-weighted portfolio return for every historical year that has
  // data for all allocated assets (mirrors the historical engine's range). Also
  // carries that year's 3-month T-bill rate (csh) in lock-step, for the monthly
  // percentage strategy's cash bucket; null (pre-1928) coerces to 0.
  function portfolioReturns(p, data) {
    const startOff = core.validStartOffset(p, data);
    const Y = data.years.length;
    const pr = [], inf = [], csh = [];
    for (let j = startOff; j < Y; j++) {
      pr.push(core.weightedReturn(p.allocation, data, j));
      inf.push(data.inflation[j]);
      csh.push(data.cash && data.cash[j] > 0 ? data.cash[j] : 0);
    }
    return { pr, inf, csh };
  }

  // Samplers optionally fill a third array (outCsh) with each resampled year's
  // T-bill rate; when it's omitted (annual mode) the pr/inf output is identical.
  function makeBootstrap(pr, inf, csh, rng, N) {
    const Y = pr.length;
    return function (outPr, outInf, outCsh) {
      for (let i = 0; i < N; i++) {
        const j = (rng() * Y) | 0;
        outPr[i] = pr[j];
        outInf[i] = inf[j];
        if (outCsh) outCsh[i] = csh[j];
      }
    };
  }

  function makeBlock(pr, inf, csh, rng, N, block) {
    const Y = pr.length;
    block = Math.max(1, block | 0);
    return function (outPr, outInf, outCsh) {
      let i = 0;
      while (i < N) {
        const j = (rng() * Y) | 0;
        for (let b = 0; b < block && i < N; b++, i++) {
          const k = (j + b) % Y; // wrap (circular block bootstrap)
          outPr[i] = pr[k];
          outInf[i] = inf[k];
          if (outCsh) outCsh[i] = csh[k];
        }
      }
    };
  }

  function makeParametric(pr, inf, csh, rng) {
    // The bivariate normal models only (return, inflation); the T-bill rate has
    // no natural fit here, so the bucket uses the long-run mean rate as a constant.
    const mc = stats.mean(csh);
    const mp = stats.mean(pr), mi = stats.mean(inf);
    const vp = stats.variance(pr, mp), vi = stats.variance(inf, mi);
    const n = pr.length;
    let c = 0;
    for (let k = 0; k < n; k++) c += (pr[k] - mp) * (inf[k] - mi);
    c = n > 1 ? c / (n - 1) : 0;
    // 2x2 Cholesky of [[vp, c],[c, vi]].
    const l11 = Math.sqrt(Math.max(vp, 1e-12));
    const l21 = c / (l11 || 1e-12);
    const l22 = Math.sqrt(Math.max(vi - l21 * l21, 1e-12));
    return function (outPr, outInf, outCsh) {
      for (let i = 0; i < outPr.length; i++) {
        const z1 = stats.normal(rng), z2 = stats.normal(rng);
        outPr[i] = Math.max(-0.95, mp + l11 * z1); // can't lose >95% in a year
        outInf[i] = mi + l21 * z1 + l22 * z2;
        if (outCsh) outCsh[i] = mc;
      }
    };
  }

  // Summary stats of the per-method sampling distribution (shown in the UI).
  function methodStats(pr, inf) {
    return {
      retMean: stats.mean(pr), retStdev: stats.stdev(pr),
      inflMean: stats.mean(inf), inflStdev: stats.stdev(inf),
    };
  }

  function run(p, data, opts) {
    opts = opts || {};
    // Hard cap independent of any caller: bounds compute time and the memory
    // held by the trial set, so no input can exhaust the browser.
    const trials = Math.min(50000, Math.max(1, opts.trials || 10000));
    const method = METHODS.indexOf(opts.method) >= 0 ? opts.method : "bootstrap";
    const N = p.years;
    const { pr, inf, csh } = portfolioReturns(p, data);
    const rng = stats.mulberry32(opts.seed != null ? (opts.seed | 0) : 0x9e3779b9);
    const onProgress = opts.onProgress;
    // Only the monthly percentage strategy needs the per-year T-bill rate; every
    // other run leaves outCsh null so the sampler's pr/inf output is unchanged.
    const needTbill = p.spending.strategy === "percent" && !!p.spending.monthly;

    let sample;
    if (method === "parametric") sample = makeParametric(pr, inf, csh, rng);
    else if (method === "block") sample = makeBlock(pr, inf, csh, rng, N, opts.block || 5);
    else sample = makeBootstrap(pr, inf, csh, rng, N);

    // Fast path for the spending solver: only the success rate is needed, so
    // skip retaining trajectories and computing percentile bands/histograms.
    if (opts.successOnly) {
      const ro = { __port: null, __tbill: null }, oPr = new Array(N), oInf = new Array(N);
      const oCsh = needTbill ? new Array(N) : null;
      let succ = 0;
      for (let t = 0; t < trials; t++) {
        sample(oPr, oInf, oCsh);
        ro.__port = oPr;
        ro.__tbill = oCsh;
        if (core.simulateCycle(p, ro, oInf).success) succ++;
      }
      return { successRate: trials ? succ / trials : 0, total: trials };
    }

    const cycles = new Array(trials);
    const retObj = { __port: null, __tbill: null };
    const outPr = new Array(N), outInf = new Array(N);
    const outCsh = needTbill ? new Array(N) : null;
    for (let t = 0; t < trials; t++) {
      sample(outPr, outInf, outCsh);
      retObj.__port = outPr;
      retObj.__tbill = outCsh;
      cycles[t] = core.simulateCycle(p, retObj, outInf);
      if (onProgress && (t & 2047) === 0) onProgress(t / trials);
    }
    if (onProgress) onProgress(1);

    const sum = core.summarize(p, cycles, {
      mode: "montecarlo", keepSeries: opts.keepSeries || 250,
    });
    sum.method = method;
    sum.trials = trials;
    sum.sampling = methodStats(pr, inf);
    return sum;
  }

  SWR.mc = { METHODS, run, portfolioReturns, methodStats };
})(typeof self !== "undefined" ? self : this);
