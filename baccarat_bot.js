// ============================================
// BACCARAT PREDICTOR v15 - @sewdangcap
// Fix lag gốc: setInterval có dead zone = POLL_MS - fetch_time
// v15: recursive loop, spawn ngay sau khi xong
// Adaptive delay: no-change -> tăng (max 2s), có change -> reset 200ms
// ============================================

const http  = require('http');
const fetch = require('node-fetch');

const API_V2_ALL   = 'https://defining-continues-defendant-thorough.trycloudflare.com/api/bcr';
const API_V1_ALL   = 'https://referrals-episode-geography-mind.trycloudflare.com/api/bcr/all';

const PORT     = process.env.PORT || 3000;
const FETCH_TO = 4000;

// Adaptive delay config
const DELAY_MIN  = 200;   // ms - khi co data moi
const DELAY_MAX  = 2000;  // ms - khi khong co gi thay doi
const DELAY_STEP = 100;   // ms - tang moi cycle khong co change

const CONF_MIN = 55;
const CONF_MAX = 80;
const CFG      = { MAX_ROW: 6, MIN_HANDS: 8 };

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
let cache        = null;
let lastFetch    = 0;
let fetchCount   = 0;
let updateCount  = 0;
let currentDelay = DELAY_MIN;
let isLooping    = false;

let lastV2Hash = '';
let lastV1Hash = '';

const lastResultStr = new Map();
const phienMap      = new Map();

// Stats de debug lag
let statNoChange = 0;
let statChanged  = 0;
let lastChangeTs = 0;

// ============================================
// FETCH HELPER
// ============================================
async function safeFetch(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TO);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0',
        'Accept':          'application/json',
        'Cache-Control':   'no-cache',
        'Pragma':          'no-cache',
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
// HASH - dua vao content thuc, khong phai length
// v14 dung length+slice(200) -> co the miss thay doi
// v15 dung full stringify hash (FNV-1a lightweight)
// ============================================
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}

function contentHash(obj) {
  try { return fnv1a(JSON.stringify(obj)); }
  catch { return String(Date.now()); }
}

// ============================================
// PARSE V1 -> phienMap
// ============================================
function parseV1Phien(json) {
  const arr = Array.isArray(json) ? json : (json?.data || json?.du_lieu);
  if (!Array.isArray(arr)) return 0;
  let updated = 0;
  for (const item of arr) {
    const ban   = String(item.ban || '').trim();
    const phien = item.phien != null ? Number(item.phien) : null;
    if (!ban || phien == null) continue;
    if (phienMap.get(ban) !== phien) {
      phienMap.set(ban, phien);
      updated++;
    }
  }
  return updated;
}

// ============================================
// PARSE V2 -> BPT items
// ============================================
function parseV2(json) {
  if (!json) return null;
  const arr = json.du_lieu || json.data || (Array.isArray(json) ? json : null);
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.map(item => ({
    ban:    String(item.ban || item.table_name || '').trim(),
    result: String(item.results || item.result || '').replace(/[^BPTbpt]/g, '').toUpperCase(),
    dealer: item.dealer || item.dealer_name || '',
  })).filter(x => x.ban);
}

// ============================================
// ALGORITHMS (unchanged from v14)
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
  return { name: `M${order}(w${w}):${key}->B${counts.B}/${total}`, side: pB > 0.5 ? 'B' : 'P', strength: Math.min(0.92, mg * (2.0 + order * 0.1)) };
}
function bayesianSignal(bead) {
  const n = bead.length; if (n < 15) return null;
  const cB = bead.filter(x => x === 'B').length;
  const pB = (cB + 3) / (n + 6);
  const mg = Math.abs(pB - (1 - pB));
  if (mg < 0.04) return null;
  return { name: `Bayes B=${cB}/${n}(${Math.round(pB * 100)}%)`, side: pB > 0.5 ? 'B' : 'P', strength: Math.min(0.85, mg * 3) };
}
function entropySignal(bead) {
  const n = bead.length; if (n < 10) return null;
  const slice = bead.slice(-Math.min(20, n));
  const e  = entropy(slice);
  const pB = slice.filter(x => x === 'B').length / slice.length;
  const last = bead.at(-1), opp = last === 'B' ? 'P' : 'B';
  if (e < 0.7) return { name: `Ent_low(${e.toFixed(2)})`, side: pB > 0.5 ? 'B' : 'P', strength: Math.min(0.8, (0.7 - e) * 1.5) };
  if (e > 0.95) {
    let s = 1; while (s < n && bead[n - 1 - s] === last) s++;
    if (s >= 2) return { name: `Ent_high(${e.toFixed(2)})`, side: opp, strength: Math.min(0.6, (e - 0.95) * 4 + 0.2) };
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
    if (ch !== curSide) { if (curCol.length) cols.push(curCol); curCol = [ch]; curSide = ch; }
    else curCol.push(ch);
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
  const rd = buildDerived(cols, offset); if (rd.length < 3) return null;
  const t  = rd.slice(-6);
  const r  = t.filter(x => x === 'R').length, b = t.filter(x => x === 'B').length;
  if (r >= 4) return last;
  if (b >= 4) return opp;
  return null;
}
function patternSignal(cols) {
  if (cols.length < 2) return null;
  const lens = cols.slice(-8).map(c => c.length);
  const last = cols.at(-1), cS = last.at(-1)[0], opp = cS === 'B' ? 'P' : 'B', cL = last.length;
  if (cL >= 6) return { name: `Cau_dai${cL}`, side: cS, strength: 0.9 };
  if (cL >= 4) return { name: `Cau_x${cL}`,   side: cS, strength: 0.7 };
  if (lens.length >= 4 && lens.every(x => x === 1)) return { name: 'Cau_don', side: opp, strength: 0.85 };
  if (lens.length >= 4 && lens.every(x => x === 2)) return { name: 'Cau_doi', side: cL < 2 ? cS : opp, strength: 0.75 };
  if (lens.length >= 3 && lens.every(x => x === 3)) return { name: 'Cau_ba',  side: cL < 3 ? cS : opp, strength: 0.7 };
  if (lens.length >= 4) {
    if (lens.every((x, i) => i % 2 === 0 ? x === 1 : x === 2)) { const n = cols.length % 2 === 0 ? 2 : 1; return { name: 'Cau_1-2', side: cL < n ? cS : opp, strength: 0.72 }; }
    if (lens.every((x, i) => i % 2 === 0 ? x === 2 : x === 1)) { const n = cols.length % 2 === 0 ? 1 : 2; return { name: 'Cau_2-1', side: cL < n ? cS : opp, strength: 0.72 }; }
  }
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  return avg >= 3.5 ? { name: `Nghieng_${cS}`, side: cS, strength: 0.45 } : null;
}
function derivedSignal(cols, offset, label) {
  if (cols.length < offset + 2) return null;
  const p = predictDerived(cols, offset); if (!p) return null;
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
    let s = 1; for (let j = i - 1; j >= 0 && bead[j] === bead[i - 1]; j--) s++;
    if (s !== len) continue; total++;
    if (i + 1 < n && bead[i + 1] !== bead[i]) broke++;
  }
  const prior = Math.max(0.35, 0.58 - len * 0.02);
  const pB    = total >= 5 ? broke / total : prior;
  const opp   = last === 'B' ? 'P' : 'B';
  return { name: `Bet${len}_ga${Math.round(pB * 100)}%(n=${total})`, side: pB > 0.5 ? opp : last, strength: Math.min(0.88, Math.abs(pB - 0.5) * 2.2 + 0.3) };
}
function zigzagSignal(bead) {
  if (bead.length < 6) return null;
  const t = bead.slice(-6);
  if (!t.every((x, i) => i === 0 || x !== t[i - 1])) return null;
  return { name: 'Zigzag_1-1', side: bead.at(-1) === 'B' ? 'P' : 'B', strength: 0.72 };
}
function bead30Signal(bead) {
  const w = adaptiveWindow(bead, 15, 40), slice = bead.slice(-w);
  if (slice.length < 10) return null;
  const cB = slice.filter(x => x === 'B').length, r = cB / slice.length;
  if (Math.abs(r - 0.5) < 0.10) return null;
  return { name: `Bead(w${w})B=${cB}/${slice.length}`, side: r > 0.5 ? 'B' : 'P', strength: Math.min(0.75, Math.abs(r - 0.5) * 2.2) };
}
function tag(s, rel) { if (!s) return null; s.rel = rel; return s; }

function combine(signals) {
  const votes = signals.filter(Boolean);
  if (!votes.length) return null;
  let sB = 0, sP = 0;
  votes.forEach(v => { const w = v.strength * (W[v.rel] || 1); v.side === 'B' ? (sB += w) : (sP += w); });
  const total = sB + sP, pred = sB >= sP ? 'B' : 'P', mg = total > 0 ? Math.max(sB, sP) / total : 0.5;
  const dA = votes.filter(v => ['BIG_EYE', 'SMALL', 'COCKROACH'].includes(v.rel) && v.side === pred).length;
  const mA = votes.filter(v => v.rel.startsWith('MARKOV') && v.side === pred).length;
  let conf = CONF_MIN + (mg - 0.5) * 50 + (dA >= 3 ? 10 : dA === 2 ? 5 : 0) + (mA >= 5 ? 12 : mA >= 3 ? 7 : mA >= 2 ? 4 : 0) + (mg < 0.55 ? -5 : 0);
  conf = Math.max(CONF_MIN, Math.min(CONF_MAX, Math.round(conf)));
  return { pred, conf, count: votes.length };
}

function analyze(rawHistory) {
  const raw  = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const bead = [...raw].filter(x => x !== 'T');
  if (bead.length < CFG.MIN_HANDS) return null;
  const cols = buildBigRoad(raw);
  const r = combine([
    tag(markovNSignal(bead, 7), 'MARKOV7'), tag(markovNSignal(bead, 6), 'MARKOV6'),
    tag(markovNSignal(bead, 5), 'MARKOV5'), tag(markovNSignal(bead, 4), 'MARKOV4'),
    tag(markovNSignal(bead, 3), 'MARKOV3'), tag(markovNSignal(bead, 2), 'MARKOV2'),
    tag(markovNSignal(bead, 1), 'MARKOV1'), tag(bayesianSignal(bead), 'BAYESIAN'),
    tag(entropySignal(bead), 'ENTROPY'),    tag(patternSignal(cols), 'PATTERN'),
    tag(derivedSignal(cols, 1, 'Big Eye Boy'), 'BIG_EYE'),
    tag(derivedSignal(cols, 2, 'Small Road'),  'SMALL'),
    tag(derivedSignal(cols, 3, 'Cockroach'),   'COCKROACH'),
    tag(streakSignal(bead), 'STREAK'),      tag(zigzagSignal(bead), 'ZIGZAG'),
    tag(bead30Signal(bead), 'BEAD30'),
  ]);
  if (!r) return null;
  return { du_doan: r.pred === 'B' ? 'Cai' : 'Con', conf: r.conf, signals: r.count };
}

// ============================================
// APPLY UPDATE
// ============================================
function applyUpdate(v2Items) {
  if (!v2Items || !v2Items.length) return 0;
  const banList  = cache ? [...cache] : [];
  const banIndex = {};
  banList.forEach((b, i) => { banIndex[b.ban] = i; });
  let changed = 0;
  for (const item of v2Items) {
    const { ban, result } = item;
    if (lastResultStr.get(ban) === result) continue;
    lastResultStr.set(ban, result);
    const a = analyze(result);
    if (!a) continue;
    const phienHienTai = phienMap.get(ban) ?? null;
    const vanDuDoan    = phienHienTai != null ? phienHienTai + 1 : null;
    const entry = { ban, van_du_doan: vanDuDoan, du_doan: a.du_doan, do_tin_cay: a.conf + '%', id: '@sewdangcap', _ts: Date.now() };
    if (ban in banIndex) banList[banIndex[ban]] = entry;
    else { banIndex[ban] = banList.length; banList.push(entry); }
    changed++;
  }
  if (changed > 0) {
    banList.sort((a, b) => String(a.ban).localeCompare(String(b.ban), undefined, { numeric: true }));
    cache     = banList;
    lastFetch = Date.now();
    updateCount++;
    lastChangeTs = Date.now();
    statChanged++;
  }
  return changed;
}

function applyPhienOnly() {
  if (!cache || !phienMap.size) return 0;
  let updated = 0;
  const newCache = cache.map(b => {
    const p = phienMap.get(b.ban);
    if (p == null) return b;
    const newVan = p + 1;
    if (b.van_du_doan === newVan) return b;
    updated++;
    return { ...b, van_du_doan: newVan };
  });
  if (updated > 0) {
    cache     = newCache;
    lastFetch = Date.now();
  }
  return updated;
}

// ============================================
// CORE POLL — fetch V1+V2 song song
// Tra ve { changed, phienUpdated }
// ============================================
async function pollOnce() {
  fetchCount++;

  const [v1Json, v2Json] = await Promise.all([
    safeFetch(API_V1_ALL),
    safeFetch(API_V2_ALL),
  ]);

  // --- V1: update phienMap ---
  let phienUpdated = 0;
  if (v1Json) {
    const h = contentHash(v1Json);
    if (h !== lastV1Hash) {
      lastV1Hash   = h;
      phienUpdated = parseV1Phien(v1Json);
    }
  }

  // --- V2: re-analyze khi content thay doi ---
  let changed = 0;
  if (v2Json) {
    const h = contentHash(v2Json);
    if (h !== lastV2Hash) {
      lastV2Hash = h;
      const items = parseV2(v2Json);
      changed = applyUpdate(items);
    } else if (phienUpdated > 0) {
      // BPT khong doi nhung phien moi -> chi update van_du_doan
      applyPhienOnly();
    }
  }

  return { changed, phienUpdated };
}

// ============================================
// REACTIVE LOOP
// Khong dung setInterval - spawn ngay sau khi pollOnce xong
// Adaptive delay: co change -> DELAY_MIN, khong -> tang dan len DELAY_MAX
//
// Tai sao nhanh hon setInterval(800ms):
//   setInterval(800): neu fetch mat 300ms -> dead zone 500ms
//   v15 recursive: fetch xong -> delay MIN 200ms -> fetch tiep
//   Tong cycle: 300ms fetch + 200ms delay = 500ms thay vi 800ms
//   Khi nguon doi nhanh -> dead zone = 0
// ============================================
async function reactiveLoop() {
  if (isLooping) return;
  isLooping = true;

  const loop = async () => {
    try {
      const t0 = Date.now();
      const { changed, phienUpdated } = await pollOnce();
      const elapsed = Date.now() - t0;

      if (changed > 0 || phienUpdated > 0) {
        // Co thay doi: reset delay ve minimum
        currentDelay = DELAY_MIN;
        statChanged++;
        const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const s  = cache?.[0];
        console.log(`[${ts}] +BPT=${changed} +Phien=${phienUpdated} fetch=${elapsed}ms delay=${currentDelay}ms`);
        if (s) console.log(`  ban=${s.ban} van=${s.van_du_doan} du_doan=${s.du_doan} dtc=${s.do_tin_cay}`);
      } else {
        // Khong co gi moi: tang delay (backoff nhe, tranh hammer)
        statNoChange++;
        currentDelay = Math.min(DELAY_MAX, currentDelay + DELAY_STEP);
      }
    } catch (e) {
      console.error('[POLL ERROR]', e.message);
      currentDelay = Math.min(DELAY_MAX, currentDelay + 200);
    }

    // Spawn cycle tiep ngay - delay hien tai
    setTimeout(loop, currentDelay);
  };

  // Lan dau chay ngay, khong delay
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

  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu, cho 2-3s' });
    return sendJSON(res, 200, {
      id:       '@sewdangcap',
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: cache.length,
      du_lieu:  cache.map(b => ({
        ban:         b.ban,
        van_du_doan: b.van_du_doan,
        du_doan:     b.du_doan,
        do_tin_cay:  b.do_tin_cay,
        id:          '@sewdangcap',
      })),
    });
  }

  const match = url.match(/^\/api\/bcr\/(.+)$/);
  if (req.method === 'GET' && match) {
    const banId = decodeURIComponent(match[1]).trim();
    const item  = cache?.find(x => String(x.ban).trim() === banId);
    if (!item) return sendJSON(res, 404, { loi: `Khong tim thay ban: ${banId}` });
    return sendJSON(res, 200, {
      ban:         item.ban,
      van_du_doan: item.van_du_doan,
      du_doan:     item.du_doan,
      do_tin_cay:  item.do_tin_cay,
      id:          '@sewdangcap',
      cap_nhat:    new Date(item._ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    });
  }

  if (req.method === 'GET' && url === '/health') {
    const msSinceChange = lastChangeTs ? Date.now() - lastChangeTs : null;
    return sendJSON(res, 200, {
      status:          'ok',
      version:         'v15',
      current_delay_ms: currentDelay,
      delay_range:     `${DELAY_MIN}-${DELAY_MAX}ms`,
      cache_size:      cache?.length ?? 0,
      phien_map:       phienMap.size,
      fetch_count:     fetchCount,
      update_count:    updateCount,
      stat_changed:    statChanged,
      stat_no_change:  statNoChange,
      ms_since_change: msSinceChange,
      last_fetch_ms:   Date.now() - lastFetch,
      phien_sample:    [...phienMap.entries()].slice(0, 5).map(([k, v]) => ({
        ban: k, phien_hien_tai: v, van_du_doan: v + 1,
      })),
    });
  }

  sendJSON(res, 404, { loi: 'Route khong ton tai', routes: ['/api/bcr', '/api/bcr/:ban', '/health'] });

}).listen(PORT, () => {
  console.log('\n=== BACCARAT v15 - Reactive Loop, Adaptive Delay ===');
  console.log(`Port       : ${PORT}`);
  console.log(`Delay range: ${DELAY_MIN}ms (change) -> ${DELAY_MAX}ms (no change)`);
  console.log('Fix lag    : recursive setTimeout, spawn ngay sau poll');
  console.log('Fix hash   : FNV-1a full content hash thay vi length+slice');
  console.log('Adaptive   : co data moi -> reset DELAY_MIN, khong co -> backoff');
  console.log('Routes     : /api/bcr | /api/bcr/:ban | /health\n');
  reactiveLoop();
});
