// ============================================
// BACCARAT PREDICTOR v17 - @sewdangcap
// Dual source: API1 (per-ban detail) + API2 (bulk results)
// Output: ban, van, du_doan, thoi_gian, id
// Algorithm: Ensemble (Markov + Pattern + Streak + Derived Roads)
// ============================================

const http  = require('http');
const fetch = require('node-fetch');

// ============================================
// CONFIG
// ============================================
const API1_BASE = 'https://elements-reporters-milton-dividend.trycloudflare.com/api/bcr';
const API2_URL  = 'https://construct-vacuum-bosnia-travel.trycloudflare.com/api/bcr';

const PORT      = process.env.PORT || 3000;
const FETCH_TO  = 5000;
const ID        = '@sewdangcap';

// Known ban list from API2 (will be auto-discovered at runtime)
// API1 is fetched per-ban based on what API2 returns
const POLL_INTERVAL_MIN = 200;
const POLL_INTERVAL_MAX = 2000;
const POLL_INTERVAL_STEP = 100;

const CONF_MIN = 55;
const CONF_MAX = 82;
const MIN_HANDS = 8;

// Signal weights
const W = {
  MARKOV7: 2.8, MARKOV6: 2.6, MARKOV5: 2.4, MARKOV4: 2.2,
  MARKOV3: 2.0, MARKOV2: 1.8, MARKOV1: 1.5,
  BAYESIAN: 1.6, ENTROPY: 1.3, PATTERN: 1.7,
  BIG_EYE: 1.3, SMALL: 1.1, COCKROACH: 0.9,
  STREAK: 1.4, ZIGZAG: 0.8, BEAD30: 1.0,
  API1_REC: 2.0,  // API1 recommended_bet signal — strong external signal
  LAST5: 1.5,     // API1 last_5 streak signal
};

// ============================================
// STATE
// ============================================
let cache        = null;          // sorted array of merged ban entries
let lastFetch    = 0;
let fetchCount   = 0;
let updateCount  = 0;
let currentDelay = POLL_INTERVAL_MIN;
let isLooping    = false;
let lastChangeTs = 0;

// Per-ban change detection
// key: ban, value: { update_at, resultsLen, phien }
const banState = new Map();

// ============================================
// SAFE FETCH
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
// PARSE API2 — bulk results
// Returns: [{ ban, results, good_road, update_at }]
// ============================================
function parseAPI2(json) {
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
// PARSE API1 — per-ban detail
// Returns: { phien, current_winner, last_5, recommended_bet, status }
// ============================================
function parseAPI1(json) {
  if (!json || !json.table) return null;
  return {
    phien:           json.phien   || 0,
    current_winner:  json.current_winner || null,
    last_5:          Array.isArray(json.last_5)
                       ? json.last_5.map(x => x.winner || '').filter(Boolean)
                       : [],
    recommended_bet: String(json.recommended_bet || '').trim(),
    status:          String(json.status || '').trim(),
  };
}

// ============================================
// DETECT CHANGED BANS
// Primary signal: update_at change OR phien change
// ============================================
function detectChanged(api2Items, api1Map) {
  const changed = [];
  for (const item of api2Items) {
    const prev   = banState.get(item.ban);
    const curLen = item.results.length;
    const a1     = api1Map.get(item.ban);
    const curPh  = a1?.phien || 0;

    const isNew = !prev
      || prev.update_at  !== item.update_at
      || prev.resultsLen !== curLen
      || prev.phien      !== curPh;

    if (isNew) {
      banState.set(item.ban, {
        update_at:  item.update_at,
        resultsLen: curLen,
        phien:      curPh,
      });
      changed.push({ ...item, api1: a1 || null });
    }
  }
  return changed;
}

// ============================================
// ============================================
// ALGORITHM CORE
// ============================================
// ============================================

function entropy(arr) {
  const n = arr.length; if (!n) return 0;
  const cB = arr.filter(x => x === 'B').length;
  const pB = cB / n, pP = 1 - pB;
  const h = x => (x > 0 ? -x * Math.log2(x) : 0);
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

// --- Markov order-N ---
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

// --- Bayesian ---
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

// --- Entropy ---
function entropySignal(bead) {
  const n = bead.length; if (n < 10) return null;
  const slice = bead.slice(-Math.min(20, n));
  const e     = entropy(slice);
  const pB    = slice.filter(x => x === 'B').length / slice.length;
  const last  = bead.at(-1), opp = last === 'B' ? 'P' : 'B';
  if (e < 0.7) return {
    name:     `Ent_low(${e.toFixed(2)})`,
    side:     pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.8, (0.7 - e) * 1.5),
  };
  if (e > 0.95) {
    let s = 1;
    while (s < n && bead[n - 1 - s] === last) s++;
    if (s >= 2) return {
      name:     `Ent_high(${e.toFixed(2)})`,
      side:     opp,
      strength: Math.min(0.6, (e - 0.95) * 4 + 0.2),
    };
  }
  return null;
}

// --- Big Road ---
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

// --- Derived roads ---
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

// --- Pattern (cau) ---
function patternSignal(cols) {
  if (cols.length < 2) return null;
  const lens = cols.slice(-8).map(c => c.length);
  const last = cols.at(-1);
  const cS   = last.at(-1)[0];
  const opp  = cS === 'B' ? 'P' : 'B';
  const cL   = last.length;
  if (cL >= 6) return { name: `Cau_dai${cL}`,   side: cS,  strength: 0.92 };
  if (cL >= 4) return { name: `Cau_x${cL}`,      side: cS,  strength: 0.75 };
  if (lens.length >= 4 && lens.every(x => x === 1)) return { name: 'Cau_don',  side: opp, strength: 0.88 };
  if (lens.length >= 4 && lens.every(x => x === 2)) return { name: 'Cau_doi',  side: cL < 2 ? cS : opp, strength: 0.78 };
  if (lens.length >= 3 && lens.every(x => x === 3)) return { name: 'Cau_ba',   side: cL < 3 ? cS : opp, strength: 0.73 };
  if (lens.length >= 4) {
    if (lens.every((x, i) => i % 2 === 0 ? x === 1 : x === 2)) {
      const n = cols.length % 2 === 0 ? 2 : 1;
      return { name: 'Cau_1-2', side: cL < n ? cS : opp, strength: 0.74 };
    }
    if (lens.every((x, i) => i % 2 === 0 ? x === 2 : x === 1)) {
      const n = cols.length % 2 === 0 ? 1 : 2;
      return { name: 'Cau_2-1', side: cL < n ? cS : opp, strength: 0.74 };
    }
  }
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  return avg >= 3.5 ? { name: `Nghieng_${cS}`, side: cS, strength: 0.5 } : null;
}

function derivedSignal(cols, offset, label) {
  if (cols.length < offset + 2) return null;
  const p = predictDerived(cols, offset);
  if (!p) return null;
  return { name: label, side: p, strength: 0.78 };
}

// --- Streak ---
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
    name:     `Streak${len}(ga${Math.round(pB * 100)}%,n=${total})`,
    side:     pB > 0.5 ? opp : last,
    strength: Math.min(0.9, Math.abs(pB - 0.5) * 2.4 + 0.3),
  };
}

// --- Zigzag ---
function zigzagSignal(bead) {
  if (bead.length < 6) return null;
  const t = bead.slice(-6);
  if (!t.every((x, i) => i === 0 || x !== t[i - 1])) return null;
  return { name: 'Zigzag_1-1', side: bead.at(-1) === 'B' ? 'P' : 'B', strength: 0.74 };
}

// --- Bead plate frequency ---
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
    strength: Math.min(0.78, Math.abs(r - 0.5) * 2.5),
  };
}

// ============================================
// API1 SIGNALS — external data as signals
// ============================================

// Parse API1 recommended_bet — "PLAYER 78%" or "BANKER 65%"
function api1RecSignal(recommended_bet) {
  if (!recommended_bet) return null;
  const m = recommended_bet.match(/^(PLAYER|BANKER)\s+(\d+)%/i);
  if (!m) return null;
  const side  = m[1].toUpperCase() === 'PLAYER' ? 'P' : 'B';
  const pct   = parseInt(m[2], 10);
  if (pct < 55) return null;    // below 55% — noise
  return {
    name:     `API1_rec(${m[1]}_${pct}%)`,
    side,
    strength: Math.min(0.95, (pct - 50) / 50 + 0.5),
  };
}

// Parse API1 last_5 — streak or momentum from live data
function api1Last5Signal(last_5) {
  if (!Array.isArray(last_5) || last_5.length < 3) return null;
  const mapped = last_5.map(w => {
    if (/banker/i.test(w)) return 'B';
    if (/player/i.test(w)) return 'P';
    return 'T';
  }).filter(x => x !== 'T');
  if (mapped.length < 3) return null;

  // Check if last 3+ are same side → streak signal
  const tail = mapped.slice(-3);
  if (tail.every(x => x === tail[0])) {
    // Streak of 3+ from live last_5: bet continues OR breaks
    // Use history_count context — just weight the streak side
    const side = tail[0];
    return {
      name:     `L5_streak(${tail.join('')})`,
      side,
      strength: 0.68,
    };
  }

  // Zigzag from last_5
  if (mapped.slice(-4).every((x, i, a) => i === 0 || x !== a[i - 1])) {
    const opp = mapped.at(-1) === 'B' ? 'P' : 'B';
    return { name: 'L5_zigzag', side: opp, strength: 0.62 };
  }

  return null;
}

// ============================================
// COMBINE + CONFIDENCE
// ============================================
function tag(s, rel) { if (!s) return null; s.rel = rel; return s; }

function combine(signals) {
  const votes = signals.filter(Boolean);
  if (!votes.length) return null;
  let sB = 0, sP = 0;
  for (const v of votes) {
    const w = v.strength * (W[v.rel] || 1.0);
    v.side === 'B' ? (sB += w) : (sP += w);
  }
  const total = sB + sP;
  const pred  = sB >= sP ? 'B' : 'P';
  const mg    = total > 0 ? Math.max(sB, sP) / total : 0.5;

  const dA = votes.filter(v =>
    ['BIG_EYE', 'SMALL', 'COCKROACH'].includes(v.rel) && v.side === pred
  ).length;
  const mA = votes.filter(v =>
    v.rel.startsWith('MARKOV') && v.side === pred
  ).length;
  const hasAPI1 = votes.some(v => v.rel === 'API1_REC' && v.side === pred);

  let conf = CONF_MIN
    + (mg - 0.5) * 54
    + (dA >= 3 ? 11 : dA === 2 ? 6 : 0)
    + (mA >= 5 ? 13 : mA >= 3 ? 8 : mA >= 2 ? 4 : 0)
    + (hasAPI1 ? 8 : 0)
    + (mg < 0.55 ? -5 : 0);

  conf = Math.max(CONF_MIN, Math.min(CONF_MAX, Math.round(conf)));
  return { pred, conf, count: votes.length, scoreB: +sB.toFixed(2), scoreP: +sP.toFixed(2) };
}

// ============================================
// MAIN ANALYZE
// Inputs: results string (API2) + api1 data object
// ============================================
function analyze(rawHistory, api1) {
  const raw  = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const bead = [...raw].filter(x => x !== 'T');

  if (bead.length < MIN_HANDS) return null;

  const cols = buildBigRoad(raw);

  const result = combine([
    // Markov chain orders 1-7
    tag(markovNSignal(bead, 7), 'MARKOV7'),
    tag(markovNSignal(bead, 6), 'MARKOV6'),
    tag(markovNSignal(bead, 5), 'MARKOV5'),
    tag(markovNSignal(bead, 4), 'MARKOV4'),
    tag(markovNSignal(bead, 3), 'MARKOV3'),
    tag(markovNSignal(bead, 2), 'MARKOV2'),
    tag(markovNSignal(bead, 1), 'MARKOV1'),
    // Statistical
    tag(bayesianSignal(bead),  'BAYESIAN'),
    tag(entropySignal(bead),   'ENTROPY'),
    // Road patterns
    tag(patternSignal(cols),                           'PATTERN'),
    tag(derivedSignal(cols, 1, 'Big Eye Boy'),         'BIG_EYE'),
    tag(derivedSignal(cols, 2, 'Small Road'),          'SMALL'),
    tag(derivedSignal(cols, 3, 'Cockroach Road'),      'COCKROACH'),
    // Streak/rhythm
    tag(streakSignal(bead),  'STREAK'),
    tag(zigzagSignal(bead),  'ZIGZAG'),
    tag(bead30Signal(bead),  'BEAD30'),
    // API1 external signals
    tag(api1RecSignal(api1?.recommended_bet), 'API1_REC'),
    tag(api1Last5Signal(api1?.last_5),        'LAST5'),
  ]);

  if (!result) return null;

  return {
    du_doan:    result.pred === 'B' ? 'Cai' : 'Con',
    do_tin_cay: result.conf + '%',
    signals:    result.count,
    score:      { cai: result.scoreB, con: result.scoreP },
  };
}

// ============================================
// FETCH ALL — API2 bulk + API1 per-ban parallel
// ============================================
async function fetchAll(banList) {
  // Fetch API2 bulk
  const api2Promise = safeFetch(API2_URL);

  // Fetch API1 per-ban in parallel (only known bans)
  const api1Promises = banList.map(async ban => {
    const url  = `${API1_BASE}/${encodeURIComponent(ban)}`;
    const json = await safeFetch(url);
    return { ban, data: parseAPI1(json) };
  });

  const [api2Raw, ...api1Results] = await Promise.all([api2Promise, ...api1Promises]);

  const api2Items = parseAPI2(api2Raw);
  const api1Map   = new Map(api1Results.map(x => [x.ban, x.data]));

  return { api2Items, api1Map };
}

// ============================================
// APPLY UPDATE
// ============================================
function applyUpdate(changedItems) {
  if (!changedItems.length) return 0;

  const cacheMap = new Map();
  if (cache) cache.forEach(b => cacheMap.set(b.ban, b));

  let changed = 0;
  for (const item of changedItems) {
    const a1  = item.api1;
    const res = analyze(item.results, a1);

    const thoi_gian = item.update_at
      || new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const van = a1?.phien || null;

    if (!res) {
      // Not enough hands yet — store skeleton
      if (!cacheMap.has(item.ban)) {
        cacheMap.set(item.ban, {
          ban:        item.ban,
          van,
          du_doan:    null,
          do_tin_cay: null,
          good_road:  item.good_road,
          thoi_gian,
          id:         ID,
          _ts:        Date.now(),
          _raw:       item,
        });
      }
      continue;
    }

    cacheMap.set(item.ban, {
      ban:        item.ban,
      van,
      du_doan:    res.du_doan,
      do_tin_cay: res.do_tin_cay,
      good_road:  item.good_road,
      thoi_gian,
      id:         ID,
      _ts:        Date.now(),
      _raw:       item,
      _a1:        a1,
    });
    changed++;
  }

  cache = [...cacheMap.values()].sort((a, b) =>
    String(a.ban).localeCompare(String(b.ban), undefined, { numeric: true })
  );
  lastFetch = Date.now();
  if (changed > 0) {
    updateCount++;
    lastChangeTs = Date.now();
  }
  return changed;
}

// ============================================
// POLL ONCE
// ============================================
async function pollOnce() {
  fetchCount++;

  // Known ban list from current cache, or empty (first run)
  const knownBans = cache ? cache.map(x => x.ban) : [];

  const { api2Items, api1Map } = await fetchAll(knownBans);
  if (!api2Items) return 0;

  // After first API2 fetch, also fetch API1 for any NEW bans discovered
  const discoveredBans = api2Items.map(x => x.ban);
  const newBans = discoveredBans.filter(b => !knownBans.includes(b));

  let fullApi1Map = api1Map;
  if (newBans.length > 0) {
    const newFetches = await Promise.all(newBans.map(async ban => {
      const url  = `${API1_BASE}/${encodeURIComponent(ban)}`;
      const json = await safeFetch(url);
      return { ban, data: parseAPI1(json) };
    }));
    fullApi1Map = new Map([...api1Map, ...newFetches.map(x => [x.ban, x.data])]);
  }

  const changedItems = detectChanged(api2Items, fullApi1Map).map(item => ({
    ...item,
    api1: fullApi1Map.get(item.ban) || null,
  }));

  if (!changedItems.length) return 0;
  return applyUpdate(changedItems);
}

// ============================================
// REACTIVE POLL LOOP
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
        currentDelay = POLL_INTERVAL_MIN;
        const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const s  = cache?.find(x => x.du_doan);
        console.log(`[${ts}] +${changed} ban | ${elapsed}ms | delay=${currentDelay}ms`);
        if (s) console.log(`  ban=${s.ban} van=${s.van} du_doan=${s.du_doan} dtc=${s.do_tin_cay}`);
      } else {
        currentDelay = Math.min(POLL_INTERVAL_MAX, currentDelay + POLL_INTERVAL_STEP);
      }
    } catch (e) {
      console.error('[POLL ERROR]', e.message);
      currentDelay = Math.min(POLL_INTERVAL_MAX, currentDelay + 200);
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

  // GET /api/bcr — all tables
  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu, cho 2-3s' });
    return sendJSON(res, 200, {
      id:       ID,
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: cache.length,
      du_lieu:  cache.map(formatEntry),
    });
  }

  // GET /api/bcr/:ban — single table
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

  // GET /health
  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      status:          'ok',
      version:         'v17-dual-source',
      delay_ms:        currentDelay,
      delay_range:     `${POLL_INTERVAL_MIN}-${POLL_INTERVAL_MAX}ms`,
      cache_size:      cache?.length ?? 0,
      fetch_count:     fetchCount,
      update_count:    updateCount,
      ms_since_change: lastChangeTs ? Date.now() - lastChangeTs : null,
      last_fetch_ms:   Date.now() - lastFetch,
      sources:         { api1: API1_BASE, api2: API2_URL },
    });
  }

  sendJSON(res, 404, {
    loi:    'Route khong ton tai',
    routes: ['/api/bcr', '/api/bcr/:ban', '/health'],
  });

}).listen(PORT, () => {
  console.log('\n=== BACCARAT v17 - Dual Source Merge ===');
  console.log(`Port    : ${PORT}`);
  console.log(`API1    : ${API1_BASE}/:ban`);
  console.log(`API2    : ${API2_URL}`);
  console.log(`Delay   : ${POLL_INTERVAL_MIN}ms -> ${POLL_INTERVAL_MAX}ms adaptive`);
  console.log('Output  : ban | van | du_doan | do_tin_cay | good_road | thoi_gian | id');
  console.log('Routes  : /api/bcr | /api/bcr/:ban | /health\n');
  reactiveLoop();
});
