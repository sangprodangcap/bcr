// ============================================
// BACCARAT PREDICTOR v10 - @sewdangcap / @ThienNhanVn
// ============================================

const http  = require('http');
const fetch = require('node-fetch');

// ============================================
// API SOURCE
// ============================================
const API_BASE  = 'https://command-increasingly-trinity-powered.trycloudflare.com';
const API_ALL   = API_BASE + '/data';
const API_TABLE = API_BASE + '/data/';

const PORT = process.env.PORT || 3000;

const POLL_MS       = 2000;
const FETCH_TIMEOUT = 3000;

// ============================================
// CAU HINH THUAT TOAN
// ============================================
const CFG = {
  MAX_ROW:        6,
  MIN_HANDS:      4,
  STREAK_MIN:     3,
  BEAD_WINDOW:    20,
  CONF_MAX:       82,
  CONF_MIN:       50,
};

const RELIABILITY = {
  PATTERN:   1.0,
  BIG_EYE:   1.3,
  SMALL:     1.0,
  COCKROACH: 0.7,
  BEAD20:    0.6,
  STREAK:    1.1,
  ZIGZAG:    0.6,
  MARKOV:    0.8,
};

// ============================================
// STATE
// ============================================
let cache       = null;
let lastFetch   = 0;
let isFetching  = false;
let fetchCount  = 0;
let updateCount = 0;

const lastResultStr = new Map();

// ============================================
// FETCH HELPER
// ============================================
async function safeFetch(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
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
// 1. BIG ROAD - CAU TRUC LOGIC
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
      curCol  = [ch];
      curSide = ch;
    } else {
      curCol.push(ch);
    }
  }
  if (curCol.length > 0) cols.push(curCol);
  return cols;
}

// ============================================
// 2. BIG ROAD GRID - BANG VE THAT (6 hang + duoi rong)
// ============================================
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
      row++;
      colObj.cells.push({ row, col });
    } else {
      colObj.dragonTail++;
      colObj.cells.push({ row: CFG.MAX_ROW - 1, col: col + colObj.dragonTail });
    }
  }
  return grid;
}

// ============================================
// 3. BEAD PLATE - BANG CAU HAT (6 hang)
// ============================================
function buildBeadGrid(raw) {
  const cells = [];
  let row = 0, col = 0;
  for (const ch of raw) {
    if (ch === 'T') {
      if (cells.length > 0)
        cells[cells.length - 1].tie = (cells[cells.length - 1].tie || 0) + 1;
      continue;
    }
    cells.push({ row, col, side: ch, tie: 0 });
    row++;
    if (row >= CFG.MAX_ROW) { row = 0; col++; }
  }
  return cells;
}

// ============================================
// 4. DERIVED ROADS (Big Eye=1, Small=2, Cockroach=3)
// ============================================
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
  const lastSide = cols[cols.length - 1].at(-1)[0];
  const oppSide  = lastSide === 'B' ? 'P' : 'B';

  const tryAppend = (side) => {
    const nc = cols.map(c => [...c]);
    if (side === lastSide) nc.at(-1).push(side);
    else nc.push([side]);
    const road = buildDerived(nc, offset);
    return road.at(-1) || null;
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
// 5. TIN HIEU: MAU BIG ROAD
// ============================================
function patternSignal(cols) {
  if (cols.length < 2) return null;
  const lens    = cols.slice(-8).map(c => c.length);
  const last    = cols.at(-1);
  const curSide = last.at(-1)[0];
  const opp     = curSide === 'B' ? 'P' : 'B';
  const curLen  = last.length;

  if (curLen >= 6) return { name: 'Cầu dài ' + curLen, side: curSide, strength: 0.9 };
  if (curLen >= 4) return { name: 'Cầu x' + curLen,    side: curSide, strength: 0.7 };

  if (lens.length >= 4 && lens.every(x => x === 1))
    return { name: 'Cầu đơn', side: opp, strength: 0.85 };
  if (lens.length >= 4 && lens.every(x => x === 2))
    return { name: 'Cầu đôi', side: curLen < 2 ? curSide : opp, strength: 0.7 };
  if (lens.length >= 3 && lens.every(x => x === 3))
    return { name: 'Cầu ba', side: curLen < 3 ? curSide : opp, strength: 0.65 };

  if (lens.length >= 4) {
    const is12 = lens.every((x, i) => i % 2 === 0 ? x === 1 : x === 2);
    const is21 = lens.every((x, i) => i % 2 === 0 ? x === 2 : x === 1);
    if (is12) {
      const nxt = cols.length % 2 === 0 ? 2 : 1;
      return { name: 'Cầu 1-2', side: curLen < nxt ? curSide : opp, strength: 0.7 };
    }
    if (is21) {
      const nxt = cols.length % 2 === 0 ? 1 : 2;
      return { name: 'Cầu 2-1', side: curLen < nxt ? curSide : opp, strength: 0.7 };
    }
    if (lens.length >= 3) {
      const seq = lens.slice(-3);
      if (
        (seq[0] === 2 && seq[1] === 3 && seq[2] === 2) ||
        (seq[0] === 3 && seq[1] === 2 && seq[2] === 3)
      ) {
        const nxtLen = seq[2] === 2 ? 3 : 2;
        return { name: 'Cầu 232', side: curLen < nxtLen ? curSide : opp, strength: 0.6 };
      }
    }
  }

  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  if (avg >= 3.0) return { name: 'Nghiêng ' + curSide, side: curSide, strength: 0.4 };
  return null;
}

// ============================================
// 6. TIN HIEU: DERIVED ROADS
// ============================================
function derivedSignal(cols, offset, key, label) {
  if (cols.length < offset + 2) return null;
  const pred = predictDerived(cols, offset);
  if (!pred) return null;
  return { name: label, side: pred, strength: 0.75 };
}

// ============================================
// 7. TIN HIEU: STREAK - xac suat gay tu lich su that
// ============================================
function streakSignal(beadOnly) {
  const n = beadOnly.length;
  if (n < CFG.STREAK_MIN) return null;

  const last = beadOnly[n - 1];
  let len = 1;
  while (len < n && beadOnly[n - 1 - len] === last) len++;
  if (len < CFG.STREAK_MIN) return null;

  let broke = 0, total = 0;
  for (let i = len; i < n; i++) {
    if (beadOnly[i] === beadOnly[i - 1]) continue;
    let s = 1;
    for (let j = i - 1; j >= 0 && beadOnly[j] === beadOnly[i - 1]; j--) s++;
    if (s !== len) continue;
    total++;
    if (i + 1 < n && beadOnly[i + 1] !== beadOnly[i]) broke++;
  }

  const prior  = Math.max(0.35, 0.60 - len * 0.02);
  const pBreak = total >= 5 ? broke / total : prior;
  const opp    = last === 'B' ? 'P' : 'B';

  return {
    name: `Bệt ${len} (${total >= 5 ? 'mẫu thực ' + total : 'ước lượng'}, P(gãy)=${Math.round(pBreak * 100)}%)`,
    side: pBreak > 0.5 ? opp : last,
    strength: Math.min(0.9, Math.abs(pBreak - 0.5) * 2 + 0.3),
  };
}

// ============================================
// 8. TIN HIEU: ZIGZAG
// ============================================
function zigzagSignal(beadOnly) {
  if (beadOnly.length < 4) return null;
  const tail4 = beadOnly.slice(-4);
  const isZig = tail4.every((x, i) => i === 0 || x !== tail4[i - 1]);
  if (!isZig) return null;
  const opp = beadOnly.at(-1) === 'B' ? 'P' : 'B';
  return { name: 'Zigzag 1-1', side: opp, strength: 0.6 };
}

// ============================================
// 9. TIN HIEU: BEAD 20
// ============================================
function bead20Signal(beadOnly) {
  const bead = beadOnly.slice(-CFG.BEAD_WINDOW);
  if (bead.length < 10) return null;
  const b = bead.filter(x => x === 'B').length;
  const r = b / bead.length;
  if (Math.abs(r - 0.5) < 0.12) return null;
  return {
    name: `Bead${bead.length}: B=${b}/${bead.length} (${Math.round(r * 100)}%)`,
    side: r > 0.5 ? 'B' : 'P',
    strength: Math.min(0.7, Math.abs(r - 0.5) * 2),
  };
}

// ============================================
// 10. TIN HIEU: MARKOV BAC 1
// ============================================
function markovSignal(beadOnly) {
  const n = beadOnly.length;
  if (n < 12) return null;
  const last = beadOnly[n - 1];
  let toB = 0, toP = 0;
  for (let i = 0; i < n - 1; i++) {
    if (beadOnly[i] !== last) continue;
    beadOnly[i + 1] === 'B' ? toB++ : toP++;
  }
  const total = toB + toP;
  if (total < 8) return null;
  const pB = toB / total;
  if (Math.abs(pB - 0.5) < 0.1) return null;
  return {
    name: `Markov: sau "${last}" → B ${toB}/${total} (${Math.round(pB * 100)}%)`,
    side: pB > 0.5 ? 'B' : 'P',
    strength: Math.min(0.7, Math.abs(pB - 0.5) * 2),
  };
}

// ============================================
// TONG HOP - 1 CO CHE CHAM DIEM DUY NHAT
// ============================================
function combine(signals) {
  const votes = signals.filter(Boolean);
  if (!votes.length) return null;

  let scoreB = 0, scoreP = 0;
  votes.forEach(v => {
    const w = v.strength * (RELIABILITY[v.rel] ?? 1.0);
    v.side === 'B' ? (scoreB += w) : (scoreP += w);
  });

  const total  = scoreB + scoreP;
  const pred   = scoreB >= scoreP ? 'B' : 'P';
  const margin = total > 0 ? Math.max(scoreB, scoreP) / total : 0.5;

  const derivedAgree = votes.filter(v =>
    ['BIG_EYE', 'SMALL', 'COCKROACH'].includes(v.rel) && v.side === pred
  ).length;
  const bonus = derivedAgree >= 3 ? 8 : derivedAgree === 2 ? 4 : 0;

  let conf = CFG.CONF_MIN + (margin - 0.5) * 60 + bonus;
  conf = Math.max(CFG.CONF_MIN, Math.min(CFG.CONF_MAX, Math.round(conf)));

  return { pred, conf, votes, scoreB: scoreB.toFixed(2), scoreP: scoreP.toFixed(2) };
}

// ============================================
// ANALYZE TONG HOP CHO 1 BAN
// ============================================
function analyze(rawHistory) {
  const raw      = (rawHistory || '').toUpperCase().replace(/[^BPT]/g, '');
  const beadOnly = [...raw].filter(x => x !== 'T');

  if (beadOnly.length < CFG.MIN_HANDS) {
    return { du_doan: 'Chua du du lieu', do_tin_cay: '0%', notes: [], cau_dep: '' };
  }

  const cols = buildBigRoad(raw);

  const signals = [
    tag(patternSignal(cols),                                    'PATTERN'),
    tag(derivedSignal(cols, 1, 'BIG_EYE',   'Big Eye Boy'),   'BIG_EYE'),
    tag(derivedSignal(cols, 2, 'SMALL',     'Small Road'),    'SMALL'),
    tag(derivedSignal(cols, 3, 'COCKROACH', 'Cockroach Road'),'COCKROACH'),
    tag(streakSignal(beadOnly),                                 'STREAK'),
    tag(zigzagSignal(beadOnly),                                 'ZIGZAG'),
    tag(bead20Signal(beadOnly),                                 'BEAD20'),
    tag(markovSignal(beadOnly),                                 'MARKOV'),
  ];

  const result = combine(signals);
  if (!result) return { du_doan: 'Chua du du lieu', do_tin_cay: '0%', notes: [], cau_dep: '' };

  const notes  = result.votes.map(v => `${v.name}→${v.side === 'B' ? 'Cái' : 'Con'}`);
  const patSig = signals.find(s => s && s.rel === 'PATTERN');

  return {
    du_doan:    result.pred === 'B' ? 'Cai' : 'Con',
    do_tin_cay: result.conf + '%',
    notes,
    cau_dep:    patSig ? patSig.name : '',
    _debug:     { scoreB: result.scoreB, scoreP: result.scoreP },
  };
}

function tag(signal, rel) {
  if (!signal) return null;
  signal.rel = rel;
  return signal;
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
    const allJson = await safeFetch(API_ALL);
    if (!Array.isArray(allJson)) { isFetching = false; return false; }

    const banList  = cache ? [...cache] : [];
    const banIndex = {};
    banList.forEach((b, i) => { banIndex[b.ban] = i; });

    for (const item of allJson) {
      const ban    = String(item.table_name).trim();
      const result = String(item.result || '');

      if (lastResultStr.get(ban) === result) continue;
      lastResultStr.set(ban, result);

      const a = analyze(result);
      if (a.du_doan === 'Chua du du lieu') continue;

      const entry = {
        ban,
        phien:      item.round || null,
        dealer:     item.dealer_name || '',
        du_doan:    a.du_doan,
        do_tin_cay: a.do_tin_cay,
        good_road:  a.cau_dep,
        notes:      a.notes,
        updated_at: Date.now(),
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
      console.log(
        '[' + ts + '] [UPDATE #' + updateCount + '] fetch #' + fetchCount +
        ' | tong ban: ' + banList.length
      );
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

  // GET /api/bcr -> toan bo ban
  if (req.method === 'GET' && url === '/api/bcr') {
    if (!cache) return sendJSON(res, 503, { loi: 'Chua co du lieu' });
    return sendJSON(res, 200, {
      id:       '@sewdangcap',
      cap_nhat: new Date(lastFetch).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      tong_ban: cache.length,
      du_lieu:  cache,
    });
  }

  // GET /api/bcr/:ban -> chi tiet 1 ban
  const match = url.match(/^\/api\/bcr\/(.+)$/);
  if (req.method === 'GET' && match) {
    const banId = decodeURIComponent(match[1]).trim();
    let item      = cache ? cache.find(x => String(x.ban).trim() === banId) : null;
    let rawResult = lastResultStr.get(banId);

    if (!item) {
      const single = await safeFetch(API_TABLE + encodeURIComponent(banId));
      if (single && single.result) {
        rawResult = String(single.result);
        const a = analyze(rawResult);
        item = {
          ban:        banId,
          phien:      single.round || null,
          dealer:     single.dealer_name || '',
          du_doan:    a.du_doan,
          do_tin_cay: a.do_tin_cay,
          good_road:  a.cau_dep,
          notes:      a.notes,
          updated_at: Date.now(),
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

  // GET /health
  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, {
      status:            'ok',
      cache_size:        cache ? cache.length : 0,
      fetch_count:       fetchCount,
      update_count:      updateCount,
      last_fetch_ago_ms: Date.now() - lastFetch,
      algorithm:         'BCR-V10-MULTISIGNAL',
    });
  }

  sendJSON(res, 404, { loi: 'Route khong ton tai' });
});

server.listen(PORT, function () {
  console.log('\n=== BACCARAT BOT v10 - Multi-Signal + Road Grid ===');
  console.log('Data API    : ' + API_ALL);
  console.log('Table API   : ' + API_TABLE + ':id');
  console.log('Thuat toan  : Pattern + BigEye + Small + Cockroach + Streak + Zigzag + Bead20 + Markov');
  console.log('Hop nhat    : 1 co che cham diem (RELIABILITY x strength), tran ' + CFG.CONF_MAX + '%');
  console.log('Routes:');
  console.log('  GET /api/bcr         -> toan bo ban');
  console.log('  GET /api/bcr/:ban    -> chi tiet + so_do_cau');
  console.log('  GET /health          -> trang thai\n');
  loop();
});
