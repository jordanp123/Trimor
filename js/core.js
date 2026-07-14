/*
 * core.js -- the retirement simulation engine (pure, DOM-free).
 *
 * Model (matches cFIREsim's conventions):
 *   - Annual time steps. One calendar year = one step.
 *   - Start-of-year withdrawal: spending + fees are removed first, THEN the
 *     remaining balance earns that year's market return.
 *   - Annual rebalance to the target allocation, modeled as a single
 *     allocation-weighted return per year.
 *   - Spending grows with inflation (historical CPI or a fixed rate).
 *   - A cycle "fails" the first year the balance is exhausted.
 *
 * Returns are NOMINAL total returns (decimals). Real (today's-dollars) values
 * are derived by dividing by the cumulative inflation of the cycle.
 *
 * Shared by the main thread and the Web Worker via the global SWR namespace.
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});
  const stats = SWR.stats;

  // Asset classes the engine understands (must match keys in market-data.js).
  const ASSETS = ["stocks", "bonds", "cash", "gold", "corp", "reit", "smallcap"];

  // Assumed long-run REAL earnings growth, used only to evolve a synthetic CAPE
  // path in forward (Monte Carlo) mode for the CAPE-based withdrawal rule.
  const CAPE_REAL_GROWTH = 0.015;

  // Withdrawal rate for the CAPE (Big ERN) rule: a + b * (1/CAPE), where 1/CAPE is
  // the cyclically-adjusted earnings yield (CAEY). Exposed for the UI's current-
  // rate readout and for tests. Defaults a=1.5%, b=0.5 come from ERN's SWR series.
  function capeRate(a, b, cape) {
    return cape > 0 ? a + b / cape : a;
  }

  // Allocation-weighted nominal return for year-index t. Renormalizes over the
  // assets that actually have data so a missing series can't silently zero out.
  function weightedReturn(alloc, ret, t) {
    let r = 0, w = 0;
    for (const k in alloc) {
      const a = alloc[k];
      if (!a) continue;
      const series = ret[k];
      if (!series) continue;
      const rr = series[t];
      if (rr == null || isNaN(rr)) continue;
      r += a * rr;
      w += a;
    }
    return w > 0 ? r / w : 0;
  }

  // Extra cash flows for retirement-year i (0-based). Income (Social Security,
  // pensions, part-time work) reduces the portfolio draw; expenses increase it.
  // Events are specified in 1-based retirement years; `cola` toggles inflation.
  function flows(p, i, cumInfl) {
    let income = 0, expense = 0;
    const ry = i + 1; // 1-based retirement year
    const inc = p.incomes || [];
    for (let k = 0; k < inc.length; k++) {
      const f = inc[k];
      if (ry >= f.start && ry <= f.end) income += f.amount * (f.cola ? cumInfl : 1);
    }
    const adj = p.adjustments || [];
    for (let k = 0; k < adj.length; k++) {
      const a = adj[k];
      if (ry >= a.start && ry <= a.end) {
        const amt = a.amount * (a.cola ? cumInfl : 1);
        if (a.kind === "income") income += amt;
        else expense += amt;
      }
    }
    return { income, expense };
  }

  // Clamp a withdrawal to optional real floor/ceiling (expressed in today's $).
  function clampSpend(x, sp, cumInfl) {
    if (sp.floor != null) x = Math.max(x, sp.floor * cumInfl);
    if (sp.ceiling != null) x = Math.min(x, sp.ceiling * cumInfl);
    return x;
  }

  // Monthly-withdrawal mode (percentage strategy only): the year's spending is
  // parked in a risk-free 3-month T-bill account each January and drawn down in
  // 12 equal monthly installments (withdrawn at the START of each month), so it
  // earns a little interest instead of nothing. Returns the accrued interest --
  // the account's leftover after 12 draws -- as a closed form of that drawdown
  // (no monthly loop). `rf` is the year's annual T-bill rate; 0 (or null, pre-
  // 1928 when T-bills didn't exist) yields exactly 0 interest.
  function bucketInterest(spend, rf) {
    if (!(rf > 0) || !(spend > 0)) return 0;
    const m = Math.pow(1 + rf, 1 / 12) - 1; // equivalent monthly rate
    return spend * (1 + rf) - (spend / 12) * (1 + m) * (rf / m);
  }

  /*
   * Simulate ONE cycle. `ret` is {asset:[N]} nominal returns, `infl` is [N].
   * Returns { series:[N+1], endValue, endValueReal, success, failedYear,
   *           inflationFactor, withdrawals:[N] (nominal) }.
   */
  function simulateCycle(p, ret, infl, cape) {
    const N = p.years;
    const sp = p.spending;
    const alloc = p.allocation;
    const feeRate = p.feeRate || 0;
    const taxRate = p.taxRate || 0;
    const initRate = p.initialValue > 0 ? sp.initial / p.initialValue : 0;
    // Monthly percentage mode: ret.__tbill carries this cycle's T-bill rate per
    // year (null pre-1928). Off for every other strategy and for annual mode.
    const monthly = sp.strategy === "percent" && !!sp.monthly;
    const tbill = ret.__tbill || null;

    let port = p.initialValue;
    let cumInfl = 1; // cumulative inflation at the START of the current year
    let gkW = sp.initial; // running nominal withdrawal for Guyton-Klinger
    let prevReturn = null;
    // CAPE rule: use the real historical CAPE for each year when a series is
    // supplied (backtest); otherwise evolve a synthetic CAPE forward (Monte Carlo).
    let capeRun = sp.cape0 > 0 ? sp.cape0 : 20;

    const series = new Array(N + 1);     // nominal balance at each year boundary
    const realSeries = new Array(N + 1); // same, deflated to year-0 dollars
    series[0] = realSeries[0] = port;
    const realWithdrawals = new Array(N).fill(0); // gross spending each year, in year-0 dollars
    let failed = -1;

    for (let i = 0; i < N; i++) {
      // Monte Carlo passes a precomputed portfolio-return array (__port); the
      // historical path passes per-asset series and we weight them here.
      const r = ret.__port ? ret.__port[i] : weightedReturn(alloc, ret, i);

      // 1) Desired gross spending for the year (nominal), by strategy.
      let spend;
      switch (sp.strategy) {
        case "percent": {
          spend = clampSpend(sp.percent * port, sp, cumInfl);
          break;
        }
        case "vpw": {
          // Annuity-due PMT factor (withdrawals at the START of each year -- this
          // engine's convention and canonical VPW's: PMT(r, n, balance, 0, 1)).
          // The ordinary-annuity factor r/(1-(1+r)^-n) assumes END-of-year payments
          // and over-draws by (1+r); dividing by (1+r) makes the final year's
          // factor exactly 1, spending the last dollar by design.
          const yrsLeft = N - i;
          const rr = sp.vpwReturn || 0;
          const factor = rr === 0 ? 1 / yrsLeft : rr / ((1 - Math.pow(1 + rr, -yrsLeft)) * (1 + rr));
          spend = clampSpend(factor * port, sp, cumInfl);
          break;
        }
        case "cape": {
          // Big ERN dynamic rule: withdrawal rate = a + b / CAPE. In backtests
          // that's the START-of-year CAPE for this calendar year (observable when
          // the withdrawal is made); forward, it's the evolving synthetic one.
          let cv = cape ? cape[i] : capeRun;
          if (!(cv > 0)) cv = capeRun; // data gap: reuse the last known valuation
          capeRun = cv;
          spend = clampSpend(Math.max(0, capeRate(sp.capeA, sp.capeB, cv)) * port, sp, cumInfl);
          break;
        }
        case "guyton": {
          if (i === 0) {
            gkW = sp.initial;
          } else {
            const guard = sp.guard != null ? sp.guard : 0.2;
            const adj = sp.gkAdjust != null ? sp.gkAdjust : 0.1;
            const wr = gkW / port;
            // Modified Withdrawal/Inflation rule: skip the inflation raise after a
            // down market year IF the current withdrawal rate exceeds the initial.
            if (!(prevReturn < 0 && wr > initRate)) gkW *= 1 + infl[i - 1];
            // Capital-Preservation guardrail (suspended in the final 15 years).
            if (N - i > 15 && gkW / port > initRate * (1 + guard)) gkW *= 1 - adj;
            // Prosperity guardrail.
            else if (gkW / port < initRate * (1 - guard)) gkW *= 1 + adj;
          }
          spend = clampSpend(gkW, sp, cumInfl);
          break;
        }
        default: {
          // "constant": inflation-adjusted fixed real spending.
          spend = sp.initial * cumInfl;
        }
      }

      // VPW amortizes the balance down to ~$0 in the final year by design, and a
      // floorLESS percentage strategy is inherently self-limiting (you only ever
      // spend a fraction of what you still hold), so cap those at the balance --
      // reaching $0 there is plan completion, not ruin. A percentage strategy
      // WITH a floor can demand more than the balance holds in a bad sequence;
      // that is a genuine failure to fund the floor, so leave it unclamped and
      // let the need>port test below register the ruin (otherwise a $0-fee plan
      // would silently coast at $0 instead of failing).
      if (sp.strategy === "vpw" ||
          ((sp.strategy === "percent" || sp.strategy === "cape") && sp.floor == null)) {
        spend = Math.min(spend, port);
      }

      // 2) Net the extra cash flows, then draw from the portfolio.
      const f = flows(p, i, cumInfl);
      let draw = spend + f.expense - f.income; // negative => surplus reinvested
      // Effective tax on withdrawals: to NET `draw` dollars when a share t of the
      // GROSS withdrawal goes to tax, you must withdraw draw/(1-t). (The previous
      // draw*(1+t) treated t as a share of the net and understated the gross-up.)
      if (taxRate > 0 && draw > 0) draw /= 1 - Math.min(taxRate, 0.95);
      const fee = port * feeRate;
      const need = draw + fee;
      realWithdrawals[i] = spend / cumInfl; // cumInfl is the deflator at the start of year i

      if (need > port) {
        // Can't cover this year's outflow. Running dry BEFORE the final year is
        // a failure; spending the last dollars in the final year completes the
        // plan (cFIREsim convention: failure = ran out *before* the end).
        port = 0;
        series[i + 1] = realSeries[i + 1] = 0;
        if (i < N - 1) {
          failed = i;
          for (let j = i + 2; j <= N; j++) series[j] = realSeries[j] = 0;
        }
        break;
      }
      port -= need;

      // 3) Grow the surviving balance, advance inflation.
      port *= 1 + r;
      // Monthly mode: credit the risk-free interest the year's spending earned
      // while sitting in the T-bill bucket. `spend` is the amount deposited in
      // January; it never carried market risk, so it's added after growth.
      if (monthly) port += bucketInterest(spend, tbill ? tbill[i] : 0);
      series[i + 1] = port;
      cumInfl *= 1 + infl[i];
      realSeries[i + 1] = port / cumInfl; // cumInfl now covers years 0..i
      prevReturn = r;
      if (sp.strategy === "cape" && !cape) {
        // Forward CAPE proxy: valuation drifts with the real return net of assumed
        // real earnings growth, so a crash lowers CAPE -> raises next year's rate.
        const realRet = (1 + r) / (1 + infl[i]) - 1;
        capeRun = Math.min(100, Math.max(4, capeRun * (1 + realRet) / (1 + CAPE_REAL_GROWTH)));
      }
    }

    return {
      series,
      realSeries,
      endValue: port,
      endValueReal: port / cumInfl,
      inflationFactor: cumInfl,
      success: failed < 0,
      failedYear: failed,
      realWithdrawals,
    };
  }

  // Aggregate a set of cycles into summary stats + chart-ready data.
  // opts.keepSeries caps how many raw trajectories are retained (charts only
  // need a sample); worst/median/best are always kept.
  function summarize(p, cycles, opts) {
    opts = opts || {};
    const N = p.years;
    const total = cycles.length;
    let succeeded = 0;
    for (let i = 0; i < total; i++) if (cycles[i].success) succeeded++;

    const endNom = cycles.map((c) => c.endValue).sort((a, b) => a - b);
    const endReal = cycles.map((c) => c.endValueReal).sort((a, b) => a - b);
    const pctl = (arr, p) => stats.percentileSorted(arr, p);
    const bucket = (arr) => ({
      min: arr[0], p5: pctl(arr, 5), p10: pctl(arr, 10), p25: pctl(arr, 25), median: pctl(arr, 50),
      p75: pctl(arr, 75), p90: pctl(arr, 90), max: arr[arr.length - 1],
      mean: stats.mean(arr),
    });

    // Percentile fan over time (per year, across all cycles), nominal AND real.
    const bands = { p10: [], p25: [], median: [], p75: [], p90: [] };
    const bandsReal = { p10: [], p25: [], median: [], p75: [], p90: [] };
    const col = new Array(total), colR = new Array(total);
    for (let t = 0; t <= N; t++) {
      for (let c = 0; c < total; c++) { col[c] = cycles[c].series[t]; colR[c] = cycles[c].realSeries[t]; }
      col.sort((a, b) => a - b);
      colR.sort((a, b) => a - b);
      for (const q of [10, 25, 50, 75, 90]) {
        const key = q === 50 ? "median" : "p" + q;
        bands[key].push(pctl(col, q));
        bandsReal[key].push(pctl(colR, q));
      }
    }

    // Histogram of (real) ending values for the distribution chart. Log-scaled
    // because ending wealth is heavily right-skewed; see histogramLog.
    const hist = histogramLog(endReal, 24);

    // Cumulative probability the portfolio is broke by each year (simulation only;
    // mortality is layered on in the UI). brokeByYear[N] == 1 - successRate.
    const firstBroke = new Array(N + 2).fill(0);
    for (let c = 0; c < total; c++) {
      const fy = cycles[c].failedYear;
      if (fy >= 0) firstBroke[Math.min(fy + 1, N + 1)]++;
    }
    const brokeByYear = new Array(N + 1);
    for (let t = 0, cum = 0; t <= N; t++) { cum += firstBroke[t]; brokeByYear[t] = total ? cum / total : 0; }

    // Spending in today's dollars, pooled across all funded cycle-years (most
    // useful for variable strategies, where the draw swings with the market).
    // Years after ruin are excluded (you're not spending from an empty account).
    const allSpend = [], worstPer = [], avgPer = [];
    for (let c = 0; c < total; c++) {
      const rw = cycles[c].realWithdrawals;
      const funded = cycles[c].failedYear >= 0 ? cycles[c].failedYear : N;
      let mn = Infinity, sum = 0, cnt = 0;
      for (let i = 0; i < funded; i++) {
        const v = rw[i];
        allSpend.push(v);
        if (v < mn) mn = v;
        sum += v; cnt++;
      }
      if (cnt) { worstPer.push(mn); avgPer.push(sum / cnt); }
    }
    allSpend.sort((a, b) => a - b);
    worstPer.sort((a, b) => a - b);
    avgPer.sort((a, b) => a - b);
    // First-year spend can differ per cycle (the CAPE rule reads each start
    // year's own valuation), so expose the spread: the UI shows a range when
    // min<max instead of pretending one cycle's number speaks for all.
    let fyMin = Infinity, fyMax = 0;
    for (let c = 0; c < total; c++) {
      const fy = cycles[c].realWithdrawals[0];
      if (fy < fyMin) fyMin = fy;
      if (fy > fyMax) fyMax = fy;
    }
    const spending = {
      strategy: p.spending.strategy,
      firstYear: total ? cycles[0].realWithdrawals[0] : 0,
      firstYearMin: total ? fyMin : 0,
      firstYearMax: total ? fyMax : 0,
      annual: allSpend.length ? bucket(allSpend) : null,
      leanestYear: worstPer.length ? { median: pctl(worstPer, 50), p10: pctl(worstPer, 10) } : null,
      avgMedian: avgPer.length ? pctl(avgPer, 50) : 0,
    };

    // Identify representative cycles by ending value.
    let worst = 0, best = 0, medianIdx = 0;
    const sortedByEnd = cycles.map((c, i) => [c.endValue, i]).sort((a, b) => a[0] - b[0]);
    worst = sortedByEnd[0][1];
    best = sortedByEnd[sortedByEnd.length - 1][1];
    medianIdx = sortedByEnd[Math.floor(sortedByEnd.length / 2)][1];

    // Retain a sample of trajectories for the spaghetti chart.
    const keep = opts.keepSeries || total;
    const keepSet = new Set([worst, best, medianIdx]);
    if (total > keep) {
      const step = total / keep;
      for (let k = 0; k < keep; k++) keepSet.add(Math.floor(k * step));
    } else {
      for (let k = 0; k < total; k++) keepSet.add(k);
    }
    const sampleSeries = [];
    keepSet.forEach((i) => {
      const c = cycles[i];
      sampleSeries.push({
        startYear: c.startYear, series: c.series, realSeries: c.realSeries, success: c.success,
        endValue: c.endValue, role: i === worst ? "worst" : i === best ? "best" : i === medianIdx ? "median" : "",
      });
    });

    return {
      mode: opts.mode || "historical",
      years: N,
      total, succeeded, failed: total - succeeded,
      successRate: total ? succeeded / total : 0,
      endingNominal: bucket(endNom),
      endingReal: bucket(endReal),
      bands,
      bandsReal,
      brokeByYear,
      spending,
      histogram: hist,
      sampleSeries,
      representative: {
        worst: cycleMeta(cycles[worst]),
        median: cycleMeta(cycles[medianIdx]),
        best: cycleMeta(cycles[best]),
      },
    };
  }

  function cycleMeta(c) {
    return {
      startYear: c.startYear, success: c.success, failedYear: c.failedYear,
      endValue: c.endValue, endValueReal: c.endValueReal,
    };
  }

  function histogram(sortedVals, nbins) {
    const n = sortedVals.length;
    if (!n) return { bins: [], counts: [], min: 0, max: 0 };
    const lo = sortedVals[0], hi = sortedVals[n - 1];
    if (hi === lo) return { bins: [lo], counts: [n], min: lo, max: hi };
    const w = (hi - lo) / nbins;
    const counts = new Array(nbins).fill(0);
    for (let i = 0; i < n; i++) {
      let b = Math.floor((sortedVals[i] - lo) / w);
      if (b >= nbins) b = nbins - 1;
      counts[b]++;
    }
    const bins = [];
    for (let b = 0; b < nbins; b++) bins.push(lo + w * b);
    return { bins, counts, binWidth: w, min: lo, max: hi };
  }

  // Log-scaled histogram for the ending-balance distribution. Ending wealth is
  // heavily right-skewed (multiplicative growth), so equal-DOLLAR bins dump ~all
  // outcomes into the first bar with a long empty tail. Equal-RATIO (log) bins
  // spread the body out. The first bin absorbs $0 (failures) and any value below
  // `loEdge`; the axis dynamic range is capped at 4 decades so a single near-zero
  // survivor can't flatten the chart. Returns `edges[nbins+1]` (bin boundaries,
  // edges[0]=0) so the renderer can place bars/ticks on a log axis and report
  // exact hover ranges. Equal-ratio bins map to equal pixel widths on that axis.
  function histogramLog(sortedVals, nbins) {
    const n = sortedVals.length;
    if (!n) return { bins: [], counts: [], edges: [], min: 0, max: 0, log: true, loEdge: 0 };
    const hi = sortedVals[n - 1];
    if (hi <= 0) return { bins: [0], counts: [n], edges: [0, 0], min: 0, max: 0, log: true, loEdge: 0 };
    let minPos = hi;
    for (let i = 0; i < n; i++) if (sortedVals[i] > 0) { minPos = sortedVals[i]; break; }
    const loEdge = Math.max(minPos, hi * 1e-4);
    const llo = Math.log(loEdge), lhi = Math.log(hi), span = (lhi - llo) || 1;
    const counts = new Array(nbins).fill(0);
    for (let i = 0; i < n; i++) {
      const v = sortedVals[i];
      let b = v <= loEdge ? 0 : Math.floor((Math.log(v) - llo) / span * nbins);
      if (b < 0) b = 0; else if (b >= nbins) b = nbins - 1;
      counts[b]++;
    }
    const edges = new Array(nbins + 1);
    edges[0] = 0; // first bin runs from $0 so it captures failures
    for (let b = 1; b <= nbins; b++) edges[b] = Math.exp(llo + span * b / nbins);
    return { bins: edges.slice(0, nbins), counts, edges, min: 0, max: hi, log: true, loEdge };
  }

  // Earliest array index at which EVERY allocated asset has data. Lets the
  // dataset extend back to 1871 for stocks/bonds while gold/cash/etc. (null
  // before 1928) automatically restrict the start range when they're used.
  function validStartOffset(p, data) {
    let off = 0;
    for (let a = 0; a < ASSETS.length; a++) {
      const key = ASSETS[a];
      if (!(p.allocation[key] > 0) || !data[key]) continue;
      const arr = data[key];
      let f = 0;
      while (f < arr.length && (arr[f] == null || isNaN(arr[f]))) f++;
      if (f > off) off = f;
    }
    return off;
  }

  function emptySummary(N) {
    const z = { min: 0, p5: 0, p10: 0, p25: 0, median: 0, p75: 0, p90: 0, max: 0, mean: 0 };
    return {
      mode: "historical", years: N, total: 0, succeeded: 0, failed: 0, successRate: 0,
      insufficient: true, endingNominal: z, endingReal: z,
      bands: { p10: [], p25: [], median: [], p75: [], p90: [] },
      bandsReal: { p10: [], p25: [], median: [], p75: [], p90: [] },
      brokeByYear: [], spending: null, histogram: { bins: [], counts: [], min: 0, max: 0 }, sampleSeries: [], representative: null,
    };
  }

  // Run every historical N-year cycle that fits the dataset + the allocation.
  function runHistorical(p, data) {
    const yrs = data.years;
    const N = p.years;
    let startOff = validStartOffset(p, data);
    // The CAPE rule needs a real CAPE for every simulated year, so it cannot start
    // before the series begins (~1880, once a full 10-year earnings window exists).
    if (p.spending.strategy === "cape" && data.cape) {
      let c = 0;
      while (c < data.cape.length && (data.cape[c] == null || isNaN(data.cape[c]))) c++;
      if (c > startOff) startOff = c;
    }
    const first = yrs[startOff];
    const lastStart = yrs[yrs.length - 1] - N + 1;
    if (lastStart < first) return emptySummary(N);
    const cycles = [];
    for (let s = first; s <= lastStart; s++) {
      const off = s - yrs[0];
      const ret = {};
      for (let a = 0; a < ASSETS.length; a++) {
        const key = ASSETS[a];
        if (data[key] && p.allocation[key] > 0) ret[key] = data[key].slice(off, off + N);
      }
      const infl = data.inflation.slice(off, off + N);
      const capeSlice = p.spending.strategy === "cape" && data.cape ? data.cape.slice(off, off + N) : null;
      // Monthly percentage mode needs the year's T-bill rate for the cash bucket,
      // regardless of whether cash is in the allocation.
      if (p.spending.strategy === "percent" && p.spending.monthly && data.cash) {
        ret.__tbill = data.cash.slice(off, off + N);
      }
      const res = simulateCycle(p, ret, infl, capeSlice);
      res.startYear = s;
      cycles.push(res);
    }
    const summary = summarize(p, cycles, { mode: "historical" });
    summary.startYears = { first: cycles[0].startYear, last: cycles[cycles.length - 1].startYear };
    return summary;
  }

  // Bisection solver: max initial spending whose success rate >= target.
  // `runner` is the engine to optimize against (historical or Monte Carlo). A
  // fixed-seed Monte Carlo runner makes success(spending) monotonic, so the
  // bisection converges. onProgress(0..1) fires once per iteration.
  function solveSpending(p, data, target, runner, onProgress) {
    runner = runner || runHistorical;
    const iters = 28;
    let lo = 0, hi = p.initialValue; // nobody sustainably spends the whole portfolio/yr
    for (let it = 0; it < iters; it++) {
      const mid = (lo + hi) / 2;
      const pp = Object.assign({}, p, {
        spending: Object.assign({}, p.spending, { strategy: "constant", initial: mid }),
      });
      if (runner(pp, data).successRate >= target) lo = mid;
      else hi = mid;
      if (onProgress) onProgress((it + 1) / iters);
    }
    return lo;
  }

  /*
   * Percent-of-portfolio guardrail solver. The caller fixes ONE spending bound
   * (a floor OR a ceiling, in today's $, on p.spending) plus a target success
   * rate; this solves for the OTHER bound by bisection.
   *
   * Both directions are monotone, which is what makes the bisection valid:
   *   - success is NON-INCREASING in the floor (a higher guaranteed minimum
   *     forces over-spending in bad sequences -> more ruin), and
   *   - success is NON-INCREASING in the ceiling (a higher cap lets good-year
   *     spending run, leaving a thinner buffer for later -> equal or more ruin).
   * A fixed-seed Monte Carlo `runner` keeps success(x) deterministic & monotone
   * exactly as solveSpending relies on.
   *
   * opts = { solveFor:"floor"|"ceiling", target, runner?, iters?, onProgress? }
   * Returns one of:
   *   { feasible:true, solveFor, target, value }                  // the solved bound
   *   { feasible:true, solveFor, target, value, atCap:true }      // floor hit the ceiling (=> constant spend)
   *   { feasible:true, solveFor, target, value:Infinity, unbounded:true } // ceiling: target met even uncapped
   *   { feasible:false, solveFor, target, reason, bestSuccess }   // can't be done; reason in {target,floorTooHigh}
   */
  function solveGuardrail(p, data, opts) {
    opts = opts || {};
    const runner = opts.runner || runHistorical;
    const target = opts.target;
    const solveFor = opts.solveFor;
    const iters = opts.iters || 30;
    const onProgress = opts.onProgress;
    // Always solve against the percentage strategy (the only one with guardrails
    // that drive failure); carry over the caller's given floor/ceiling.
    const base = Object.assign({}, p.spending, { strategy: "percent" });

    function successAt(x) {
      const sp = Object.assign({}, base);
      sp[solveFor] = x;
      return runner(Object.assign({}, p, { spending: sp }), data).successRate;
    }
    function bisect(lo, hi) {
      for (let it = 0; it < iters; it++) {
        const mid = (lo + hi) / 2;
        if (successAt(mid) >= target) lo = mid; else hi = mid;
        if (onProgress) onProgress((it + 1) / iters);
      }
      return lo; // largest x we proved still meets the target
    }

    let out;
    if (solveFor === "floor") {
      // Floor lives in [0, hiCap]; it can never exceed the ceiling (a floor above
      // the cap is contradictory). success(0) is the best you can do.
      const hiCap = base.ceiling != null ? base.ceiling : p.initialValue;
      const sBest = successAt(0);
      if (sBest + 1e-12 < target) out = { feasible: false, reason: "target", bestSuccess: sBest };
      else if (successAt(hiCap) >= target) out = { feasible: true, value: hiCap, atCap: true };
      else out = { feasible: true, value: bisect(0, hiCap) };
    } else {
      // Ceiling lives in [floor, BIG]; BIG is large enough to be effectively no
      // cap (spending is bounded by the portfolio anyway). Capping at the floor
      // gives constant spending = the best achievable success.
      const floor = base.floor != null ? base.floor : 0;
      const BIG = (p.initialValue > 0 ? p.initialValue : 1e7) * 50;
      const sCapped = successAt(floor);
      if (sCapped + 1e-12 < target) out = { feasible: false, reason: "floorTooHigh", bestSuccess: sCapped };
      else if (successAt(BIG) >= target) out = { feasible: true, value: Infinity, unbounded: true };
      else out = { feasible: true, value: bisect(floor, BIG) };
    }
    out.solveFor = solveFor;
    out.target = target;
    return out;
  }

  SWR.core = {
    ASSETS, weightedReturn, simulateCycle, summarize, runHistorical,
    solveSpending, solveGuardrail, histogram, histogramLog, validStartOffset, capeRate,
    bucketInterest,
  };
})(typeof self !== "undefined" ? self : this);
