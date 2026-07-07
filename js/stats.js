/*
 * stats.js -- small, dependency-free numeric helpers.
 * Pure functions only (no DOM): shared by the main thread and the Web Worker.
 * Attaches to the global `SWR` namespace (works in window AND worker scope).
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});

  // --- Seedable PRNG (mulberry32). Deterministic => reproducible Monte Carlo. ---
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Standard-normal sample via Box-Muller, driven by a uniform rng() in [0,1).
  function normal(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function mean(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }

  function variance(a, m) {
    if (a.length < 2) return 0;
    m = m == null ? mean(a) : m;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return s / (a.length - 1); // sample variance
  }

  function stdev(a, m) {
    return Math.sqrt(variance(a, m));
  }

  // Percentile p in [0,100] over an ALREADY-SORTED ascending array (linear interp).
  function percentileSorted(sorted, p) {
    const n = sorted.length;
    if (!n) return NaN;
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[n - 1];
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Covariance matrix of k column-series (each equal length). Returns {means, cov}.
  function covMatrix(cols) {
    const k = cols.length, n = cols[0].length;
    const means = cols.map(mean);
    const C = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < k; i++) {
      for (let j = i; j < k; j++) {
        let s = 0;
        for (let t = 0; t < n; t++) s += (cols[i][t] - means[i]) * (cols[j][t] - means[j]);
        C[i][j] = C[j][i] = n > 1 ? s / (n - 1) : 0;
      }
    }
    return { means, cov: C };
  }

  // Lower-triangular Cholesky factor L (L*Lᵀ = A). Jitters the diagonal if needed
  // so a near-singular sample covariance still factors.
  function cholesky(A) {
    const n = A.length;
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = 0;
        for (let k = 0; k < j; k++) s += L[i][k] * L[j][k];
        if (i === j) L[i][j] = Math.sqrt(Math.max(A[i][i] - s, 1e-12));
        else L[i][j] = (A[i][j] - s) / (L[j][j] || 1e-12);
      }
    }
    return L;
  }

  SWR.stats = {
    mulberry32, normal, mean, variance, stdev, percentileSorted, covMatrix, cholesky,
  };
})(typeof self !== "undefined" ? self : this);
