/*
 * worker.js -- runs the heavy Monte Carlo off the main thread so the UI stays
 * responsive and can show a progress bar. Loads the SAME pure-compute modules
 * the page uses (importScripts, all same-origin -> allowed by a strict CSP).
 */
"use strict";
importScripts("market-data.js", "cape-data.js", "stats.js", "core.js", "montecarlo.js");

self.onmessage = function (e) {
  const msg = e.data || {};
  // The page may send a `data` override (e.g. fixed-inflation mode); otherwise
  // use the authoritative bundled dataset.
  const data = msg.data || self.SWR_DATA;
  try {
    if (msg.type === "montecarlo") {
      const summary = self.SWR.mc.run(msg.params, data, {
        method: msg.method,
        trials: msg.trials,
        block: msg.block,
        seed: msg.seed,
        keepSeries: 250,
        onProgress: function (v) { self.postMessage({ type: "progress", value: v }); },
      });
      self.postMessage({ type: "result", summary: summary });
    } else if (msg.type === "historical") {
      self.postMessage({
        type: "result",
        summary: self.SWR.core.runHistorical(msg.params, data),
      });
    } else if (msg.type === "solve") {
      // Max constant spending for a target success rate, optimized against the
      // chosen engine. Fixed seed keeps the Monte Carlo runner deterministic.
      const runner = msg.basis === "montecarlo"
        ? function (pp, dd) {
            return self.SWR.mc.run(pp, dd, {
              method: msg.method, trials: msg.trials, block: msg.block, seed: msg.seed, successOnly: true,
            });
          }
        : self.SWR.core.runHistorical;
      const max = self.SWR.core.solveSpending(msg.params, data, msg.target, runner,
        function (v) { self.postMessage({ type: "progress", value: v }); });
      self.postMessage({ type: "solveResult", max: max });
    } else if (msg.type === "gsolve") {
      // Percent-of-portfolio guardrail: solve the missing floor/ceiling for a
      // target success rate against the chosen engine (fixed seed => monotone).
      const runner = msg.basis === "montecarlo"
        ? function (pp, dd) {
            return self.SWR.mc.run(pp, dd, {
              method: msg.method, trials: msg.trials, block: msg.block, seed: msg.seed, successOnly: true,
            });
          }
        : self.SWR.core.runHistorical;
      const result = self.SWR.core.solveGuardrail(msg.params, data, {
        solveFor: msg.solveFor, target: msg.target, runner: runner,
        onProgress: function (v) { self.postMessage({ type: "progress", value: v }); },
      });
      self.postMessage({ type: "gsolveResult", result: result });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
