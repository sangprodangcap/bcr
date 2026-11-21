// ============================================
// BACCARAT PREDICTOR v20 - @sewdangcap
// Source : https://jjjjbcrsexxy-1.onrender.com/api/bcrvh11
// Output : ban, van, du_doan, do_tin_cay, good_road, thoi_gian, id
//
// ENGINE v20 — CẦU-FIRST ARCHITECTURE
// Priority: nhận diện cầu đang chạy → theo cầu → chỉ dùng stats khi ko có cầu
// Cầu types: Đơn, Đôi, Ba, 1-2, 2-1, Dài, Đứt cầu (lật cầu), Hỗn hợp
// Derived: Big Eye Boy, Small Road, Cockroach (chuẩn casino)
// Fallback: Markov ensemble + Bayes + Entropy + Recency
// ============================================

'use strict';
const http  = require('http');
const fetch = require('node-fetch');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SOURCE_URL         = 'https://jjjjbcrsexxy-1.onrender.com/api/bcrvh11';
const PORT               = process.env.PORT || 3000;
const FETCH_TO           = 20000;
const ID                 = '@sewdangcap';
const POLL_MIN           = 1000;
const POLL_MAX           = 5000;
const POLL_STEP          = 500;
const CONF_FLOOR         = 55;
const CONF_CEIL          = 88;
const MIN_HANDS          = 6;

// ─── STATE ────────────────────────────────────────────────────────────────────
let cache        = null;
let lastFetch    = 0;
let fetchCount   = 0;
let updateCount  = 0;
let currentDelay = POLL_MIN;
let isLooping    = false;
let lastChangeTs = 0;
const banState   = new Map();   // ban → { results, phien }

// ─── FETCH ────────────────────────────────────────────────────────────────────
async function safeFetch(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TO);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
                 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch { clearTimeout(timer); return null; }
}

// ─── PARSE ────────────────────────────────────────────────────────────────────
function parseSource(json) {
  if (!json || json.success !== true) return null;
  const arr = json.predictions;
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.map(item => ({
    ban:       String(item.table ?? '').trim(),
    results:   String(item.result || '').replace(/[^BPTbpt]/g, '').toUpperCase(),
    good_road: String(item.pattern || '').trim(),
    phien:     Number(item.phien) || 0,
    update_at: '',
  })).filter(x => x.ban && x.results.length >= 1);
}

function detectChanged(items) {
  const changed = [];
  for (const item of items) {
    const prev = banState.get(item.ban);
    if (!prev || prev.results !== item.results || prev.phien !== item.phien) {
      banState.set(item.ban, { results: item.results, phien: item.phien });
      changed.push(item);
    }
  }
  return changed;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ALGORITHM ENGINE v20
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip ties → pure B/P array */
function toBead(raw) {
  return [...raw.toUpperCase().replace(/[^BPT]/g, '')].filter(c => c !== 'T');
}

/** Build Big Road columns from raw string (ties handled per casino rule) */
function buildBigRoad(raw) {
  const cols = [];
  let curSide = null, curCol = [];
  for (const ch of raw.toUpperCase().replace(/[^BPT]/g, '')) {
    if (ch === 'T') {
      if (curCol.length) curCol[curCol.length - 1] += 'T';
      else if (cols.length) cols[cols.length - 1][cols[cols.length - 1].length - 1] += 'T';
      continue;
    }
    if (ch !== curSide) {
      if (curCol.length) cols.push(curCol);
      curCol = [ch]; curSide = ch;
    } else {
      curCol.push(ch);
    }
  }
  if (curCol.length) cols.push(curCol);
  return cols;    // cols[i] = array of "B" or "P" strings (may have appended "T"s)
}

function colSide(col) { return col[0][0]; }   // "B" or "P"

// ── Derived road builder (Big Eye Boy offset=1, Small offset=2, Cockroach offset=3) ──
function buildDerived(cols, offset) {
  const out = [];
  for (let i = offset; i < cols.length; i++) {
    const cur = cols[i], ref = cols[i - offset];
    // R (red) = same depth pattern; B (blue) = different
    let matched = true;
    const maxR = Math.max(cur.length, ref.length);
    for (let r = 1; r < maxR; r++) {
      const a = cur[r] ? 1 : 0;
      const b = ref[r] ? 1 : 0;
      if (a !== b) { matched = false; break; }
    }
    out.push(matched ? 'R' : 'B');
  }
  return out;
}

/** What would derived road show if we append `side` to current big road? */
function peekDerived(cols, offset, side) {
  if (cols.length < offset + 1) return null;
  const nc   = cols.map(c => [...c]);
  const last = colSide(nc.at(-1));
  if (side === last) nc.at(-1).push(side);
  else               nc.push([side]);
  return buildDerived(nc, offset).at(-1) ?? null;
}

/** Predict derived road next entry: returns "B" or "P" or null */
function derivedPredict(cols, offset) {
  if (cols.length < offset + 2) return null;
  const pB = peekDerived(cols, offset, 'B');
  const pP = peekDerived(cols, offset, 'P');
  // Both same → ambiguous
  if (pB === pP) {
    // fall back: momentum of last 6 entries in derived road
    const rd = buildDerived(cols, offset);
    if (rd.length < 4) return null;
    const t  = rd.slice(-6);
    const nR = t.filter(x => x === 'R').length;
    const nB = t.length - nR;
    const last = colSide(cols.at(-1));
    const opp  = last === 'B' ? 'P' : 'B';
    if (nR >= 4) return last;   // R streak → continue last side
    if (nB >= 4) return opp;    // B streak → switch side
    return null;
  }
  // pB=R means appending Banker keeps pattern → predict Banker
  if (pB === 'R') return 'B';
  if (pP === 'R') return 'P';
  return null;
}

// ── Road strength (how consistent is the current derived road?) ───────────────
function derivedStrength(cols, offset) {
  const rd = buildDerived(cols, offset);
  if (rd.length < 4) return 0.5;
  const t  = rd.slice(-8);
  const nR = t.filter(x => x === 'R').length;
  return 0.5 + Math.abs(nR / t.length - 0.5) * 1.0;  // 0.5–1.0
}

// ════════════════════════════════════════════════════════════════════════════════
//  CẦU (ROAD PATTERN) ENGINE — tầng 1, ưu tiên cao nhất
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Classify the CURRENT active cầu from Big Road columns.
 * Returns { type, predict, confidence, label }
 */
function detectCau(cols) {
  if (cols.length < 2) return null;

  const lens  = cols.map(c => c.length);
  const last  = cols.at(-1);
  const cS    = colSide(last);           // side of current column
  const opp   = cS === 'B' ? 'P' : 'B';
  const cL    = last.length;             // depth of current column
  const nCols = cols.length;

  // ── 1. CẦU ĐƠN (ping-pong 1-1) ───────────────────────────────────────────
  // Need at least 4 recent single-length columns
  const recent8 = lens.slice(-8);
  if (recent8.length >= 4 && recent8.slice(-4).every(x => x === 1)) {
    // Dự đoán: đổi bên (cầu đơn → alternating)
    return { type: 'CAU_DON', predict: opp, confidence: 82, label: 'Cầu đơn' };
  }

  // ── 2. CẦU ĐÔI (2-2) ──────────────────────────────────────────────────────
  if (recent8.length >= 4 && recent8.slice(-4).every(x => x === 2)) {
    // Nếu cột hiện tại chưa đủ 2 → tiếp tục bên hiện tại
    // Nếu đủ 2 rồi → đổi bên
    const predict = cL < 2 ? cS : opp;
    return { type: 'CAU_DOI', predict, confidence: 80, label: 'Cầu đôi' };
  }

  // ── 3. CẦU BA (3-3) ───────────────────────────────────────────────────────
  if (recent8.length >= 3 && recent8.slice(-3).every(x => x === 3)) {
    const predict = cL < 3 ? cS : opp;
    return { type: 'CAU_BA', predict, confidence: 76, label: 'Cầu ba' };
  }

  // ── 4. CẦU 1-2 / 2-1 (alternating 1 and 2) ──────────────────────────────
  // Slide window from widest (8) down to minimum (4 cols) to detect pattern
  // at any starting offset — handles short histories correctly.
  if (recent8.length >= 4) {
    for (let winLen = Math.min(recent8.length, 8); winLen >= 4; winLen--) {
      const s    = recent8.slice(-winLen);
      const fst  = s[0];                           // first col length in window
      const snd  = fst === 1 ? 2 : fst === 2 ? 1 : 0;
      if (!snd) continue;                           // only handle 1 and 2
      const is12 = fst === 1 && s.every((x, i) => i % 2 === 0 ? x === 1 : x === 2);
      const is21 = fst === 2 && s.every((x, i) => i % 2 === 0 ? x === 2 : x === 1);
      if (!is12 && !is21) continue;
      // Position of the current (last) column within the detected pattern
      const posInPat = (winLen - 1) % 2;           // 0 = same as fst, 1 = same as snd
      const expLen   = is12
        ? (posInPat === 0 ? 1 : 2)
        : (posInPat === 0 ? 2 : 1);
      const predict  = cL < expLen ? cS : opp;
      return { type: is12 ? 'CAU_1_2' : 'CAU_2_1', predict,
               confidence: 76, label: is12 ? 'Cầu 1-2' : 'Cầu 2-1' };
    }
  }

  // ── 5. CẦU DÀI (streak ≥ 5) ───────────────────────────────────────────────
  if (cL >= 7) return { type: 'CAU_DAI', predict: cS, confidence: 88, label: `Cầu dài ${cL}` };
  if (cL >= 5) return { type: 'CAU_DAI', predict: cS, confidence: 80, label: `Cầu dài ${cL}` };
  if (cL >= 4) return { type: 'CAU_DAI', predict: cS, confidence: 73, label: `Cầu dài ${cL}` };

  // ── 6. CẦU NGHIÊNG (lopsided — one side dominates column count) ───────────
  const colsB = cols.filter(c => colSide(c) === 'B').length;
  const colsP = cols.filter(c => colSide(c) === 'P').length;
  const domSide = colsB > colsP ? 'B' : 'P';
  const ratio   = Math.max(colsB, colsP) / (colsB + colsP);
  if (ratio >= 0.70 && nCols >= 8) {
    return { type: 'CAU_NGHIENG', predict: domSide, confidence: 65,
             label: `Cầu nghiêng ${domSide === 'B' ? 'Cái' : 'Con'}` };
  }

  // ── 7. CẦU ĐỨT / KHÔNG RÕ → trả về null, engine dùng fallback ────────────
  return null;
}

// ════════════════════════════════════════════════════════════════════════════════
//  DERIVED ROADS LAYER — tầng 2
// ════════════════════════════════════════════════════════════════════════════════

function derivedLayer(cols) {
  const r1 = derivedPredict(cols, 1);  // Big Eye Boy
  const r2 = derivedPredict(cols, 2);  // Small Road
  const r3 = derivedPredict(cols, 3);  // Cockroach

  const s1 = derivedStrength(cols, 1);
  const s2 = derivedStrength(cols, 2);
  const s3 = derivedStrength(cols, 3);

  // Weighted vote from three derived roads
  const votes = { B: 0, P: 0 };
  if (r1) votes[r1] += s1 * 1.4;
  if (r2) votes[r2] += s2 * 1.2;
  if (r3) votes[r3] += s3 * 1.0;

  const total = votes.B + votes.P;
  if (total < 0.5) return null;

  const pred     = votes.B >= votes.P ? 'B' : 'P';
  const margin   = Math.max(votes.B, votes.P) / total;  // 0.5–1.0
  const agreeCnt = [r1, r2, r3].filter(x => x === pred).length;

  // Only trust when at least 2 roads agree
  if (agreeCnt < 2) return null;

  return {
    predict:    pred,
    confidence: Math.round(55 + (margin - 0.5) * 60 + agreeCnt * 5),
    label:      `Derived ${['BEB','SR','CR'].filter((_, i) => [r1,r2,r3][i] === pred).join('+')}`,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
//  STATISTICAL FALLBACK — tầng 3 (khi không có cầu rõ ràng)
// ════════════════════════════════════════════════════════════════════════════════

function adaptiveWindow(bead, minW = 8, maxW = 60) {
  let bestW = Math.min(20, bead.length), bestS = -1;
  for (let w = minW; w <= Math.min(maxW, bead.length); w++) {
    const s = Math.abs(0.5 - bead.slice(-w).filter(x => x === 'B').length / w);
    if (s > bestS) { bestS = s; bestW = w; }
  }
  return bestW;
}

function markovSignal(bead, order) {
  const n = bead.length;
  if (n < order * 4 + 10) return null;
  const minW  = Math.max(order * 3, 10);
  const maxW  = Math.min(order * 10 + 20, n);
  const w     = adaptiveWindow(bead, minW, maxW);
  const slice = bead.slice(-w);
  const key   = slice.slice(-(order + 1), -1).join('');
  if (key.length < order) return null;
  const cnt = { B: 0, P: 0 };
  for (let i = order; i < slice.length; i++) {
    if (slice.slice(i - order, i).join('') !== key) continue;
    const nx = slice[i];
    if (cnt[nx] !== undefined) cnt[nx]++;
  }
  const total = cnt.B + cnt.P;
  if (total < Math.max(3, order)) return null;
  const pB = cnt.B / total;
  const mg  = Math.abs(pB - 0.5);
  if (mg < 0.05 + order * 0.01) return null;
  return {
    side:   pB > 0.5 ? 'B' : 'P',
    weight: Math.min(0.92, mg * (2.0 + order * 0.1)) * (2.0 + order * 0.1),
  };
}

function recencySignal(bead) {
  if (bead.length < 5) return null;
  const recent  = bead.slice(-8);
  const weights = [0.3, 0.5, 0.7, 0.9, 1.1, 1.4, 1.7, 2.2];
  let sB = 0, sP = 0;
  for (let i = 0; i < recent.length; i++) {
    const w = weights[weights.length - recent.length + i] ?? 1;
    recent[i] === 'B' ? (sB += w) : (sP += w);
  }
  const total = sB + sP;
  const mg    = Math.abs(sB - sP) / total;
  if (mg < 0.08) return null;
  return { side: sB > sP ? 'B' : 'P', weight: mg * 2.5 };
}

function bayesSignal(bead) {
  const n  = bead.length; if (n < 10) return null;
  const cB = bead.filter(x => x === 'B').length;
  const pB = (cB + 2) / (n + 4);   // Beta(2,2) prior
  const mg = Math.abs(2 * pB - 1);
  if (mg < 0.05) return null;
  return { side: pB > 0.5 ? 'B' : 'P', weight: mg * 2.0 };
}

function streakSignal(bead) {
  const n = bead.length; if (n < 5) return null;
  const last = bead.at(-1); let len = 1;
  while (len < n && bead[n - 1 - len] === last) len++;
  if (len < 3) return null;
  // Count historical breaks after same streak length
  let broke = 0, trials = 0;
  for (let i = len; i < n; i++) {
    if (bead[i] === bead[i - 1]) continue;
    let s = 1;
    while (s + i - 1 >= 0 && i - 1 - s >= 0 && bead[i - 1 - s] === bead[i - 1]) s++;
    if (s !== len) continue;
    trials++;
    if (i + 1 < n && bead[i + 1] !== bead[i]) broke++;
  }
  const pBreak = trials >= 5 ? broke / trials : Math.max(0.35, 0.58 - len * 0.02);
  const opp    = last === 'B' ? 'P' : 'B';
  const mg     = Math.abs(pBreak - 0.5);
  if (mg < 0.05) return null;
  return {
    side:   pBreak > 0.5 ? opp : last,
    weight: Math.min(0.9, mg * 2.0 + 0.3) * 1.5,
  };
}

/** Pure statistical ensemble — returns { predict, confidence } */
function statFallback(bead) {
  const signals = [
    markovSignal(bead, 7), markovSignal(bead, 6), markovSignal(bead, 5),
    markovSignal(bead, 4), markovSignal(bead, 3), markovSignal(bead, 2),
    markovSignal(bead, 1), recencySignal(bead), bayesSignal(bead),
    streakSignal(bead),
  ].filter(Boolean);

  if (!signals.length) return null;

  let sB = 0, sP = 0;
  for (const s of signals) s.side === 'B' ? (sB += s.weight) : (sP += s.weight);

  const total  = sB + sP;
  const pred   = sB >= sP ? 'B' : 'P';
  const margin = total > 0 ? Math.max(sB, sP) / total : 0.5;
  if (margin < 0.52) return null;  // too close → skip

  const conf = Math.round(Math.max(CONF_FLOOR, Math.min(CONF_CEIL,
    CONF_FLOOR + (margin - 0.5) * 70
  )));
  return { predict: pred, confidence: conf, label: 'Stat fallback' };
}

// ════════════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR — 3-layer priority stack
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Layers (highest → lowest priority):
 *   1. Cầu (road pattern) — đây là signal chính của baccarat thực tế
 *   2. Derived roads consensus (BEB + SR + CR)
 *   3. Statistical fallback
 *
 * Cầu layer:
 *   - If cau found AND derived agrees → use cau confidence boosted +5
 *   - If cau found BUT derived disagrees → use cau confidence −8 (still use cau)
 *   - If no cau → try derived
 *   - If no derived → try stat
 */
function analyze(rawHistory) {
  const raw  = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const bead = toBead(raw);

  if (bead.length < MIN_HANDS) return null;

  const cols = buildBigRoad(raw);

  // ── Layer 1: Cầu ──────────────────────────────────────────────────────────
  const cau = detectCau(cols);

  // ── Layer 2: Derived roads ─────────────────────────────────────────────────
  const der = derivedLayer(cols);

  let result = null;

  if (cau) {
    let conf = cau.confidence;
    // Cross-validate with derived roads
    if (der) {
      if (der.predict === cau.predict) conf = Math.min(CONF_CEIL, conf + 5);
      else                             conf = Math.max(CONF_FLOOR, conf - 8);
    }
    // Cross-validate with stat
    const stat = statFallback(bead);
    if (stat) {
      if (stat.predict === cau.predict) conf = Math.min(CONF_CEIL, conf + 3);
      else                              conf = Math.max(CONF_FLOOR, conf - 4);
    }
    result = { predict: cau.predict, confidence: conf, source: cau.label };

  } else if (der) {
    // No cầu → lean on derived roads
    let conf = der.confidence;
    const stat = statFallback(bead);
    if (stat) {
      if (stat.predict === der.predict) conf = Math.min(CONF_CEIL, conf + 4);
      else                              conf = Math.max(CONF_FLOOR, conf - 6);
    }
    result = { predict: der.predict, confidence: conf, source: der.label };

  } else {
    // Pure stat fallback
    const stat = statFallback(bead);
    if (!stat) return null;
    result = { predict: stat.predict, confidence: stat.confidence, source: stat.label };
  }

  if (!result) return null;

  return {
    du_doan:    result.predict === 'B' ? 'Cai' : 'Con',
    do_tin_cay: result.confidence + '%',
    cau_hien:   result.source,
  };
}

// ─── APPLY UPDATE ─────────────────────────────────────────────────────────────
function applyUpdate(changedItems, rootTime) {
  if (!changedItems.length) return 0;
  const cacheMap = new Map();
  if (cache) cache.forEach(b => cacheMap.set(b.ban, b));

  let changed = 0;
  for (const item of changedItems) {
    const res = analyze(item.results);
    let thoi_gian = item.update_at;
    if (!thoi_gian && rootTime) {
      try { thoi_gian = new Date(rootTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }); }
      catch { thoi_gian = ''; }
    }
    if (!thoi_gian) thoi_gian = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    cacheMap.set(item.ban, {
      ban:        item.ban,
      van:        item.phien || null,
      du_doan:    res?.du_doan    ?? null,
      do_tin_cay: res?.do_tin_cay ?? null,
      good_road:  item.good_road,
      thoi_gian,
      id:         ID,
      _ts:        Date.now(),
    });
    if (res) changed++;
  }

  cache = [...cacheMap.values()].sort((a, b) =>
    String(a.ban).localeCompare(String(b.ban), undefined, { numeric: true })
  );
  lastFetch = Date.now();
  if (changed > 0) { updateCount++; lastChangeTs = Date.now(); }
  return changed;
}

// ─── POLL ─────────────────────────────────────────────────────────────────────
async function pollOnce() {
  fetchCount++;
  const json = await safeFetch(SOURCE_URL);
  if (!json) return 0;
  const rootTime = json.time || null;
  const items    = parseSource(json);
  if (!items) return 0;
  const changed  = detectChanged(items);
  if (!changed.length) return 0;
  return applyUpdate(changed, rootTime);
}

async function reactiveLoop() {
  if (isLooping) return;
  isLooping = true;
  const loop = async () => {
    try {
      const t0      = Date.now();
      const changed = await pollOnce();
      const elapsed = Date.now() - t0;
      if (changed > 0) {
        currentDelay = POLL_MIN;
        const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const s  = cache?.find(x => x.du_doan);
        console.log(`[${ts}] +${changed} ban | ${elapsed}ms | delay=${currentDelay}ms`);
        if (s) console.log(`  ban=${s.ban} van=${s.van} du_doan=${s.du_doan} dtc=${s.do_tin_cay} cau=${s.good_road}`);
      } else {
        currentDelay = Math.min(POLL_MAX, currentDelay + POLL_STEP);
      }
    } catch (e) {
      console.error('[POLL ERROR]', e.message);
      currentDelay = Math.min(POLL_MAX, currentDelay + 500);
    }
    setTimeout(loop, currentDelay);
  };
  await loop();
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Content-Length':              Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-store',
  });
  res.end(body);
}

function formatEntry(b) {
  return {
    ban:        b.ban,
    van:        b.van,
    du_doan:    b.du_doan,
    do_tin_cay: b.do_tin_cay,
    good_road:  b.good_road,
    thoi_gian:  b.thoi_gian,
    id:         b.id,
  };
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu, cho 2-3s' });
    return sendJSON(res, 200, {
      id:       ID,
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: cache.length,
      du_lieu:  cache.map(formatEntry),
    });
  }

  const match = url.match(/^\/api\/bcr\/(.+)$/);
  if (req.method === 'GET' && match) {
    const banId = decodeURIComponent(match[1]).trim();
    const item  = cache?.find(x => String(x.ban).trim() === banId);
    if (!item) return sendJSON(res, 404, { loi: `Khong tim thay ban: ${banId}` });
    return sendJSON(res, 200, {
      ...formatEntry(item),
      cap_nhat: new Date(item._ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    });
  }

  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      status:          'ok',
      version:         'v20-cau-first',
      source:          SOURCE_URL,
      delay_ms:        currentDelay,
      cache_size:      cache?.length ?? 0,
      fetch_count:     fetchCount,
      update_count:    updateCount,
      ms_since_change: lastChangeTs ? Date.now() - lastChangeTs : null,
    });
  }

  sendJSON(res, 404, { loi: 'Route khong ton tai',
    routes: ['/api/bcr', '/api/bcr/:ban', '/health'] });

}).listen(PORT, () => {
  console.log('\n=== BACCARAT v20 — Cầu-First Engine ===');
  console.log(`Port   : ${PORT}`);
  console.log(`Source : ${SOURCE_URL}`);
  console.log('Engine : Layer1=Cầu → Layer2=Derived Roads → Layer3=Stat Fallback');
  console.log('Cầu    : Đơn | Đôi | Ba | 1-2 | 2-1 | Dài | Nghiêng');
  console.log('Derived: Big Eye Boy + Small Road + Cockroach (casino standard)');
  console.log('Stat   : Markov x7 + Bayes + Recency + Streak');
  console.log('Output : ban | van | du_doan | do_tin_cay | good_road | thoi_gian | id');
  console.log('Routes : /api/bcr | /api/bcr/:ban | /health\n');
  reactiveLoop();
});
