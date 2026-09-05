// ============================================
// BACCARAT PREDICTOR v13 - @sewdangcap
// Fix: phien null (await fetchV1Phien truoc het)
// Fix: van_du_doan = phien_hien_tai + 1
// Fix: do_tin_cay clamp 55-80%
// Output: ban, van_du_doan, du_doan, do_tin_cay, id
// ============================================

const http  = require('http');
const fetch = require('node-fetch');

// V2: co BPT day du (results string)
// V1 /all: co phien chinh xac
// V1 /:ban: chi tiet tung ban (fallback)
const API_V2_ALL   = 'https://defining-continues-defendant-thorough.trycloudflare.com/api/bcr';
const API_V1_ALL   = 'https://referrals-episode-geography-mind.trycloudflare.com/api/bcr/all';
const API_V1_TABLE = 'https://referrals-episode-geography-mind.trycloudflare.com/api/bcr/';

const PORT     = process.env.PORT || 3000;
const POLL_MS  = 2000;
const FETCH_TO = 5000;

// Clamp do_tin_cay trong khoang [55, 80]
const CONF_MIN = 55;
const CONF_MAX = 80;

const CFG = { MAX_ROW: 6, MIN_HANDS: 8 };

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
let cache      = null;   // Array ban entries
let lastFetch  = 0;
let isFetching = false;
let fetchCount = 0, updateCount = 0;
const lastResultStr = new Map();  // ban -> BPT string
const phienMap      = new Map();  // ban -> phien hien tai (so phien cua van TRUOC)

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
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ============================================
// FETCH V1 /all de lay phien
// V1 /all tra ve array: [{ban, phien, ket_qua_truoc, ...}]
// phien o day la so phien cua van TRC do (van hien tai)
// Van du doan = phien + 1
// ============================================
async function fetchV1Phien() {
  const json = await safeFetch(API_V1_ALL);
  if (!Array.isArray(json)) {
    // Thu parse neu wrapped
    const arr = json && (json.data || json.du_lieu);
    if (!Array.isArray(arr)) return false;
    for (const item of arr) {
      const ban = String(item.ban || '').trim();
      if (ban && item.phien != null) phienMap.set(ban, Number(item.phien));
    }
    return true;
  }
  for (const item of json) {
    const ban = String(item.ban || '').trim();
    if (ban && item.phien != null) phienMap.set(ban, Number(item.phien));
  }
  console.log(`[PHIEN] V1 /all OK: ${phienMap.size} ban co phien`);
  return phienMap.size > 0;
}

// ============================================
// NORMALIZE V2
// V2 /api/bcr: { id, du_lieu: [{ban, results, ...}] }
// ============================================
function normalizeV2(json) {
  if (!json) return null;
  const arr = json.du_lieu || json.data || (Array.isArray(json) ? json : null);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map(item => ({
    table_name:  String(item.ban || item.table_name || '').trim(),
    result:      String(item.results || item.result || '').replace(/[^BPTbpt]/g, '').toUpperCase(),
    dealer_name: item.dealer || item.dealer_name || '',
  })).filter(x => x.table_name);
}

// ============================================
// FETCH ALL - V1 phien TRUOC, V2 BPT sau
// ============================================
async function fetchAll() {
  // AWAIT V1 phien truoc het - day la fix chinh
  await fetchV1Phien();

  // V2 primary: co BPT day du
  const v2      = await safeFetch(API_V2_ALL);
  const v2Items = normalizeV2(v2);
  if (v2Items && v2Items.length > 0) {
    console.log(`[SOURCE] V2 OK: ${v2Items.length} ban`);
    return { items: v2Items, source: 'V2' };
  }

  // V1 fallback
  console.warn('[SOURCE] V2 fail, V1 fallback');
  const v1All = await safeFetch(API_V1_ALL);
  if (!Array.isArray(v1All)) return null;
  const fetched = await Promise.all(
    v1All.map(async item => {
      const ban = String(item.ban || '').trim();
      const s   = await safeFetch(API_V1_TABLE + encodeURIComponent(ban));
      const result = s && s.last_5
        ? s.last_5.map(x => {
            const w = (x.winner || '').toLowerCase();
            return w === 'banker' ? 'B' : w === 'player' ? 'P' : w === 'tie' ? 'T' : '';
          }).filter(Boolean).join('')
        : '';
      return { table_name: ban, result, dealer_name: '' };
    })
  );
  return { items: fetched.filter(x => x.table_name), source: 'V1-fallback' };
}

// ============================================
// ROADS
// ============================================
function buildBigRoad(raw) {
  const cols = [];
  let curSide = null, curCol = [];
  for (const ch of raw) {
    if (ch === 'T') {
      if (curCol.length > 0) curCol[curCol.length - 1] += 'T';
      else if (cols.length > 0) cols[cols.length-1][cols[cols.length-1].length-1] += 'T';
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
// ALGORITHMS
// ============================================
function entropy(arr) {
  const n = arr.length;
  if (!n) return 0;
  const cB = arr.filter(x => x === 'B').length;
  const pB = cB / n, pP = 1 - pB;
  const h  = x => (x > 0 ? -x * Math.log2(x) : 0);
  return h(pB) + h(pP);
}

function adaptiveWindow(bead, minW = 8, maxW = 60) {
  let bestW = Math.min(20, bead.length), bestS = -1;
  for (let w = minW; w <= Math.min(maxW, bead.length); w++) {
    const slice = bead.slice(-w);
    const s     = Math.abs(0.5 - slice.filter(x => x === 'B').length / w);
    if (s > bestS) { bestS = s; bestW = w; }
  }
  return bestW;
}

function markovNSignal(bead, order) {
  const n          = bead.length;
  const minSamples = order * 4 + 10;
  if (n < minSamples) return null;
  const minW  = Math.max(order * 3, 10);
  const maxW  = Math.min(order * 10 + 20, n);
  const w     = adaptiveWindow(bead, minW, maxW);
  const slice = bead.slice(-w);
  const key   = slice.slice(-(order + 1), -1).join('');
  if (key.length < order) return null;
  const counts = { B: 0, P: 0 };
  for (let i = order; i < slice.length; i++) {
    const context = slice.slice(i - order, i).join('');
    if (context !== key) continue;
    const next = slice[i];
    if (next === 'B' || next === 'P') counts[next]++;
  }
  const total = counts.B + counts.P;
  if (total < Math.max(3, order)) return null;
  const pB     = counts.B / total;
  const margin = Math.abs(pB - 0.5);
  if (margin < 0.05 + order * 0.01) return null;
  return {
    name:     `M${order}(w${w}):"${key}"->B ${counts.B}/${total}(${Math.round(pB*100)}%)`,
    side:     pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.92, margin * (2.0 + order * 0.1)),
  };
}

function bayesianSignal(bead) {
  const n = bead.length;
  if (n < 15) return null;
  const cB    = bead.filter(x => x === 'B').length;
  const alpha = 3;
  const pB    = (cB + alpha) / (n + 2 * alpha);
  const margin = Math.abs(pB - (1 - pB));
  if (margin < 0.04) return null;
  return { name: `Bayes B=${cB}/${n}(${Math.round(pB*100)}%)`, side: pB > 0.5 ? 'B' : 'P', strength: Math.min(0.85, margin * 3) };
}

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
  if (e < 0.7)  return { name: `Entropy thap(${e.toFixed(2)})`, side: pB > 0.5 ? 'B' : 'P', strength: Math.min(0.8, (0.7 - e) * 1.5) };
  if (e > 0.95) {
    let sLen = 1;
    while (sLen < n && bead[n-1-sLen] === last) sLen++;
    if (sLen >= 2) return { name: `Entropy cao(${e.toFixed(2)}) nguoc streak`, side: opp, strength: Math.min(0.6, (e-0.95)*4+0.2) };
  }
  return null;
}

function patternSignal(cols) {
  if (cols.length < 2) return null;
  const lens    = cols.slice(-8).map(c => c.length);
  const last    = cols.at(-1);
  const curSide = last.at(-1)[0];
  const opp     = curSide === 'B' ? 'P' : 'B';
  const curLen  = last.length;
  if (curLen >= 6) return { name: `Cau dai ${curLen}`, side: curSide, strength: 0.9 };
  if (curLen >= 4) return { name: `Cau x${curLen}`,   side: curSide, strength: 0.7 };
  if (lens.length >= 4 && lens.every(x => x === 1)) return { name: 'Cau don', side: opp, strength: 0.85 };
  if (lens.length >= 4 && lens.every(x => x === 2)) return { name: 'Cau doi', side: curLen < 2 ? curSide : opp, strength: 0.75 };
  if (lens.length >= 3 && lens.every(x => x === 3)) return { name: 'Cau ba',  side: curLen < 3 ? curSide : opp, strength: 0.7 };
  if (lens.length >= 4) {
    const is12 = lens.every((x, i) => i % 2 === 0 ? x === 1 : x === 2);
    const is21 = lens.every((x, i) => i % 2 === 0 ? x === 2 : x === 1);
    if (is12) { const nxt = cols.length % 2 === 0 ? 2 : 1; return { name: 'Cau 1-2', side: curLen < nxt ? curSide : opp, strength: 0.72 }; }
    if (is21) { const nxt = cols.length % 2 === 0 ? 1 : 2; return { name: 'Cau 2-1', side: curLen < nxt ? curSide : opp, strength: 0.72 }; }
  }
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  if (avg >= 3.5) return { name: `Nghieng ${curSide}`, side: curSide, strength: 0.45 };
  return null;
}

function derivedSignal(cols, offset, label) {
  if (cols.length < offset + 2) return null;
  const pred = predictDerived(cols, offset);
  if (!pred) return null;
  return { name: label, side: pred, strength: 0.75 };
}

function streakSignal(bead) {
  const n = bead.length;
  if (n < 5) return null;
  const last = bead.at(-1);
  let len = 1;
  while (len < n && bead[n-1-len] === last) len++;
  if (len < 3) return null;
  let broke = 0, total = 0;
  for (let i = len; i < n; i++) {
    if (bead[i] === bead[i-1]) continue;
    let s = 1;
    for (let j = i-1; j >= 0 && bead[j] === bead[i-1]; j--) s++;
    if (s !== len) continue;
    total++;
    if (i+1 < n && bead[i+1] !== bead[i]) broke++;
  }
  const prior  = Math.max(0.35, 0.58 - len * 0.02);
  const pBreak = total >= 5 ? broke / total : prior;
  const opp    = last === 'B' ? 'P' : 'B';
  return {
    name:     `Bet ${len} P(ga)=${Math.round(pBreak*100)}%(n=${total})`,
    side:     pBreak > 0.5 ? opp : last,
    strength: Math.min(0.88, Math.abs(pBreak-0.5)*2.2+0.3),
  };
}

function zigzagSignal(bead) {
  if (bead.length < 6) return null;
  const tail = bead.slice(-6);
  if (!tail.every((x, i) => i === 0 || x !== tail[i-1])) return null;
  return { name: 'Zigzag 1-1(6)', side: bead.at(-1) === 'B' ? 'P' : 'B', strength: 0.72 };
}

function bead30Signal(bead) {
  const w     = adaptiveWindow(bead, 15, 40);
  const slice = bead.slice(-w);
  if (slice.length < 10) return null;
  const cB = slice.filter(x => x === 'B').length;
  const r  = cB / slice.length;
  if (Math.abs(r - 0.5) < 0.10) return null;
  return { name: `Bead(w${w}) B=${cB}/${slice.length}(${Math.round(r*100)}%)`, side: r > 0.5 ? 'B' : 'P', strength: Math.min(0.75, Math.abs(r-0.5)*2.2) };
}

// ============================================
// COMBINE
// ============================================
function combine(signals) {
  const votes = signals.filter(Boolean);
  if (!votes.length) return null;
  let scoreB = 0, scoreP = 0;
  votes.forEach(v => {
    const w = v.strength * (W[v.rel] || 1.0);
    v.side === 'B' ? (scoreB += w) : (scoreP += w);
  });
  const total  = scoreB + scoreP;
  const pred   = scoreB >= scoreP ? 'B' : 'P';
  const margin = total > 0 ? Math.max(scoreB, scoreP) / total : 0.5;

  const derivedAgree = votes.filter(v => ['BIG_EYE','SMALL','COCKROACH'].includes(v.rel) && v.side === pred).length;
  const markovAgree  = votes.filter(v => v.rel.startsWith('MARKOV') && v.side === pred).length;

  const derivedBonus  = derivedAgree >= 3 ? 10 : derivedAgree === 2 ? 5 : 0;
  const markovBonus   = markovAgree >= 5 ? 12 : markovAgree >= 3 ? 7 : markovAgree >= 2 ? 4 : 0;
  const balancePenalty = margin < 0.55 ? -5 : 0;

  let conf = CONF_MIN + (margin - 0.5) * 50 + derivedBonus + markovBonus + balancePenalty;
  conf = Math.max(CONF_MIN, Math.min(CONF_MAX, Math.round(conf)));

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
  const raw     = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const beadAll = [...raw].filter(x => x !== 'T');

  if (beadAll.length < CFG.MIN_HANDS) {
    return { du_doan: 'Chua du du lieu', do_tin_cay: '0%', signals_used: 0 };
  }

  const cols = buildBigRoad(raw);

  const signals = [
    tag(markovNSignal(beadAll, 7), 'MARKOV7'),
    tag(markovNSignal(beadAll, 6), 'MARKOV6'),
    tag(markovNSignal(beadAll, 5), 'MARKOV5'),
    tag(markovNSignal(beadAll, 4), 'MARKOV4'),
    tag(markovNSignal(beadAll, 3), 'MARKOV3'),
    tag(markovNSignal(beadAll, 2), 'MARKOV2'),
    tag(markovNSignal(beadAll, 1), 'MARKOV1'),
    tag(bayesianSignal(beadAll),                    'BAYESIAN'),
    tag(entropySignal(beadAll),                     'ENTROPY'),
    tag(patternSignal(cols),                        'PATTERN'),
    tag(derivedSignal(cols, 1, 'Big Eye Boy'),      'BIG_EYE'),
    tag(derivedSignal(cols, 2, 'Small Road'),       'SMALL'),
    tag(derivedSignal(cols, 3, 'Cockroach'),        'COCKROACH'),
    tag(streakSignal(beadAll),                      'STREAK'),
    tag(zigzagSignal(beadAll),                      'ZIGZAG'),
    tag(bead30Signal(beadAll),                      'BEAD30'),
  ];

  const result = combine(signals);
  if (!result) return { du_doan: 'Chua du du lieu', do_tin_cay: '0%', signals_used: 0 };

  return {
    du_doan:      result.pred === 'B' ? 'Cai' : 'Con',
    do_tin_cay:   result.conf + '%',
    signals_used: result.votes.length,
    _score: { B: result.scoreB, P: result.scoreP },
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
    // AWAIT V1 phien - fix chinh
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

      // phien hien tai tu V1 map
      const phienHienTai = phienMap.get(ban) ?? null;
      // Van du doan = phien tiep theo
      const vanDuDoan    = phienHienTai != null ? phienHienTai + 1 : null;

      const entry = {
        ban,
        van_du_doan:  vanDuDoan,    // phien tiec theo - day la van can du doan
        du_doan:      a.du_doan,
        do_tin_cay:   a.do_tin_cay,
        id:           '@sewdangcap',
        // Internal - khong show o list, chi show o detail
        _signals_used: a.signals_used,
        _source:       source,
        _updated_at:   Date.now(),
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
      console.log(`[${ts}] #${updateCount} | ${banList.length} ban | phienMap: ${phienMap.size} entries`);
      // Log sample
      if (banList.length > 0) {
        const s = banList[0];
        console.log(`  Sample: ban=${s.ban} van_du_doan=${s.van_du_doan} du_doan=${s.du_doan} dtc=${s.do_tin_cay}`);
      }
    }
  } catch (err) {
    console.error('[CACHE ERROR]', err.message);
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  const url = req.url.split('?')[0];

  // ── GET /api/bcr — toan bo ban, format gon ──────────────────
  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu' });

    // Output gon theo yeu cau:
    // ban, van_du_doan, du_doan, do_tin_cay, id
    const output = cache.map(b => ({
      ban:         b.ban,
      van_du_doan: b.van_du_doan,
      du_doan:     b.du_doan,
      do_tin_cay:  b.do_tin_cay,
      id:          '@sewdangcap',
    }));

    return sendJSON(res, 200, {
      id:       '@sewdangcap',
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: output.length,
      du_lieu:  output,
    });
  }

  // ── GET /api/bcr/:ban — chi tiet ────────────────────────────
  const match = url.match(/^\/api\/bcr\/(.+)$/);
  if (req.method === 'GET' && match) {
    const banId = decodeURIComponent(match[1]).trim();
    let item    = cache ? cache.find(x => String(x.ban).trim() === banId) : null;

    if (!item) {
      // Fallback fetch don
      await fetchV1Phien();
      const v2All  = await safeFetch(API_V2_ALL);
      const v2List = normalizeV2(v2All);
      const found  = v2List && v2List.find(x => x.table_name === banId);
      if (found) {
        const a            = analyze(found.result);
        const phienHienTai = phienMap.get(banId) ?? null;
        item = {
          ban:          banId,
          van_du_doan:  phienHienTai != null ? phienHienTai + 1 : null,
          du_doan:      a.du_doan,
          do_tin_cay:   a.do_tin_cay,
          id:           '@sewdangcap',
          _signals_used: a.signals_used,
          _source:      'V2-single',
          _updated_at:  Date.now(),
        };
      }
    }

    if (!item) return sendJSON(res, 404, { loi: `Khong tim thay ban: ${banId}` });

    return sendJSON(res, 200, {
      ban:          item.ban,
      van_du_doan:  item.van_du_doan,
      du_doan:      item.du_doan,
      do_tin_cay:   item.do_tin_cay,
      id:           '@sewdangcap',
      cap_nhat:     new Date(item._updated_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      signals_used: item._signals_used,
    });
  }

  // ── GET /health ──────────────────────────────────────────────
  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      status:        'ok',
      version:       'v13',
      cache_size:    cache ? cache.length : 0,
      phien_map:     phienMap.size,
      fetch_count:   fetchCount,
      update_count:  updateCount,
      last_fetch_ms: Date.now() - lastFetch,
      phien_sample:  [...phienMap.entries()].slice(0, 5).map(([k,v]) => ({ ban: k, phien: v, van_du_doan: v+1 })),
    });
  }

  sendJSON(res, 404, { loi: 'Route khong ton tai', routes: ['/api/bcr', '/api/bcr/:ban', '/health'] });
});

server.listen(PORT, () => {
  console.log('\n=== BACCARAT v13 - phien fix + clean output ===');
  console.log(`Port: ${PORT}`);
  console.log('Fix: await fetchV1Phien() truoc het -> phien khong con null');
  console.log('Fix: van_du_doan = phien_hien_tai + 1');
  console.log('Fix: do_tin_cay clamp 55-80%');
  console.log('Output: { ban, van_du_doan, du_doan, do_tin_cay, id }');
  console.log('Routes:');
  console.log('  GET /api/bcr         -> tat ca ban');
  console.log('  GET /api/bcr/:ban    -> chi tiet ban');
  console.log('  GET /health          -> trang thai + phien_sample\n');
  loop();
});
