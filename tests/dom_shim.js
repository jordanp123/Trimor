/*
 * dom_shim.js -- a minimal browser/DOM/canvas shim so the page scripts can run
 * headlessly in JavaScriptCore (osascript). Lets us smoke-test ui.js + charts.js
 * (read form -> run engine -> render -> draw) with no browser. Not a real DOM:
 * just enough surface for our code, with element values pre-seeded to the
 * index.html defaults. Unknown element ids are recorded so a ui/html id mismatch
 * is caught instead of silently passing.
 */
var self = this;
var window = this;
var devicePixelRatio = 1;

// Segmented-control button specs: container id -> [datasetKey, ...values].
var SEG = {
  trajMode: ["mode", "historical", "montecarlo"],
  dollarMode: ["dollar", "real", "nominal"],
  solveBasis: ["basis", "historical", "montecarlo"],
  gsolveBasis: ["basis", "historical", "montecarlo"],
  viewTabs: ["view", "main", "loan", "compound"],
  compTiming: ["timing", "start", "end"],
  withdrawFreq: ["freq", "annual", "monthly"],
};

function classListFor() {
  var set = {};
  return {
    add: function (c) { set[c] = true; },
    remove: function (c) { delete set[c]; },
    contains: function (c) { return !!set[c]; },
    toggle: function (c, on) { if (on === undefined) on = !set[c]; if (on) set[c] = true; else delete set[c]; return on; },
  };
}

function ctxStub() {
  var noop = function () {};
  return {
    font: "", textAlign: "", textBaseline: "", lineWidth: 1, strokeStyle: "", fillStyle: "",
    setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, fill: noop, fillRect: noop, fillText: noop, arc: noop, arcTo: noop,
    closePath: noop, setLineDash: noop, save: noop, restore: noop,
    measureText: function (s) { return { width: (s ? s.length : 0) * 7 }; },
  };
}

// Minimal selector matcher: ".class", "tag", or '[data-key="value"]' -- the
// only forms the app uses on elements (readFlows row lookups, seg buttons,
// trajMode's [data-mode=...]). Class check covers BOTH the className string
// (set by el()) and the classList set (toggled by seg handlers).
function stubMatches(n, sel) {
  if (sel.charAt(0) === ".") {
    var c = sel.slice(1);
    if (n.classList && n.classList.contains(c)) return true;
    return (" " + (n.className || "") + " ").indexOf(" " + c + " ") >= 0;
  }
  var m = /^\[data-([a-zA-Z-]+)="([^"]*)"\]$/.exec(sel);
  if (m) return n.dataset && n.dataset[m[1]] === m[2];
  return (n.tagName || "").toLowerCase() === sel.toLowerCase();
}

function Stub(tag, id) {
  var children = [], attrs = {};
  // Recursive search over real children AND a seg control's lazy _buttons.
  function collect(node, sel, out, firstOnly) {
    var kids = (node.children || []).concat(node._buttons || []);
    for (var i = 0; i < kids.length; i++) {
      if (stubMatches(kids[i], sel)) { out.push(kids[i]); if (firstOnly) return; }
      collect(kids[i], sel, out, firstOnly);
      if (firstOnly && out.length) return;
    }
  }
  var n = {
    tagName: tag || "div", id: id || "",
    value: "", checked: false, textContent: "", className: "", hidden: false,
    disabled: false, type: "", title: "", min: "", max: "", step: "", placeholder: "", name: "",
    width: 0, height: 0, style: {}, dataset: {}, classList: classListFor(), children: children,
    firstChild: null, lastChild: null, parentNode: null, _ev: {}, _buttons: null,
    appendChild: function (c) { children.push(c); c.parentNode = n; n.firstChild = children[0]; n.lastChild = c; return c; },
    insertBefore: function (c, ref) {
      var i = children.indexOf(ref);
      if (i < 0) children.push(c); else children.splice(i, 0, c);
      c.parentNode = n; n.firstChild = children[0]; n.lastChild = children[children.length - 1];
      return c;
    },
    removeChild: function (c) { var i = children.indexOf(c); if (i >= 0) { children.splice(i, 1); c.parentNode = null; } n.firstChild = children[0] || null; n.lastChild = children[children.length - 1] || null; },
    remove: function () { if (n.parentNode) n.parentNode.removeChild(n); },
    replaceChildren: function () { children.length = 0; for (var i = 0; i < arguments.length; i++) { children.push(arguments[i]); arguments[i].parentNode = n; } n.firstChild = children[0] || null; n.lastChild = children[children.length - 1] || null; },
    addEventListener: function (t, fn) { (n._ev[t] || (n._ev[t] = [])).push(fn); },
    setAttribute: function (k, v) { attrs[k] = v; if (k === "data-theme") n.dataset.theme = v; },
    getAttribute: function (k) { return attrs[k] !== undefined ? attrs[k] : null; },
    querySelector: function (sel) {
      n.querySelectorAll("button"); // materialize a seg control's lazy buttons first
      var out = [];
      collect(n, sel, out, true);
      return out.length ? out[0] : null;
    },
    querySelectorAll: function (sel) {
      // Return the real toggle buttons for segmented controls so ui.js can wire
      // (and our integration test can fire) their click handlers.
      if (sel === "button" && SEG[n.id]) {
        if (!n._buttons) {
          n._buttons = [];
          var spec = SEG[n.id];
          for (var i = 1; i < spec.length; i++) { var b = Stub("button"); b.dataset[spec[0]] = spec[i]; n._buttons.push(b); }
        }
        return n._buttons;
      }
      var out = [];
      collect(n, sel, out, false);
      return out;
    },
    getContext: function () { return ctxStub(); },
    toDataURL: function () { return "data:image/png;base64,c3R1Yg=="; },
    getBoundingClientRect: function () { return { width: 760, height: n.id === "histCanvas" ? 240 : 360, left: 0, top: 0 }; },
  };
  return n;
}

// Inputs pre-seeded with the index.html default values.
var DEFAULTS = {
  initialValue: { type: "number", value: "1000000" }, years: { type: "number", value: "30" },
  feeRate: { type: "number", value: "0.10" },
  currentAge: { type: "number", value: "65" }, sex: { type: "select-one", value: "male" },
  loanAmount: { type: "number", value: "350000" }, loanApr: { type: "number", value: "6.5" },
  loanTerm: { type: "number", value: "30" }, loanExtra: { type: "number", value: "" },
  compPrincipal: { type: "number", value: "1500" }, compAddition: { type: "number", value: "0" },
  compRate: { type: "number", value: "5" }, compYears: { type: "number", value: "5" },
  compTimes: { type: "number", value: "1" },
  allocStocks: { type: "number", value: "75" }, allocBonds: { type: "number", value: "25" },
  allocGold: { type: "number", value: "0" }, allocCash: { type: "number", value: "0" },
  allocCorp: { type: "number", value: "0" }, allocReit: { type: "number", value: "0" }, allocSmallcap: { type: "number", value: "0" },
  strategy: { type: "select-one", value: "constant" }, initialSpend: { type: "number", value: "40000" },
  spendPercent: { type: "number", value: "4" }, vpwReturn: { type: "number", value: "3.4" },
  capeA: { type: "number", value: "1.75" }, capeB: { type: "number", value: "0.5" },
  gkGuard: { type: "number", value: "20" }, gkAdjust: { type: "number", value: "10" },
  spendFloor: { type: "number", value: "" }, spendCeiling: { type: "number", value: "" },
  inflationMode: { type: "select-one", value: "cpi" }, fixedInflation: { type: "number", value: "3" },
  taxRate: { type: "number", value: "0" },
  runMonteCarlo: { type: "checkbox", checked: true }, // forced on to exercise the MC path
  mcMethod: { type: "select-one", value: "bootstrap" }, mcTrials: { type: "number", value: "2000" },
  mcBlock: { type: "number", value: "5" }, mcSeed: { type: "number", value: "" }, // seed is blank in HTML; init() randomizes it
  targetSuccess: { type: "number", value: "100" }, gsolveTarget: { type: "number", value: "95" },
  withdrawFreqVal: { type: "hidden", value: "annual" }, // percentage monthly-payout toggle (hidden input backs the seg control)
};
// Non-input element ids that exist in index.html.
var KNOWN = {};
["themeBtn", "helpBtn", "helpOverlay", "helpClose", "helpTitle", "inputs", "allocSum", "spendRateHint", "fixedInflationWrap", "incomeRows", "addIncome",
 "adjustRows", "addAdjust", "mcOptions", "mcBlockWrap", "runBtn", "solveBtn", "shareBtn",
 "capeRateNow", "withdrawFreq", "withdrawFreqHint", "printBtn", "report",
 "resetBtn", "solveBasis", "solveResult", "gsolveBtn", "gsolveBasis", "gsolveResult", "formMsg", "results", "successCard", "successBig", "successLabel", "headStats",
 "progressWrap", "progressBar", "progressLabel", "trajMode", "dollarMode", "trajUnit", "trajCanvas", "histCanvas",
 "rbdCard", "rbdCanvas", "rbdSub", "detailBody",
 "viewTabs", "viewMain", "viewLoan", "loanInputs", "loanRunBtn", "loanMsg", "loanResults",
 "loanPayCard", "loanPayment", "loanStats", "loanCanvas", "loanSchedule",
 "viewCompound", "compoundInputs", "compRunBtn", "compMsg", "compResults",
 "compFvCard", "compFv", "compStats", "compCanvas", "compSchedule", "compTiming",
].forEach(function (k) { KNOWN[k] = 1; });

var missing = [];
var _els = {};
var document = {
  readyState: "complete",
  documentElement: Stub("html"),
  getElementById: function (id) {
    if (!_els[id]) {
      if (!(id in DEFAULTS) && !KNOWN[id]) missing.push(id);
      var s = Stub("input", id), d = DEFAULTS[id];
      if (d) { if (d.type) s.type = d.type; if ("value" in d) s.value = d.value; if ("checked" in d) s.checked = d.checked; }
      _els[id] = s;
    }
    return _els[id];
  },
  createElement: function (tag) { return Stub(tag); },
  createTextNode: function (t) { return { textContent: String(t), nodeType: 3 }; },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
};

function getComputedStyle() { return { getPropertyValue: function () { return ""; } }; }
function requestAnimationFrame(cb) { cb(); return 0; }
function matchMedia() { return { matches: false }; }
window.matchMedia = matchMedia;
window.addEventListener = function () {};
function setTimeout(fn) { fn(); return 0; } // synchronous => inline MC runs during the test
function clearTimeout() {}
function btoa(s) { return s; }
function atob(s) { return s; }
var navigator = {};
var location = { hash: self.__SWR_TEST_HASH || "", pathname: "/index.html", href: "http://localhost/", reload: function () {} };
var history = { _last: "", replaceState: function (s, t, url) { history._last = url || ""; } };
var localStorage = { getItem: function () { return null; }, setItem: function () {} };
// Shadow jsc's native stdout print(): window.print() must be a no-op here,
// and the smoke test asserts the report path actually invoked it.
var _printed = 0;
var print = function () { _printed++; };
// Worker intentionally undefined -> getWorker() falls back to inline Monte Carlo.
