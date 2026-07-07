/*
 * charts.js -- dependency-free <canvas> charts (no Chart.js / D3).
 * Renders the portfolio "fan" (percentile bands over time) and the ending-value
 * histogram. Reads colors from CSS custom properties so theming/dark-mode works.
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});
  const FONT = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

  function fmtMoney(x) {
    const a = Math.abs(x), s = x < 0 ? "-$" : "$";
    if (a >= 1e12) return s + (a / 1e12).toFixed(2) + "T"; // keeps near-cap values comma-free
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
    return s + Math.round(a);
  }

  function palette() {
    const s = getComputedStyle(document.documentElement);
    const g = (n, d) => s.getPropertyValue(n).trim() || d;
    return {
      axis: g("--chart-axis", "#94a0b8"),
      grid: g("--chart-grid", "rgba(140,150,170,0.16)"),
      text: g("--chart-text", "#62708a"),
      band: g("--chart-band", "rgba(47,111,237,0.13)"),
      band2: g("--chart-band2", "rgba(47,111,237,0.24)"),
      median: g("--chart-median", "#2f6fed"),
      worst: g("--chart-worst", "#e2483d"),
      best: g("--chart-best", "#15a06a"),
      spag: g("--chart-spag", "rgba(120,132,156,0.16)"),
      bar: g("--chart-bar", "#5b8def"),
      dead: g("--chart-dead", "#8a93a6"),
      tipbg: g("--chart-tip-bg", "#1c2230"),
      tipfg: g("--chart-tip-fg", "#f3f5fa"),
    };
  }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(280, Math.round(rect.width));
    const h = Math.max(180, Math.round(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    return { ctx, w, h };
  }

  // Round, human tick values between lo and hi.
  function niceTicks(lo, hi, count) {
    if (hi <= lo) return [lo];
    const span = hi - lo;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  function polyline(ctx, X, Y, series) {
    ctx.beginPath();
    for (let t = 0; t < series.length; t++) {
      const px = X(t), py = Y(series[t]);
      if (t === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function fillBand(ctx, X, Y, lo, hi, color) {
    ctx.beginPath();
    for (let t = 0; t < lo.length; t++) (t ? ctx.lineTo : ctx.moveTo).call(ctx, X(t), Y(lo[t]));
    for (let t = hi.length - 1; t >= 0; t--) ctx.lineTo(X(t), Y(hi[t]));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Draw an x-axis label so it never spills off the canvas: edge labels switch
  // alignment (left/right) instead of being clipped at the boundary.
  function clampedLabel(ctx, text, x, top, lo, hi) {
    const half = ctx.measureText(text).width / 2;
    ctx.textBaseline = "top";
    if (x - half < lo) { ctx.textAlign = "left"; x = lo; }
    else if (x + half > hi) { ctx.textAlign = "right"; x = hi; }
    else ctx.textAlign = "center";
    ctx.fillText(text, x, top);
  }

  // Round-number x-axis ticks that fit the available width without crowding,
  // always including the final value. X(t) maps a tick to a pixel; labelFn(t)
  // is its text.
  function xTicks(ctx, N, plotW, X, top, w, labelFn) {
    const lw = ctx.measureText(labelFn(N)).width;
    const maxLabels = Math.max(2, Math.floor(plotW / (lw + 28)));
    let step = Math.ceil(N / maxLabels);
    for (const s of [1, 2, 5, 10, 15, 20, 25, 50, 100]) { if (s >= step) { step = s; break; } }
    for (let t = 0; t < N - step * 0.7; t += step) clampedLabel(ctx, labelFn(t), X(t), top, 2, w - 2);
    clampedLabel(ctx, labelFn(N), X(N), top, 2, w - 2);
  }

  function trajectory(canvas, summary, opts) {
    opts = opts || {};
    const { ctx, w, h } = setup(canvas);
    const pal = palette();
    const real = !!opts.real;
    const N = summary.years, b = (real && summary.bandsReal) ? summary.bandsReal : summary.bands;
    const mL = 70, mR = 16, mT = 12, mB = 30;
    const plotW = w - mL - mR, plotH = h - mT - mB;

    let yMax = 0;
    for (let t = 0; t <= N; t++) if (b.p90[t] > yMax) yMax = b.p90[t];
    yMax = yMax > 0 ? yMax * 1.08 : 1;
    const X = (t) => mL + plotW * (t / N);
    const Y = (v) => mT + plotH * (1 - Math.max(0, Math.min(v, yMax)) / yMax);

    // Gridlines + $ axis labels.
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    for (const tv of niceTicks(0, yMax, 5)) {
      const yy = Y(tv);
      ctx.strokeStyle = pal.grid;
      ctx.beginPath(); ctx.moveTo(mL, yy); ctx.lineTo(w - mR, yy); ctx.stroke();
      ctx.fillStyle = pal.text;
      ctx.fillText(fmtMoney(tv), mL - 7, yy);
    }
    // Year labels.
    ctx.fillStyle = pal.text;
    xTicks(ctx, N, plotW, X, h - mB + 7, w, (t) => "Yr " + t);

    // Percentile fan.
    fillBand(ctx, X, Y, b.p10, b.p90, pal.band);
    fillBand(ctx, X, Y, b.p25, b.p75, pal.band2);

    // Faint sample trajectories.
    const ser = (s) => (real && s.realSeries) ? s.realSeries : s.series;
    ctx.strokeStyle = pal.spag; ctx.lineWidth = 1;
    for (const s of summary.sampleSeries) if (!s.role) polyline(ctx, X, Y, ser(s));
    // Worst / best highlighted cycles.
    for (const s of summary.sampleSeries) {
      if (s.role === "worst") { ctx.strokeStyle = pal.worst; ctx.lineWidth = 1.75; polyline(ctx, X, Y, ser(s)); }
      else if (s.role === "best") { ctx.strokeStyle = pal.best; ctx.lineWidth = 1.75; polyline(ctx, X, Y, ser(s)); }
    }
    // Median (per-year p50) line.
    ctx.strokeStyle = pal.median; ctx.lineWidth = 2.5; polyline(ctx, X, Y, b.median);

    // Axes.
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, h - mB); ctx.lineTo(w - mR, h - mB); ctx.stroke();

    // Persist geometry for hover redraws.
    canvas._chart = { summary, opts, pal, geom: { mL, mR, mT, mB, plotW, plotH, N, yMax, X, Y, w, h } };
    if (!canvas._hoverBound) { bindHover(canvas); canvas._hoverBound = true; }
    if (opts.hoverT != null) drawHover(ctx, canvas._chart, opts.hoverT);
  }

  function drawHover(ctx, chart, t) {
    const { geom, pal, summary } = chart;
    t = Math.max(0, Math.min(geom.N, Math.round(t)));
    const b = (chart.opts.real && summary.bandsReal) ? summary.bandsReal : summary.bands;
    const px = geom.X(t);
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, geom.mT); ctx.lineTo(px, geom.mT + geom.plotH); ctx.stroke();
    ctx.setLineDash([]);
    const dot = (v, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(px, geom.Y(v), 3, 0, 6.2832); ctx.fill(); };
    dot(b.p90[t], pal.band2); dot(b.median[t], pal.median); dot(b.p10[t], pal.band2);
    const lines = [
      "Year " + t,
      "90th: " + fmtMoney(b.p90[t]),
      "Median: " + fmtMoney(b.median[t]),
      "10th: " + fmtMoney(b.p10[t]),
    ];
    tooltip(ctx, pal, lines, px, geom.mT + 6, geom.w);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Shared hover tooltip box anchored near px, kept inside [4, rightEdge-4].
  function tooltip(ctx, pal, lines, px, top, rightEdge) {
    ctx.font = FONT; ctx.textBaseline = "top";
    let tw = 0; for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
    const bw = tw + 16, bh = lines.length * 16 + 10;
    let bx = px + 12; if (bx + bw > rightEdge - 4) bx = px - bw - 12; if (bx < 4) bx = 4;
    ctx.fillStyle = pal.tipbg; roundRect(ctx, bx, top, bw, bh, 6); ctx.fill();
    ctx.fillStyle = pal.tipfg; ctx.textAlign = "left";
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], bx + 8, top + 6 + i * 16);
  }

  // Generic hover wiring: a chart sets canvas._redraw(mx|null), then calls this.
  function attachHover(canvas) {
    if (canvas._hoverAttached) return;
    canvas._hoverAttached = true;
    canvas.addEventListener("mousemove", (ev) => {
      const r = canvas.getBoundingClientRect();
      if (canvas._redraw) canvas._redraw(ev.clientX - r.left);
    });
    canvas.addEventListener("mouseleave", () => { if (canvas._redraw) canvas._redraw(null); });
  }

  function bindHover(canvas) {
    const move = (ev) => {
      const c = canvas._chart; if (!c) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const g = c.geom;
      if (mx < g.mL || mx > g.w - g.mR) { trajectory(canvas, c.summary, Object.assign({}, c.opts, { hoverT: null })); return; }
      const t = ((mx - g.mL) / g.plotW) * g.N;
      trajectory(canvas, c.summary, Object.assign({}, c.opts, { hoverT: t }));
    };
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseleave", () => {
      const c = canvas._chart; if (c) trajectory(canvas, c.summary, Object.assign({}, c.opts, { hoverT: null }));
    });
  }

  // Decade ticks (…, $100k, $1M, $10M, …) spanning [lo, hi] for a log axis;
  // adds 3x midpoints when the span is under ~2 decades so it's never too sparse.
  function logTicks(lo, hi) {
    if (!(hi > lo) || lo <= 0) return [];
    const out = [];
    for (let p = Math.pow(10, Math.ceil(Math.log10(lo) - 1e-9)); p <= hi * (1 + 1e-9); p *= 10) out.push(p);
    if (out.length <= 2) {
      for (let q = Math.pow(10, Math.floor(Math.log10(lo))); q <= hi; q *= 10) {
        const m = 3 * q; if (m > lo && m < hi) out.push(m);
      }
      out.sort((a, b) => a - b);
    }
    return out;
  }

  function histogram(canvas, summary, opts) {
    opts = opts || {};
    const { ctx, w, h } = setup(canvas);
    const pal = palette();
    const hd = summary.histogram;
    if (!hd || !hd.counts.length) return;
    const mL = 46, mR = 14, mT = 12, mB = 30;
    const plotW = w - mL - mR, plotH = h - mT - mB;
    let maxCount = 0; for (const c of hd.counts) if (c > maxCount) maxCount = c;
    const n = hd.counts.length, bw = plotW / n;

    // Map a dollar value to an x pixel. Log axis when the summary is log-binned
    // (the ending-balance distribution); plain linear otherwise. Equal-ratio log
    // bins land on equal pixel widths, so the bars below still tile uniformly.
    const useLog = !!hd.log && hd.loEdge > 0 && hd.max > hd.loEdge;
    const llo = useLog ? Math.log(hd.loEdge) : 0;
    const lspan = useLog ? (Math.log(hd.max) - llo) || 1 : 1;
    const xOf = (v) => useLog
      ? mL + plotW * Math.max(0, Math.min(1, (Math.log(Math.max(v, hd.loEdge)) - llo) / lspan))
      : mL + plotW * ((v - hd.min) / ((hd.max - hd.min) || 1));
    const lticks = useLog ? logTicks(hd.loEdge, hd.max) : [];

    let hoverBin = -1;
    if (opts.hoverPx != null && opts.hoverPx >= mL && opts.hoverPx <= w - mR) {
      hoverBin = Math.min(n - 1, Math.max(0, Math.floor((opts.hoverPx - mL) / bw)));
    }

    // Horizontal count gridlines + y labels.
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const tv of niceTicks(0, maxCount, 4)) {
      const yy = mT + plotH * (1 - tv / (maxCount || 1));
      ctx.strokeStyle = pal.grid; ctx.beginPath(); ctx.moveTo(mL, yy); ctx.lineTo(w - mR, yy); ctx.stroke();
      ctx.fillStyle = pal.text; ctx.fillText(String(Math.round(tv)), mL - 6, yy);
    }
    // Vertical decade gridlines (behind the bars).
    ctx.strokeStyle = pal.grid;
    for (const t of lticks) { const tx = xOf(t); ctx.beginPath(); ctx.moveTo(tx, mT); ctx.lineTo(tx, mT + plotH); ctx.stroke(); }

    // Bars.
    for (let i = 0; i < n; i++) {
      const bh = plotH * (hd.counts[i] / (maxCount || 1));
      ctx.fillStyle = i === hoverBin ? pal.median : pal.bar;
      ctx.fillRect(mL + i * bw + 1, mT + plotH - bh, Math.max(1, bw - 2), bh);
    }

    // Median marker (line now; label drawn last so it sits on top of any tick).
    const med = summary.endingReal.median;
    let medX = null, medText = "", medHalf = 0;
    if (med > 0 && med <= hd.max) {
      medX = xOf(med); medText = "median " + fmtMoney(med);
      ctx.strokeStyle = pal.median; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(medX, mT); ctx.lineTo(medX, mT + plotH); ctx.stroke();
      medHalf = ctx.measureText(medText).width / 2;
    }

    // Bottom labels: $0 (left), max (right), decade ticks, then the median.
    const yLab = h - mB + 7;
    ctx.textBaseline = "top"; ctx.fillStyle = pal.text;
    clampedLabel(ctx, fmtMoney(hd.min), mL, yLab, 2, w - 2);     // "$0"
    clampedLabel(ctx, fmtMoney(hd.max), w - mR, yLab, 2, w - 2);
    const occ = [
      [mL - 4, mL + ctx.measureText(fmtMoney(hd.min)).width + 4],
      [w - mR - ctx.measureText(fmtMoney(hd.max)).width - 4, w - mR + 4],
    ];
    if (medX != null) occ.push([medX - medHalf - 6, medX + medHalf + 6]);
    ctx.fillStyle = pal.text;
    for (const t of lticks) {
      const tx = xOf(t), lbl = fmtMoney(t), half = ctx.measureText(lbl).width / 2;
      let clash = false;
      for (const o of occ) if (tx + half > o[0] && tx - half < o[1]) { clash = true; break; }
      if (clash) continue;
      ctx.textAlign = "center"; ctx.fillText(lbl, tx, yLab);
      occ.push([tx - half - 4, tx + half + 4]);
    }
    if (medX != null) { ctx.fillStyle = pal.median; clampedLabel(ctx, medText, medX, yLab, 2, w - 2); }

    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + plotH); ctx.lineTo(w - mR, mT + plotH); ctx.stroke();

    canvas._redraw = (mx) => histogram(canvas, summary, { hoverPx: mx });
    attachHover(canvas);
    if (hoverBin >= 0) {
      const edges = hd.edges;
      const lo = edges ? edges[hoverBin] : hd.min + (hd.binWidth || 0) * hoverBin;
      const hiV = edges ? edges[hoverBin + 1] : lo + (hd.binWidth || 0);
      const cnt = hd.counts[hoverBin], pct = summary.total ? cnt / summary.total * 100 : 0;
      tooltip(ctx, pal, [fmtMoney(lo) + " – " + fmtMoney(hiV),
        cnt.toLocaleString() + " of " + summary.total.toLocaleString() + " (" + pct.toFixed(0) + "%)"],
        mL + (hoverBin + 0.5) * bw, mT + 6, w);
    }
  }

  // "Rich, broke, or dead" — stacks, for each year, the probability of being
  // alive with money / alive but broke / deceased (sums to 100%).
  // d = { years, survival:[N+1] (P alive), brokeByYear:[N+1] (P broke|sim), startAge }
  function richBrokeDead(canvas, d, opts) {
    opts = opts || {};
    const { ctx, w, h } = setup(canvas);
    const pal = palette();
    const N = d.years, surv = d.survival, broke = d.brokeByYear;
    if (!surv || !broke || !broke.length) return;
    const mL = 40, mR = 14, mT = 12, mB = 30;
    const plotW = w - mL - mR, plotH = h - mT - mB;
    const X = (t) => mL + plotW * (t / N);
    const Y = (v) => mT + plotH * (1 - Math.max(0, Math.min(1, v)));

    const zero = [], solventTop = [], survTop = [], one = [];
    for (let t = 0; t <= N; t++) {
      const s = surv[t] == null ? 0 : surv[t];
      zero.push(0); solventTop.push(s * (1 - broke[t])); survTop.push(s); one.push(1);
    }
    fillBand(ctx, X, Y, zero, solventTop, pal.best);   // alive & solvent
    fillBand(ctx, X, Y, solventTop, survTop, pal.worst); // alive & broke
    fillBand(ctx, X, Y, survTop, one, pal.dead);        // deceased

    // Gridlines + % axis.
    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.lineWidth = 1;
    for (let p = 0; p <= 100; p += 25) {
      const yy = Y(p / 100);
      ctx.strokeStyle = pal.grid; ctx.beginPath(); ctx.moveTo(mL, yy); ctx.lineTo(w - mR, yy); ctx.stroke();
      ctx.fillStyle = pal.text; ctx.fillText(p + "%", mL - 6, yy);
    }
    ctx.fillStyle = pal.text;
    xTicks(ctx, N, plotW, X, h - mB + 7, w, (t) => d.startAge ? "age " + (d.startAge + t) : "Yr " + t);
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + plotH); ctx.lineTo(w - mR, mT + plotH); ctx.stroke();

    canvas._redraw = (mx) => richBrokeDead(canvas, d, { hoverPx: mx });
    attachHover(canvas);
    if (opts.hoverPx != null && opts.hoverPx >= mL && opts.hoverPx <= w - mR) {
      const t = Math.min(N, Math.max(0, Math.round(((opts.hoverPx - mL) / plotW) * N)));
      const s = surv[t] == null ? 0 : surv[t];
      const px = X(t);
      ctx.strokeStyle = pal.axis; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, mT); ctx.lineTo(px, mT + plotH); ctx.stroke(); ctx.setLineDash([]);
      const pc = (x) => (x * 100).toFixed(0) + "%";
      tooltip(ctx, pal, [
        d.startAge ? "Age " + (d.startAge + t) + " (yr " + t + ")" : "Year " + t,
        "Alive, money lasts: " + pc(s * (1 - broke[t])),
        "Alive, but broke: " + pc(s * broke[t]),
        "Deceased: " + pc(1 - s),
      ], px, mT + 6, w);
    }
  }

  // Loan: remaining balance (filled, declining) + cumulative interest paid.
  function loanChart(canvas, sched) {
    const { ctx, w, h } = setup(canvas);
    const pal = palette();
    const rows = sched.rows, n = rows.length;
    if (!n) return;
    const mL = 64, mR = 14, mT = 12, mB = 30;
    const plotW = w - mL - mR, plotH = h - mT - mB;
    // Must cover BOTH lines: on long/high-rate loans the cumulative interest
    // exceeds the principal (e.g. $347k interest on a $300k 30-yr @6%).
    const yMax = Math.max(sched.principal || 1, sched.totalInterest || 0) * 1.04;
    const X = (i) => mL + plotW * (i / n);
    const Y = (v) => mT + plotH * (1 - Math.max(0, Math.min(v, yMax)) / yMax);
    const bal = [sched.principal], cumInt = [0];
    let ci = 0;
    for (const r of rows) { bal.push(r.balance); ci += r.interest; cumInt.push(ci); }

    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.lineWidth = 1;
    for (const tv of niceTicks(0, yMax, 5)) {
      const yy = Y(tv);
      ctx.strokeStyle = pal.grid; ctx.beginPath(); ctx.moveTo(mL, yy); ctx.lineTo(w - mR, yy); ctx.stroke();
      ctx.fillStyle = pal.text; ctx.fillText(fmtMoney(tv), mL - 7, yy);
    }
    ctx.fillStyle = pal.text;
    const totalYears = Math.max(1, Math.round(n / 12));
    xTicks(ctx, totalYears, plotW, (yr) => X(Math.min(yr * 12, n)), h - mB + 7, w, (yr) => "Yr " + yr);

    fillBand(ctx, X, Y, new Array(bal.length).fill(0), bal, pal.band);
    ctx.strokeStyle = pal.median; ctx.lineWidth = 2.5; polyline(ctx, X, Y, bal);
    ctx.strokeStyle = pal.worst; ctx.lineWidth = 2; polyline(ctx, X, Y, cumInt);
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, h - mB); ctx.lineTo(w - mR, h - mB); ctx.stroke();
  }

  // Compound interest: balance growth (filled) + total-contributed line.
  function compoundChart(canvas, res) {
    const { ctx, w, h } = setup(canvas);
    const pal = palette();
    const s = res.series, n = s.length - 1;
    if (n < 1) return;
    const mL = 64, mR = 14, mT = 12, mB = 30;
    const plotW = w - mL - mR, plotH = h - mT - mB;
    const bal = s.map((p) => p.balance), contrib = s.map((p) => p.contributed);
    const yMax = Math.max(bal[n], contrib[n], 1) * 1.04;
    const X = (t) => mL + plotW * (t / n);
    const Y = (v) => mT + plotH * (1 - Math.max(0, Math.min(v, yMax)) / yMax);

    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.lineWidth = 1;
    for (const tv of niceTicks(0, yMax, 5)) {
      const yy = Y(tv);
      ctx.strokeStyle = pal.grid; ctx.beginPath(); ctx.moveTo(mL, yy); ctx.lineTo(w - mR, yy); ctx.stroke();
      ctx.fillStyle = pal.text; ctx.fillText(fmtMoney(tv), mL - 7, yy);
    }
    ctx.fillStyle = pal.text;
    xTicks(ctx, n, plotW, X, h - mB + 7, w, (t) => "Yr " + t);

    fillBand(ctx, X, Y, new Array(bal.length).fill(0), bal, pal.band);
    ctx.strokeStyle = pal.median; ctx.lineWidth = 2.5; polyline(ctx, X, Y, bal);
    ctx.strokeStyle = pal.dead; ctx.lineWidth = 2; polyline(ctx, X, Y, contrib);
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, h - mB); ctx.lineTo(w - mR, h - mB); ctx.stroke();
  }

  SWR.charts = { trajectory, histogram, richBrokeDead, loanChart, compoundChart, fmtMoney };
})(typeof self !== "undefined" ? self : this);
