// ============================================
// BACCARAT PREDICTOR v16 - @sewdangcap
// Single source: construct-vacuum-bosnia-travel.trycloudflare.com
// Change detection: update_at per ban (chinh xac hon full hash)
// Bo: van_du_doan, V1 API, phienMap
// Them: good_road pass-through, update_at tracking
// ============================================

const http  = require('http');
const fetch = require('node-fetch');

const API_URL = 'https://construct-vacuum-bosnia-travel.trycloudflare.com/api/bcr';

const PORT     = process.env.PORT || 3000;
const FETCH_TO = 4000;

// Adaptive delay
const DELAY_MIN  = 200;
const DELAY_MAX  = 2000;
const DELAY_STEP = 100;

const CONF_MIN = 55;
const CONF_MAX = 80;
const CFG      = { MIN_HANDS: 8 };

const W = {
  MARKOV7: 2.8, MARKOV6: 2.6, MARKOV5: 2.4, MARKOV4: 2.2,
  MARKOV3: 2.0, MARKOV2: 1.8, MARKOV1: 1.5,
  BAYESIAN: 1.6, ENTROPY: 1.3, PATTERN: 1.4,
  BIG_EYE: 1.2, SMALL: 1.0, COCKROACH: 0.8,
  STREAK: 1.1, ZIGZAG: 0.7, BEAD30: 0.9,
};

// ============================================
// STATE
// ============================================
let cache        = null;   // Map ban -> entry object
let lastFetch    = 0;
let fetchCount   = 0;
let updateCount  = 0;
let currentDelay = DELAY_MIN;
let isLooping    = false;
let lastChangeTs = 0;
let statChanged  = 0;
let statNoChange = 0;

// Per-ban tracking: detect change bang update_at + results length
// update_at thay doi -> hand moi -> re-analyze
const banState = new Map(); // ban -> { update_at, resultsLen }

// ============================================
// FETCH
// ============================================
async function safeFetch(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TO);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':    'Mozilla/5.0',
        'Accept':        'application/json',
        'Cache-Control': 'no-cache',
        'Pragma':        'no-cache',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ============================================
// PARSE API RESPONSE
// Input: raw json { code, data: [...] }
// Output: array of { ban, results, good_road, update_at }
// ============================================
function parseResponse(json) {
  if (!json || json.code !== 200) return null;
  const arr = json.data;
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.map(item => ({
    ban:       String(item.ban || '').trim(),
    results:   String(item.results || '').replace(/[^BPTbpt]/g, '').toUpperCase(),
    good_road: String(item.good_road || '').trim(),
    update_at: String(item.update_at || '').trim(),
  })).filter(x => x.ban);
}

// ============================================
// DETECT CHANGE PER BAN
// Dung update_at lam primary signal
// Fall back sang results length neu update_at kosng co
// Tra ve array ban nao can re-analyze
// ============================================
function detectChanged(items) {
  const changed = [];
  for (const item of items) {
    const prev = banState.get(item.ban);
    const curLen = item.results.length;

    const isNew = !prev
      || prev.update_at !== item.update_at
      || prev.resultsLen !== curLen;

    if (isNew) {
      banState.set(item.ban, {
        update_at:  item.update_at,
        resultsLen: curLen,
      });
      changed.push(item);
    }
  }
  return changed;
}

// ============================================
// ALGORITHMS
// ============================================
function entropy(arr) {
  const n = arr.length; if (!n) return 0;
  const cB = arr.filter(x => x === 'B').length;
  const pB = cB / n, pP = 1 - pB;
  const h = x => x > 0 ? -x * Math.log2(x) : 0;
  return h(pB) + h(pP);
}

function adaptiveWindow(bead, minW = 8, maxW = 60) {
  let bestW = Math.min(20, bead.length), bestS = -1;
  for (let w = minW; w <= Math.min(maxW, bead.length); w++) {
    const s = Math.abs(0.5 - bead.slice(-w).filter(x => x === 'B').length / w);
    if (s > bestS) { bestS = s; bestW = w; }
  }
  return bestW;
}

function markovNSignal(bead, order) {
  const n = bead.length;
  if (n < order * 4 + 10) return null;
  const minW  = Math.max(order * 3, 10);
  const maxW  = Math.min(order * 10 + 20, n);
  const w     = adaptiveWindow(bead, minW, maxW);
  const slice = bead.slice(-w);
  const key   = slice.slice(-(order + 1), -1).join('');
  if (key.length < order) return null;
  const counts = { B: 0, P: 0 };
  for (let i = order; i < slice.length; i++) {
    if (slice.slice(i - order, i).join('') !== key) continue;
    const nx = slice[i];
    if (nx === 'B' || nx === 'P') counts[nx]++;
  }
  const total = counts.B + counts.P;
  if (total < Math.max(3, order)) return null;
  const pB = counts.B / total;
  const mg  = Math.abs(pB - 0.5);
  if (mg < 0.05 + order * 0.01) return null;
  return {
    name:     `M${order}(w${w}):${key}->B${counts.B}/${total}`,
    side:     pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.92, mg * (2.0 + order * 0.1)),
  };
}

function bayesianSignal(bead) {
  const n = bead.length; if (n < 15) return null;
  const cB = bead.filter(x => x === 'B').length;
  const pB = (cB + 3) / (n + 6);
  const mg = Math.abs(pB - (1 - pB));
  if (mg < 0.04) return null;
  return {
    name:     `Bayes B=${cB}/${n}(${Math.round(pB * 100)}%)`,
    side:     pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.85, mg * 3),
  };
}

function entropySignal(bead) {
  const n = bead.length; if (n < 10) return null;
  const slice = bead.slice(-Math.min(20, n));
  const e     = entropy(slice);
  const pB    = slice.filter(x => x === 'B').length / slice.length;
  const last  = bead.at(-1), opp = last === 'B' ? 'P' : 'B';
  if (e < 0.7) return {
    name: `Ent_low(${e.toFixed(2)})`, side: pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.8, (0.7 - e) * 1.5),
  };
  if (e > 0.95) {
    let s = 1; while (s < n && bead[n - 1 - s] === last) s++;
    if (s >= 2) return {
      name: `Ent_high(${e.toFixed(2)})`, side: opp,
      strength: Math.min(0.6, (e - 0.95) * 4 + 0.2),
    };
  }
  return null;
}

function buildBigRoad(raw) {
  const cols = [];
  let curSide = null, curCol = [];
  for (const ch of raw) {
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
  return cols;
}

function buildDerived(cols, offset) {
  const out = [];
  for (let i = offset; i < cols.length; i++) {
    const cur = cols[i], ref = cols[i - offset];
    if (cur.length === 1 && ref.length === 1) { out.push('R'); continue; }
    let matched = true;
    for (let r = 1; r < Math.max(cur.length, ref.length); r++) {
      const a = cur[r]?.[0], b = ref[r]?.[0];
      if (!a && !b) continue;
      if (!a || !b) { matched = false; break; }
    }
    out.push(matched ? 'R' : 'B');
  }
  return out;
}

function predictDerived(cols, offset) {
  if (cols.length < offset + 1) return null;
  const last = cols.at(-1).at(-1)[0], opp = last === 'B' ? 'P' : 'B';
  const tryA = side => {
    const nc = cols.map(c => [...c]);
    side === last ? nc.at(-1).push(side) : nc.push([side]);
    return buildDerived(nc, offset).at(-1) || null;
  };
  const iS = tryA(last), iO = tryA(opp);
  if (iS === 'R' && iO === 'B') return last;
  if (iS === 'B' && iO === 'R') return opp;
  const rd = buildDerived(cols, offset);
  if (rd.length < 3) return null;
  const t = rd.slice(-6);
  const r = t.filter(x => x === 'R').length;
  const b = t.filter(x => x === 'B').length;
  if (r >= 4) return last;
  if (b >= 4) return opp;
  return null;
}

function patternSignal(cols) {
  if (cols.length < 2) return null;
  const lens = cols.slice(-8).map(c => c.length);
  const last = cols.at(-1);
  const cS   = last.at(-1)[0];
  const opp  = cS === 'B' ? 'P' : 'B';
  const cL   = last.length;
  if (cL >= 6) return { name: `Cau_dai${cL}`, side: cS,  strength: 0.9 };
  if (cL >= 4) return { name: `Cau_x${cL}`,   side: cS,  strength: 0.7 };
  if (lens.length >= 4 && lens.every(x => x === 1)) return { name: 'Cau_don', side: opp, strength: 0.85 };
  if (lens.length >= 4 && lens.every(x => x === 2)) return { name: 'Cau_doi', side: cL < 2 ? cS : opp, strength: 0.75 };
  if (lens.length >= 3 && lens.every(x => x === 3)) return { name: 'Cau_ba',  side: cL < 3 ? cS : opp, strength: 0.7 };
  if (lens.length >= 4) {
    if (lens.every((x, i) => i % 2 === 0 ? x === 1 : x === 2)) {
      const n = cols.length % 2 === 0 ? 2 : 1;
      return { name: 'Cau_1-2', side: cL < n ? cS : opp, strength: 0.72 };
    }
    if (lens.every((x, i) => i % 2 === 0 ? x === 2 : x === 1)) {
      const n = cols.length % 2 === 0 ? 1 : 2;
      return { name: 'Cau_2-1', side: cL < n ? cS : opp, strength: 0.72 };
    }
  }
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  return avg >= 3.5 ? { name: `Nghieng_${cS}`, side: cS, strength: 0.45 } : null;
}

function derivedSignal(cols, offset, label) {
  if (cols.length < offset + 2) return null;
  const p = predictDerived(cols, offset);
  if (!p) return null;
  return { name: label, side: p, strength: 0.75 };
}

function streakSignal(bead) {
  const n = bead.length; if (n < 5) return null;
  const last = bead.at(-1); let len = 1;
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
  const prior = Math.max(0.35, 0.58 - len * 0.02);
  const pB    = total >= 5 ? broke / total : prior;
  const opp   = last === 'B' ? 'P' : 'B';
  return {
    name:     `Bet${len}_ga${Math.round(pB * 100)}%(n=${total})`,
    side:     pB > 0.5 ? opp : last,
    strength: Math.min(0.88, Math.abs(pB - 0.5) * 2.2 + 0.3),
  };
}

function zigzagSignal(bead) {
  if (bead.length < 6) return null;
  const t = bead.slice(-6);
  if (!t.every((x, i) => i === 0 || x !== t[i - 1])) return null;
  return { name: 'Zigzag_1-1', side: bead.at(-1) === 'B' ? 'P' : 'B', strength: 0.72 };
}

function bead30Signal(bead) {
  const w     = adaptiveWindow(bead, 15, 40);
  const slice = bead.slice(-w);
  if (slice.length < 10) return null;
  const cB = slice.filter(x => x === 'B').length;
  const r  = cB / slice.length;
  if (Math.abs(r - 0.5) < 0.10) return null;
  return {
    name:     `Bead(w${w})B=${cB}/${slice.length}`,
    side:     r > 0.5 ? 'B' : 'P',
    strength: Math.min(0.75, Math.abs(r - 0.5) * 2.2),
  };
}

function tag(s, rel) { if (!s) return null; s.rel = rel; return s; }

function combine(signals) {
  const votes = signals.filter(Boolean);
  if (!votes.length) return null;
  let sB = 0, sP = 0;
  votes.forEach(v => {
    const w = v.strength * (W[v.rel] || 1);
    v.side === 'B' ? (sB += w) : (sP += w);
  });
  const total = sB + sP;
  const pred  = sB >= sP ? 'B' : 'P';
  const mg    = total > 0 ? Math.max(sB, sP) / total : 0.5;
  const dA    = votes.filter(v => ['BIG_EYE', 'SMALL', 'COCKROACH'].includes(v.rel) && v.side === pred).length;
  const mA    = votes.filter(v => v.rel.startsWith('MARKOV') && v.side === pred).length;
  let conf    = CONF_MIN
    + (mg - 0.5) * 50
    + (dA >= 3 ? 10 : dA === 2 ? 5 : 0)
    + (mA >= 5 ? 12 : mA >= 3 ? 7 : mA >= 2 ? 4 : 0)
    + (mg < 0.55 ? -5 : 0);
  conf = Math.max(CONF_MIN, Math.min(CONF_MAX, Math.round(conf)));
  return { pred, conf, count: votes.length };
}

function analyze(rawHistory) {
  const raw  = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const bead = [...raw].filter(x => x !== 'T');
  if (bead.length < CFG.MIN_HANDS) return null;
  const cols = buildBigRoad(raw);
  const r = combine([
    tag(markovNSignal(bead, 7), 'MARKOV7'),
    tag(markovNSignal(bead, 6), 'MARKOV6'),
    tag(markovNSignal(bead, 5), 'MARKOV5'),
    tag(markovNSignal(bead, 4), 'MARKOV4'),
    tag(markovNSignal(bead, 3), 'MARKOV3'),
    tag(markovNSignal(bead, 2), 'MARKOV2'),
    tag(markovNSignal(bead, 1), 'MARKOV1'),
    tag(bayesianSignal(bead),   'BAYESIAN'),
    tag(entropySignal(bead),    'ENTROPY'),
    tag(patternSignal(cols),    'PATTERN'),
    tag(derivedSignal(cols, 1, 'Big Eye Boy'), 'BIG_EYE'),
    tag(derivedSignal(cols, 2, 'Small Road'),  'SMALL'),
    tag(derivedSignal(cols, 3, 'Cockroach'),   'COCKROACH'),
    tag(streakSignal(bead),  'STREAK'),
    tag(zigzagSignal(bead),  'ZIGZAG'),
    tag(bead30Signal(bead),  'BEAD30'),
  ]);
  if (!r) return null;
  return { du_doan: r.pred === 'B' ? 'Cai' : 'Con', conf: r.conf, signals: r.count };
}

// ============================================
// APPLY UPDATE — chi re-analyze ban co thay doi
// ============================================
function applyUpdate(changedItems) {
  if (!changedItems.length) return 0;

  // Build current cache map
  const cacheMap = new Map();
  if (cache) cache.forEach(b => cacheMap.set(b.ban, b));

  let changed = 0;
  for (const item of changedItems) {
    const a = analyze(item.results);
    // Neu khong du data de analyze -> giu entry cu neu co, bo qua neu chua co
    if (!a) {
      if (!cacheMap.has(item.ban)) {
        cacheMap.set(item.ban, {
          ban:       item.ban,
          du_doan:   null,
          do_tin_cay: null,
          good_road: item.good_road,
          update_at: item.update_at,
          id:        '@sewdangcap',
          _ts:       Date.now(),
        });
      }
      continue;
    }

    cacheMap.set(item.ban, {
      ban:        item.ban,
      du_doan:    a.du_doan,
      do_tin_cay: a.conf + '%',
      good_road:  item.good_road,
      update_at:  item.update_at,
      id:         '@sewdangcap',
      _ts:        Date.now(),
    });
    changed++;
  }

  // Rebuild sorted array
  cache = [...cacheMap.values()].sort((a, b) =>
    String(a.ban).localeCompare(String(b.ban), undefined, { numeric: true })
  );
  lastFetch = Date.now();
  if (changed > 0) {
    updateCount++;
    lastChangeTs = Date.now();
    statChanged++;
  }
  return changed;
}

// ============================================
// CORE POLL
// ============================================
async function pollOnce() {
  fetchCount++;
  const json  = await safeFetch(API_URL);
  const items = parseResponse(json);
  if (!items) return 0;

  const changedItems = detectChanged(items);
  if (!changedItems.length) return 0;

  return applyUpdate(changedItems);
}

// ============================================
// REACTIVE LOOP — recursive, adaptive delay
// ============================================
async function reactiveLoop() {
  if (isLooping) return;
  isLooping = true;

  const loop = async () => {
    try {
      const t0      = Date.now();
      const changed = await pollOnce();
      const elapsed = Date.now() - t0;

      if (changed > 0) {
        currentDelay = DELAY_MIN;
        const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const s  = cache?.find(x => x.du_doan);
        console.log(`[${ts}] +${changed} ban cap nhat | fetch=${elapsed}ms delay=${currentDelay}ms`);
        if (s) console.log(`  ban=${s.ban} du_doan=${s.du_doan} dtc=${s.do_tin_cay} update_at=${s.update_at}`);
      } else {
        statNoChange++;
        currentDelay = Math.min(DELAY_MAX, currentDelay + DELAY_STEP);
      }
    } catch (e) {
      console.error('[POLL ERROR]', e.message);
      currentDelay = Math.min(DELAY_MAX, currentDelay + 200);
    }

    setTimeout(loop, currentDelay);
  };

  await loop();
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
    'Cache-Control':               'no-store',
  });
  res.end(body);
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  const url = req.url.split('?')[0];

  // GET /api/bcr — tat ca ban
  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu, cho 2-3s' });
    return sendJSON(res, 200, {
      id:       '@sewdangcap',
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: cache.length,
      du_lieu:  cache.map(b => ({
        ban:        b.ban,
        du_doan:    b.du_doan,
        do_tin_cay: b.do_tin_cay,
        good_road:  b.good_road,
        update_at:  b.update_at,
        id:         '@sewdangcap',
      })),
    });
  }

  // GET /api/bcr/:ban — mot ban cu the
  const match = url.match(/^\/api\/bcr\/(.+)$/);
  if (req.method === 'GET' && match) {
    const banId = decodeURIComponent(match[1]).trim();
    const item  = cache?.find(x => String(x.ban).trim() === banId);
    if (!item) return sendJSON(res, 404, { loi: `Khong tim thay ban: ${banId}` });
    return sendJSON(res, 200, {
      ban:        item.ban,
      du_doan:    item.du_doan,
      do_tin_cay: item.do_tin_cay,
      good_road:  item.good_road,
      update_at:  item.update_at,
      id:         '@sewdangcap',
      cap_nhat:   new Date(item._ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    });
  }

  // GET /health
  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      status:           'ok',
      version:          'v16',
      current_delay_ms: currentDelay,
      delay_range:      `${DELAY_MIN}-${DELAY_MAX}ms`,
      cache_size:       cache?.length ?? 0,
      fetch_count:      fetchCount,
      update_count:     updateCount,
      stat_changed:     statChanged,
      stat_no_change:   statNoChange,
      ms_since_change:  lastChangeTs ? Date.now() - lastChangeTs : null,
      last_fetch_ms:    Date.now() - lastFetch,
      ban_states:       [...banState.entries()].slice(0, 5).map(([k, v]) => ({
        ban: k, update_at: v.update_at, results_len: v.resultsLen,
      })),
    });
  }

  sendJSON(res, 404, {
    loi:    'Route khong ton tai',
    routes: ['/api/bcr', '/api/bcr/:ban', '/health'],
  });

}).listen(PORT, () => {
  console.log('\n=== BACCARAT v16 - Single Source, update_at Detection ===');
  console.log(`Port       : ${PORT}`);
  console.log(`API        : ${API_URL}`);
  console.log(`Delay range: ${DELAY_MIN}ms -> ${DELAY_MAX}ms (adaptive)`);
  console.log('Detection  : update_at per ban + results length fallback');
  console.log('Removed    : van_du_doan, V1 API, phienMap');
  console.log('Added      : good_road pass-through, update_at in output');
  console.log('Routes     : /api/bcr | /api/bcr/:ban | /health\n');
  reactiveLoop();
});
