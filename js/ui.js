/*
 * ui.js -- the page controller. Reads the form, runs the engine (Monte Carlo in
 * a Worker), and renders results + charts. No frameworks, no innerHTML with
 * dynamic data (DOM is built with createElement), no eval. Shareable state is
 * encoded in the URL hash and strictly validated on the way back in.
 */
(function () {
  "use strict";
  const SWR = window.SWR;
  const DATA = window.SWR_DATA;
  const CAPE = window.SWR_CAPE || null;
  const money = SWR.charts.fmtMoney;
  const $ = (id) => document.getElementById(id);

  const PERSIST = [
    "initialValue", "years", "feeRate", "currentAge", "sex",
    "allocStocks", "allocBonds", "allocGold", "allocCash", "allocCorp", "allocReit", "allocSmallcap",
    "strategy", "initialSpend", "spendPercent", "withdrawFreqVal", "vpwReturn", "capeA", "capeB", "gkGuard", "gkAdjust",
    "spendFloor", "spendCeiling", "inflationMode", "fixedInflation", "taxRate",
    "runMonteCarlo", "mcMethod", "mcTrials", "mcBlock", "mcSeed", "targetSuccess",
    "gsolveTarget",
  ];
  const ALLOC = {
    allocStocks: "stocks", allocBonds: "bonds", allocGold: "gold", allocCash: "cash",
    allocCorp: "corp", allocReit: "reit", allocSmallcap: "smallcap",
  };

  const state = { historical: null, montecarlo: null, mode: "historical", dollar: "real", solveBasis: "historical", gsolveBasis: "historical", params: null, data: null, view: "main", loan: null, loanDone: false, compound: null, compoundDone: false, compTiming: "start" };
  let worker = null, workerOK = true, solvePending = null;
  let solving = false, solveTimer = null, solveFallback = null;
  // If the Worker doesn't make progress on a solve within this window (e.g. a
  // stale cached worker without the 'solve' handler, or a worker error), run the
  // solve inline instead. Re-armed on every progress tick, so a healthy worker
  // never trips it.
  function armSolveTimer() {
    if (solveTimer) clearTimeout(solveTimer);
    solveTimer = setTimeout(function () {
      solveTimer = null;
      if (solving && solveFallback) solveFallback();
    }, 3000);
  }

  // ---------- tiny DOM helper ----------
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "title") n.title = attrs[k];
      else if (k in n) n[k] = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (kids) for (const c of kids) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  }
  // Money inputs display thousands separators, so every numeric read strips
  // commas first. (They're type="text": a type="number" field can't show them.)
  const stripNum = (s) => String(s == null ? "" : s).replace(/,/g, "");
  const num = (id, d) => { const v = parseFloat(stripNum($(id).value)); return isFinite(v) ? v : d; };
  const clampNum = (id, d, lo, hi) => { let v = num(id, d); if (!isFinite(v)) v = d; return Math.min(hi, Math.max(lo, v)); };

  // ---------- live thousands separators for the $ inputs ----------
  const MONEY_IDS = ["initialValue", "initialSpend", "spendFloor", "spendCeiling",
                     "loanAmount", "loanExtra", "compPrincipal", "compAddition"];
  function formatMoneyValue(s) {
    s = String(s == null ? "" : s);
    if (/[eE]/.test(s)) return s; // scientific notation: leave as typed (parseFloat handles it)
    s = stripNum(s).replace(/[^0-9.]/g, "");
    if (!s) return "";
    const dot = s.indexOf(".");
    const frac = dot >= 0 ? "." + s.slice(dot + 1).replace(/\./g, "") : "";
    let int = (dot >= 0 ? s.slice(0, dot) : s).replace(/^0+(?=\d)/, "");
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return int + frac;
  }
  function formatMoneyInput(eln) {
    const before = eln.value;
    const after = formatMoneyValue(before);
    if (after === before) return;
    // While the user is typing, keep the caret anchored to the same DIGIT as
    // commas shuffle around it (count digits left of the caret, re-seek them).
    if (typeof eln.selectionStart === "number" && document.activeElement === eln) {
      const digitsLeft = stripNum(before.slice(0, eln.selectionStart)).replace(/[^0-9.]/g, "").length;
      eln.value = after;
      let pos = 0, seen = 0;
      while (pos < after.length && seen < digitsLeft) { if (after[pos] !== ",") seen++; pos++; }
      eln.setSelectionRange(pos, pos);
    } else {
      eln.value = after;
    }
  }
  const attachMoney = (eln) => eln.addEventListener("input", () => formatMoneyInput(eln));
  // Current CAPE the forward/Monte-Carlo path starts from: the shipped ERN "better
  // CAPE", refreshed daily by the server-side pipeline (no user input). Bounded.
  function currentCape() {
    const v = CAPE && CAPE.latest ? CAPE.latest.betterCape : 30;
    return Math.min(120, Math.max(1, v));
  }

  // ---------- reading inputs ----------
  function allocSum() {
    let s = 0;
    for (const id in ALLOC) s += num(id, 0);
    return s;
  }

  function readFlows(containerId, fixedKind) {
    const out = [];
    $(containerId).querySelectorAll(".flowrow").forEach((row) => {
      const amt = parseFloat(stripNum(row.querySelector(".f-amt").value));
      if (!isFinite(amt) || amt === 0) return;
      const start = Math.max(1, Math.round(parseFloat(row.querySelector(".f-start").value) || 1));
      const end = Math.max(start, Math.round(parseFloat(row.querySelector(".f-end").value) || start));
      const cola = row.querySelector(".f-cola").checked;
      const kindSel = row.querySelector(".f-kind");
      const kind = fixedKind || (kindSel ? kindSel.value : "expense");
      // A short user label ("SS", "roof"); read-side cap because maxlength only
      // guards typing, not programmatic/hash-restored values. Engine ignores it.
      const noteEl = row.querySelector(".f-note");
      const note = noteEl ? String(noteEl.value).slice(0, MAX_NOTE) : "";
      // Bounded like the portfolio itself: a hash-planted 1e308 income would
      // otherwise compound the balance to Infinity and render as "$InfinityB".
      out.push({ amount: Math.min(Math.abs(amt), MAX_PORTFOLIO), start, end, cola, kind, note });
    });
    return out;
  }

  // Hardening: the URL hash is fully attacker-controlled (a crafted share link a
  // victim might open), so every value derived from it is bounded to keep memory
  // and CPU finite. There is no server, so these protect the visitor's browser.
  const MAX_FLOWS = 50;        // income/adjustment rows
  const MAX_TRIALS = 50000;    // Monte Carlo trials
  const MAX_PORTFOLIO = 1e13;  // $10 trillion ceiling guards against overflow/Infinity
  const MAX_NOTE = 24;         // per-row note tag; also caps hash-planted strings

  function buildParams() {
    const allocation = {};
    for (const id in ALLOC) allocation[ALLOC[id]] = num(id, 0) / 100;
    const strategy = $("strategy").value;
    const sp = {
      strategy,
      initial: clampNum("initialSpend", 0, 0, MAX_PORTFOLIO),
      percent: num("spendPercent", 4) / 100,
      vpwReturn: num("vpwReturn", 3.4) / 100,
      guard: num("gkGuard", 20) / 100,
      gkAdjust: num("gkAdjust", 10) / 100,
      capeA: clampNum("capeA", 1.75, 0, 50) / 100, // intercept a (decimal, ERN default 1.75%)
      capeB: clampNum("capeB", 0.5, 0, 10),         // slope b on the earnings yield
      cape0: currentCape(),                        // starting CAPE for forward mode (shipped)
    };
    const fl = parseFloat(stripNum($("spendFloor").value)); if (isFinite(fl)) sp.floor = fl;
    const cl = parseFloat(stripNum($("spendCeiling").value)); if (isFinite(cl)) sp.ceiling = cl;
    // Monthly payout (T-bill cash bucket) is a percentage-strategy-only option.
    if (strategy === "percent" && $("withdrawFreqVal").value === "monthly") sp.monthly = true;
    return {
      initialValue: num("initialValue", 0),
      // Clamp to the dataset length so N can never blow up array allocations,
      // independent of validate() (defense in depth).
      years: Math.min(DATA.years.length, Math.max(1, Math.round(num("years", 30)) || 1)),
      allocation,
      feeRate: num("feeRate", 0) / 100,
      // Bounded: the engine grosses up by 1/(1-t), so t must stay well below 100%.
      taxRate: clampNum("taxRate", 0, 0, 90) / 100,
      spending: sp,
      incomes: readFlows("incomeRows", "income"),
      adjustments: readFlows("adjustRows", null),
    };
  }

  // For fixed-inflation mode, swap in a flat CPI series (returns stay historical).
  function effectiveData() {
    if ($("inflationMode").value !== "fixed") return DATA;
    const rate = num("fixedInflation", 3) / 100;
    const d = Object.assign({}, DATA);
    d.inflation = DATA.years.map(() => rate);
    return d;
  }

  function validate() {
    const s = allocSum();
    if (Math.abs(s - 100) > 0.5) return "Asset allocation must sum to 100% (currently " + s.toFixed(0) + "%).";
    const iv = num("initialValue", 0);
    if (!(iv > 0) || !isFinite(iv) || iv > MAX_PORTFOLIO) return "Enter a starting portfolio between $1 and $10 trillion.";
    const y = Math.round(num("years", 0));
    if (y < 1 || y > DATA.years.length) return "Retirement length must be between 1 and " + DATA.years.length + " years.";
    return "";
  }

  // ---------- dynamic income / adjustment rows ----------
  function addFlowRow(container, kindSelectable, v) {
    v = v || {};
    const row = el("div", { class: "flowrow" });
    let first;
    if (kindSelectable) {
      first = el("select", { class: "f-kind" }, [
        el("option", { value: "expense", text: "Expense" }),
        el("option", { value: "income", text: "Income" }),
      ]);
      first.value = v.kind === "income" ? "income" : "expense";
    } else {
      first = el("span", { class: "rowlabel", text: "Inflow" });
    }
    const amt = el("input", { class: "f-amt", type: "text", inputmode: "numeric", autocomplete: "off", placeholder: "$ / yr" });
    if (v.amount != null) amt.value = v.amount;
    attachMoney(amt);
    formatMoneyInput(amt);
    const start = el("input", { class: "f-start", type: "number", min: "1", step: "1", placeholder: "start yr" });
    start.value = v.start != null ? v.start : 1;
    const end = el("input", { class: "f-end", type: "number", min: "1", step: "1", placeholder: "end yr" });
    end.value = v.end != null ? v.end : $("years").value;
    const colaBox = el("input", { class: "f-cola", type: "checkbox" });
    colaBox.checked = v.cola !== false;
    const cola = el("label", { class: "col-cola", title: "Adjust for inflation" }, [colaBox]);
    const note = el("input", { class: "f-note", type: "text", autocomplete: "off", placeholder: "note", title: "Short label for this row (shows in the printed report)" });
    note.maxLength = MAX_NOTE;
    if (v.note) note.value = String(v.note).slice(0, MAX_NOTE);
    const rm = el("button", { class: "ghost rm", type: "button", text: "×", title: "Remove" });
    rm.addEventListener("click", () => {
      row.remove();
      if (!container.querySelector(".flowrow")) {
        const h = container.querySelector(".flowhead");
        if (h) h.remove();
      }
    });
    [first, amt, start, end, cola, note, rm].forEach((c) => row.appendChild(c));
    ensureFlowHeader(container, kindSelectable);
    container.appendChild(row);
    return row;
  }
  // A one-time column header above the rows so "1" / "45" read as start/end year.
  function ensureFlowHeader(container, kindSelectable) {
    if (container.querySelector(".flowhead")) return;
    const labels = (kindSelectable ? ["Type"] : ["Source"]).concat(["Amount / yr", "Start yr", "End yr", "COLA", "Note", ""]);
    const h = el("div", { class: "flowhead" });
    labels.forEach((t, i) => {
      const span = el("span", { class: "fh", text: t });
      if (i === 4) span.title = "Cost-of-living adjustment: grow this amount with inflation each year";
      h.appendChild(span);
    });
    container.insertBefore(h, container.firstChild);
  }
  const clearRows = (id) => { const c = $(id); while (c.firstChild) c.removeChild(c.firstChild); };

  // ---------- visibility toggles ----------
  // Read-only readout: the shipped (daily-refreshed) CAPE and the withdrawal rate
  // the current a, b imply this year -- clamped by the floor/ceiling so it never
  // disagrees with what a simulated year 1 at today's CAPE would actually spend.
  function updateCapeHint() {
    const cape = currentCape(), a = clampNum("capeA", 1.75, 0, 50), b = clampNum("capeB", 0.5, 0, 10);
    const wr = SWR.core.capeRate(a / 100, b, cape), iv = num("initialValue", 0);
    const asOf = CAPE && CAPE.latest ? CAPE.latest.date : "";
    // Provenance: the pipeline prefers ERN's own published CAPE.2 and falls back
    // to our computed ERN-method value -- say which one this build is serving.
    const src = CAPE && CAPE.latest && typeof CAPE.latest.source === "string" && CAPE.latest.source.indexOf("ERN") === 0
      ? " · from ERN’s published sheet"
      : " · computed estimate (ERN sheet unavailable)";
    let text = "Current CAPE " + cape.toFixed(1) + (asOf ? " · auto-updated, as of " + asOf : "") + src +
      " → this year’s rate ≈ " + (wr * 100).toFixed(2) + "% of balance";
    if (iv > 0) {
      let dollars = wr * iv, note = "";
      const cl = parseFloat(stripNum($("spendCeiling").value)), fl = parseFloat(stripNum($("spendFloor").value));
      if (isFinite(cl) && dollars > cl) { dollars = cl; note = " (your ceiling)"; }
      else if (isFinite(fl) && dollars < fl) { dollars = fl; note = " (your floor)"; }
      text += " ≈ " + money(Math.round(dollars)) + note;
    }
    $("capeRateNow").textContent = text;
  }

  function syncStrategy() {
    const st = $("strategy").value;
    document.querySelectorAll(".strat").forEach((e) => {
      e.classList.toggle("show", e.classList.contains("strat-" + st));
    });
    const iv = num("initialValue", 0), s = num("initialSpend", 0);
    $("spendRateHint").textContent =
      (st === "constant" || st === "guyton") && iv > 0 ? "Initial rate: " + (s / iv * 100).toFixed(2) + "% of portfolio" : "";
    updateCapeHint();
  }
  // Reflect the persisted withdrawFreqVal into the segmented buttons + hint (the
  // hidden input is the single source of truth so it round-trips in the hash).
  function syncFreq() {
    const v = $("withdrawFreqVal").value === "monthly" ? "monthly" : "annual";
    $("withdrawFreq").querySelectorAll("button").forEach((b) =>
      b.classList.toggle("seg-on", b.dataset.freq === v));
    $("withdrawFreqHint").textContent = v === "monthly"
      ? "Each January the year's withdrawal moves into a risk-free 3-month T-bill account and is drawn down monthly, earning a little interest along the way — no market risk on money you're about to spend."
      : "The whole year's withdrawal is taken up front each January.";
  }
  function updateAllocSum() {
    const s = allocSum(), e = $("allocSum");
    e.textContent = (Math.round(s * 10) / 10) + "%";
    e.classList.toggle("bad", Math.abs(s - 100) > 0.5);
  }
  const toggleFixed = () => { $("fixedInflationWrap").hidden = $("inflationMode").value !== "fixed"; };
  const toggleMcOptions = () => { $("mcOptions").hidden = !$("runMonteCarlo").checked; };
  const toggleMcBlock = () => { $("mcBlockWrap").hidden = $("mcMethod").value !== "block"; };

  // ---------- running ----------
  function run(ev) {
    if (ev) ev.preventDefault();
    const err = validate();
    if (err) return msg(err, false);
    if (ev) { $("solveResult").hidden = true; $("gsolveResult").hidden = true; } // a manual run clears stale solver results
    const params = buildParams();
    const data = effectiveData();
    state.params = params; state.data = data; state.montecarlo = null;
    state.historical = SWR.core.runHistorical(params, data);
    enableMcTab(false);
    setMode("historical");
    if ($("runMonteCarlo").checked) runMC(params, data);
    updateHash();
    msg("", true);
  }

  function clampTrials() {
    let t = Math.round(num("mcTrials", 10000));
    if (!isFinite(t)) t = 10000;
    return Math.max(100, Math.min(MAX_TRIALS, t));
  }

  function runMC(params, data) {
    const opts = {
      method: $("mcMethod").value, trials: clampTrials(),
      block: Math.round(num("mcBlock", 5)), seed: Math.round(num("mcSeed", 12345)),
    };
    showProgress(true, 0);
    const w = getWorker();
    if (w) {
      w.postMessage({ type: "montecarlo", params, data, method: opts.method, trials: opts.trials, block: opts.block, seed: opts.seed });
    } else {
      // No Worker (e.g. opened via file://): run inline on the next tick.
      setTimeout(() => {
        try {
          const s = SWR.mc.run(params, data, Object.assign({}, opts, { onProgress: (v) => showProgress(true, v) }));
          onMC(s);
        } catch (e) { showProgress(false); msg("Monte Carlo error: " + e.message, false); }
      }, 12);
    }
  }
  // Results default to the Historical view: when Monte Carlo finishes we only
  // store it and ENABLE its tab -- we don't auto-switch the view, so Historical
  // stays selected until the user clicks the Monte Carlo tab themselves.
  function onMC(s) { state.montecarlo = s; showProgress(false); enableMcTab(true); }

  function getWorker() {
    if (worker || !workerOK) return worker;
    try {
      worker = new Worker("js/worker.js");
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "progress") { showProgress(true, m.value); if (solving) armSolveTimer(); }
        else if (m.type === "result") onMC(m.summary);
        else if (m.type === "solveResult") applySolve(m.max);
        else if (m.type === "gsolveResult") applyGsolve(m.result);
        else if (m.type === "error") { showProgress(false); if (solving && solveFallback) solveFallback(); else msg("Monte Carlo error: " + m.message, false); }
      };
      worker.onerror = () => { showProgress(false); workerOK = false; worker = null; };
    } catch (e) { workerOK = false; worker = null; }
    return worker;
  }

  function solve() {
    if (solving) return; // a solve is already in flight
    const err = validate();
    if (err) return msg(err, false);
    const params = buildParams(), data = effectiveData();
    const target = Math.min(1, Math.max(0.01, num("targetSuccess", 100) / 100));
    solvePending = { target, basis: state.solveBasis };
    solving = true;
    if (state.solveBasis === "montecarlo") {
      const o = {
        method: $("mcMethod").value, trials: Math.min(5000, clampTrials()),
        block: Math.round(num("mcBlock", 5)), seed: Math.round(num("mcSeed", 12345)),
      };
      const inline = function () {
        const runner = (pp, dd) => SWR.mc.run(pp, dd, Object.assign({}, o, { successOnly: true }));
        applySolve(SWR.core.solveSpending(params, data, target, runner));
      };
      solveFallback = inline;
      const w = getWorker();
      if (w) {
        showProgress(true, 0);
        msg("Finding max spending (Monte Carlo)…", true);
        armSolveTimer();
        w.postMessage({ type: "solve", basis: "montecarlo", params, data, target, method: o.method, trials: o.trials, block: o.block, seed: o.seed });
        return;
      }
      inline();
      return;
    }
    solveFallback = null;
    applySolve(SWR.core.solveSpending(params, data, target));
  }

  function applySolve(max) {
    if (!solving) return; // already applied (e.g. the inline fallback beat the worker)
    solving = false;
    if (solveTimer) { clearTimeout(solveTimer); solveTimer = null; }
    solveFallback = null;
    const target = solvePending ? solvePending.target : num("targetSuccess", 100) / 100;
    const basis = solvePending ? solvePending.basis : "historical";
    solvePending = null;
    showProgress(false);
    // FLOOR to the $100 grid, never round: the bisection returns the highest
    // VERIFIED-passing spending, and success only falls as spending rises --
    // rounding up (even by $50) can tip a knife-edge cycle and re-run below
    // the promised target. applyGsolve floors for the same reason.
    const spend = Math.floor(max / 100) * 100;
    const pctOfPort = (spend / num("initialValue", 1) * 100).toFixed(2);
    $("strategy").value = "constant";
    $("initialSpend").value = spend;
    formatMoneyInput($("initialSpend"));
    syncStrategy(); // after the writeback so the "Initial rate" hint shows the new value
    if (basis === "montecarlo") { $("runMonteCarlo").checked = true; toggleMcOptions(); }
    msg("", true);
    run(); // re-run with the solved spending (run() leaves the solver result box alone)
    // Prominent answer right at the solver so it can't be missed.
    const sr = $("solveResult");
    sr.replaceChildren(
      document.createTextNode("Max spending for " + (target * 100).toFixed(0) + "% " +
        (basis === "montecarlo" ? "Monte Carlo" : "historical") + " success: "),
      el("strong", { text: money(spend) + " / yr" }),
      document.createTextNode(" (" + pctOfPort + "% of portfolio). Set as your spending plan above and re-ran — see the updated results."),
    );
    sr.hidden = false;
  }

  // ---------- percent-of-portfolio guardrail solver ----------
  // Writes a status/answer into the box that sits under the floor/ceiling inputs.
  function gmsg(text, ok) {
    const box = $("gsolveResult");
    box.classList.toggle("err", !ok);
    box.textContent = text;
    box.hidden = false;
  }

  function gsolve() {
    if (solving) return; // a solve (either kind) is already in flight
    const err = validate();
    if (err) return msg(err, false);
    if ($("strategy").value !== "percent")
      return gmsg("Switch the withdrawal strategy to “Percentage of portfolio” to solve a guardrail.", false);
    const flRaw = stripNum($("spendFloor").value || "").trim();
    const clRaw = stripNum($("spendCeiling").value || "").trim();
    const hasFloor = flRaw !== "" && isFinite(parseFloat(flRaw));
    const hasCeil = clRaw !== "" && isFinite(parseFloat(clRaw));
    let solveFor;
    if (hasFloor && hasCeil)
      return gmsg("Clear either the floor or the ceiling above — I solve whichever you leave blank.", false);
    else if (hasFloor) solveFor = "ceiling";
    else if (hasCeil) solveFor = "floor";
    else return gmsg("Enter a floor or a ceiling above (today's $) and leave the other blank — I'll solve the blank one.", false);

    const params = buildParams(), data = effectiveData();
    const target = Math.min(1, Math.max(0.01, num("gsolveTarget", 95) / 100));
    solvePending = { kind: "guard", solveFor: solveFor, target: target, basis: state.gsolveBasis };
    solving = true;
    if (state.gsolveBasis === "montecarlo") {
      const o = {
        method: $("mcMethod").value, trials: Math.min(5000, clampTrials()),
        block: Math.round(num("mcBlock", 5)), seed: Math.round(num("mcSeed", 12345)),
      };
      const inline = function () {
        const runner = (pp, dd) => SWR.mc.run(pp, dd, Object.assign({}, o, { successOnly: true }));
        applyGsolve(SWR.core.solveGuardrail(params, data, { solveFor: solveFor, target: target, runner: runner }));
      };
      solveFallback = inline;
      const w = getWorker();
      if (w) {
        showProgress(true, 0);
        gmsg("Solving the " + solveFor + " (Monte Carlo)…", true);
        armSolveTimer();
        w.postMessage({ type: "gsolve", basis: "montecarlo", params: params, data: data,
          solveFor: solveFor, target: target, method: o.method, trials: o.trials, block: o.block, seed: o.seed });
        return;
      }
      inline();
      return;
    }
    solveFallback = null;
    applyGsolve(SWR.core.solveGuardrail(params, data, { solveFor: solveFor, target: target }));
  }

  function applyGsolve(result) {
    if (!solving) return; // already applied (inline fallback beat the worker)
    solving = false;
    if (solveTimer) { clearTimeout(solveTimer); solveTimer = null; }
    solveFallback = null;
    const pend = solvePending || {};
    solvePending = null;
    showProgress(false);
    const target = pend.target != null ? pend.target : num("gsolveTarget", 95) / 100;
    const basis = pend.basis === "montecarlo" ? "montecarlo" : "historical";
    const basisLabel = basis === "montecarlo" ? "Monte Carlo" : "historical";
    const tgt = (target * 100).toFixed(0);
    const box = $("gsolveResult");

    if (!result || !result.feasible) {
      const best = result && result.bestSuccess != null ? (result.bestSuccess * 100).toFixed(1) : "?";
      gmsg(result && result.reason === "floorTooHigh"
        ? "Not achievable: even capping every year at your floor, the plan only reaches " + best +
          "% success — the floor itself is too high for " + tgt + "%. Lower the floor or the target."
        : "Not achievable: even with no floor this percentage-of-portfolio plan only reaches " + best +
          "% success. Lower the target, the withdrawal %, or other spending.", false);
      return;
    }

    // Feasible: write the solved bound into its input, then re-run (still percent).
    box.classList.remove("err");
    if (basis === "montecarlo") { $("runMonteCarlo").checked = true; toggleMcOptions(); }
    let lead, value = null;
    if (result.solveFor === "ceiling") {
      if (result.unbounded) {
        $("spendCeiling").value = "";
        lead = "No ceiling needed — even uncapped, your floor keeps ≥" + tgt + "% " + basisLabel + " success.";
      } else {
        value = Math.floor(result.value / 100) * 100;
        $("spendCeiling").value = value;
        formatMoneyInput($("spendCeiling"));
        lead = "Highest spending ceiling for ≥" + tgt + "% " + basisLabel + " success:";
      }
    } else { // floor
      value = result.atCap ? result.value : Math.floor(result.value / 100) * 100;
      $("spendFloor").value = value;
      formatMoneyInput($("spendFloor"));
      lead = result.atCap
        ? "Floor can rise all the way to your ceiling (constant spending) and still keep ≥" + tgt + "% " + basisLabel + " success:"
        : "Highest safe spending floor for ≥" + tgt + "% " + basisLabel + " success:";
    }
    syncStrategy();
    run(); // re-run with the percentage strategy + the solved guardrail
    const nodes = [document.createTextNode(lead + " ")];
    if (value != null) {
      nodes.push(el("strong", { text: money(value) + " / yr" }));
      nodes.push(document.createTextNode(" — applied above and re-ran; see the updated results."));
    } else {
      nodes.push(document.createTextNode(" Cleared the ceiling and re-ran."));
    }
    box.replaceChildren.apply(box, nodes);
    box.hidden = false;
  }

  // ---------- rendering ----------
  function setMode(mode) {
    if (mode === "montecarlo" && !state.montecarlo) return;
    state.mode = mode;
    $("trajMode").querySelectorAll("button").forEach((b) => b.classList.toggle("seg-on", b.dataset.mode === mode));
    render(mode === "montecarlo" ? state.montecarlo : state.historical);
  }
  function enableMcTab(on) {
    $("trajMode").querySelector('[data-mode="montecarlo"]').disabled = !on;
  }

  function statCard(k, v) { return el("div", { class: "stat" }, [el("div", { class: "k", text: k }), el("div", { class: "v", text: v })]); }
  function kv(k, v, cls) {
    const right = cls ? el("span", { class: "tag " + cls, text: v }) : document.createTextNode(v);
    return el("div", { class: "kv" }, [el("span", { class: "k", text: k }), el("span", null, [right])]);
  }
  function block(title, rows) { return el("div", { class: "detail-block" }, [el("h4", { text: title })].concat(rows)); }
  function noteBlock(title, text) { return el("div", { class: "detail-block" }, [el("h4", { text: title }), el("p", { class: "muted small", text: text })]); }

  function render(s) {
    if (!s || s.total === 0) {
      $("successBig").textContent = "—";
      $("successCard").className = "success-card";
      $("successLabel").textContent = "Not enough historical data for this allocation and length.";
      $("headStats").replaceChildren();
      $("rbdCard").hidden = true;
      $("detailBody").replaceChildren(el("p", { class: "muted",
        text: "Try a shorter retirement length, or an allocation with longer history — stocks/bonds reach back to 1871, while gold, cash, corporate bonds, real estate and small-cap begin in 1928." }));
      return;
    }
    const pct = s.successRate * 100;
    $("successBig").textContent = (pct >= 99.95 ? "100" : pct.toFixed(1)) + "%";
    $("successCard").className = "success-card " + (s.successRate >= 0.95 ? "good" : s.successRate >= 0.75 ? "warn" : "bad");
    const unit = s.mode === "montecarlo" ? "trials" : "cycles";
    let label = s.succeeded.toLocaleString() + " of " + s.total.toLocaleString() + " " + unit + " lasted " + s.years + " years";
    if (s.startYears) label += " · retirements starting " + s.startYears.first + "–" + s.startYears.last;
    $("successLabel").textContent = label;

    $("headStats").replaceChildren(
      statCard(s.mode === "montecarlo" ? "Trials" : "Historical cycles", s.total.toLocaleString()),
      statCard("Median end (real)", money(s.endingReal.median)),
      statCard("10th pct (real)", money(s.endingReal.p10)),
      statCard("Failures", String(s.failed))
    );

    const blocks = [];
    blocks.push(block("Ending portfolio · today's $", [
      kv("Minimum", money(s.endingReal.min)),
      kv("5th percentile", money(s.endingReal.p5)),
      kv("10th percentile", money(s.endingReal.p10)),
      kv("Median", money(s.endingReal.median)),
      kv("90th percentile", money(s.endingReal.p90)),
      kv("Maximum", money(s.endingReal.max)),
      kv("Average", money(s.endingReal.mean)),
    ]));
    if (s.spending && s.spending.annual) {
      const sp = s.spending, a = sp.annual;
      // The CAPE rule reads each start year's own valuation, so in a historical
      // run "first year" is a RANGE across cycles -- one cycle's number would
      // misleadingly disagree with the today's-CAPE readout under the inputs.
      const fyVaries = sp.firstYearMax > sp.firstYearMin * 1.001 + 1;
      const rows = [
        fyVaries
          ? kv("First year (by start-year CAPE)", money(sp.firstYearMin) + " – " + money(sp.firstYearMax))
          : kv("First year", money(sp.firstYear)),
        kv("Typical (median)", money(a.median)),
        kv("Range (10–90%)", money(a.p10) + " – " + money(a.p90)),
      ];
      if (sp.leanestYear) {
        const lean = sp.leanestYear;
        // For variable strategies (percent/VPW/CAPE), spending is cut in bad
        // sequences, so surface the rough-retirement low -- not just the typical
        // leanest year, which for Monte Carlo sits near the first year and hides
        // the downside. Constant/guardrail plans stay a single row.
        if (lean.p10 < lean.median * 0.98) {
          rows.push(kv("Leanest year (typical)", money(lean.median)));
          rows.push(kv("Leanest year (rough case)", money(lean.p10)));
        } else {
          rows.push(kv("Leanest year", money(lean.median)));
        }
      }
      rows.push(kv("Lifetime average", money(sp.avgMedian)));
      blocks.push(block("Annual spending · today's $", rows));
    }
    const rep = s.representative;
    const repBlock = (label, c) => {
      const rows = [];
      if (c.startYear != null) rows.push(kv("Retired in", String(c.startYear)));
      rows.push(kv("Outcome", c.success ? "Survived" : "Failed yr " + (c.failedYear + 1), c.success ? "ok" : "no"));
      rows.push(kv("End (real)", money(c.endValueReal)));
      rows.push(kv("End (nominal)", money(c.endValue)));
      return block(label, rows);
    };
    blocks.push(repBlock("Worst case", rep.worst));
    blocks.push(repBlock("Median case", rep.median));
    blocks.push(repBlock("Best case", rep.best));
    if (s.mode === "montecarlo" && s.sampling) {
      blocks.push(block("Monte Carlo", [
        kv("Method", s.method),
        kv("Trials", s.trials.toLocaleString()),
        kv("Mean return", (s.sampling.retMean * 100).toFixed(1) + "%"),
        kv("Return σ", (s.sampling.retStdev * 100).toFixed(1) + "%"),
        kv("Mean inflation", (s.sampling.inflMean * 100).toFixed(1) + "%"),
      ]));
    }
    if (s.startYears && s.startYears.first < 1928) {
      blocks.push(noteBlock("About 1871–1927 data",
        "Cycles starting before 1928 use returns reconstructed from Robert Shiller's annual data (stocks, bonds and inflation only). 1928 onward uses Damodaran's exact annual totals and FRED CPI."));
    }
    $("detailBody").replaceChildren.apply($("detailBody"), blocks);

    const opts = { real: state.dollar === "real" };
    requestAnimationFrame(() => {
      SWR.charts.trajectory($("trajCanvas"), s, opts);
      SWR.charts.histogram($("histCanvas"), s);
      renderMortality(s);
    });
  }

  // "Rich, broke, or dead?" — combine the simulation's failure probability with
  // SSA survival probabilities for the given age/sex. Independent of real/nominal,
  // so it re-renders cheaply when age/sex change (no re-simulation needed).
  function renderMortality(s) {
    const card = $("rbdCard");
    if (!SWR.mortality || !window.SWR_MORTALITY || !s || !s.brokeByYear || !s.brokeByYear.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const age = Math.max(18, Math.min(110, Math.round(num("currentAge", 65))));
    const sex = $("sex").value;
    const survival = SWR.mortality.survivalCurve(age, sex, s.years);
    SWR.charts.richBrokeDead($("rbdCanvas"), { years: s.years, survival, brokeByYear: s.brokeByYear, startAge: age });
    const le = SWR.mortality.lifeExpectancy(age, sex);
    const deadByEnd = (1 - (survival[s.years] || 0)) * 100;
    $("rbdSub").textContent = "SSA life table · life expectancy ≈ age " + Math.round(age + le) +
      " · " + deadByEnd.toFixed(0) + "% chance deceased by year " + s.years;
  }

  function redrawCharts() {
    const s = state.mode === "montecarlo" ? state.montecarlo : state.historical;
    if (!s || s.total === 0) return;
    SWR.charts.trajectory($("trajCanvas"), s, { real: state.dollar === "real" });
    SWR.charts.histogram($("histCanvas"), s);
    renderMortality(s);
  }

  // ---------- loan / compound / retirement view switching ----------
  function switchView(view) {
    state.view = view;
    $("viewMain").hidden = view !== "main";
    $("viewLoan").hidden = view !== "loan";
    $("viewCompound").hidden = view !== "compound";
    $("viewTabs").querySelectorAll("button").forEach((b) => b.classList.toggle("seg-on", b.dataset.view === view));
    if (view === "loan") {
      if (!state.loanDone) { runLoan(); state.loanDone = true; }
      else if (state.loan) SWR.charts.loanChart($("loanCanvas"), state.loan);
    } else if (view === "compound") {
      if (!state.compoundDone) { runCompound(); state.compoundDone = true; }
      else if (state.compound) SWR.charts.compoundChart($("compCanvas"), state.compound);
    } else {
      redrawCharts(); // canvases were hidden; refresh sizes
    }
  }

  function runLoan(ev) {
    if (ev) ev.preventDefault();
    const m = $("loanMsg");
    const principal = num("loanAmount", 0);
    const months = Math.round(num("loanTerm", 30) * 12);
    if (!(principal > 0) || !isFinite(principal) || principal > MAX_PORTFOLIO) {
      m.textContent = "Enter a loan amount between $1 and $10 trillion."; m.className = "formmsg"; return;
    }
    if (!(months >= 1)) { m.textContent = "Enter a term of at least 1 month."; m.className = "formmsg"; return; }
    m.textContent = "";
    state.loan = SWR.amortize.schedule({ principal, apr: num("loanApr", 0), months, extra: num("loanExtra", 0) });
    renderLoan(state.loan);
  }

  function renderLoan(sched) {
    // Exact dollars-and-cents: the payment is THE number people compare offers by.
    $("loanPayment").textContent = "$" + sched.payment.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dur = (mo) => Math.floor(mo / 12) + "y " + (mo % 12) + "m";
    const cards = [
      statCard("Total interest", money(sched.totalInterest)),
      statCard("Total paid", money(sched.totalPaid)),
      statCard("Payoff time", dur(sched.payoffMonths)),
      sched.monthsSaved > 0 ? statCard("Time saved", dur(sched.monthsSaved)) : statCard("Loan amount", money(sched.principal)),
    ];
    $("loanStats").replaceChildren.apply($("loanStats"), cards);
    requestAnimationFrame(() => SWR.charts.loanChart($("loanCanvas"), sched));
    // Yearly breakdown.
    const years = [];
    for (const r of sched.rows) {
      const y = Math.ceil(r.month / 12);
      const e = years[y - 1] || (years[y - 1] = { year: y, interest: 0, principal: 0, balance: 0 });
      e.interest += r.interest; e.principal += r.principal; e.balance = r.balance;
    }
    const rows = years.map((y) => el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Year " + y.year }),
      el("span", null, [document.createTextNode(money(y.principal) + " prin · " + money(y.interest) + " int · " + money(y.balance) + " left")]),
    ]));
    $("loanSchedule").replaceChildren(el("div", { class: "detail-block" }, [el("h4", { text: "Per year" })].concat(rows)));
  }

  // ---------- compound interest view ----------
  function runCompound(ev) {
    if (ev) ev.preventDefault();
    const m = $("compMsg");
    const principal = num("compPrincipal", 0), annual = num("compAddition", 0);
    if (!(principal >= 0) || !isFinite(principal) || principal > MAX_PORTFOLIO ||
        !(annual >= 0) || !isFinite(annual) || annual > MAX_PORTFOLIO) {
      m.textContent = "Enter a principal and annual addition between $0 and $10 trillion."; m.className = "formmsg"; return;
    }
    if (!(principal > 0 || annual > 0)) {
      m.textContent = "Enter a starting principal and/or an annual addition."; m.className = "formmsg"; return;
    }
    m.textContent = "";
    state.compound = SWR.compound.grow({
      principal, annual,
      years: num("compYears", 5),
      rate: num("compRate", 5) / 100,
      times: num("compTimes", 1),
      timing: state.compTiming,
    });
    renderCompound(state.compound);
  }

  function renderCompound(res) {
    // Exact dollars-and-cents (not the abbreviated $1.9k form): this number gets
    // compared against other calculators, so the cents must be visible.
    $("compFv").textContent = "$" + res.fv.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cards = [
      statCard("Total contributed", money(res.contributed)),
      statCard("Interest earned", money(res.interest)),
      statCard("Growth multiple", (res.contributed > 0 ? (res.fv / res.contributed).toFixed(2) : "—") + "×"),
      statCard("Rate", (res.rate * 100).toFixed(2) + "% · " + res.times + "×/yr"),
    ];
    $("compStats").replaceChildren.apply($("compStats"), cards);
    requestAnimationFrame(() => SWR.charts.compoundChart($("compCanvas"), res));
    const rows = res.series.slice(1).map((p, i) => {
      const prev = res.series[i];
      const interest = p.balance - prev.balance - res.annual;
      return el("div", { class: "kv" }, [
        el("span", { class: "k", text: "Year " + p.year }),
        el("span", null, [document.createTextNode(
          money(res.annual) + " added · " + money(interest) + " interest · " + money(p.balance) + " balance")]),
      ]);
    });
    $("compSchedule").replaceChildren(el("div", { class: "detail-block" }, [el("h4", { text: "Per year" })].concat(rows)));
  }

  function showProgress(on, v) {
    $("progressWrap").hidden = !on;
    if (on) $("progressBar").style.width = Math.round((v || 0) * 100) + "%";
  }
  function msg(text, ok) {
    const m = $("formMsg");
    m.textContent = text || "";
    m.className = "formmsg" + (text && ok ? " ok" : "");
  }

  // ---------- shareable URL state ----------
  function gather() {
    const o = {};
    // stripNum: share-links carry plain digits, not display commas.
    PERSIST.forEach((id) => { const e = $(id); if (!e) return; o[id] = e.type === "checkbox" ? (e.checked ? 1 : 0) : stripNum(e.value); });
    o.inc = readFlows("incomeRows", "income").map((f) => [f.amount, f.start, f.end, f.cola ? 1 : 0, f.note || ""]);
    o.adj = readFlows("adjustRows", null).map((f) => [f.kind === "income" ? 1 : 0, f.amount, f.start, f.end, f.cola ? 1 : 0, f.note || ""]);
    return o;
  }
  function updateHash() {
    try { history.replaceState(null, "", "#" + btoa(encodeURIComponent(JSON.stringify(gather())))); } catch (e) {}
  }
  function applyState(o) {
    PERSIST.forEach((id) => {
      if (!(id in o)) return;
      const e = $(id); if (!e) return;
      if (e.type === "checkbox") e.checked = !!(+o[id]); else e.value = String(o[id]);
    });
    // Cap the row count so a hostile hash can't spawn a million DOM nodes.
    // Notes are optional trailing strings (older links lack them); anything
    // non-string from a crafted hash is dropped, and length is capped.
    const noteOf = (x) => (typeof x === "string" ? x.slice(0, MAX_NOTE) : "");
    clearRows("incomeRows");
    (Array.isArray(o.inc) ? o.inc.slice(0, MAX_FLOWS) : []).forEach((a) =>
      addFlowRow($("incomeRows"), false, { amount: +a[0], start: +a[1], end: +a[2], cola: !!+a[3], kind: "income", note: noteOf(a[4]) }));
    clearRows("adjustRows");
    (Array.isArray(o.adj) ? o.adj.slice(0, MAX_FLOWS) : []).forEach((a) =>
      addFlowRow($("adjustRows"), true, { kind: +a[0] ? "income" : "expense", amount: +a[1], start: +a[2], end: +a[3], cola: !!+a[4], note: noteOf(a[5]) }));
  }
  function loadHash() {
    if (!location.hash || location.hash.length < 2) return false;
    try {
      const o = JSON.parse(decodeURIComponent(atob(location.hash.slice(1))));
      if (o && typeof o === "object") { applyState(o); return true; }
    } catch (e) { /* ignore malformed hash */ }
    return false;
  }

  // ---------- print report ----------
  // Rebuilt from scratch on every print: a light, self-contained summary of the
  // current inputs + latest results. All dynamic data lands via textContent
  // (never innerHTML), so user/hash-supplied notes stay inert. Chart canvases
  // are snapshotted to data: URIs (the CSP allows img-src data:) after a
  // temporary light-theme redraw so the printout is dark-on-white ink even if
  // the app is in dark mode; the on-screen theme is restored right after.
  const ASSET_NAMES = { stocks: "stocks", bonds: "bonds", gold: "gold", cash: "cash", corp: "corp bonds", reit: "REIT", smallcap: "small-cap" };
  const fmtExact = (x) => "$" + Math.round(x).toLocaleString("en-US");
  function rptSection(title) {
    const s = el("section", { class: "rpt-sec" });
    s.appendChild(el("h2", { text: title }));
    return s;
  }
  function rptKV(sec, k, v) {
    sec.appendChild(el("div", { class: "rpt-kv" }, [el("span", { class: "rpt-k", text: k }), el("span", { class: "rpt-v", text: v })]));
  }
  function strategyText() {
    const st = $("strategy").value;
    let t;
    if (st === "percent") {
      t = num("spendPercent", 4) + "% of portfolio, withdrawn " +
        ($("withdrawFreqVal").value === "monthly" ? "monthly (from a 3-mo T-bill cash bucket)" : "annually");
    } else if (st === "vpw") t = "VPW (amortization) at " + num("vpwReturn", 3.4) + "% assumed real return";
    else if (st === "cape") t = "CAPE-based: " + num("capeA", 1.75) + "% + " + num("capeB", 0.5) + " × 1/CAPE (current CAPE " + (currentCape() > 0 ? currentCape().toFixed(1) : "n/a") + ")";
    else if (st === "guyton") t = "Guyton-Klinger from " + fmtExact(num("initialSpend", 0)) + "/yr, " + num("gkGuard", 20) + "% guardrails, " + num("gkAdjust", 10) + "% cut/raise";
    else t = "Constant (inflation-adjusted): " + fmtExact(num("initialSpend", 0)) + "/yr";
    const fl = parseFloat(stripNum($("spendFloor").value));
    const cl = parseFloat(stripNum($("spendCeiling").value));
    if (isFinite(fl)) t += "; floor " + fmtExact(fl);
    if (isFinite(cl)) t += "; ceiling " + fmtExact(cl);
    return t;
  }
  function flowText(f) {
    return (f.kind === "income" ? "Income " : "Expense ") + fmtExact(f.amount) + "/yr, years " +
      f.start + "–" + f.end + (f.cola ? ", COLA" : ", flat") + (f.note ? " — " + f.note : "");
  }
  function rptResults(rpt, label, s, isMC) {
    const sec = rptSection(label);
    rptKV(sec, "Success rate", (s.successRate * 100).toFixed(1) + "% — " + s.succeeded + " of " + s.total + (isMC ? " trials" : " cycles") + " lasted the full " + s.years + " years");
    if (!isMC && s.startYears) rptKV(sec, "Cycle start years", s.startYears.first + "–" + s.startYears.last);
    if (!isMC && s.representative && s.representative.worst) {
      const w = s.representative.worst;
      rptKV(sec, "Worst cycle", w.startYear + (w.success ? " (survived)" : " (failed in year " + (w.failedYear + 1) + ")"));
    }
    rptKV(sec, "Ending balance, real (median)", money(s.endingReal.median));
    rptKV(sec, "Ending balance, real (10th–90th pctl)", money(s.endingReal.p10) + " – " + money(s.endingReal.p90));
    rptKV(sec, "Ending balance, real (worst)", money(s.endingReal.min));
    const sp = s.spending;
    if (sp) {
      rptKV(sec, "First-year spending", sp.firstYearMax > sp.firstYearMin + 0.5
        ? fmtExact(sp.firstYearMin) + " – " + fmtExact(sp.firstYearMax) + " (varies by start-year valuation)"
        : fmtExact(sp.firstYear));
      if (sp.leanestYear && sp.leanestYear.p10 < sp.leanestYear.median * 0.98) {
        rptKV(sec, "Leanest year (typical / rough case)", fmtExact(sp.leanestYear.median) + " / " + fmtExact(sp.leanestYear.p10));
      }
      if (sp.avgMedian) rptKV(sec, "Average yearly spending (median cycle)", fmtExact(sp.avgMedian));
    }
    rpt.appendChild(sec);
  }
  function buildReport() {
    const active = state.mode === "montecarlo" ? state.montecarlo : state.historical;
    if (!active || !active.total) return false;
    const rpt = $("report");

    // Snapshot the charts in light theme (print is paper-white); restore after.
    const themeBefore = document.documentElement.getAttribute("data-theme");
    if (themeBefore !== "light") { document.documentElement.setAttribute("data-theme", "light"); redrawCharts(); }
    const shots = [];
    [["trajCanvas", "Portfolio balance over time"], ["histCanvas", "Ending balance distribution (real, log scale)"], ["rbdCanvas", "Rich, broke or dead"]].forEach((pair) => {
      const c = $(pair[0]);
      if (!c || typeof c.toDataURL !== "function") return;
      if (pair[0] === "rbdCanvas" && $("rbdCard").hidden) return;
      try { shots.push([pair[1], c.toDataURL("image/png")]); } catch (e) { /* tainted/unrendered: skip */ }
    });
    if (themeBefore !== "light") { document.documentElement.setAttribute("data-theme", themeBefore); redrawCharts(); }

    rpt.replaceChildren();
    rpt.appendChild(el("h1", { text: "WebSWR — retirement simulation report" }));
    rpt.appendChild(el("p", { class: "rpt-sub", text: "Generated " + new Date().toLocaleString() + " · showing the " + (state.mode === "montecarlo" ? "Monte Carlo" : "historical backtest") + " view" }));

    const plan = rptSection("Plan");
    rptKV(plan, "Starting portfolio", fmtExact(num("initialValue", 0)));
    rptKV(plan, "Retirement length", Math.round(num("years", 30)) + " years");
    const alloc = [];
    for (const id in ALLOC) { const v = num(id, 0); if (v > 0) alloc.push(v + "% " + ASSET_NAMES[ALLOC[id]]); }
    rptKV(plan, "Allocation", alloc.join(" · "));
    rptKV(plan, "Withdrawal strategy", strategyText());
    rptKV(plan, "Fees / tax on withdrawals", num("feeRate", 0) + "% / " + num("taxRate", 0) + "%");
    rptKV(plan, "Inflation", $("inflationMode").value === "fixed" ? "fixed " + num("fixedInflation", 3) + "%/yr" : "historical CPI");
    rptKV(plan, "Age / sex (for mortality overlay)", Math.round(num("currentAge", 65)) + " / " + $("sex").value);
    if (state.montecarlo) {
      rptKV(plan, "Monte Carlo settings", $("mcMethod").value + ", " + Math.round(num("mcTrials", 10000)).toLocaleString("en-US") + " trials" +
        ($("mcMethod").value === "block" ? ", block " + Math.round(num("mcBlock", 5)) : "") + ", seed " + Math.round(num("mcSeed", 0)));
    }
    rpt.appendChild(plan);

    const flows = rptSection("Income & adjustments");
    const inc = readFlows("incomeRows", "income"), adj = readFlows("adjustRows", null);
    if (!inc.length && !adj.length) flows.appendChild(el("p", { class: "rpt-none", text: "None" }));
    inc.concat(adj).forEach((f) => flows.appendChild(el("p", { class: "rpt-flow", text: flowText(f) })));
    rpt.appendChild(flows);

    if (state.historical && state.historical.total) {
      rptResults(rpt, "Results — historical backtest", state.historical, false);
    }
    if (state.montecarlo && state.montecarlo.total) {
      rptResults(rpt, "Results — Monte Carlo (" + state.montecarlo.method + ")", state.montecarlo, true);
    }

    shots.forEach((pair) => {
      const fig = el("figure", { class: "rpt-fig" });
      fig.appendChild(el("figcaption", { text: pair[0] + " — " + (state.mode === "montecarlo" ? "Monte Carlo" : "historical") + " view, " + (state.dollar === "real" ? "real" : "nominal") + " dollars" }));
      fig.appendChild(el("img", { src: pair[1], alt: pair[0] }));
      rpt.appendChild(fig);
    });

    const foot = rptSection("Reproduce this simulation");
    updateHash();
    foot.appendChild(el("p", { class: "rpt-url", text: location.href }));
    let vintage = "Market data " + DATA.meta.firstYear + "–" + DATA.meta.lastYear + ", generated " + DATA.meta.generated;
    if (CAPE && CAPE.latest) vintage += " · CAPE as of " + CAPE.latest.date;
    foot.appendChild(el("p", { class: "rpt-vintage", text: vintage }));
    foot.appendChild(el("p", { class: "rpt-disclaimer", text: "Educational tool — a historical/statistical simulation, not financial advice and not a guarantee of future results." }));
    rpt.appendChild(foot);
    return true;
  }
  function printReport() {
    if (buildReport()) window.print();
    else msg("Run a simulation first — there are no results to report.", false);
  }

  // ---------- theme ----------
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("swr-theme", t); } catch (e) {}
    redrawCharts();
  }

  // ---------- wiring ----------
  function wire() {
    $("inputs").addEventListener("submit", run);
    $("strategy").addEventListener("change", syncStrategy);
    $("initialValue").addEventListener("input", syncStrategy);
    $("initialSpend").addEventListener("input", syncStrategy);
    ["capeA", "capeB", "spendFloor", "spendCeiling"].forEach((id) => $(id).addEventListener("input", updateCapeHint));
    MONEY_IDS.forEach((id) => attachMoney($(id)));
    Object.keys(ALLOC).forEach((id) => $(id).addEventListener("input", updateAllocSum));
    $("inflationMode").addEventListener("change", toggleFixed);
    $("runMonteCarlo").addEventListener("change", toggleMcOptions);
    $("mcMethod").addEventListener("change", toggleMcBlock);
    const reRbd = () => {
      const s = state.mode === "montecarlo" ? state.montecarlo : state.historical;
      if (s && s.total) { renderMortality(s); updateHash(); }
    };
    $("currentAge").addEventListener("input", reRbd);
    $("sex").addEventListener("change", reRbd);
    $("addIncome").addEventListener("click", () => addFlowRow($("incomeRows"), false, {}));
    $("addAdjust").addEventListener("click", () => addFlowRow($("adjustRows"), true, {}));
    $("withdrawFreq").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => { $("withdrawFreqVal").value = b.dataset.freq; syncFreq(); }));
    $("solveBtn").addEventListener("click", solve);
    $("gsolveBtn").addEventListener("click", gsolve);
    $("gsolveBasis").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.gsolveBasis = b.dataset.basis;
        $("gsolveBasis").querySelectorAll("button").forEach((x) => x.classList.toggle("seg-on", x === b));
      }));
    $("resetBtn").addEventListener("click", () => { history.replaceState(null, "", location.pathname); location.reload(); });
    $("shareBtn").addEventListener("click", () => {
      updateHash();
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(
        () => msg("Link copied — it restores these exact inputs.", true),
        () => msg("Could not copy; copy the URL from the address bar.", false));
      else msg("Clipboard unavailable; copy the URL from the address bar.", false);
    });
    $("printBtn").addEventListener("click", printReport);
    // Cmd/Ctrl+P without the button: build the report just-in-time. (The button
    // path triggers this too via window.print(); the rebuild is idempotent.)
    window.addEventListener("beforeprint", () => { buildReport(); });
    $("themeBtn").addEventListener("click", () =>
      setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));
    const showHelp = (on) => { $("helpOverlay").hidden = !on; };
    $("helpBtn").addEventListener("click", () => showHelp(true));
    $("helpClose").addEventListener("click", () => showHelp(false));
    $("helpOverlay").addEventListener("click", (e) => { if (e.target === $("helpOverlay")) showHelp(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") showHelp(false); });
    $("viewTabs").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => switchView(b.dataset.view)));
    $("loanInputs").addEventListener("submit", runLoan);
    $("compoundInputs").addEventListener("submit", runCompound);
    $("compTiming").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.compTiming = b.dataset.timing;
        $("compTiming").querySelectorAll("button").forEach((x) => x.classList.toggle("seg-on", x === b));
      }));
    $("trajMode").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => { if (!b.disabled) setMode(b.dataset.mode); }));
    $("dollarMode").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.dollar = b.dataset.dollar;
        $("dollarMode").querySelectorAll("button").forEach((x) => x.classList.toggle("seg-on", x === b));
        $("trajUnit").textContent = state.dollar === "real" ? "real / today's $" : "nominal $";
        redrawCharts();
      }));
    $("solveBasis").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.solveBasis = b.dataset.basis;
        $("solveBasis").querySelectorAll("button").forEach((x) => x.classList.toggle("seg-on", x === b));
      }));
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(redrawCharts, 150); });
  }

  function init() {
    let t; try { t = localStorage.getItem("swr-theme"); } catch (e) {}
    if (!t) t = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    wire();
    // Fresh Monte Carlo seed on every page load (6 digits, human-copyable).
    // Must run BEFORE loadHash(): share links carry mcSeed, so a restored link
    // reproduces its exact run. The user can also type a seed of their own --
    // nothing touches this field again until the next reload.
    $("mcSeed").value = String(100000 + Math.floor(Math.random() * 900000));
    loadHash();
    MONEY_IDS.forEach((id) => formatMoneyInput($(id))); // defaults + hash values get commas
    syncStrategy(); syncFreq(); updateAllocSum(); toggleFixed(); toggleMcOptions(); toggleMcBlock();
    run();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
