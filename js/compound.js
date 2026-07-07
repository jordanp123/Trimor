/*
 * compound.js -- compound interest / future value (pure, DOM-free).
 * All inputs are clamped so a hostile value can't produce NaN/Infinity or hang;
 * everything is closed-form (no per-period loops).
 *
 * Semantics (the classic "compound interest calculator" conventions):
 *   - rate r compounds `times` times per year: periodic rate i = r/times.
 *   - the ANNUAL addition is spread evenly across compounding periods
 *     (a = annual/times), added at the start or end of each period.
 *   - FV after m periods = P(1+i)^m + a*((1+i)^m - 1)/i  [*(1+i) if start]
 *     (i = 0 degenerates to P + a*m).
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});

  const MAX_YEARS = 200, MAX_TIMES = 365, MAX_AMOUNT = 1e12;

  const clamp = (v, lo, hi, d) => {
    v = +v;
    if (!isFinite(v)) v = d;
    return Math.min(hi, Math.max(lo, v));
  };

  // p: { principal, annual, years, rate (decimal, 0.05 = 5%), times, timing:"start"|"end" }
  // Returns { fv, principal, annual, years, rate, times, timing,
  //           contributed, interest, series:[{year, balance, contributed}] }.
  function grow(p) {
    const principal = clamp(p.principal, 0, MAX_AMOUNT, 0);
    const annual = clamp(p.annual, 0, MAX_AMOUNT, 0);
    const years = Math.round(clamp(p.years, 1, MAX_YEARS, 1));
    const rate = clamp(p.rate, 0, 1, 0); // 0..100% annually
    const times = Math.round(clamp(p.times, 1, MAX_TIMES, 1));
    const timing = p.timing === "end" ? "end" : "start";

    const i = rate / times;
    const a = annual / times;
    const due = timing === "start" ? 1 + i : 1;

    // Closed-form balance after m compounding periods.
    const fvAt = (m) => {
      const g = Math.pow(1 + i, m);
      return i === 0 ? principal + a * m : principal * g + a * ((g - 1) / i) * due;
    };

    const series = new Array(years + 1);
    for (let y = 0; y <= years; y++) {
      series[y] = { year: y, balance: fvAt(y * times), contributed: principal + annual * y };
    }
    const fv = series[years].balance;
    const contributed = principal + annual * years;
    return {
      fv, principal, annual, years, rate, times, timing,
      contributed, interest: fv - contributed, series,
    };
  }

  SWR.compound = { grow, MAX_YEARS, MAX_TIMES };
})(typeof self !== "undefined" ? self : this);
