// ============================================
// BACCARAT PREDICTOR v12 - @sewdangcap / @ThienNhanVn
// Markov bậc 1-7 + Bayesian + Entropy + Pattern
// Phien lấy từ V1/all, BPT lấy từ V2
// ============================================

const http  = require('http');
const fetch = require('node-fetch');

const API_V2_ALL   = 'https://defining-continues-defendant-thorough.trycloudflare.com/api/bcr';
const API_V1_ALL   = 'https://referrals-episode-geography-mind.trycloudflare.com/api/bcr/all';
const API_V1_TABLE = 'https://referrals-episode-geography-mind.trycloudflare.com/api/bcr/';

const PORT     = process.env.PORT || 3000;
const POLL_MS  = 2000;
const FETCH_TO = 3000;

// ============================================
// CONFIG
// ============================================
const CFG = {
  MAX_ROW:   6,
  MIN_HANDS: 8,
  CONF_MAX:  85,
  CONF_MIN:  50,
};

// Signal weights
const W = {
  MARKOV7:   2.8,
  MARKOV6:   2.6,
  MARKOV5:   2.4,
  MARKOV4:   2.2,
  MARKOV3:   2.0,
  MARKOV2:   1.8,
  MARKOV1:   1.5,
  BAYESIAN:  1.6,
  ENTROPY:   1.3,
  PATTERN:   1.4,
  BIG_EYE:   1.2,
  SMALL:     1.0,
  COCKROACH: 0.8,
  STREAK:    1.1,
  ZIGZAG:    0.7,
  BEAD30:    0.9,
};

// ============================================
// STATE
// ============================================
let cache      = null;
let lastFetch  = 0;
let isFetching = false;
let fetchCount = 0, updateCount = 0;
const lastResultStr = new Map();
// Map ban → phien lấy từ V1
const phienMap = new Map();

// ============================================
// FETCH HELPER
// ============================================
async function safeFetch(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TO);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch { clearTimeout(timer); return null; }
}

// ============================================
// FETCH V1 /all → cập nhật phienMap
// ============================================
async function fetchV1Phien() {
  const json = await safeFetch(API_V1_ALL);
  if (!Array.isArray(json)) return;
  for (const item of json) {
    const ban = String(item.ban || '').trim();
    if (ban && item.phien != null) {
      phienMap.set(ban, item.phien);
    }
  }
}

// ============================================
// NORMALIZE V2
// V2: { code, data: [{ban, results, good_road, update_at}] }
// ============================================
function normalizeV2(json) {
  if (!json) return null;
  const arr = json.data || json.du_lieu || (Array.isArray(json) ? json : null);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map(item => ({
    table_name:  String(item.ban || item.table_name || '').trim(),
    result:      String(item.results || item.result || '').replace(/[^BPTbpt]/g, '').toUpperCase(),
    dealer_name: item.dealer || item.dealer_name || '',
  })).filter(x => x.table_name);
}

// ============================================
// NORMALIZE V1 last_5 → BPT (fallback)
// ============================================
function last5ToBPT(last5) {
  if (!Array.isArray(last5)) return '';
  return last5.map(x => {
    const w = (x.winner || '').toLowerCase();
    if (w === 'banker') return 'B';
    if (w === 'player') return 'P';
    if (w === 'tie')    return 'T';
    return '';
  }).filter(Boolean).join('');
}

function normalizeV1All(json) {
  if (!Array.isArray(json)) return null;
  return json.map(item => ({
    table_name:  String(item.ban || '').trim(),
    result:      '',
    dealer_name: item.dealer_name || '',
  })).filter(x => x.table_name);
}

// ============================================
// FETCH ALL — V2 BPT + V1 phien (merge)
// ============================================
async function fetchAll() {
  // Luôn fetch V1 để lấy phien
  fetchV1Phien(); // fire and forget, không await để không block

  // V2 primary — có BPT đầy đủ
  const v2     = await safeFetch(API_V2_ALL);
  const v2Items = normalizeV2(v2);
  if (v2Items && v2Items.length > 0) {
    console.log(`[SOURCE] V2 OK — ${v2Items.length} ban`);
    return { items: v2Items, source: 'V2' };
  }

  // V1 fallback — chỉ có last_5
  console.warn('[SOURCE] V2 fail — V1 fallback');
  const v1All  = await safeFetch(API_V1_ALL);
  const v1List = normalizeV1All(v1All);
  if (!v1List || v1List.length === 0) return null;

  const fetched = await Promise.all(
    v1List.map(async item => {
      const s = await safeFetch(API_V1_TABLE + encodeURIComponent(item.table_name));
      if (!s) return item;
      return {
        ...item,
        result:      last5ToBPT(s.last_5),
        dealer_name: s.summary ? (s.summary.dealer || '') : '',
      };
    })
  );

  console.log(`[SOURCE] V1 fallback OK — ${fetched.length} ban`);
  return { items: fetched, source: 'V1-fallback' };
}

async function fetchSingle(banId) {
  const v2All  = await safeFetch(API_V2_ALL);
  const v2Items = normalizeV2(v2All);
  if (v2Items) {
    const found = v2Items.find(x =>
      x.table_name.toLowerCase() === String(banId).trim().toLowerCase()
    );
    if (found && found.result) return { ...found, source: 'V2' };
  }

  const v1 = await safeFetch(API_V1_TABLE + encodeURIComponent(banId));
  if (v1 && v1.last_5) {
    return {
      table_name:  String(v1.table || banId),
      result:      last5ToBPT(v1.last_5),
      dealer_name: v1.summary ? (v1.summary.dealer || '') : '',
      source:      'V1-single',
    };
  }
  return null;
}

// ============================================
// ROAD BUILDERS
// ============================================
function buildBigRoad(raw) {
  const cols = [];
  let curSide = null, curCol = [];
  for (const ch of raw) {
    if (ch === 'T') {
      if (curCol.length > 0) curCol[curCol.length - 1] += 'T';
      else if (cols.length > 0) {
        const lc = cols[cols.length - 1];
        lc[lc.length - 1] += 'T';
      }
      continue;
    }
    if (ch !== curSide) {
      if (curCol.length > 0) cols.push(curCol);
      curCol = [ch]; curSide = ch;
    } else {
      curCol.push(ch);
    }
  }
  if (curCol.length > 0) cols.push(curCol);
  return cols;
}

function buildBigRoadGrid(raw) {
  const beadOnly = [...raw].filter(x => x !== 'T');
  const grid = [];
  let curSide = null, col = -1, row = 0, colObj = null;
  for (const ch of beadOnly) {
    if (ch !== curSide) {
      col++; row = 0; curSide = ch;
      colObj = { side: ch, col, cells: [{ row, col }], dragonTail: 0 };
      grid.push(colObj);
    } else if (row < CFG.MAX_ROW - 1) {
      row++; colObj.cells.push({ row, col });
    } else {
      colObj.dragonTail++;
      colObj.cells.push({ row: CFG.MAX_ROW - 1, col: col + colObj.dragonTail });
    }
  }
  return grid;
}

function buildBeadGrid(raw) {
  const cells = [];
  let row = 0, col = 0;
  for (const ch of raw) {
    if (ch === 'T') {
      if (cells.length > 0) cells.at(-1).tie = (cells.at(-1).tie || 0) + 1;
      continue;
    }
    cells.push({ row, col, side: ch, tie: 0 });
    row++;
    if (row >= CFG.MAX_ROW) { row = 0; col++; }
  }
  return cells;
}

function buildDerived(cols, offset) {
  const out = [];
  for (let i = offset; i < cols.length; i++) {
    const cur = cols[i], ref = cols[i - offset];
    if (cur.length === 1 && ref.length === 1) { out.push('R'); continue; }
    const maxRow = Math.max(cur.length, ref.length);
    let matched = true;
    for (let r = 1; r < maxRow; r++) {
      const a = cur[r] ? cur[r][0] : null;
      const b = ref[r] ? ref[r][0] : null;
      if (!a && !b) continue;
      if (!a || !b) { matched = false; break; }
    }
    out.push(matched ? 'R' : 'B');
  }
  return out;
}

function predictDerived(cols, offset) {
  if (cols.length < offset + 1) return null;
  const lastSide = cols.at(-1).at(-1)[0];
  const oppSide  = lastSide === 'B' ? 'P' : 'B';

  const tryAppend = side => {
    const nc = cols.map(c => [...c]);
    if (side === lastSide) nc.at(-1).push(side);
    else nc.push([side]);
    return buildDerived(nc, offset).at(-1) || null;
  };

  const ifSame = tryAppend(lastSide);
  const ifOpp  = tryAppend(oppSide);
  if (ifSame === 'R' && ifOpp === 'B') return lastSide;
  if (ifSame === 'B' && ifOpp === 'R') return oppSide;

  const road = buildDerived(cols, offset);
  if (road.length < 3) return null;
  const tail = road.slice(-6);
  const rCnt = tail.filter(x => x === 'R').length;
  const bCnt = tail.filter(x => x === 'B').length;
  if (rCnt >= 4) return lastSide;
  if (bCnt >= 4) return oppSide;
  return null;
}

// ============================================
// ===== THUẬT TOÁN V12 =====
// ============================================

function entropy(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  const cB = arr.filter(x => x === 'B').length;
  const pB = cB / n, pP = 1 - pB;
  const h  = x => x > 0 ? -x * Math.log2(x) : 0;
  return h(pB) + h(pP);
}

function adaptiveWindow(bead, minW = 8, maxW = 60) {
  let bestW = Math.min(20, bead.length);
  let bestS = -1;
  for (let w = minW; w <= Math.min(maxW, bead.length); w++) {
    const slice = bead.slice(-w);
    const s     = Math.abs(0.5 - slice.filter(x => x === 'B').length / w);
    if (s > bestS) { bestS = s; bestW = w; }
  }
  return bestW;
}

// --- MARKOV bậc N (1 → 7) ---
function markovNSignal(bead, order, rel) {
  const n = bead.length;
  // Cần ít nhất order*4 + 10 mẫu để có ý nghĩa thống kê
  const minSamples = order * 4 + 10;
  if (n < minSamples) return null;

  // Dùng adaptive window: càng bậc cao → cần window rộng hơn
  const minW = Math.max(order * 3, 10);
  const maxW = Math.min(order * 10 + 20, n);
  const w    = adaptiveWindow(bead, minW, maxW);
  const slice = bead.slice(-w);

  // Key = chuỗi `order` phiên gần nhất
  const key = slice.slice(-(order + 1), -1).join(''); // order chars
  if (key.length < order) return null;

  // Đếm transition trong slice
  const counts = { B: 0, P: 0 };
  for (let i = order; i < slice.length; i++) {
    const context = slice.slice(i - order, i).join('');
    if (context !== key) continue;
    const next = slice[i];
    if (next === 'B' || next === 'P') counts[next]++;
  }

  const total = counts.B + counts.P;
  // Ngưỡng minimum samples tăng theo bậc
  const minCount = Math.max(3, order);
  if (total < minCount) return null;

  const pB     = counts.B / total;
  const margin = Math.abs(pB - 0.5);

  // Ngưỡng confidence tăng theo bậc (bậc cao cần margin rõ hơn)
  const minMargin = 0.05 + order * 0.01;
  if (margin < minMargin) return null;

  return {
    name:     `M${order}(w${w}): "${key}"→B ${counts.B}/${total} (${Math.round(pB * 100)}%)`,
    side:     pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.92, margin * (2.0 + order * 0.1)),
  };
}

// --- BAYESIAN ---
function bayesianSignal(bead) {
  const n = bead.length;
  if (n < 15) return null;
  const cB    = bead.filter(x => x === 'B').length;
  const alpha = 3;
  const pB    = (cB + alpha) / (n + 2 * alpha);
  const pP    = 1 - pB;
  const margin = Math.abs(pB - pP);
  if (margin < 0.04) return null;
  return {
    name:     `Bayes: B=${cB}/${n} (${Math.round(pB * 100)}%)`,
    side:     pB > pP ? 'B' : 'P',
    strength: Math.min(0.85, margin * 3),
  };
}

// --- ENTROPY REGIME ---
function entropySignal(bead) {
  const n = bead.length;
  if (n < 10) return null;
  const w     = Math.min(20, n);
  const slice = bead.slice(-w);
  const e     = entropy(slice);
  const cB    = slice.filter(x => x === 'B').length;
  const pB    = cB / slice.length;
  const last  = bead.at(-1);
  const opp   = last === 'B' ? 'P' : 'B';

  if (e < 0.7) {
    return {
      name:     `Entropy thấp(${e.toFixed(2)}): xu hướng ${pB > 0.5 ? 'B' : 'P'}`,
      side:     pB > 0.5 ? 'B' : 'P',
      strength: Math.min(0.8, (0.7 - e) * 1.5),
    };
  }
  if (e > 0.95) {
    let streakLen = 1;
    while (streakLen < n && bead[n - 1 - streakLen] === last) streakLen++;
    if (streakLen >= 2) {
      return {
        name:     `Entropy cao(${e.toFixed(2)}): ngược streak`,
        side:     opp,
        strength: Math.min(0.6, (e - 0.95) * 4 + 0.2),
      };
    }
  }
  return null;
}

// --- PATTERN (Big Road) ---
function patternSignal(cols) {
  if (cols.length < 2) return null;
  const lens    = cols.slice(-8).map(c => c.length);
  const last    = cols.at(-1);
  const curSide = last.at(-1)[0];
  const opp     = curSide === 'B' ? 'P' : 'B';
  const curLen  = last.length;

  if (curLen >= 6) return { name: 'Cầu dài ' + curLen, side: curSide, strength: 0.9 };
  if (curLen >= 4) return { name: 'Cầu x'   + curLen, side: curSide, strength: 0.7 };

  if (lens.length >= 4 && lens.every(x => x === 1))
    return { name: 'Cầu đơn', side: opp, strength: 0.85 };
  if (lens.length >= 4 && lens.every(x => x === 2))
    return { name: 'Cầu đôi', side: curLen < 2 ? curSide : opp, strength: 0.75 };
  if (lens.length >= 3 && lens.every(x => x === 3))
    return { name: 'Cầu ba',  side: curLen < 3 ? curSide : opp, strength: 0.7 };

  if (lens.length >= 4) {
    const is12 = lens.every((x, i) => i % 2 === 0 ? x === 1 : x === 2);
    const is21 = lens.every((x, i) => i % 2 === 0 ? x === 2 : x === 1);
    if (is12) {
      const nxt = cols.length % 2 === 0 ? 2 : 1;
      return { name: 'Cầu 1-2', side: curLen < nxt ? curSide : opp, strength: 0.72 };
    }
    if (is21) {
      const nxt = cols.length % 2 === 0 ? 1 : 2;
      return { name: 'Cầu 2-1', side: curLen < nxt ? curSide : opp, strength: 0.72 };
    }
    if (lens.length >= 3) {
      const seq = lens.slice(-3);
      if (
        (seq[0] === 2 && seq[1] === 3 && seq[2] === 2) ||
        (seq[0] === 3 && seq[1] === 2 && seq[2] === 3)
      ) {
        const nxtLen = seq[2] === 2 ? 3 : 2;
        return { name: 'Cầu 232', side: curLen < nxtLen ? curSide : opp, strength: 0.65 };
      }
    }
  }

  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  if (avg >= 3.5) return { name: 'Nghiêng ' + curSide, side: curSide, strength: 0.45 };
  return null;
}

// --- DERIVED ROADS ---
function derivedSignal(cols, offset, label) {
  if (cols.length < offset + 2) return null;
  const pred = predictDerived(cols, offset);
  if (!pred) return null;
  return { name: label, side: pred, strength: 0.75 };
}

// --- STREAK ---
function streakSignal(bead) {
  const n = bead.length;
  if (n < 5) return null;
  const last = bead.at(-1);
  let len = 1;
  while (len < n && bead[n - 1 - len] === last) len++;
  if (len < 3) return null;

  let broke = 0, total = 0;
  for (let i = len; i < n; i++) {
    if (bead[i] === bead[i - 1]) continue;
    let s = 1;
    for (let j = i - 1; j >= 0 && bead[j] === bead[i - 1]; j--) s++;
    if (s !== len) continue;
    total++;
    if (i + 1 < n && bead[i + 1] !== bead[i]) broke++;
  }

  const prior  = Math.max(0.35, 0.58 - len * 0.02);
  const pBreak = total >= 5 ? broke / total : prior;
  const opp    = last === 'B' ? 'P' : 'B';

  return {
    name:     `Bệt ${len} P(gãy)=${Math.round(pBreak * 100)}% (n=${total})`,
    side:     pBreak > 0.5 ? opp : last,
    strength: Math.min(0.88, Math.abs(pBreak - 0.5) * 2.2 + 0.3),
  };
}

// --- ZIGZAG ---
function zigzagSignal(bead) {
  if (bead.length < 6) return null;
  const tail = bead.slice(-6);
  const isZig = tail.every((x, i) => i === 0 || x !== tail[i - 1]);
  if (!isZig) return null;
  const opp = bead.at(-1) === 'B' ? 'P' : 'B';
  return { name: 'Zigzag 1-1 (6)', side: opp, strength: 0.72 };
}

// --- BEAD WINDOW (adaptive) ---
function bead30Signal(bead) {
  const w     = adaptiveWindow(bead, 15, 40);
  const slice = bead.slice(-w);
  if (slice.length < 10) return null;
  const cB = slice.filter(x => x === 'B').length;
  const r  = cB / slice.length;
  if (Math.abs(r - 0.5) < 0.10) return null;
  return {
    name:     `Bead(w${w}): B=${cB}/${slice.length} (${Math.round(r * 100)}%)`,
    side:     r > 0.5 ? 'B' : 'P',
    strength: Math.min(0.75, Math.abs(r - 0.5) * 2.2),
  };
}

// ============================================
// COMBINE V12
// ============================================
function combine(signals) {
  const votes = signals.filter(Boolean);
  if (!votes.length) return null;

  let scoreB = 0, scoreP = 0;
  votes.forEach(v => {
    const w = v.strength * (W[v.rel] ?? 1.0);
    v.side === 'B' ? (scoreB += w) : (scoreP += w);
  });

  const total  = scoreB + scoreP;
  const pred   = scoreB >= scoreP ? 'B' : 'P';
  const margin = total > 0 ? Math.max(scoreB, scoreP) / total : 0.5;

  // Bonus: derived roads đồng thuận
  const derivedAgree = votes.filter(v =>
    ['BIG_EYE', 'SMALL', 'COCKROACH'].includes(v.rel) && v.side === pred
  ).length;
  const derivedBonus = derivedAgree >= 3 ? 10 : derivedAgree === 2 ? 5 : 0;

  // Bonus: bao nhiêu bậc Markov đồng thuận
  const markovAgree = votes.filter(v =>
    v.rel.startsWith('MARKOV') && v.side === pred
  ).length;
  const markovBonus = markovAgree >= 5 ? 12
                    : markovAgree >= 3 ? 7
                    : markovAgree >= 2 ? 4 : 0;

  // Penalty nếu vote quá sít
  const balancePenalty = margin < 0.55 ? -5 : 0;

  let conf = CFG.CONF_MIN + (margin - 0.5) * 70 + derivedBonus + markovBonus + balancePenalty;
  conf = Math.max(CFG.CONF_MIN, Math.min(CFG.CONF_MAX, Math.round(conf)));

  return { pred, conf, votes, scoreB: scoreB.toFixed(2), scoreP: scoreP.toFixed(2) };
}

function tag(signal, rel) {
  if (!signal) return null;
  signal.rel = rel;
  return signal;
}

// ============================================
// ANALYZE
// ============================================
function analyze(rawHistory) {
  const raw      = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const beadAll  = [...raw].filter(x => x !== 'T');

  if (beadAll.length < CFG.MIN_HANDS) {
    return { du_doan: 'Chua du du lieu', do_tin_cay: '0%', notes: [], cau_dep: '', signals_used: 0 };
  }

  const cols = buildBigRoad(raw);

  const signals = [
    // Markov bậc 7 → 1 (cao nhất trước, weight cao nhất)
    tag(markovNSignal(beadAll, 7), 'MARKOV7'),
    tag(markovNSignal(beadAll, 6), 'MARKOV6'),
    tag(markovNSignal(beadAll, 5), 'MARKOV5'),
    tag(markovNSignal(beadAll, 4), 'MARKOV4'),
    tag(markovNSignal(beadAll, 3), 'MARKOV3'),
    tag(markovNSignal(beadAll, 2), 'MARKOV2'),
    tag(markovNSignal(beadAll, 1), 'MARKOV1'),
    // Statistical
    tag(bayesianSignal(beadAll),            'BAYESIAN'),
    tag(entropySignal(beadAll),             'ENTROPY'),
    // Road-based
    tag(patternSignal(cols),                'PATTERN'),
    tag(derivedSignal(cols, 1, 'Big Eye Boy'),   'BIG_EYE'),
    tag(derivedSignal(cols, 2, 'Small Road'),    'SMALL'),
    tag(derivedSignal(cols, 3, 'Cockroach'),     'COCKROACH'),
    tag(streakSignal(beadAll),              'STREAK'),
    tag(zigzagSignal(beadAll),              'ZIGZAG'),
    tag(bead30Signal(beadAll),              'BEAD30'),
  ];

  const result = combine(signals);
  if (!result) {
    return { du_doan: 'Chua du du lieu', do_tin_cay: '0%', notes: [], cau_dep: '', signals_used: 0 };
  }

  const notes  = result.votes.map(v =>
    `[${v.rel}] ${v.name} → ${v.side === 'B' ? 'Cái' : 'Con'}`
  );
  const patSig = signals.find(s => s && s.rel === 'PATTERN');

  return {
    du_doan:      result.pred === 'B' ? 'Cai' : 'Con',
    do_tin_cay:   result.conf + '%',
    notes,
    cau_dep:      patSig ? patSig.name : '',
    signals_used: result.votes.length,
    _debug: {
      scoreB:       result.scoreB,
      scoreP:       result.scoreP,
      history_len:  beadAll.length,
      entropy_20:   entropy(beadAll.slice(-20)).toFixed(3),
    },
  };
}

// ============================================
// FETCH & CACHE
// ============================================
async function fetchAndCache() {
  if (isFetching) return false;
  isFetching = true;
  fetchCount++;
  let hasNew = false;

  try {
    // Fetch V1 phien trước (await để đảm bảo phienMap đã có data)
    await fetchV1Phien();

    const fetched = await fetchAll();
    if (!fetched) { isFetching = false; return false; }

    const { items, source } = fetched;
    const banList  = cache ? [...cache] : [];
    const banIndex = {};
    banList.forEach((b, i) => { banIndex[b.ban] = i; });

    for (const item of items) {
      const ban    = String(item.table_name).trim();
      const result = String(item.result || '');

      if (lastResultStr.get(ban) === result) continue;
      lastResultStr.set(ban, result);

      const a = analyze(result);
      if (a.du_doan === 'Chua du du lieu') continue;

      const entry = {
        ban,
        // Lấy phien từ V1 map (luôn có nếu V1 còn sống)
        phien:        phienMap.get(ban) ?? null,
        dealer:       item.dealer_name || '',
        du_doan:      a.du_doan,
        do_tin_cay:   a.do_tin_cay,
        good_road:    a.cau_dep,
        signals_used: a.signals_used,
        notes:        a.notes,
        source,
        updated_at:   Date.now(),
      };

      if (ban in banIndex) banList[banIndex[ban]] = entry;
      else { banIndex[ban] = banList.length; banList.push(entry); }

      hasNew = true;
    }

    banList.sort((a, b) =>
      String(a.ban).localeCompare(String(b.ban), undefined, { numeric: true })
    );

    cache     = banList;
    lastFetch = Date.now();

    if (hasNew) {
      updateCount++;
      const ts = new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      console.log(`[${ts}] [#${updateCount}] fetch #${fetchCount} | ban: ${banList.length} | src: ${source}`);
    }
  } catch (err) {
    console.error('fetchAndCache error:', err.message);
  } finally {
    isFetching = false;
  }

  return hasNew;
}

async function loop() {
  await fetchAndCache();
  setTimeout(loop, POLL_MS);
}

// ============================================
// HTTP SERVER
// ============================================
function sendJSON(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Content-Length':              Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-cache',
  });
  res.end(body);
}

const server = http.createServer(async function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu' });
    return sendJSON(res, 200, {
      id:       '@sewdangcap',
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: cache.length,
      du_lieu:  cache,
    });
  }

  const match = url.match(/^\/api\/bcr\/(.+)$/);
  if (req.method === 'GET' && match) {
    const banId   = decodeURIComponent(match[1]).trim();
    let item      = cache ? cache.find(x => String(x.ban).trim() === banId) : null;
    let rawResult = lastResultStr.get(banId);

    if (!item) {
      // Đảm bảo phienMap có data
      await fetchV1Phien();
      const single = await fetchSingle(banId);
      if (single) {
        rawResult = single.result;
        const a = analyze(rawResult);
        item = {
          ban:          banId,
          phien:        phienMap.get(banId) ?? null,
          dealer:       single.dealer_name || '',
          du_doan:      a.du_doan,
          do_tin_cay:   a.do_tin_cay,
          good_road:    a.cau_dep,
          signals_used: a.signals_used,
          notes:        a.notes,
          source:       single.source,
          updated_at:   Date.now(),
        };
      }
    }

    if (!item) return sendJSON(res, 404, { loi: 'Khong tim thay ban: ' + banId });

    const raw  = (rawResult || '').toUpperCase().replace(/[^BPT]/g, '');
    const cols = buildBigRoad(raw);

    return sendJSON(res, 200, {
      id:       '@sewdangcap',
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      ...item,
      so_do_cau: {
        big_road_grid: buildBigRoadGrid(raw),
        bead_grid:     buildBeadGrid(raw),
        big_eye_boy:   buildDerived(cols, 1).join(''),
        small_road:    buildDerived(cols, 2).join(''),
        cockroach:     buildDerived(cols, 3).join(''),
      },
    });
  }

  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      status:            'ok',
      version:           'v12',
      cache_size:        cache ? cache.length : 0,
      phien_map_size:    phienMap.size,
      fetch_count:       fetchCount,
      update_count:      updateCount,
      last_fetch_ago_ms: Date.now() - lastFetch,
      sources: {
        v2_bpt:     API_V2_ALL,
        v1_phien:   API_V1_ALL,
        v1_single:  API_V1_TABLE + ':ban',
        strategy:   'V2(BPT) + V1(phien) merge → V1-fallback nếu V2 chết',
      },
      signals: Object.keys(W),
    });
  }

  sendJSON(res, 404, { loi: 'Route khong ton tai' });
});

server.listen(PORT, function () {
  console.log('\n=== BACCARAT BOT v12 - Markov 1-7 + Merge Source ===');
  console.log('BPT source  : V2 (results đầy đủ)');
  console.log('Phien source: V1 /all (phien field)');
  console.log('Signals     : Markov×7 + Bayesian + Entropy + Pattern + Derived×3 + Streak + Zigzag + Bead30');
  console.log('Routes:');
  console.log('  GET /api/bcr         -> toan bo ban');
  console.log('  GET /api/bcr/:ban    -> chi tiet + so_do_cau');
  console.log('  GET /health          -> trang thai\n');
  loop();
});
