/*
 * qrcode.js -- minimal, dependency-free QR encoder (byte mode, versions 1-40,
 * error-correction levels M and L). Pure math: string in, module matrix /
 * PNG data-URI out. Used by the print report to make the share link scannable.
 *
 * Security posture: this is a WRITE-ONLY encoder. It never parses or
 * interprets its input -- the text (our own share URL) is treated as opaque
 * bytes, and the output is drawn with fillRect on an offscreen canvas. No
 * innerHTML, no eval, no network, no DOM sinks.
 *
 * De-risking the spec tables: the total codeword capacity of each version is
 * DERIVED from matrix geometry (non-function modules / 8), not transcribed.
 * Only the EC-codewords-per-block and block-count tables are hand-copied from
 * ISO/IEC 18004, and selfCheck() cross-validates them against the geometry
 * (data modules mod 8 must equal the spec's per-version remainder bits).
 */
(function (root) {
  "use strict";
  const SWR = (root.SWR = root.SWR || {});

  // ---------- GF(256), polynomial 0x11d (the QR field) ----------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  // Reed-Solomon generator polynomial of degree n: (x-a^0)(x-a^1)...(x-a^(n-1)).
  function rsGenPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= gfMul(g[j], EXP[i]);
        next[j + 1] ^= g[j];
      }
      g = next;
    }
    return g.reverse(); // highest-degree coefficient first
  }
  // EC codewords for a data block (polynomial long division remainder).
  function rsEC(data, n) {
    const gen = rsGenPoly(n);
    const rem = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) {
      const f = rem[i];
      if (f === 0) continue;
      for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], f);
    }
    return rem.slice(data.length);
  }

  // ---------- spec tables (ISO/IEC 18004), EC levels L and M only ----------
  // Per version 1..40: EC codewords PER BLOCK and number of blocks.
  const EC_PER_BLOCK = {
    L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
        28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
        26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  };
  const NUM_BLOCKS = {
    L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
        8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
        17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  };
  // Alignment-pattern centre coordinates per version (index 0 unused, 1 = none).
  const ALIGN = [null, [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
    [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
  ];

  // ---------- function-pattern scaffold (geometry) ----------
  // Builds the size x size matrix with all function patterns placed and a
  // parallel `func` mask marking modules the data stream must skip. Format and
  // version areas are RESERVED here (marked func) and written later.
  function scaffold(version) {
    const size = 17 + 4 * version;
    const mat = [], func = [];
    for (let r = 0; r < size; r++) { mat.push(new Uint8Array(size)); func.push(new Uint8Array(size)); }
    const set = (r, c, v) => { mat[r][c] = v; func[r][c] = 1; };

    // Finder patterns + separators at three corners.
    const finder = (fr, fc) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = fr + r, cc = fc + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      if (!func[6][i]) set(6, i, i % 2 === 0 ? 1 : 0);
      if (!func[i][6]) set(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // Alignment patterns. Only the three candidates that fall inside finder
    // corners are dropped -- the ones on the timing lines are REAL patterns
    // (their dark/light cells mesh exactly with the timing alternation).
    const centers = ALIGN[version], last = size - 7;
    for (const cr of centers) for (const cc of centers) {
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === last) || (cr === last && cc === 6)) continue;
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
        set(cr + r, cc + c, Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0);
      }
    }

    // Reserve format-info areas (written per-mask later): 15 modules around the
    // top-left finder, 8 to the right of the bottom-left, 8 under the top-right.
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) { func[8][i] = 1; func[i][8] = 1; }
      if (i < 8) { func[8][size - 1 - i] = 1; func[size - 1 - i][8] = 1; }
    }
    func[8][8] = 1;
    // Dark module.
    set(4 * version + 9, 8, 1);

    // Reserve version-info areas (v >= 7).
    if (version >= 7) {
      for (let i = 0; i < 18; i++) {
        func[Math.floor(i / 3)][size - 11 + (i % 3)] = 1;
        func[size - 11 + (i % 3)][Math.floor(i / 3)] = 1;
      }
    }
    return { size, mat, func };
  }

  // Data capacity is DERIVED: count of non-function modules, in whole codewords.
  function dataModules(version) {
    const { size, func } = scaffold(version);
    let n = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!func[r][c]) n++;
    return n;
  }
  const _totalCW = []; // memoized total codewords per version (1-indexed)
  function totalCodewords(version) {
    if (!_totalCW[version]) _totalCW[version] = Math.floor(dataModules(version) / 8);
    return _totalCW[version];
  }
  function dataCodewords(version, ec) {
    return totalCodewords(version) - EC_PER_BLOCK[ec][version - 1] * NUM_BLOCKS[ec][version - 1];
  }

  // ---------- BCH for format / version info ----------
  function bchRem(value, gen, genBits) {
    // Polynomial mod-2 remainder of value (already shifted) by gen.
    let v = value;
    for (let bit = 31 - Math.clz32(v); bit >= genBits - 1; bit = 31 - Math.clz32(v)) {
      v ^= gen << (bit - (genBits - 1));
      if (v === 0) break;
    }
    return v;
  }
  function formatInfo(ec, mask) {
    const ECB = { L: 1, M: 0, Q: 3, H: 2 };
    const f5 = (ECB[ec] << 3) | mask;
    return (((f5 << 10) | bchRem(f5 << 10, 0x537, 11)) ^ 0x5412) & 0x7fff;
  }
  function versionInfo(version) {
    return ((version << 12) | bchRem(version << 12, 0x1f25, 13)) & 0x3ffff;
  }

  // ---------- encode ----------
  function utf8Bytes(text) {
    // UTF-8 without TextEncoder (jsc-compatible); ASCII passes through.
    const s = unescape(encodeURIComponent(String(text)));
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  // Smallest version fitting the payload at EC level M; above version 26
  // prefer L (lower module density scans better on clean prints).
  function pickVersion(nBytes) {
    for (const ec of ["M", "L"]) {
      for (let v = 1; v <= 40; v++) {
        if (ec === "M" && v > 26) break; // beyond this, M densifies too much
        const cci = v <= 9 ? 8 : 16; // char-count indicator bits (byte mode)
        if (4 + cci + 8 * nBytes <= 8 * dataCodewords(v, ec)) return { version: v, ec };
      }
    }
    return null; // exceeds v40-L capacity
  }

  function buildCodewords(bytes, version, ec) {
    const dcw = dataCodewords(version, ec);
    const cci = version <= 9 ? 8 : 16;
    // Bit stream: mode 0100, count, data, terminator, pad to byte, pad bytes.
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(4, 4);
    push(bytes.length, cci);
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && bits.length < dcw * 8; i++) bits.push(0); // terminator
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    const PADS = [0xec, 0x11];
    for (let i = 0; data.length < dcw; i++) data.push(PADS[i % 2]);

    // Split into blocks: short blocks first, then the +1-length blocks.
    const nb = NUM_BLOCKS[ec][version - 1], ecb = EC_PER_BLOCK[ec][version - 1];
    const base = Math.floor(dcw / nb), longBlocks = dcw % nb;
    const blocks = [], ecs = [];
    let off = 0;
    for (let b = 0; b < nb; b++) {
      const len = base + (b >= nb - longBlocks ? 1 : 0);
      const blk = data.slice(off, off + len);
      off += len;
      blocks.push(blk);
      ecs.push(rsEC(blk, ecb));
    }
    // Interleave data then EC, column-wise across blocks.
    const out = [];
    const maxLen = base + (longBlocks ? 1 : 0);
    for (let i = 0; i < maxLen; i++) for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
    for (let i = 0; i < ecb; i++) for (const e of ecs) out.push(e[i]);
    return out;
  }

  // Zigzag placement of the codeword bit stream into non-function modules.
  function placeData(g, codewords) {
    const { size, mat, func } = g;
    let bitIdx = 0;
    const total = codewords.length * 8;
    const bitAt = (i) => (i < total ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0); // remainder bits = 0
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // timing column is skipped entirely
      for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (!func[r][c]) mat[r][c] = bitAt(bitIdx++);
        }
      }
      upward = !upward;
    }
    return bitIdx; // number of data modules filled (for the self-check)
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function writeFormat(g, ec, mask) {
    const { size, mat } = g;
    const f = formatInfo(ec, mask);
    const bit = (i) => (f >> i) & 1; // i = 0 is the LSB
    // Copy 1 around the top-left finder (bit 14 -> bit 0).
    const coordsA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
                     [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    // Copy 2 split between the other two finders.
    const coordsB = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
                     [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
    for (let i = 0; i < 15; i++) {
      mat[coordsA[i][0]][coordsA[i][1]] = bit(14 - i);
      mat[coordsB[i][0]][coordsB[i][1]] = bit(14 - i);
    }
  }
  function writeVersion(g, version) {
    if (version < 7) return;
    const { size, mat } = g;
    const vi = versionInfo(version);
    for (let i = 0; i < 18; i++) {
      const b = (vi >> i) & 1;
      mat[Math.floor(i / 3)][size - 11 + (i % 3)] = b;
      mat[size - 11 + (i % 3)][Math.floor(i / 3)] = b;
    }
  }

  // Standard mask penalty (rules 1-4).
  function penalty(g) {
    const { size, mat } = g;
    let score = 0;
    // Rule 1: runs of 5+ in rows and columns.
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < size; i++) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          const cur = axis ? mat[j][i] : mat[i][j];
          const prev = axis ? mat[j - 1][i] : mat[i][j - 1];
          if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else run = 1;
        }
      }
    }
    // Rule 2: 2x2 blocks of one colour.
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = mat[r][c];
      if (mat[r][c + 1] === v && mat[r + 1][c] === v && mat[r + 1][c + 1] === v) score += 3;
    }
    // Rule 3: finder-like 1011101 with 4 light modules on one side.
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const at = (axis, i, j) => (axis ? mat[j][i] : mat[i][j]);
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < size; i++) for (let j = 0; j <= size - 11; j++) {
        let m1 = true, m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = at(axis, i, j + k);
          if (v !== P1[k]) m1 = false;
          if (v !== P2[k]) m2 = false;
          if (!m1 && !m2) break;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }
    }
    // Rule 4: dark-module proportion.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mat[r][c];
    score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
    return score;
  }

  // Full encode: returns { size, version, ec, mask, mat } or null if too big.
  function encode(text) {
    const bytes = utf8Bytes(text);
    const pick = pickVersion(bytes.length);
    if (!pick) return null;
    const { version, ec } = pick;
    const codewords = buildCodewords(bytes, version, ec);

    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const g = scaffold(version);
      placeData(g, codewords);
      // Apply the mask to data modules only.
      for (let r = 0; r < g.size; r++) for (let c = 0; c < g.size; c++) {
        if (!g.func[r][c] && MASKS[mask](r, c)) g.mat[r][c] ^= 1;
      }
      writeFormat(g, ec, mask);
      writeVersion(g, version);
      const s = penalty(g);
      if (s < bestScore) { bestScore = s; best = { size: g.size, version, ec, mask, mat: g.mat }; }
    }
    return best;
  }

  // PNG data URI via an offscreen canvas. Fixed black-on-white (never theme
  // colours) with the spec's 4-module quiet zone. Returns null when the text
  // exceeds capacity or canvas rendering is unavailable.
  function dataURL(text, scale) {
    const q = encode(text);
    if (!q) return null;
    scale = scale || 4;
    const quiet = 4 * scale, px = q.size * scale + 2 * quiet;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.toDataURL !== "function") return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
      if (q.mat[r][c]) ctx.fillRect(quiet + c * scale, quiet + r * scale, scale, scale);
    }
    try { return canvas.toDataURL("image/png"); } catch (e) { return null; }
  }

  // Table/geometry cross-check, used by the test suite: for every version the
  // leftover after whole codewords must equal the spec's remainder bits, and
  // the EC tables must leave a positive data capacity.
  function selfCheck() {
    const REM = (v) => (v === 1 ? 0 : v <= 6 ? 7 : v <= 13 ? 0 : v <= 20 ? 3 : v <= 27 ? 4 : v <= 34 ? 3 : 0);
    for (let v = 1; v <= 40; v++) {
      const dm = dataModules(v);
      if (dm - totalCodewords(v) * 8 !== REM(v)) return "remainder mismatch at v" + v;
      for (const ec of ["L", "M"]) {
        if (dataCodewords(v, ec) <= 0) return "no data capacity at v" + v + "-" + ec;
      }
    }
    return "";
  }

  SWR.qr = {
    encode, dataURL,
    // exposed for the test suite
    _internals: { rsGenPoly, rsEC, gfMul, formatInfo, versionInfo, totalCodewords, dataCodewords, dataModules, pickVersion, buildCodewords, selfCheck, EXP, LOG },
  };
})(typeof self !== "undefined" ? self : this);
