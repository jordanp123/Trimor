/*
 * amortize.js -- loan amortization (mortgage, car, …). Pure, DOM-free.
 * All inputs are bounded so a hostile value can't loop forever or allocate
 * unbounded memory (term capped at 1200 months / 100 years).
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});

  const MAX_MONTHS = 1200;

  // p: { principal, apr (annual %), months, extra (extra principal per month) }
  function schedule(p) {
    const principal = Math.min(1e12, Math.max(0, +p.principal || 0));
    const months = Math.max(1, Math.min(MAX_MONTHS, Math.round(+p.months || 0)));
    const r = Math.min(1, Math.max(0, +p.apr || 0) / 100) / 12; // monthly rate, apr capped at 100%
    const extra = Math.min(principal, Math.max(0, +p.extra || 0));

    const payment = r === 0 ? principal / months : principal * r / (1 - Math.pow(1 + r, -months));

    const rows = [];
    let bal = principal, totalInterest = 0, totalPaid = 0, m = 0;
    while (bal > 0.005 && m < MAX_MONTHS) {
      m++;
      const interest = bal * r;
      let principalPay = payment - interest + extra;
      if (principalPay <= 0) break;            // payment can't cover interest (shouldn't happen)
      if (principalPay > bal) principalPay = bal; // final payment
      const pay = principalPay + interest;
      bal -= principalPay;
      totalInterest += interest;
      totalPaid += pay;
      rows.push({ month: m, interest, principal: principalPay, payment: pay, balance: bal < 0.005 ? 0 : bal });
    }
    return {
      principal, payment, payoffMonths: m, totalInterest, totalPaid, rows,
      monthsSaved: extra > 0 ? months - m : 0,
    };
  }

  SWR.amortize = { schedule, MAX_MONTHS };
})(typeof self !== "undefined" ? self : this);
