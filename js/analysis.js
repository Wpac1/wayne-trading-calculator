'use strict';

// ── State ────────────────────────────────────────────────────────────────────
var ANA = null;
var ANA_RAW_M15 = null;         // raw bars from the loaded file (native TF)
var ANA_INTERVAL = 'M15';       // current view interval (auto-set from filename)
var ANA_FILE_TF  = 'M15';       // native TF of the file on disk  e.g. 'H1', 'H4'
var ANA_BARS = 200;
var ANA_CLOCK_TIMER = null;

var ANA_SYMBOLS = [];           // [{file, symbol}] — full universe from index.json
var ANA_ACTIVE_FILE = null;     // file loaded in single view
var ANA_ACTIVE_SYMBOL = 'XAUUSD';
var ANA_VIEW = 'single';        // 'single' | 'multi'
var ANA_MULTI_LOADED = {};      // file -> bars[] cache
var ANA_MULTI_SELECTED = {};    // file -> true/false  (which symbols show in multi grid)
var ANA_REFRESH_TIMER = null;   // silent 5-min background refresh

// Signal price tracking
var SIG_PRICE_CACHE = {};       // symbol -> { price, ts }
var SIG_POLL_TIMER  = null;

// Confluence definitions — 5 named checkpoints a trade must pass
var CONF_DEFS = [
  { key: 'trend',    label: 'Trend',     desc: 'Trading with the higher-TF trend' },
  { key: 'keyLevel', label: 'Key Level', desc: 'Entry at a strong S/R zone'       },
  { key: 'pattern',  label: 'Pattern',   desc: 'Candle or chart pattern present'  },
  { key: 'htf',      label: 'HTF',       desc: 'Higher timeframe agrees'           },
  { key: 'momentum', label: 'Momentum',  desc: 'RSI / MACD support direction'     },
];
var CONF_REQUIRED = 3; // ticked confluences needed to auto-go LIVE
var ANA_SYNC_SCROLL = null; // saved scroll position during a sync reload

// ── Silent background refresh ────────────────────────────────────────────────
var ANA_REFRESH_SECS = parseInt(localStorage.getItem('wayne_refresh_secs') || '300') || 300;

function setRefreshInterval(secs) {
  ANA_REFRESH_SECS = parseInt(secs) || 0;
  localStorage.setItem('wayne_refresh_secs', String(ANA_REFRESH_SECS));

  // Restart timer with new interval
  if (ANA_REFRESH_TIMER) { clearInterval(ANA_REFRESH_TIMER); ANA_REFRESH_TIMER = null; }
  if (ANA_REFRESH_SECS > 0) {
    ANA_REFRESH_TIMER = setInterval(silentRefresh, ANA_REFRESH_SECS * 1000);
  }

  // Update dot indicator
  var dot = document.getElementById('refreshDot');
  if (dot) dot.classList.toggle('active', ANA_REFRESH_SECS > 0);
}

function silentRefresh() {
  var view = document.getElementById('view-analysis');
  if (!view || !view.classList.contains('active')) return;
  if (!ANA_ACTIVE_FILE || ANA_VIEW === 'multi') return;

  ANA_SYNC_SCROLL = window.scrollY || window.pageYOffset || 0;

  // Re-read the active CSV and rebuild — called after sync attempt
  function reloadFile() {
    fetch('data/gold/' + ANA_ACTIVE_FILE + '?t=' + Date.now())
      .then(function(r) { return r.ok ? r.text() : Promise.reject(); })
      .then(function(txt) {
        var data = parseAnalysisCSV(txt);
        if (data.length < 30) return;
        ANA_RAW_M15 = data;
        ANA_MULTI_LOADED[ANA_ACTIVE_FILE] = data;
        buildAnalysis(aggregateData(data, ANA_INTERVAL));
      })
      .catch(function() {});
  }

  // Pull fresh files from MT4 Common/Files first, then reload regardless of outcome
  fetch('/api/sync', { method: 'POST' })
    .then(function() { reloadFile(); })
    .catch(function() { reloadFile(); }); // still reload even if server is down
}

// ── Auto-load on tab open ────────────────────────────────────────────────────
function initAnalysis() {
  startAnaClock();
  updateSessionBadge();
  renderSigLog();

  // Wire up card drag-to-reorder (idempotent — safe to call on every tab switch)
  initCardDrag();

  // Restore saved refresh interval and sync dropdown
  var sel = document.getElementById('refreshIntervalSelect');
  if (sel) sel.value = String(ANA_REFRESH_SECS);
  var dot = document.getElementById('refreshDot');
  if (dot) dot.classList.toggle('active', ANA_REFRESH_SECS > 0);

  // Start timer once — guard prevents stacking on tab switches
  if (!ANA_REFRESH_TIMER && ANA_REFRESH_SECS > 0) {
    ANA_REFRESH_TIMER = setInterval(silentRefresh, ANA_REFRESH_SECS * 1000);
  }

  // Restore bot order type, lot size, and direction from persisted values
  setBotOrderType(botOrderType);
  setBotDirection(BOT_DIRECTION);
  var lotEl = document.getElementById('botLotInput');
  if (lotEl) lotEl.value = botLotSize;

  // Restore bot ON/OFF state and cooldown timestamp (survives page refresh)
  BOT_LAST_SENT_AT = parseInt(localStorage.getItem('wayne_bot_last_sent') || '0') || 0;
  var botWasOn = localStorage.getItem('wayne_bot_enabled') === '1';
  if (botWasOn && !BOT_SCAN_TIMER) {
    toggleBotMaster(true, true); // restore=true keeps cooldown intact
  }
  if (ANA_SYMBOLS.length) {
    // Symbol list known — just re-render if data is present, else reload
    if (ANA_RAW_M15) {
      var data = aggregateData(ANA_RAW_M15, ANA_INTERVAL);
      buildAnalysis(data);
    } else {
      loadActiveSymbol();
    }
    return;
  }
  loadSymbolList();
}

// ── Sync button — force fresh sync then reload ───────────────────────────────
function syncAnalysis() {
  ANA_SYNC_SCROLL = window.scrollY || window.pageYOffset || 0;
  var btn  = document.getElementById('anaSyncBtn');
  var fBtn = document.getElementById('anaFloatSync');
  if (btn)  { btn.textContent  = '⏳ Syncing…'; btn.disabled  = true; }
  if (fBtn) { fBtn.textContent = '⏳'; fBtn.disabled = true; }

  fetch('/api/sync', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (btn)  { btn.textContent  = '⟳ Sync MT4'; btn.disabled  = false; }
      if (fBtn) { fBtn.textContent = '⟳ Sync'; fBtn.disabled = false; }
      ANA_RAW_M15 = null; ANA = null; ANA_MULTI_LOADED = {};
      loadSymbolList();
    })
    .catch(function() {
      if (btn)  { btn.textContent  = '⟳ Sync MT4'; btn.disabled  = false; }
      if (fBtn) { fBtn.textContent = '⟳ Sync'; fBtn.disabled = false; }
      ANA_RAW_M15 = null; ANA = null; ANA_MULTI_LOADED = {};
      loadSymbolList();
    });
}

// ── Symbol list — reads data/gold/index.json (written by sync/download scripts) ──
function loadSymbolList() {
  showAnaStatus('loading');
  // Try index.json first (works without server API), fall back to /api/symbols
  fetch('data/gold/index.json')
    .then(function(r) { return r.ok ? r.json() : Promise.reject('index.json missing'); })
    .catch(function() { return fetch('/api/symbols').then(function(r){ return r.ok ? r.json() : Promise.reject('HTTP'); }); })
    .then(function(data) {
      ANA_SYMBOLS = data.files || [];
      // Default: all symbols selected for multi view
      ANA_SYMBOLS.forEach(function(s) {
        if (!(s.file in ANA_MULTI_SELECTED)) ANA_MULTI_SELECTED[s.file] = true;
      });
      renderSymbolChips();
      if (!ANA_SYMBOLS.length) {
        showAnaStatus('error',
          'No CSV files found in <code>data/gold/</code>.<br>' +
          'Run: <code>py scripts/download_data.py --symbol XAUUSD</code>');
        return;
      }
      // Keep current selection if still valid, else prefer XAUUSD_M15, else first
      var best = null;
      if (ANA_ACTIVE_FILE) {
        best = ANA_SYMBOLS.find(function(s){ return s.file === ANA_ACTIVE_FILE; });
      }
      if (!best) {
        best = ANA_SYMBOLS.find(function(s){ return s.file === 'XAUUSD_M15.csv'; }) ||
               ANA_SYMBOLS.find(function(s){ return s.symbol === 'XAUUSD'; }) ||
               ANA_SYMBOLS[0];
      }
      if (ANA_VIEW === 'multi') {
        renderMultiGrid();
      } else {
        selectSymbol(best.file, best.symbol);
      }
    })
    .catch(function() {
      // Both failed — try XAUUSD_M15.csv directly
      ANA_SYMBOLS = [];
      ANA_ACTIVE_FILE   = ANA_ACTIVE_FILE   || 'XAUUSD_M15.csv';
      ANA_ACTIVE_SYMBOL = ANA_ACTIVE_SYMBOL || 'XAUUSD';
      loadActiveSymbol();
    });
}

// ── Symbol chips — single mode: click to load | multi mode: click to toggle ──
function renderSymbolChips() {
  var el = document.getElementById('anaSymbolChips');
  if (!el) return;
  if (!ANA_SYMBOLS.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px;opacity:.6">No files in data/gold/ — run Sync MT4</span>';
    return;
  }
  el.innerHTML = ANA_SYMBOLS.map(function(s) {
    var parts = s.file.replace('.csv','').split('_');
    var itvl  = parts[1] ? ' ' + parts[1].toUpperCase() : '';
    var label = s.symbol + itvl;
    var isActive;
    var onclick;
    if (ANA_VIEW === 'multi') {
      isActive = ANA_MULTI_SELECTED[s.file] !== false;
      onclick  = 'toggleMultiSymbol(\'' + s.file.replace(/'/g,"\\'") + '\')';
    } else {
      isActive = s.file === ANA_ACTIVE_FILE;
      onclick  = 'selectSymbol(\'' + s.file.replace(/'/g,"\\'") + '\',\'' + s.symbol + '\')';
    }
    return '<button class="ana-sym-chip' + (isActive ? ' active' : '') + '" ' +
      'onclick="' + onclick + '" title="' + s.file + '">' + label + '</button>';
  }).join('');
}

// Derive the native timeframe from a filename like "XAUUSD_H1.csv"
function fileTFfromName(file) {
  var tfMap = { M1:1, M5:5, M15:15, M30:30, H1:60, H4:240, D1:1440, W1:10080 };
  var stem  = file.replace(/\.csv$/i, '');
  var parts = stem.split('_');
  var last  = parts[parts.length - 1].toUpperCase();
  return tfMap[last] !== undefined ? last : 'M15';
}

function selectSymbol(file, symbol) {
  ANA_ACTIVE_FILE   = file;
  ANA_ACTIVE_SYMBOL = symbol;
  ANA_RAW_M15       = null;
  ANA               = null;
  BOT_SENT_SIGS     = {};

  // Auto-set interval to match the file's native TF — no manual TF selection needed
  ANA_FILE_TF  = fileTFfromName(file);
  ANA_INTERVAL = ANA_FILE_TF;

  renderSymbolChips();
  loadActiveSymbol();
}

function loadActiveSymbol() {
  if (!ANA_ACTIVE_FILE) return;
  showAnaStatus('loading');
  fetch('data/gold/' + ANA_ACTIVE_FILE)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function(txt) {
      var data = parseAnalysisCSV(txt);
      if (data.length < 30) throw new Error('Too few bars (' + data.length + ')');
      ANA_RAW_M15 = data;
      ANA_MULTI_LOADED[ANA_ACTIVE_FILE] = data;
      hideAnaStatus();
      var agg = aggregateData(data, ANA_INTERVAL);
      buildAnalysis(agg);
    })
    .catch(function(err) {
      showAnaStatus('error', err.message);
    });
}

// ── View toggle (single / multi) ─────────────────────────────────────────────
function setAnaView(view) {
  ANA_VIEW = view;
  var btnS = document.getElementById('viewSingle');
  var btnM = document.getElementById('viewMulti');
  if (btnS) btnS.classList.toggle('active', view === 'single');
  if (btnM) btnM.classList.toggle('active', view === 'multi');

  var multiGrid = document.getElementById('anaMultiGrid');
  var content   = document.getElementById('anaContent');
  var status    = document.getElementById('anaStatus');

  renderSymbolChips(); // re-render chips for the new mode's behavior

  if (view === 'multi') {
    if (content)   content.style.display   = 'none';
    if (status)    status.style.display    = 'none';
    if (multiGrid) multiGrid.style.display = 'grid';
    renderMultiGrid();
  } else {
    if (multiGrid) multiGrid.style.display = 'none';
    if (ANA_RAW_M15) {
      var data = aggregateData(ANA_RAW_M15, ANA_INTERVAL);
      buildAnalysis(data);
    } else {
      loadActiveSymbol();
    }
  }
}

// ── Multi-symbol grid ────────────────────────────────────────────────────────
function toggleMultiSymbol(file) {
  ANA_MULTI_SELECTED[file] = !ANA_MULTI_SELECTED[file];
  renderSymbolChips();
  renderMultiGrid();
}

function renderMultiGrid() {
  var el = document.getElementById('anaMultiGrid');
  if (!el) return;
  var status = document.getElementById('anaStatus');
  if (status) status.style.display = 'none';

  if (!ANA_SYMBOLS.length) {
    el.innerHTML = '<div class="ana-multi-empty">No symbols in universe.<br>Run <strong>Sync MT4</strong> or <code>py scripts/download_data.py</code> first.</div>';
    return;
  }

  var selected = ANA_SYMBOLS.filter(function(s){ return ANA_MULTI_SELECTED[s.file] !== false; });

  if (!selected.length) {
    el.innerHTML = '<div class="ana-multi-empty">No symbols selected — click chips above to add to grid.</div>';
    return;
  }

  el.innerHTML = selected.map(function(s, idx) {
    var parts  = s.file.replace('.csv','').split('_');
    var itvl   = parts[1] ? parts[1].toUpperCase() : '';
    var isMain = s.file === ANA_ACTIVE_FILE;
    return '<div class="ana-mini-card' + (isMain ? ' ana-mini-active' : '') + '" ' +
      'onclick="isolateSymbol(\'' + s.file.replace(/'/g,"\\'") + '\',\'' + s.symbol + '\')" ' +
      'title="Click to open full analysis">' +
      '<div class="ana-mini-head">' +
        '<span class="ana-mini-sym">' + s.symbol + '</span>' +
        '<span class="ana-mini-itvl">' + itvl + '</span>' +
        (isMain ? '<span class="ana-mini-badge">ACTIVE</span>' : '') +
      '</div>' +
      '<canvas class="ana-mini-canvas" id="mgc-' + idx + '" style="height:130px"></canvas>' +
      '<div class="ana-mini-price" id="mgp-' + idx + '">loading…</div>' +
    '</div>';
  }).join('');

  selected.forEach(function(s, idx) {
    loadMiniChart(s.file, s.symbol, idx);
  });
}

function loadMiniChart(file, symbol, idx) {
  var cached = ANA_MULTI_LOADED[file];
  if (cached) { drawMiniChart(idx, cached, symbol); return; }
  fetch('data/gold/' + file)
    .then(function(r) { return r.ok ? r.text() : Promise.reject('HTTP ' + r.status); })
    .then(function(txt) {
      var bars = parseAnalysisCSV(txt);
      ANA_MULTI_LOADED[file] = bars;
      drawMiniChart(idx, bars, symbol);
    })
    .catch(function() {
      var el = document.getElementById('mgp-' + idx);
      if (el) el.textContent = 'Load error';
    });
}

function drawMiniChart(idx, bars, symbol) {
  var canvas  = document.getElementById('mgc-' + idx);
  var priceEl = document.getElementById('mgp-' + idx);
  if (!canvas) return;

  var recent = bars.slice(-80);
  if (!recent.length) return;

  var last = recent[recent.length - 1];
  var prev = recent.length > 1 ? recent[recent.length - 2] : last;
  var chg    = last.close - prev.close;
  var chgPct = (chg / prev.close * 100).toFixed(2);
  var up     = chg >= 0;

  if (priceEl) {
    priceEl.innerHTML = '<span style="color:' + (up ? 'var(--green)' : 'var(--red)') + '">' +
      last.close.toFixed(2) + '&nbsp;&nbsp;' + (up?'+':'') + chgPct + '%</span>';
  }

  var DPR = window.devicePixelRatio || 1;
  var W   = canvas.offsetWidth  || 220;
  var H   = canvas.offsetHeight || 130;
  if (W < 10 || H < 10) {
    requestAnimationFrame(function(){ drawMiniChart(idx, bars, symbol); });
    return;
  }
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  var ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // Background
  ctx.fillStyle = '#020409';
  ctx.fillRect(0, 0, W, H);

  var priceMax = Math.max.apply(null, recent.map(function(b){ return b.high; }));
  var priceMin = Math.min.apply(null, recent.map(function(b){ return b.low;  }));
  var pad5     = (priceMax - priceMin) * 0.06;
  priceMax += pad5; priceMin -= pad5;
  var pRange   = priceMax - priceMin || 1;

  var pad = { top: 6, right: 4, bottom: 4, left: 2 };
  var cW  = W - pad.left - pad.right;
  var cH  = H - pad.top  - pad.bottom;
  var toY = function(p){ return pad.top + cH * (1 - (p - priceMin) / pRange); };
  var toX = function(i){ return pad.left + (i + 0.5) * (cW / recent.length); };
  var bW  = cW / recent.length;

  // EMA20
  var closes = recent.map(function(b){ return b.close; });
  var ema20  = calcEMA(closes, 20);
  ctx.strokeStyle = 'rgba(0,229,255,0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  var mv = false;
  for (var i = 0; i < ema20.length; i++) {
    if (!ema20[i]) continue;
    var x = toX(i), y = toY(ema20[i]);
    if (!mv) { ctx.moveTo(x, y); mv = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Candlesticks
  var bw = Math.max(1, bW * 0.72);
  for (var i = 0; i < recent.length; i++) {
    var b   = recent[i];
    var bull = b.close >= b.open;
    var col  = bull ? '#00d4aa' : '#ff3355';
    var cx   = toX(i);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(0.5, bw * 0.1);
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(cx, toY(b.high)); ctx.lineTo(cx, toY(b.low)); ctx.stroke();
    var bTop = toY(Math.max(b.open, b.close));
    var bBot = toY(Math.min(b.open, b.close));
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(cx - bw/2, bTop, bw, Math.max(1, bBot - bTop));
    ctx.globalAlpha = 1;
  }

  // Current price line
  var pricY = toY(last.close);
  ctx.strokeStyle = up ? 'rgba(0,212,170,0.5)' : 'rgba(255,51,85,0.5)';
  ctx.lineWidth = 0.7;
  ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.moveTo(pad.left, pricY); ctx.lineTo(pad.left + cW, pricY); ctx.stroke();
  ctx.setLineDash([]);
}

function isolateSymbol(file, symbol) {
  ANA_VIEW    = 'single';
  ANA_RAW_M15 = ANA_MULTI_LOADED[file] || null;
  ANA         = null;
  ANA_ACTIVE_FILE   = file;
  ANA_ACTIVE_SYMBOL = symbol;

  var btnS = document.getElementById('viewSingle');
  var btnM = document.getElementById('viewMulti');
  if (btnS) btnS.classList.add('active');
  if (btnM) btnM.classList.remove('active');
  var multiGrid = document.getElementById('anaMultiGrid');
  if (multiGrid) multiGrid.style.display = 'none';

  renderSymbolChips();

  if (ANA_RAW_M15) {
    var data = aggregateData(ANA_RAW_M15, ANA_INTERVAL);
    buildAnalysis(data);
  } else {
    loadActiveSymbol();
  }
}

function showAnaStatus(type, msg) {
  var box   = document.getElementById('anaStatus');
  var icon  = document.getElementById('anaStatusIcon');
  var title = document.getElementById('anaStatusTitle');
  var sub   = document.getElementById('anaStatusSub');
  var cont  = document.getElementById('anaContent');
  if (!box) return;
  if (cont && ANA_VIEW !== 'multi') cont.style.display = 'none';
  box.style.display = 'block';
  if (type === 'loading') {
    icon.textContent  = '⏳';
    title.textContent = 'Loading ' + (ANA_ACTIVE_SYMBOL || 'data') + '…';
    sub.innerHTML     = 'Fetching <code>data/gold/' + (ANA_ACTIVE_FILE || '…') + '</code>';
  } else {
    icon.textContent  = '⚠️';
    title.textContent = 'Could not load data';
    sub.innerHTML     = (msg || 'Unknown error') + '<br><br>' +
      'Click <strong>Sync MT4</strong> to retry, or run:<br>' +
      '<code>py scripts/download_data.py --symbol ' + (ANA_ACTIVE_SYMBOL || 'XAUUSD') + '</code>';
  }
}

function hideAnaStatus() {
  var box = document.getElementById('anaStatus');
  if (box) box.style.display = 'none';
}

// ── Interval / bars switching ────────────────────────────────────────────────
function setAnaInterval(tf) {
  ANA_INTERVAL = tf;
  document.querySelectorAll('.ana-itvl-btn').forEach(function(b) {
    b.classList.toggle('active', b.id === 'itvl-' + tf);
  });
  if (ANA_VIEW === 'multi') { renderMultiGrid(); return; }
  if (ANA_RAW_M15) {
    var data = aggregateData(ANA_RAW_M15, tf);
    buildAnalysis(data);
  }
}

function setAnaBars(n) {
  ANA_BARS = n;
  document.querySelectorAll('.ana-bars-btn').forEach(function(b) {
    b.classList.toggle('active', b.id === 'bars-' + n);
  });
  if (ANA_VIEW === 'multi') return;
  if (ANA && ANA.data) {
    drawAllCharts();
  }
}

// ── Aggregation helpers ──────────────────────────────────────────────────────
var TF_MINUTES = { M1:1, M5:5, M15:15, M30:30, H1:60, H4:240, D1:1440, W1:10080 };

// Source-aware aggregation: uses ANA_FILE_TF to compute the correct factor.
// If target is the same or lower than the file's native TF → return as-is.
function aggregateData(rawData, targetTF) {
  var srcMins = TF_MINUTES[ANA_FILE_TF]  || 15;
  var tgtMins = TF_MINUTES[targetTF]     || 15;
  var factor  = Math.round(tgtMins / srcMins);
  if (factor <= 1) return rawData; // already at or below target resolution

  var out = [];
  for (var i = 0; i < rawData.length; i += factor) {
    var slice = rawData.slice(i, i + factor);
    if (!slice.length) continue;
    out.push({
      datetime: slice[0].datetime,
      date:     slice[0].date,
      open:     slice[0].open,
      close:    slice[slice.length - 1].close,
      high:     Math.max.apply(null, slice.map(function(b){ return b.high; })),
      low:      Math.min.apply(null, slice.map(function(b){ return b.low; })),
      volume:   slice.reduce(function(s, b){ return s + b.volume; }, 0),
    });
  }
  return out;
}

// ── CSV Parser ───────────────────────────────────────────────────────────────
function parseAnalysisCSV(text) {
  var lines = text.trim().split('\n').filter(function(l){ return l.trim(); });
  var raw   = lines[0].split(',').map(function(h){ return h.trim().replace(/"/g,'').toLowerCase(); });

  var col = {
    dt:    raw.findIndex(function(h){ return h === 'datetime' || h.includes('date'); }),
    open:  raw.findIndex(function(h){ return h === 'open'; }),
    high:  raw.findIndex(function(h){ return h === 'high'; }),
    low:   raw.findIndex(function(h){ return h === 'low'; }),
    close: raw.findIndex(function(h){ return h === 'close'; }),
    vol:   raw.findIndex(function(h){ return h === 'volume'; }),
  };

  return lines.slice(1).map(function(l) {
    var c  = l.split(',').map(function(v){ return v.trim().replace(/"/g,''); });
    var dt = c[col.dt] || '';
    return {
      datetime: dt,
      date:     dt.substring(0, 10),
      open:     parseFloat(c[col.open]),
      high:     parseFloat(c[col.high]),
      low:      parseFloat(c[col.low]),
      close:    parseFloat(c[col.close]),
      volume:   parseInt(c[col.vol]) || 0,
    };
  }).filter(function(r){ return isFinite(r.close) && isFinite(r.open) && r.high >= r.low; });
}

// ── Indicators ───────────────────────────────────────────────────────────────
function calcATR(data, period) {
  period = period || 14;
  var tr = data.map(function(d, i) {
    if (i === 0) return d.high - d.low;
    var pc = data[i-1].close;
    return Math.max(d.high - d.low, Math.abs(d.high - pc), Math.abs(d.low - pc));
  });
  var atr = new Array(data.length).fill(null);
  var sum = 0;
  for (var i = 0; i < period; i++) sum += tr[i];
  atr[period-1] = sum / period;
  for (var i = period; i < data.length; i++) {
    atr[i] = (atr[i-1] * (period-1) + tr[i]) / period;
  }
  return atr;
}

function calcEMA(closes, period) {
  var k   = 2 / (period + 1);
  var ema = new Array(closes.length).fill(null);
  var sum = 0;
  for (var i = 0; i < period; i++) sum += closes[i];
  ema[period-1] = sum / period;
  for (var i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i-1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  period = period || 14;
  var rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 2) return rsi;
  var avgGain = 0, avgLoss = 0;
  for (var i = 1; i <= period; i++) {
    var d = closes[i] - closes[i-1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (var i = period + 1; i < closes.length; i++) {
    var d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(0,  d)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(0, -d)) / period;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// ── Swing Detection ──────────────────────────────────────────────────────────
function findSwings(data, lookback) {
  lookback = lookback || 5;
  var highs = [], lows = [];
  for (var i = lookback; i < data.length - lookback; i++) {
    var isH = true, isL = true;
    for (var j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (data[j].high >= data[i].high) isH = false;
      if (data[j].low  <= data[i].low)  isL = false;
    }
    if (isH) highs.push({ index: i, price: data[i].high, date: data[i].date });
    if (isL) lows.push({  index: i, price: data[i].low,  date: data[i].date });
  }
  return { highs: highs, lows: lows };
}

// ── S/R Zone Detection ───────────────────────────────────────────────────────
function detectSRZones(data, atr) {
  var latestATR = atr.filter(function(v){ return v !== null; }).slice(-1)[0];
  var tol       = latestATR * 0.6;
  var close     = data[data.length-1].close;

  var swings = findSwings(data, 5);

  var allLevels = [];
  swings.highs.forEach(function(h){ allLevels.push({ price: h.price, type: 'resistance', index: h.index }); });
  swings.lows.forEach(function(l){  allLevels.push({ price: l.price, type: 'support',    index: l.index }); });
  allLevels.sort(function(a,b){ return a.price - b.price; });

  var zones = [], used = {};

  for (var i = 0; i < allLevels.length; i++) {
    if (used[i]) continue;
    var cluster = [allLevels[i]];
    used[i] = true;
    for (var j = i+1; j < allLevels.length; j++) {
      if (used[j]) continue;
      if (Math.abs(allLevels[j].price - allLevels[i].price) <= tol) {
        cluster.push(allLevels[j]); used[j] = true;
      }
    }

    var avgPrice  = cluster.reduce(function(s,c){ return s + c.price; }, 0) / cluster.length;
    var resCount  = cluster.filter(function(c){ return c.type === 'resistance'; }).length;
    var supCount  = cluster.filter(function(c){ return c.type === 'support';    }).length;
    var type      = resCount > supCount ? 'resistance' : supCount > resCount ? 'support' : 'both';
    var latestIdx = Math.max.apply(null, cluster.map(function(c){ return c.index; }));

    var touches = 0;
    for (var k = 0; k < data.length; k++) {
      var b = data[k];
      if (b.low <= avgPrice + tol && b.high >= avgPrice - tol) touches++;
    }

    // Scale-aware round number step (works for Gold, US30, NAS100, US500)
    var step = close < 100 ? 1 : close < 500 ? 5 : close < 2000 ? 25 :
               close < 5000 ? 50 : close < 15000 ? 100 : close < 50000 ? 500 : 1000;
    var mod  = avgPrice % step;
    var nearRound = mod < latestATR * 0.35 || (step - mod) < latestATR * 0.35;

    var raw = cluster.length * 1.5 + Math.log(touches + 1) * 2 + (nearRound ? 2.5 : 0);
    var strength = Math.round(Math.min(10, raw) * 10) / 10;
    var distPct  = (avgPrice - close) / close * 100;

    zones.push({
      price:    Math.round(avgPrice * 10) / 10,
      type:     type,
      touches:  touches,
      strength: strength,
      barsAgo:  data.length - 1 - latestIdx,
      distPct:  distPct,
      isRound:  nearRound,
    });
  }

  // Filter to ±8% of current price, sort by proximity-weighted strength
  return zones
    .filter(function(z){ return Math.abs(z.distPct) <= 8; })
    .sort(function(a, b){
      // Proximity score: strength discounted by distance from price
      var aScore = a.strength / (Math.abs(a.distPct) + 0.8);
      var bScore = b.strength / (Math.abs(b.distPct) + 0.8);
      return bScore - aScore;
    })
    .slice(0, 16);
}

// ── Fibonacci ────────────────────────────────────────────────────────────────
function calcFibLevels(data) {
  var recent = data.slice(-Math.min(data.length, 150));
  var sw = findSwings(recent, 5);
  if (!sw.highs.length || !sw.lows.length) return null;

  var bestH = sw.highs.reduce(function(a, b) { return b.price > a.price ? b : a; });
  var bestL = sw.lows.reduce(function(a, b)  { return b.price < a.price ? b : a; });

  // Prefer cross-date pair so Fib spans a meaningful multi-session move
  if (bestH.date === bestL.date) {
    var altH = sw.highs.filter(function(h) { return h.date !== bestL.date; });
    var altL = sw.lows.filter(function(l)  { return l.date !== bestH.date; });
    if (altH.length || altL.length) {
      var sameRange  = bestH.price - bestL.price;
      var candidates = [];
      if (altH.length) {
        var xH = altH.reduce(function(a, b) { return b.price > a.price ? b : a; });
        candidates.push({ H: xH, L: bestL, range: xH.price - bestL.price });
      }
      if (altL.length) {
        var xL = altL.reduce(function(a, b) { return b.price < a.price ? b : a; });
        candidates.push({ H: bestH, L: xL, range: bestH.price - xL.price });
      }
      if (altH.length && altL.length) {
        var xH2 = altH.reduce(function(a, b) { return b.price > a.price ? b : a; });
        var xL2 = altL.reduce(function(a, b) { return b.price < a.price ? b : a; });
        candidates.push({ H: xH2, L: xL2, range: xH2.price - xL2.price });
      }
      candidates.sort(function(a, b) { return b.range - a.range; });
      if (candidates.length && candidates[0].range > sameRange * 0.5) {
        bestH = candidates[0].H;
        bestL = candidates[0].L;
      }
    }
  }

  var swingH = bestH, swingL = bestL;
  var dir    = swingH.index > swingL.index ? 'retrace-down' : 'retrace-up';
  var range  = swingH.price - swingL.price;
  var ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

  return {
    swingH: swingH, swingL: swingL, dir: dir,
    levels: ratios.map(function(r) {
      return {
        ratio: r,
        label: (r * 100).toFixed(1) + '%',
        price: dir === 'retrace-down'
          ? swingH.price - range * r
          : swingL.price + range * r,
      };
    }),
  };
}

// ── Trend Analysis ───────────────────────────────────────────────────────────
function analyzeTrend(data, emas, atr) {
  var last  = data.length - 1;
  var close = data[last].close;
  var e20   = emas.e20[last];
  var e50   = emas.e50[last];
  var e200  = emas.e200[last];
  var latestATR = atr[last] || atr.filter(function(v){ return v; }).slice(-1)[0];

  var emaScore = 0;
  if (e20 && e50 && e200) {
    if      (close > e20 && e20 > e50 && e50 > e200) emaScore =  3;
    else if (close < e20 && e20 < e50 && e50 < e200) emaScore = -3;
    else if (close > e50 && e50 > e200)               emaScore =  2;
    else if (close < e50 && e50 < e200)               emaScore = -2;
    else if (close > e200)                            emaScore =  1;
    else                                              emaScore = -1;
  }

  var recent40 = data.slice(-40);
  var sw = findSwings(recent40, 3);
  var structure = 'Mixed / Consolidating', structScore = 0;

  if (sw.highs.length >= 2 && sw.lows.length >= 2) {
    var h0 = sw.highs[sw.highs.length-2], h1 = sw.highs[sw.highs.length-1];
    var l0 = sw.lows[sw.lows.length-2],   l1 = sw.lows[sw.lows.length-1];
    var hhhl = h1.price > h0.price && l1.price > l0.price;
    var llhl = h1.price < h0.price && l1.price < l0.price;
    var cont = h1.price < h0.price && l1.price > l0.price;
    var exp  = h1.price > h0.price && l1.price < l0.price;

    if (hhhl)      { structure = 'HH / HL — Uptrend';           structScore =  2; }
    else if (llhl) { structure = 'LH / LL — Downtrend';         structScore = -2; }
    else if (cont) { structure = 'Contracting (Squeeze)';            structScore =  0; }
    else if (exp)  { structure = 'Expanding (High Volatility)';      structScore =  0; }
  }

  var total = emaScore + structScore;
  var direction, colorClass;

  if      (total >= 4)  { direction = 'STRONG BULL'; colorClass = 'green'; }
  else if (total >= 2)  { direction = 'BULLISH';     colorClass = 'green'; }
  else if (total >= 1)  { direction = 'WEAK BULL';   colorClass = 'amber'; }
  else if (total <= -4) { direction = 'STRONG BEAR'; colorClass = 'red';   }
  else if (total <= -2) { direction = 'BEARISH';     colorClass = 'red';   }
  else if (total <= -1) { direction = 'WEAK BEAR';   colorClass = 'amber'; }
  else                  { direction = 'NEUTRAL';     colorClass = 'dark';  }

  var atrPct = (latestATR / close) * 100;
  var regime = atrPct > 0.75 ? 'TRENDING' : 'RANGING';

  var dist20  = e20  ? ((close - e20)  / close * 100).toFixed(2) : null;
  var dist200 = e200 ? ((close - e200) / close * 100).toFixed(2) : null;

  return {
    direction: direction, colorClass: colorClass,
    emaScore: emaScore, structScore: structScore, total: total,
    structure: structure, regime: regime, atrPct: atrPct,
    e20: e20, e50: e50, e200: e200, close: close,
    dist20: dist20, dist200: dist200,
  };
}

// ── Pattern Scanner ──────────────────────────────────────────────────────────
function scanPatterns(data) {
  var n   = data.length;
  var win = data.slice(-60);
  var wn  = win.length;
  var patterns = [];
  var sw  = findSwings(win, 4);

  // Helpers for zone / confirmation checks
  var atrLast = ANA && ANA.atr ? (ANA.atr.filter(function(v){ return v; }).slice(-1)[0] || 1) : 1;
  var zones   = (ANA && ANA.zones) ? ANA.zones : [];
  var amdPhase = ANA && ANA.amd ? ANA.amd.phase : null;

  function nearZone(price, side) {
    return zones.some(function(z) {
      if (Math.abs(z.price - price) > atrLast * 1.6) return false;
      if (side === 'buy'  && (z.type === 'support'    || z.type === 'both')) return true;
      if (side === 'sell' && (z.type === 'resistance' || z.type === 'both')) return true;
      return false;
    });
  }

  // Checks whether the candle at win[i+1] confirms the expected direction
  function nextBarConfirms(i, dir) {
    if (i >= wn - 1) return false; // no next bar yet
    var next = win[i + 1];
    var cur  = win[i];
    if (dir === 'bull') return next.close > Math.max(cur.open, cur.close);
    if (dir === 'bear') return next.close < Math.min(cur.open, cur.close);
    return false;
  }

  // ── Bullish / Bearish Engulfing ─────────────────────────────────────────
  for (var i = 1; i < wn; i++) {
    var c = win[i], p = win[i-1];
    var cB = c.close > c.open, pB = p.close > p.open;
    var cBody = Math.abs(c.close - c.open), pBody = Math.abs(p.close - p.open);
    if (pBody < 0.001) continue;

    // Bearish engulfing: must be at resistance, body 1.3× previous
    if (!cB && pB && c.open >= p.close && c.close <= p.open && cBody >= pBody * 1.3) {
      var atR  = nearZone(c.high, 'sell');
      var conf = nextBarConfirms(i, 'bear');
      var inAMD = amdPhase === 'MANIPULATION' && ANA.amd && ANA.amd.dir === 'down';
      patterns.push({ name: 'Bearish Engulfing', type: 'bearish',
        sig: (conf && atR) ? 'very high' : conf || atR ? 'high' : 'medium',
        barIdx: n-wn+i, date: c.date,
        confirmed: conf, atZone: atR, amdAlign: inAMD,
        desc: 'Full red body engulfs prior green — sellers took control' +
              (!atR ? ' · not at a resistance zone, treat with caution' : '') });
    }
    // Bullish engulfing: must be at support, body 1.3× previous
    if (cB && !pB && c.open <= p.close && c.close >= p.open && cBody >= pBody * 1.3) {
      var atS  = nearZone(c.low, 'buy');
      var conf = nextBarConfirms(i, 'bull');
      var inAMD = amdPhase === 'MANIPULATION' && ANA.amd && ANA.amd.dir === 'up';
      patterns.push({ name: 'Bullish Engulfing', type: 'bullish',
        sig: (conf && atS) ? 'very high' : conf || atS ? 'high' : 'medium',
        barIdx: n-wn+i, date: c.date,
        confirmed: conf, atZone: atS, amdAlign: inAMD,
        desc: 'Full green body engulfs prior red — buyers took control' +
              (!atS ? ' · not at a support zone, treat with caution' : '') });
    }
  }

  // ── Hammer / Bullish Pin Bar ────────────────────────────────────────────
  for (var i = 0; i < wn; i++) {
    var b = win[i];
    var range = b.high - b.low;
    if (range < 0.001) continue;
    var body  = Math.abs(b.close - b.open);
    var lower = Math.min(b.open, b.close) - b.low;
    var upper = b.high - Math.max(b.open, b.close);
    // Strict: lower wick >= 62% of range, body <= 28%, lower at least 2.5× upper
    if (lower >= range * 0.62 && body <= range * 0.28 && lower > upper * 2.5) {
      var atS  = nearZone(b.low, 'buy');
      var conf = i < wn - 1 && win[i+1].close > Math.max(b.open, b.close);
      var inAMD = amdPhase === 'MANIPULATION' && ANA.amd && ANA.amd.dir === 'up';
      if (atS || conf) { // require at least one confirmation criterion
        patterns.push({ name: 'Hammer / Pin Bar', type: 'bullish',
          sig: (conf && atS) ? 'very high' : 'high',
          barIdx: n-wn+i, date: b.date,
          confirmed: conf, atZone: atS, amdAlign: inAMD,
          desc: 'Long lower wick rejects lower prices — bullish reversal signal' });
      }
    }
  }

  // ── Shooting Star / Bearish Pin Bar ────────────────────────────────────
  for (var i = 0; i < wn; i++) {
    var b = win[i];
    var range = b.high - b.low;
    if (range < 0.001) continue;
    var body  = Math.abs(b.close - b.open);
    var upper = b.high - Math.max(b.open, b.close);
    var lower = Math.min(b.open, b.close) - b.low;
    // Strict: upper wick >= 62%, body <= 28%, upper at least 2.5× lower
    if (upper >= range * 0.62 && body <= range * 0.28 && upper > lower * 2.5) {
      var atR  = nearZone(b.high, 'sell');
      var conf = i < wn - 1 && win[i+1].close < Math.min(b.open, b.close);
      var inAMD = amdPhase === 'MANIPULATION' && ANA.amd && ANA.amd.dir === 'down';
      if (atR || conf) { // require at least one
        patterns.push({ name: 'Shooting Star / Pin Bar', type: 'bearish',
          sig: (conf && atR) ? 'very high' : 'high',
          barIdx: n-wn+i, date: b.date,
          confirmed: conf, atZone: atR, amdAlign: inAMD,
          desc: 'Long upper wick rejects higher prices — bearish reversal signal' });
      }
    }
  }

  // ── Doji — only show when confirmed by the following bar ────────────────
  for (var i = 0; i < wn - 1; i++) {  // wn-1: need next bar for confirmation
    var b = win[i];
    var range = b.high - b.low;
    if (range < 0.001) continue;
    var bodyRatio = Math.abs(b.close - b.open) / range;
    if (bodyRatio < 0.07) {
      var next = win[i + 1];
      var bullConf = next.close > b.high;
      var bearConf = next.close < b.low;
      if (!bullConf && !bearConf) continue; // skip unconfirmed dojis
      var atZ  = nearZone(b.close, bullConf ? 'buy' : 'sell');
      patterns.push({ name: 'Doji' + (atZ ? ' at Zone' : ''), type: bullConf ? 'bullish' : 'bearish',
        sig: atZ ? 'high' : 'medium',
        barIdx: n-wn+i, date: b.date,
        confirmed: true, atZone: atZ, amdAlign: false,
        desc: 'Indecision candle confirmed by ' + (bullConf ? 'bullish' : 'bearish') + ' follow-through' });
    }
  }

  // ── Inside Bar (neutral — only at key zones) ────────────────────────────
  for (var i = 1; i < wn; i++) {
    var c = win[i], p = win[i-1];
    if (c.high < p.high && c.low > p.low) {
      var atAny = zones.some(function(z) { return Math.abs(z.price - c.close) <= atrLast * 1.5; });
      if (!atAny) continue; // skip inside bars that aren't at a zone
      patterns.push({ name: 'Inside Bar', type: 'neutral', sig: 'medium',
        barIdx: n-wn+i, date: c.date,
        confirmed: false, atZone: true, amdAlign: false,
        desc: 'Consolidation at key level — await breakout in trend direction' });
    }
  }

  // ── Double Top / Bottom (structure-level — no extra filter needed) ──────
  for (var i = 0; i < sw.highs.length - 1; i++) {
    var h0 = sw.highs[i], h1 = sw.highs[i+1];
    if (h1.index - h0.index < 5) continue;
    if (Math.abs(h1.price - h0.price) / h0.price * 100 < 0.5)
      patterns.push({ name: 'Double Top', type: 'bearish', sig: 'very high',
        barIdx: n-wn+h1.index, date: h1.date,
        confirmed: true, atZone: true, amdAlign: false,
        desc: 'Twin peaks near ' + h0.price.toFixed(0) + ' — strong resistance, reversal likely' });
  }
  for (var i = 0; i < sw.lows.length - 1; i++) {
    var l0 = sw.lows[i], l1 = sw.lows[i+1];
    if (l1.index - l0.index < 5) continue;
    if (Math.abs(l1.price - l0.price) / l0.price * 100 < 0.5)
      patterns.push({ name: 'Double Bottom', type: 'bullish', sig: 'very high',
        barIdx: n-wn+l1.index, date: l1.date,
        confirmed: true, atZone: true, amdAlign: false,
        desc: 'Twin troughs near ' + l0.price.toFixed(0) + ' — strong support, reversal likely' });
  }

  // ── HH/HL and LH/LL Market Structure ────────────────────────────────────
  if (sw.highs.length >= 3 && sw.lows.length >= 3) {
    var hh = sw.highs.slice(-3), ll = sw.lows.slice(-3);
    if (hh[2].price > hh[1].price && hh[1].price > hh[0].price &&
        ll[2].price > ll[1].price && ll[1].price > ll[0].price)
      patterns.push({ name: 'Confirmed HH/HL Structure', type: 'bullish', sig: 'high',
        barIdx: n-1, date: data[n-1].date, confirmed: true, atZone: false, amdAlign: false,
        desc: '3 consecutive HH + HL — uptrend structure confirmed' });
    if (hh[2].price < hh[1].price && hh[1].price < hh[0].price &&
        ll[2].price < ll[1].price && ll[1].price < ll[0].price)
      patterns.push({ name: 'Confirmed LH/LL Structure', type: 'bearish', sig: 'high',
        barIdx: n-1, date: data[n-1].date, confirmed: true, atZone: false, amdAlign: false,
        desc: '3 consecutive LH + LL — downtrend structure confirmed' });
  }

  // ── RSI Divergence ───────────────────────────────────────────────────────
  if (ANA && ANA.rsi) {
    var rsi = ANA.rsi;
    if (sw.highs.length >= 2) {
      var sh0 = sw.highs[sw.highs.length-2], sh1 = sw.highs[sw.highs.length-1];
      var ai0 = n - wn + sh0.index, ai1 = n - wn + sh1.index;
      if (ai0 >= 0 && rsi[ai0] && rsi[ai1] && sh1.price > sh0.price && rsi[ai1] < rsi[ai0])
        patterns.push({ name: 'Bearish RSI Divergence', type: 'bearish', sig: 'high',
          barIdx: ai1, date: data[ai1] ? data[ai1].date : '',
          confirmed: true, atZone: false, amdAlign: false,
          desc: 'Price new high, RSI lower — momentum fading, reversal risk' });
    }
    if (sw.lows.length >= 2) {
      var sl0 = sw.lows[sw.lows.length-2], sl1 = sw.lows[sw.lows.length-1];
      var ai0 = n - wn + sl0.index, ai1 = n - wn + sl1.index;
      if (ai0 >= 0 && rsi[ai0] && rsi[ai1] && sl1.price < sl0.price && rsi[ai1] > rsi[ai0])
        patterns.push({ name: 'Bullish RSI Divergence', type: 'bullish', sig: 'high',
          barIdx: ai1, date: data[ai1] ? data[ai1].date : '',
          confirmed: true, atZone: false, amdAlign: false,
          desc: 'Price new low, RSI higher — sellers losing steam, reversal likely' });
    }
  }

  var seen = {};
  return patterns
    .filter(function(p){ return p.barIdx >= n - 20; })
    .filter(function(p){
      var k = p.name + '|' + p.barIdx;
      if (seen[k]) return false; seen[k] = true; return true;
    })
    .sort(function(a,b){ return b.barIdx - a.barIdx; });
}

// ── Deal Scorer ──────────────────────────────────────────────────────────────
function runDealScore() {
  if (!ANA) return;
  var dir   = document.getElementById('scDir').value;
  var entry = parseFloat(document.getElementById('scEntry').value);
  var sl    = parseFloat(document.getElementById('scSL').value);
  var tp    = parseFloat(document.getElementById('scTP').value);
  var el    = document.getElementById('scResult');

  if (!entry || !sl || !tp || isNaN(entry) || isNaN(sl) || isNaN(tp)) {
    el.innerHTML = '<div class="ana-score-empty">Fill in your trade above to score it</div>';
    return;
  }

  var risk   = Math.abs(entry - sl);
  var reward = Math.abs(tp - entry);
  if (risk === 0) { el.innerHTML = '<div class="ana-score-empty">Entry and SL cannot be the same</div>'; return; }
  var rr     = reward / risk;

  var latestATR = ANA.atr.filter(function(v){ return v !== null; }).slice(-1)[0];
  var bd = [], total = 0;

  var rrScore = rr >= 3 ? 25 : rr >= 2 ? 20 : rr >= 1.5 ? 14 : rr >= 1 ? 8 : 2;
  bd.push({ label: 'Risk : Reward', score: rrScore, max: 25,
    detail: rr.toFixed(2) + ':1 — ' + (rr >= 3 ? 'Exceptional' : rr >= 2 ? 'Strong' : rr >= 1.5 ? 'Good' : rr >= 1 ? 'Marginal' : 'Poor') });
  total += rrScore;

  var tr     = ANA.trend;
  var isBull = ['STRONG BULL','BULLISH','WEAK BULL'].indexOf(tr.direction) >= 0;
  var isBear = ['STRONG BEAR','BEARISH','WEAK BEAR'].indexOf(tr.direction) >= 0;
  var strong = ['STRONG BULL','STRONG BEAR'].indexOf(tr.direction) >= 0;
  var withTrend = (dir === 'buy' && isBull) || (dir === 'sell' && isBear);
  var tScore = withTrend ? (strong ? 20 : 15) : tr.direction === 'NEUTRAL' ? 10 : 3;
  bd.push({ label: 'Trend Alignment', score: tScore, max: 20,
    detail: tr.direction + ' — ' + (withTrend ? 'WITH trend' : tr.direction === 'NEUTRAL' ? 'Neutral market' : 'COUNTER trend') });
  total += tScore;

  var entryZone = null;
  for (var i = 0; i < ANA.zones.length; i++) {
    if (Math.abs(ANA.zones[i].price - entry) <= latestATR * 0.8) { entryZone = ANA.zones[i]; break; }
  }
  var eScore = 0, eDetail = 'No key zone near entry — no confluence';
  if (entryZone) {
    var match = (dir === 'buy'  && (entryZone.type === 'support'    || entryZone.type === 'both')) ||
                (dir === 'sell' && (entryZone.type === 'resistance' || entryZone.type === 'both'));
    eScore  = match ? 20 : 10;
    eDetail = 'At ' + entryZone.type + ' zone ~' + entryZone.price.toFixed(0) +
              ' (' + entryZone.touches + ' touches)' + (match ? '' : ' — type mismatch');
  }
  bd.push({ label: 'Entry Confluence', score: eScore, max: 20, detail: eDetail });
  total += eScore;

  var slZone = null;
  for (var i = 0; i < ANA.zones.length; i++) {
    var z = ANA.zones[i];
    var behindSL = dir === 'buy' ? z.price < entry : z.price > entry;
    if (behindSL && Math.abs(z.price - sl) <= latestATR * 0.7) { slZone = z; break; }
  }
  var slAtr  = risk / latestATR;
  var slScore = 0;
  if (slZone) slScore += 8;
  slScore += slAtr >= 0.4 && slAtr <= 2.5 ? 7 : slAtr < 0.4 ? 2 : 3;
  bd.push({ label: 'Stop Loss Quality', score: slScore, max: 15,
    detail: risk.toFixed(0) + ' pts | ' + slAtr.toFixed(2) + 'x ATR' + (slZone ? ' | behind ' + slZone.type + ' zone' : ' | no zone behind SL') });
  total += slScore;

  var tpZone = null;
  for (var i = 0; i < ANA.zones.length; i++) {
    if (Math.abs(ANA.zones[i].price - tp) <= latestATR * 0.9) { tpZone = ANA.zones[i]; break; }
  }
  var tpScore = 0, tpDetail = 'No key zone at target — arbitrary TP';
  if (tpZone) {
    var tpMatch = (dir === 'buy'  && (tpZone.type === 'resistance' || tpZone.type === 'both')) ||
                 (dir === 'sell' && (tpZone.type === 'support'    || tpZone.type === 'both'));
    tpScore  = tpMatch ? 10 : 5;
    tpDetail = 'Near ' + tpZone.type + ' ~' + tpZone.price.toFixed(0);
  }
  bd.push({ label: 'TP at Key Level', score: tpScore, max: 10, detail: tpDetail });
  total += tpScore;

  var atrPct  = (latestATR / ANA.data[ANA.data.length-1].close) * 100;
  var aligned = (dir === 'buy' && tr.total > 0) || (dir === 'sell' && tr.total < 0);
  var rScore  = tr.regime === 'TRENDING' ? (aligned ? 10 : 4) : 7;
  bd.push({ label: 'Market Regime', score: rScore, max: 10,
    detail: tr.regime + ' | ATR ' + latestATR.toFixed(1) + ' (' + atrPct.toFixed(2) + '% of price)' });
  total += rScore;

  var grade, cls, verdict;
  if      (total >= 88) { grade = 'S'; cls = 'grade-s'; verdict = 'SNIPER DEAL — pull the trigger'; }
  else if (total >= 73) { grade = 'A'; cls = 'grade-a'; verdict = 'HIGH QUALITY setup'; }
  else if (total >= 55) { grade = 'B'; cls = 'grade-b'; verdict = 'SOLID — watch for tighter entry'; }
  else if (total >= 38) { grade = 'C'; cls = 'grade-c'; verdict = 'MARGINAL — key confluence missing'; }
  else                  { grade = 'D'; cls = 'grade-d'; verdict = 'SKIP — not a deal'; }

  renderScoreResult(el, total, grade, cls, verdict, bd, rr, risk, reward);
}

function renderScoreResult(el, total, grade, cls, verdict, bd, rr, risk, reward) {
  var rows = bd.map(function(b) {
    var pct = b.score / b.max * 100;
    var col = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--gold)' : 'var(--red)';
    var txt = pct >= 70 ? 'green' : pct >= 40 ? 'amber' : 'red';
    return '<div class="sc-row">' +
      '<span class="sc-row-label">' + b.label + '</span>' +
      '<span class="sc-row-detail">' + b.detail + '</span>' +
      '<div class="sc-row-bar"><div class="sc-row-fill" style="width:' + pct + '%;background:' + col + '"></div></div>' +
      '<span class="sc-row-num ' + txt + '">' + b.score + '/' + b.max + '</span>' +
      '</div>';
  }).join('');

  el.innerHTML =
    '<div class="sc-top">' +
      '<div class="sc-grade ' + cls + '">' + grade + '</div>' +
      '<div class="sc-top-right">' +
        '<div class="sc-score">' + total + '<span class="sc-max">/100</span></div>' +
        '<div class="sc-verdict ' + cls + '">' + verdict + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="sc-bar-wrap"><div class="sc-bar-fill ' + cls + '" style="width:' + total + '%"></div></div>' +
    '<div class="sc-meta">' +
      '<span>R:R <strong>' + rr.toFixed(2) + ':1</strong></span>' +
      '<span>Risk <strong>' + risk.toFixed(0) + ' pts</strong></span>' +
      '<span>Reward <strong>' + reward.toFixed(0) + ' pts</strong></span>' +
    '</div>' +
    '<div class="sc-bd">' + rows + '</div>';
}

// ── ICT Models ───────────────────────────────────────────────────────────────

function getCurrentKillZone() {
  var now = new Date();
  var h   = now.getUTCHours();
  var m   = now.getUTCMinutes();
  var t   = h * 60 + m;
  var zones = [
    { name: 'Asian KZ',       start:  1*60, end:  4*60, col: '#8c5aff' },
    { name: 'London KZ',      start:  7*60, end: 10*60, col: '#f5b935' },
    { name: 'NY KZ',          start: 13*60, end: 16*60, col: '#0ecb8a' },
    { name: 'London Close KZ',start: 15*60, end: 17*60, col: '#f5b935' },
  ];
  for (var i = 0; i < zones.length; i++) {
    if (t >= zones[i].start && t < zones[i].end) {
      var minsLeft = zones[i].end - t;
      return { name: zones[i].name, col: zones[i].col, active: true,
               sub: minsLeft + ' min remaining · closes ' + Math.floor(zones[i].end/60) + ':00 UTC' };
    }
  }
  // Find next zone
  var next = zones.find(function(z){ return z.start > t; }) || zones[0];
  var minsTo = (next.start > t ? next.start - t : (24*60 - t + next.start));
  return { name: next.name, col: '#5c6b84', active: false,
           sub: 'opens in ' + Math.floor(minsTo/60) + 'h ' + (minsTo%60) + 'm' };
}

function detectBOS_CHoCH(data, swings, atr) {
  var close   = data[data.length - 1].close;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var highs   = swings.highs;
  var lows    = swings.lows;
  var results = [];

  if (highs.length >= 2) {
    var lastH = highs[highs.length - 1];
    var prevH = highs[highs.length - 2];
    if (close > lastH.price) {
      var isCHoCH = lows.length >= 2 && lows[lows.length-1].price < lows[lows.length-2].price; // was making LLs
      results.push({ struct: isCHoCH ? 'CHoCH' : 'BOS', dir: 'bull', price: lastH.price,
        label: (isCHoCH ? '⚠ CHoCH' : 'BOS') + ' Bullish @ ' + lastH.price.toFixed(1),
        desc: isCHoCH ? 'Downtrend broken — potential reversal to bullish' : 'Bullish break of structure confirmed — continuation expected' });
    }
  }

  if (lows.length >= 2) {
    var lastL = lows[lows.length - 1];
    if (close < lastL.price) {
      var isCHoCH = highs.length >= 2 && highs[highs.length-1].price > highs[highs.length-2].price; // was HH
      results.push({ struct: isCHoCH ? 'CHoCH' : 'BOS', dir: 'bear', price: lastL.price,
        label: (isCHoCH ? '⚠ CHoCH' : 'BOS') + ' Bearish @ ' + lastL.price.toFixed(1),
        desc: isCHoCH ? 'Uptrend broken — potential reversal to bearish' : 'Bearish break of structure confirmed — continuation expected' });
    }
  }

  return results;
}

function detectOTEEntry(data, fib, atr) {
  if (!fib) return null;
  var close   = data[data.length - 1].close;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;

  var l618 = fib.levels.filter(function(l){ return l.ratio === 0.618; })[0];
  var l786 = fib.levels.filter(function(l){ return l.ratio === 0.786; })[0];
  if (!l618 || !l786) return null;

  var oteTop = Math.max(l618.price, l786.price);
  var oteBot = Math.min(l618.price, l786.price);
  var tol    = atrLast * 0.8;

  if (close > oteTop + tol || close < oteBot - tol) return null; // not in OTE zone

  var dir = fib.dir === 'retrace-down' ? 'buy' : 'sell';
  var sl  = dir === 'buy'
    ? parseFloat((fib.swingL.price - atrLast * 0.5).toFixed(1))
    : parseFloat((fib.swingH.price + atrLast * 0.5).toFixed(1));
  var tp1 = dir === 'buy'
    ? parseFloat(fib.swingH.price.toFixed(1))
    : parseFloat(fib.swingL.price.toFixed(1));

  return { type: 'OTE', icon: '◆', dir: dir,
    entry: parseFloat(close.toFixed(1)), sl: sl, tp1: tp1,
    tp2: dir === 'buy'
      ? parseFloat((fib.swingH.price + (fib.swingH.price - fib.swingL.price) * 0.5).toFixed(1))
      : parseFloat((fib.swingL.price - (fib.swingH.price - fib.swingL.price) * 0.5).toFixed(1)),
    zone: oteBot.toFixed(1) + ' – ' + oteTop.toFixed(1),
    desc: 'Price in OTE zone (61.8%–78.6% retrace) · ' + (dir === 'buy' ? 'discount' : 'premium') + ' entry · SL beyond swing ' + (dir === 'buy' ? 'low' : 'high') };
}

function detectBreakerBlocks(data, atr) {
  var n       = data.length;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var close   = data[n - 1].close;
  var minMove = atrLast * 2.2;
  var breakers = [];

  for (var i = 4; i < n - 8; i++) {
    var bullMove = data[i].close - data[i - 3].close;
    if (bullMove >= minMove) {
      for (var j = i - 1; j >= Math.max(0, i - 5); j--) {
        var b = data[j];
        if (b.close < b.open) {
          var violated = false;
          for (var k = i + 1; k < n; k++) { if (data[k].low <= b.low) { violated = true; break; } }
          if (violated && Math.abs(close - b.high) <= atrLast * 7) {
            breakers.push({ type: 'bear_breaker', high: parseFloat(b.high.toFixed(1)), low: parseFloat(b.low.toFixed(1)), date: b.date,
              desc: 'Failed Bull OB → Bearish Breaker (resistance) at ' + b.low.toFixed(1) + '–' + b.high.toFixed(1) });
          }
          break;
        }
      }
    }
    var bearMove = data[i - 3].close - data[i].close;
    if (bearMove >= minMove) {
      for (var j = i - 1; j >= Math.max(0, i - 5); j--) {
        var b = data[j];
        if (b.close > b.open) {
          var violated = false;
          for (var k = i + 1; k < n; k++) { if (data[k].high >= b.high) { violated = true; break; } }
          if (violated && Math.abs(close - b.low) <= atrLast * 7) {
            breakers.push({ type: 'bull_breaker', high: parseFloat(b.high.toFixed(1)), low: parseFloat(b.low.toFixed(1)), date: b.date,
              desc: 'Failed Bear OB → Bullish Breaker (support) at ' + b.low.toFixed(1) + '–' + b.high.toFixed(1) });
          }
          break;
        }
      }
    }
  }

  var seen = {};
  return breakers.filter(function(br) {
    var key = br.type + '|' + br.date + '|' + br.low;
    if (seen[key]) return false; seen[key] = true; return true;
  }).reverse().slice(0, 4);
}

function getDealingRange(data, swings) {
  if (!swings.highs.length || !swings.lows.length) return null;
  var close = data[data.length - 1].close;
  var hi = swings.highs.reduce(function(a, b){ return b.price > a.price ? b : a; });
  var lo = swings.lows.reduce(function(a, b){ return b.price < a.price ? b : a; });
  var range = hi.price - lo.price;
  if (range <= 0) return null;
  var pct = (close - lo.price) / range * 100;
  return {
    high: parseFloat(hi.price.toFixed(1)), low: parseFloat(lo.price.toFixed(1)),
    eq:   parseFloat(((hi.price + lo.price) / 2).toFixed(1)),
    pct:  Math.round(pct),
    zone: pct >= 70 ? 'PREMIUM — sell bias' : pct <= 30 ? 'DISCOUNT — buy bias' : pct >= 50 ? 'Above EQ · neutral sell' : 'Below EQ · neutral buy',
    col:  pct >= 70 ? 'var(--red)' : pct <= 30 ? 'var(--green)' : 'var(--gold)',
  };
}

var _ictEntries = [];

function renderICTSection(data, emas, zones, atr, fib, amd) {
  var el = document.getElementById('anaICT');
  if (!el) return;

  var n       = data.length;
  var close   = data[n - 1].close;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var swings  = findSwings(data.slice(-100), 5);

  var kz      = getCurrentKillZone();
  var bos     = detectBOS_CHoCH(data, swings, atr);
  var ote     = detectOTEEntry(data, fib, atr);
  var breakers = detectBreakerBlocks(data, atr);
  var dr      = getDealingRange(data, swings);

  // Update kill zone badge in card header
  var kzBadge = document.getElementById('ictKillZoneBadge');
  if (kzBadge) {
    kzBadge.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:3px;background:' +
      (kz.active ? kz.col + '22' : 'transparent') + ';border:1px solid ' + kz.col + '55">' +
      '<span style="width:6px;height:6px;border-radius:50%;background:' + kz.col + (kz.active ? ';box-shadow:0 0 4px ' + kz.col : '') + '"></span>' +
      '<span style="color:' + kz.col + ';font-weight:700">' + kz.name + '</span>' +
    '</span>';
  }

  // ── Kill Zone banner ──────────────────────────────────────────────────────
  var kzHtml = '<div class="ict-kz-banner" style="background:' + kz.col + '11;border:1px solid ' + kz.col + '33">' +
    '<div class="ict-kz-dot' + (kz.active ? ' active' : '') + '" style="background:' + kz.col + (kz.active ? ';box-shadow:0 0 6px ' + kz.col : '') + '"></div>' +
    '<div><div class="ict-kz-name" style="color:' + kz.col + '">' + kz.name + (kz.active ? ' ACTIVE' : ' — next') + '</div>' +
    '<div class="ict-kz-sub">' + kz.sub + '</div></div>' +
  '</div>';

  // ── Dealing Range ─────────────────────────────────────────────────────────
  var drHtml = '';
  if (dr) {
    var pctClamped = Math.max(0, Math.min(100, dr.pct));
    drHtml = '<div class="ict-section-head">Dealing Range</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px">' +
        '<span style="color:var(--green)">' + dr.low + '</span>' +
        '<span style="color:var(--muted)">EQ ' + dr.eq + '</span>' +
        '<span style="color:var(--red)">' + dr.high + '</span>' +
      '</div>' +
      '<div class="ict-dr-bar">' +
        '<div class="ict-dr-fill-disc" style="width:30%"></div>' +
        '<div class="ict-dr-fill-prem" style="width:30%"></div>' +
        '<div class="ict-dr-eq"></div>' +
        '<div class="ict-dr-cursor" style="left:' + pctClamped + '%"></div>' +
      '</div>' +
      '<div style="font-size:10px;color:' + dr.col + ';font-weight:700;margin-top:3px">' + dr.zone + ' (' + dr.pct + '%)</div>';
  }

  // ── Market Structure ──────────────────────────────────────────────────────
  var structHtml = '<div class="ict-section-head" style="margin-top:10px">Market Structure</div>';
  if (!bos.length) {
    structHtml += '<div style="color:var(--dim);font-size:10px">No BOS/CHoCH in last 100 bars</div>';
  } else {
    structHtml += bos.map(function(b) {
      var col = b.dir === 'bull' ? 'var(--green)' : 'var(--red)';
      var bg  = b.dir === 'bull' ? 'rgba(14,203,138,.1)' : 'rgba(246,79,87,.1)';
      return '<div class="ict-struct-row">' +
        '<span class="ict-struct-badge" style="background:' + bg + ';color:' + col + ';border:1px solid ' + col + '55">' + b.struct + '</span>' +
        '<span style="font-size:11px;color:' + col + ';font-weight:600">' + b.label + '</span>' +
      '</div>' +
      '<div style="font-size:9px;color:var(--muted);padding:2px 0 6px 52px">' + b.desc + '</div>';
    }).join('');
  }

  // ── Breaker Blocks ────────────────────────────────────────────────────────
  var bkHtml = '<div class="ict-section-head" style="margin-top:10px">Breaker Blocks</div>';
  if (!breakers.length) {
    bkHtml += '<div style="color:var(--dim);font-size:10px">No active breaker blocks near price</div>';
  } else {
    bkHtml += breakers.map(function(b) {
      var col = b.type === 'bull_breaker' ? 'var(--green)' : 'var(--red)';
      var lbl = b.type === 'bull_breaker' ? '▲ Bull Breaker' : '▼ Bear Breaker';
      return '<div class="ict-struct-row">' +
        '<span style="font-size:9px;font-weight:700;color:' + col + ';min-width:80px">' + lbl + '</span>' +
        '<span style="font-size:11px;font-family:var(--num-font);color:' + col + '">' + b.low + ' – ' + b.high + '</span>' +
        '<span style="font-size:9px;color:var(--muted);margin-left:4px">' + b.date + '</span>' +
      '</div>';
    }).join('');
  }

  // ── ICT Entry setups ──────────────────────────────────────────────────────
  _ictEntries = [];
  var entriesHtml = '<div class="ict-section-head" style="margin-top:12px">ICT Entry Setups</div>';
  var entries = [];

  // OTE Entry
  if (ote) {
    entries.push({
      type: 'OTE Entry', icon: '◆', dir: ote.dir,
      entry: ote.entry, sl: ote.sl, tp1: ote.tp1, tp2: ote.tp2,
      desc: ote.desc + (kz.active ? ' · ✓ During ' + kz.name : ''),
      confidence: kz.active ? 88 : 72,
    });
  }

  // Breaker Block entries
  breakers.forEach(function(b) {
    var dir    = b.type === 'bull_breaker' ? 'buy' : 'sell';
    var entry  = dir === 'buy' ? b.high : b.low;
    var sl     = dir === 'buy' ? parseFloat((b.low - atrLast * 0.3).toFixed(1)) : parseFloat((b.high + atrLast * 0.3).toFixed(1));
    var risk   = Math.abs(entry - sl);
    entries.push({
      type: 'Breaker ' + (dir === 'buy' ? 'Long' : 'Short'), icon: '⬡', dir: dir,
      entry: parseFloat(entry.toFixed(1)), sl: sl,
      tp1: parseFloat((dir === 'buy' ? entry + risk * 2 : entry - risk * 2).toFixed(1)),
      tp2: parseFloat((dir === 'buy' ? entry + risk * 3.5 : entry - risk * 3.5).toFixed(1)),
      desc: b.desc + (kz.active ? ' · ✓ During ' + kz.name : ''),
      confidence: kz.active ? 78 : 62,
    });
  });

  // AMD-based ICT entry (if in manipulation phase)
  if (amd && amd.phase === 'MANIPULATION' && amd.manipLevel) {
    var dir = amd.dir;
    var entry = parseFloat(close.toFixed(1));
    var sl    = parseFloat((dir === 'up' ? amd.manipLevel - atrLast * 0.5 : amd.manipLevel + atrLast * 0.5).toFixed(1));
    entries.push({
      type: 'Judas Swing / AMD', icon: '◈', dir: dir === 'up' ? 'buy' : 'sell',
      entry: entry, sl: sl,
      tp1: parseFloat(amd.accumHigh.toFixed(1)),
      tp2: parseFloat((dir === 'up' ? amd.accumHigh + (amd.accumHigh - amd.accumLow) * 0.5 : amd.accumLow - (amd.accumHigh - amd.accumLow) * 0.5).toFixed(1)),
      desc: 'Judas Swing: false move to ' + amd.manipLevel.toFixed(1) + ' took liquidity. Real move expected ' + (dir === 'up' ? 'higher' : 'lower') + '.',
      confidence: kz.active ? 85 : 70,
    });
  }

  if (!entries.length) {
    entriesHtml += '<div style="color:var(--dim);font-size:10px">No ICT setups active — load H1/H4 data and wait for kill zone alignment</div>';
  } else {
    _ictEntries = entries;
    entriesHtml += entries.map(function(e, idx) {
      var col    = e.dir === 'buy' ? 'var(--green)' : 'var(--red)';
      var dirLbl = e.dir === 'buy' ? '▲ LONG' : '▼ SHORT';
      var risk   = Math.abs(e.entry - e.sl);
      var rw1    = risk > 0 ? (Math.abs(e.tp1 - e.entry) / risk).toFixed(1) : '—';
      var rw2    = risk > 0 ? (Math.abs(e.tp2 - e.entry) / risk).toFixed(1) : '—';
      var cCol   = e.confidence >= 80 ? 'var(--green)' : e.confidence >= 65 ? 'var(--gold)' : 'var(--muted)';
      var mlProb = predictSignalWinProb({ dir: e.dir, symbol: ANA_ACTIVE_SYMBOL, time: new Date().toISOString(), entry: e.entry, sl: e.sl, tp: e.tp1 });
      var mlBadge = mlProb !== null ? ' <span style="font-size:9px;color:' + (mlProb>=65?'var(--green)':mlProb>=45?'var(--gold)':'var(--red)') + '">ML ' + mlProb + '%</span>' : '';
      return '<div class="ict-entry-card">' +
        '<div class="ict-entry-head">' +
          '<span class="ict-entry-type">' + e.icon + ' ' + e.type + '</span>' +
          '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;color:' + col + ';border:1px solid ' + col + '55">' + dirLbl + '</span>' +
          '<span style="font-size:10px;color:' + cCol + '">' + e.confidence + '%' + '</span>' +
          mlBadge +
        '</div>' +
        '<div class="ict-entry-levels">' +
          '<div class="ict-level"><span class="ict-level-lbl">Entry</span><span class="ict-level-val">' + e.entry + '</span></div>' +
          '<div class="ict-level"><span class="ict-level-lbl">SL</span><span class="ict-level-val" style="color:var(--red)">' + e.sl + '</span></div>' +
          '<div class="ict-level"><span class="ict-level-lbl">TP1</span><span class="ict-level-val" style="color:var(--green)">' + e.tp1 + ' <small>1:' + rw1 + 'R</small></span></div>' +
          '<div class="ict-level"><span class="ict-level-lbl">TP2</span><span class="ict-level-val" style="color:var(--green)">' + e.tp2 + ' <small>1:' + rw2 + 'R</small></span></div>' +
        '</div>' +
        '<div class="ict-entry-desc">' + e.desc + '</div>' +
        '<button class="ict-send-btn" onclick="sendICTEntry(' + idx + ')">&#9654; Send to MT4 as Limit Order</button>' +
      '</div>';
    }).join('');
  }

  el.innerHTML = kzHtml +
    '<div class="ict-grid"><div>' + drHtml + '</div><div>' + structHtml + bkHtml + '</div></div>' +
    entriesHtml;
}

function sendICTEntry(idx) {
  var e = _ictEntries[idx];
  if (!e) return;
  var lotSize   = parseFloat((document.getElementById('swingLotSize')  || {}).value) || 0.02;
  var positions = parseInt((document.getElementById('swingPositions')  || {}).value) || 1;
  var sig = {
    id:          Date.now() + Math.floor(Math.random() * 100),
    time:        new Date().toISOString(),
    symbol:      ANA_ACTIVE_SYMBOL || 'XAUUSD',
    dir:         e.dir,
    entry:       e.entry,
    sl:          e.sl,
    tp:          e.tp1,
    lot:         parseFloat((lotSize * positions).toFixed(2)),
    orderType:   'PENDING',
    basis:       'ICT — ' + e.type,
    note:        e.desc,
    status:      'LIVE',
    confluences: {},
    confRequired: 0,
    mt4Status:   null,
    mlFeatures:  extractMLFeatures(e.dir),
  };
  var sigs = loadSigLog();
  sigs.push(sig);
  saveSigLog(sigs);
  sendSignalToMT4(sig.id);
  showBotToast('✓ ICT ' + e.type + ' sent to MT4 · ' + e.dir.toUpperCase() + ' @ ' + e.entry, 'ok');
  renderSigLog();
}

// ── ML Signal Model (Naive Bayes) ─────────────────────────────────────────────
var ML_KEY = 'wayne_ml_v1';

function getMLModel() {
  try { var r = localStorage.getItem(ML_KEY); if (r) return JSON.parse(r); } catch(e) {}
  return { total: 0, wins: 0, feats: {} };
}

function saveMLModel(m) {
  try { localStorage.setItem(ML_KEY, JSON.stringify(m)); } catch(e) {}
}

// Capture current market state as a flat feature map
function extractMLFeatures(dir) {
  var f = {};
  if (!ANA) return f;

  // Direction of the trade
  f.dir = dir || '?';

  // Trend
  if (ANA.trend) {
    f.trend     = ANA.trend.direction;                                // e.g. STRONG BULL
    f.structure = ANA.trend.structure.split(' ')[0];                  // HH, LH, etc.
    f.regime    = ANA.trend.regime;                                   // TRENDING / RANGING
  }

  // RSI bucket
  var rsiArr = ANA.rsi.filter(function(v){ return v; });
  var rsiVal = rsiArr[rsiArr.length - 1] || 50;
  f.rsi = rsiVal > 70 ? 'overbought' : rsiVal < 30 ? 'oversold' : rsiVal > 55 ? 'high' : rsiVal < 45 ? 'low' : 'neutral';

  // AMD phase + direction
  if (ANA.amd) {
    f.amd_phase = ANA.amd.phase;
    f.amd_dir   = ANA.amd.dir || 'none';
  }

  // Session (UTC hour)
  var h = new Date().getUTCHours();
  f.session = h >= 13 && h < 17 ? 'overlap' : h >= 13 && h < 22 ? 'ny' : h >= 7 && h < 13 ? 'london' : 'asian';

  // Day of week (Mon-Fri, Sat/Sun)
  var dow = ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
  f.dow = dow;

  // Timeframe
  f.tf = ANA_INTERVAL;

  // Symbol
  f.symbol = (ANA_ACTIVE_SYMBOL || 'XAUUSD').toUpperCase();

  // Trade direction vs trend alignment
  if (dir && ANA.trend) {
    var isBull = ANA.trend.total > 0;
    var isBear = ANA.trend.total < 0;
    f.trend_align = (dir === 'buy' && isBull) || (dir === 'sell' && isBear) ? 'with' : 'against';
  }

  return f;
}

// Train model on one closed trade
function trainMLModel(mlFeatures, outcome) {
  if (!mlFeatures || !outcome) return;
  var isWin = outcome === 'WIN', isLoss = outcome === 'LOSS';
  if (!isWin && !isLoss) return; // skip BE / CANCEL

  var m = getMLModel();
  m.total = (m.total || 0) + 1;
  if (isWin) m.wins = (m.wins || 0) + 1;
  m.updated = new Date().toISOString();
  if (!m.feats) m.feats = {};

  Object.keys(mlFeatures).forEach(function(k) {
    var v = String(mlFeatures[k]);
    if (!m.feats[k])    m.feats[k]    = {};
    if (!m.feats[k][v]) m.feats[k][v] = { w: 0, l: 0 };
    if (isWin)  m.feats[k][v].w++;
    else        m.feats[k][v].l++;
  });

  saveMLModel(m);
  renderMLPanel();
}

// Predict win probability for a feature set — returns 0-100 or null if < 5 samples
function predictWinProb(mlFeatures) {
  var m = getMLModel();
  if (!m.total || m.total < 5) return null;

  var base = (m.wins || 0) / m.total;
  // Log-odds form of Naive Bayes (avoids underflow)
  var logOdds = Math.log((base + 0.01) / (1 - base + 0.01));

  Object.keys(mlFeatures).forEach(function(k) {
    var v   = String(mlFeatures[k]);
    var fkv = m.feats && m.feats[k] && m.feats[k][v];
    if (!fkv) return;
    var tot = fkv.w + fkv.l;
    if (tot < 2) return; // need at least 2 obs per feature value
    var p   = (fkv.w + 0.5) / (tot + 1);      // Laplace smoothed
    var bf  = Math.log((p + 0.001) / (1 - p + 0.001)) -
              Math.log((base + 0.01) / (1 - base + 0.01)); // Bayes factor vs base
    logOdds += bf;
  });

  var prob = 1 / (1 + Math.exp(-logOdds));
  return Math.round(prob * 100);
}

// Feature-level insight — which features push toward win or loss
function getMLFactors(mlFeatures) {
  var m = getMLModel();
  if (!m.total || m.total < 5) return [];
  var base = (m.wins || 0) / m.total;
  var factors = [];

  Object.keys(mlFeatures).forEach(function(k) {
    var v   = String(mlFeatures[k]);
    var fkv = m.feats && m.feats[k] && m.feats[k][v];
    if (!fkv) return;
    var tot = fkv.w + fkv.l;
    if (tot < 2) return;
    var p   = (fkv.w + 0.5) / (tot + 1);
    var edge = (p - base) * 100; // % above or below base win rate
    factors.push({ key: k, val: v, edge: edge, obs: tot });
  });

  return factors.sort(function(a, b){ return Math.abs(b.edge) - Math.abs(a.edge); }).slice(0, 8);
}

function renderMLPanel() {
  var el = document.getElementById('anaMLPanel');
  if (!el) return;

  var m     = getMLModel();
  var badge = document.getElementById('mlModelBadge');
  if (badge) badge.textContent = (m.total || 0) + ' trade' + (m.total !== 1 ? 's' : '') + ' · ' + Math.round((m.wins||0)/(m.total||1)*100) + '% WR';

  if (!m.total || m.total < 5) {
    el.innerHTML = '<div style="color:var(--dim);font-size:11px;padding:4px 0">' +
      (m.total > 0
        ? m.total + ' sample' + (m.total > 1 ? 's' : '') + ' collected — need ' + (5 - m.total) + ' more to activate predictions.'
        : 'No training data yet. Load your statement and click <strong>Train from Statement</strong>, or mark trades WIN/LOSS in the signal log.') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button class="ml-reset-btn" onclick="trainMLFromStatement()" style="color:var(--cyan);border-color:rgba(0,229,255,.3)">&#9650; Train from Statement</button>' +
        (m.total ? '<button class="ml-reset-btn" onclick="resetMLModel()">Reset</button>' : '') +
      '</div>';
    return;
  }

  var features = ANA ? extractMLFeatures(null) : {};
  var prob     = predictWinProb(features);
  var factors  = getMLFactors(features);
  var winRate  = Math.round((m.wins || 0) / m.total * 100);

  var probCol   = prob >= 65 ? 'var(--green)' : prob >= 45 ? 'var(--gold)' : 'var(--red)';
  var probLabel = prob >= 65 ? 'FAVOURABLE' : prob >= 45 ? 'NEUTRAL' : 'UNFAVOURABLE';

  var factorHtml = factors.map(function(f) {
    var cls = f.edge > 5 ? 'ml-feat-chip-pos' : f.edge < -5 ? 'ml-feat-chip-neg' : 'ml-feat-chip-neu';
    var sign = f.edge > 0 ? '+' : '';
    return '<span class="ml-feat-chip ' + cls + '" title="' + f.obs + ' observations">' +
      f.key + ': ' + f.val + ' (' + sign + f.edge.toFixed(0) + '%)' +
    '</span>';
  }).join('');

  el.innerHTML =
    '<div class="ml-top">' +
      '<div class="ml-prob-dial">' +
        '<div class="ml-prob-pct" style="color:' + probCol + '">' + (prob !== null ? prob + '%' : '—') + '</div>' +
        '<div class="ml-prob-label" style="color:' + probCol + '">' + (prob !== null ? probLabel : '') + '</div>' +
      '</div>' +
      '<div class="ml-stats-grid">' +
        '<div class="ml-stat"><span class="ml-stat-lbl">Trades</span><span class="ml-stat-val">' + m.total + '</span></div>' +
        '<div class="ml-stat"><span class="ml-stat-lbl">Win rate</span><span class="ml-stat-val" style="color:' + (winRate >= 50 ? 'var(--green)' : 'var(--red)') + '">' + winRate + '%</span></div>' +
        '<div class="ml-stat"><span class="ml-stat-lbl">Features</span><span class="ml-stat-val">' + Object.keys(m.feats || {}).length + '</span></div>' +
      '</div>' +
    '</div>' +
    '<div class="ml-bar-wrap"><div class="ml-bar-fill" style="width:' + (prob || 50) + '%;background:' + probCol + '"></div></div>' +
    '<div class="ml-features-wrap">' +
      '<div class="ml-feat-head">Factor analysis — current conditions</div>' +
      '<div class="ml-feat-chips">' + (factorHtml || '<span style="color:var(--dim);font-size:10px">No strong factors detected yet — need more trades</span>') + '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="ml-reset-btn" onclick="trainMLFromStatement()" style="color:var(--cyan);border-color:rgba(0,229,255,.3)">&#9650; Train from Statement</button>' +
      '<button class="ml-reset-btn" onclick="resetMLModel()">Reset model</button>' +
    '</div>';
}

function resetMLModel() {
  if (!confirm('Reset ML model? All learned patterns will be cleared.')) return;
  localStorage.removeItem(ML_KEY);
  renderMLPanel();
}

// Extract ML features from a statement trade record
function extractFeaturesFromTrade(t) {
  var f = {};

  f.dir    = t.type || '?';                            // buy / sell
  f.symbol = (t.item || '').toUpperCase().split('.')[0] || '?'; // XAUUSD, US30 etc.

  // Session + day from open time
  var openD = t.openDate ? new Date(t.openDate) : null;
  if (openD) {
    var h    = openD.getUTCHours();
    f.session = h >= 13 && h < 17 ? 'overlap' : h >= 13 && h < 22 ? 'ny' : h >= 7 && h < 13 ? 'london' : 'asian';
    f.dow     = ['sun','mon','tue','wed','thu','fri','sat'][openD.getDay()];
  }

  // R:R bucket (from entry/SL/TP)
  if (t.openPrice && t.sl && t.tp && !isNaN(t.sl) && !isNaN(t.tp)) {
    var risk   = Math.abs(t.openPrice - t.sl);
    var reward = Math.abs(t.tp - t.openPrice);
    if (risk > 0) {
      var rr = reward / risk;
      f.rr = rr >= 3 ? '3R+' : rr >= 2 ? '2R' : rr >= 1.5 ? '1.5R' : '1R';
    }
  }

  // Hold time bucket
  if (t.openDate && t.closeDate) {
    var hrs = (new Date(t.closeDate) - new Date(t.openDate)) / 3600000;
    f.hold = hrs < 1 ? 'scalp' : hrs < 4 ? 'intraday' : hrs < 24 ? 'swing' : 'multiday';
  }

  // Whether stop was hit (bad placement / management signal)
  f.sl_hit = t.isSLHit ? 'yes' : 'no';

  return f;
}

// Train ML model from all loaded statement trades — bulk import
function trainMLFromStatement() {
  var trades = (typeof stmtTrades !== 'undefined' && Array.isArray(stmtTrades)) ? stmtTrades : [];

  if (!trades.length) {
    alert('No statement loaded. Go to Dashboard → Sync MT4 or Browse a statement file first.');
    return;
  }

  // Reset model before bulk import so statement is the clean base
  if (!confirm('This will reset the current model and retrain from ' + trades.length + ' statement trades. Continue?')) return;
  localStorage.removeItem(ML_KEY);

  var trained = 0;
  trades.forEach(function(t) {
    if (typeof t.isWin === 'undefined' || typeof t.profit === 'undefined') return;
    var features = extractFeaturesFromTrade(t);
    var outcome  = t.profit > 0 ? 'WIN' : 'LOSS';
    trainMLModel(features, outcome);
    trained++;
  });

  renderMLPanel();
  if (typeof showBotToast === 'function') {
    showBotToast('✓ Trained ML on ' + trained + ' statement trades', 'ok');
  }
}

// Predict win probability for any signal — uses stored features if available,
// falls back to partial features derivable from the signal record itself
function predictSignalWinProb(sig) {
  // Full features were captured at dispatch time (bot / swing signals)
  if (sig.mlFeatures && Object.keys(sig.mlFeatures).length > 3) {
    return predictWinProb(sig.mlFeatures);
  }
  // Partial features — derive from the signal record
  var f = {};
  f.dir    = sig.dir || '?';
  f.symbol = (sig.symbol || '').toUpperCase().split('.')[0] || '?';
  if (sig.time) {
    var d = new Date(sig.time);
    var h = d.getUTCHours();
    f.session = h >= 13 && h < 17 ? 'overlap' : h >= 13 && h < 22 ? 'ny' : h >= 7 && h < 13 ? 'london' : 'asian';
    f.dow     = ['sun','mon','tue','wed','thu','fri','sat'][d.getDay()];
  }
  if (sig.entry && sig.sl && sig.tp && !isNaN(sig.sl) && !isNaN(sig.tp)) {
    var risk = Math.abs(sig.entry - sig.sl), reward = Math.abs(sig.tp - sig.entry);
    if (risk > 0) {
      var rr = reward / risk;
      f.rr = rr >= 3 ? '3R+' : rr >= 2 ? '2R' : rr >= 1.5 ? '1.5R' : '1R';
    }
  }
  return predictWinProb(f);
}

// ── Signal table collapse ─────────────────────────────────────────────────────
var _sigTableOpen = true;
var _botLogOpen   = true;

function toggleSigTable() {
  _sigTableOpen = !_sigTableOpen;
  var wrap  = document.getElementById('sigTableCollapse');
  var arrow = document.getElementById('sigCollapseArrow');
  if (wrap)  wrap.style.maxHeight  = _sigTableOpen ? wrap.scrollHeight + 'px' : '0';
  if (arrow) arrow.classList.toggle('open', _sigTableOpen);
}

function toggleBotLog() {
  _botLogOpen = !_botLogOpen;
  var wrap = document.getElementById('botLogCollapse');
  var btn  = document.getElementById('botLogToggleBtn');
  if (wrap) wrap.style.display = _botLogOpen ? '' : 'none';
  if (btn)  btn.textContent    = (_botLogOpen ? '▼ Hide' : '▶ Show');
}

// Patch renderSigLog to also update the collapse summary bar
var _origRenderSigLog = null;
function patchSigLogWithCollapse() {
  if (_origRenderSigLog) return;
  var orig = renderSigLog;
  renderSigLog = function() {
    orig();
    updateSigCollapseBar();
  };
  _origRenderSigLog = orig;
}

function updateSigCollapseBar() {
  var sigs    = loadSigLog();
  var live    = sigs.filter(function(s){ return s.status === 'LIVE'; }).length;
  var pending = sigs.filter(function(s){ return s.status === 'PENDING'; }).length;
  var done    = sigs.filter(function(s){ return ['WIN','LOSS','BE','CANCEL'].indexOf(s.status) >= 0; }).length;

  var countEl  = document.getElementById('sigCollapseCount');
  var pillsEl  = document.getElementById('sigCollapsePills');
  var wrapEl   = document.getElementById('sigTableCollapse');

  if (countEl) countEl.textContent = sigs.length + ' signal' + (sigs.length !== 1 ? 's' : '');
  if (pillsEl) pillsEl.innerHTML =
    (live    ? '<span class="sig-cpill sig-cpill-live">'    + live    + ' live</span>'    : '') +
    (pending ? '<span class="sig-cpill sig-cpill-pending">' + pending + ' pending</span>' : '') +
    (done    ? '<span class="sig-cpill sig-cpill-done">'    + done    + ' done</span>'    : '');

  // Keep open state consistent
  if (wrapEl && _sigTableOpen) wrapEl.style.maxHeight = wrapEl.scrollHeight + 'px';
}

// ── Swing Trade Lab — detection ───────────────────────────────────────────────

function detectOrderBlocks(data, atr) {
  var n       = data.length;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var minMove = atrLast * 2.2;
  var close   = data[n - 1].close;
  var obs     = [];

  for (var i = 4; i < n; i++) {
    var bullMove = data[i].close - data[i - 3].close;
    var bearMove = data[i - 3].close - data[i].close;

    if (bullMove >= minMove) {
      for (var j = i - 1; j >= Math.max(0, i - 5); j--) {
        var b = data[j];
        if (b.close < b.open) {
          var mid = (b.high + b.low) / 2;
          var mitigated = false;
          for (var k = j + 1; k < n; k++) { if (data[k].low <= mid) { mitigated = true; break; } }
          if (!mitigated) obs.push({ type: 'bullish', high: parseFloat(b.high.toFixed(1)), low: parseFloat(b.low.toFixed(1)), mid: parseFloat(mid.toFixed(1)), date: b.date, barIdx: j });
          break;
        }
      }
    }

    if (bearMove >= minMove) {
      for (var j = i - 1; j >= Math.max(0, i - 5); j--) {
        var b = data[j];
        if (b.close > b.open) {
          var mid = (b.high + b.low) / 2;
          var mitigated = false;
          for (var k = j + 1; k < n; k++) { if (data[k].high >= mid) { mitigated = true; break; } }
          if (!mitigated) obs.push({ type: 'bearish', high: parseFloat(b.high.toFixed(1)), low: parseFloat(b.low.toFixed(1)), mid: parseFloat(mid.toFixed(1)), date: b.date, barIdx: j });
          break;
        }
      }
    }
  }

  // Deduplicate by date+type+low, filter to within 8 ATR of price, most recent first
  var seen = {};
  return obs.filter(function(ob) {
    var key = ob.type + '|' + ob.date + '|' + ob.low;
    if (seen[key]) return false; seen[key] = true;
    return Math.abs(close - ob.mid) <= atrLast * 10;
  }).reverse().slice(0, 6);
}

function calcSessionLevels(data) {
  var n       = data.length;
  var lastDate = data[n - 1].date;
  var byDate  = {};

  data.forEach(function(b) {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  });

  var dates    = Object.keys(byDate).sort();
  var todayIdx = dates.indexOf(lastDate);
  var levels   = [];

  function hiLo(bars) {
    return {
      hi: Math.max.apply(null, bars.map(function(b){ return b.high; })),
      lo: Math.min.apply(null, bars.map(function(b){ return b.low; })),
    };
  }

  if (todayIdx > 0) {
    var pd = hiLo(byDate[dates[todayIdx - 1]]);
    levels.push({ type: 'PDH', price: pd.hi, label: 'Prev Day High', color: '#f64f57' });
    levels.push({ type: 'PDL', price: pd.lo, label: 'Prev Day Low',  color: '#0ecb8a' });
  }

  if (todayIdx >= 5) {
    var wkDates = dates.slice(Math.max(0, todayIdx - 7), todayIdx);
    var wkBars  = wkDates.reduce(function(a, d){ return a.concat(byDate[d]); }, []);
    if (wkBars.length) {
      var pw = hiLo(wkBars);
      levels.push({ type: 'PWH', price: pw.hi, label: 'Prev Week High', color: 'rgba(246,79,87,.55)' });
      levels.push({ type: 'PWL', price: pw.lo, label: 'Prev Week Low',  color: 'rgba(14,203,138,.55)'  });
    }
  }

  return levels;
}

function detectEqualLevels(data, atr) {
  var atrLast  = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var tol      = atrLast * 0.22;
  var swings   = findSwings(data.slice(-80), 4);
  var close    = data[data.length - 1].close;
  var levels   = [];

  function findEquals(arr, side) {
    for (var i = 0; i < arr.length - 1; i++) {
      for (var j = i + 1; j < arr.length; j++) {
        if (Math.abs(arr[i].price - arr[j].price) <= tol) {
          var avg = (arr[i].price + arr[j].price) / 2;
          if (Math.abs(avg - close) / close <= 0.06) {
            levels.push({
              type:  side === 'high' ? 'equal_highs' : 'equal_lows',
              price: parseFloat(avg.toFixed(1)),
              label: side === 'high' ? 'Equal Highs — sell-side liq.' : 'Equal Lows — buy-side liq.',
              color: side === 'high' ? '#f64f57' : '#0ecb8a',
            });
          }
          break;
        }
      }
    }
  }

  findEquals(swings.highs, 'high');
  findEquals(swings.lows,  'low');
  return levels;
}

function detectWPattern(data, atrLast) {
  var swings = findSwings(data.slice(-100), 5);
  if (!swings.lows || swings.lows.length < 2) return null;

  var last2  = swings.lows.slice(-2);
  var l0 = last2[0], l1 = last2[1];
  var close  = data[data.length - 1].close;
  var diff   = Math.abs(l0.price - l1.price);

  if (diff > atrLast * 1.5) return null;

  var between  = data.slice(l0.index, l1.index + 1);
  if (!between.length) return null;
  var neckline = Math.max.apply(null, between.map(function(b){ return b.high; }));
  var bottom   = Math.min(l0.price, l1.price);
  if (close <= bottom) return null;

  var height   = neckline - bottom;
  var equalness = 1 - diff / (atrLast * 1.5);
  var aboveNeck = close >= neckline ? 15 : 0;
  var conf = Math.min(92, Math.round(58 + equalness * 24 + aboveNeck));

  return {
    l1Price: parseFloat(l0.price.toFixed(1)), l2Price: parseFloat(l1.price.toFixed(1)),
    neckline: parseFloat(neckline.toFixed(1)), bottom: parseFloat(bottom.toFixed(1)),
    confidence: conf,
    entry: parseFloat(neckline.toFixed(1)),
    sl:    parseFloat((bottom - atrLast * 0.5).toFixed(1)),
    tp1:   parseFloat((neckline + height).toFixed(1)),
    tp2:   parseFloat((neckline + height * 2).toFixed(1)),
    note:  'Double bottom ' + l0.price.toFixed(1) + ' / ' + l1.price.toFixed(1) + ' · neckline ' + neckline.toFixed(1),
  };
}

function detectSwingSetups(data, emas, zones, atr, fib, amd) {
  var setups  = [];
  var n       = data.length;
  var close   = data[n - 1].close;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var obs     = (ANA && ANA.obs) ? ANA.obs : [];

  // TP1 = fixed distance from entry (user-configured, default 50 pts)
  var tp1Dist = parseFloat((document.getElementById('swingTP1Dist') || {}).value) || 50;
  function tp1(entry, dir) {
    return parseFloat((dir === 'buy' ? entry + tp1Dist : entry - tp1Dist).toFixed(1));
  }

  // ── 1. W-Bottom ──────────────────────────────────────────────────────────
  var wp = detectWPattern(data, atrLast);
  if (wp) {
    setups.push({ type: 'W-Bottom', icon: '〓', dir: 'buy', confidence: wp.confidence,
      entry: wp.entry, sl: wp.sl,
      tp1: tp1(wp.entry, 'buy'),                          // +50 pts quick take
      tp2: wp.tp2,                                        // full W projection
      note: wp.note });
  }

  // ── 2. Order Block entries ────────────────────────────────────────────────
  obs.forEach(function(ob) {
    if (ob.type === 'bullish' && close > ob.high && Math.abs(close - ob.high) <= atrLast * 6) {
      var structTP = parseFloat((ob.high + Math.abs(ob.high - ob.low) * 4).toFixed(1));
      setups.push({ type: 'OB Long Entry', icon: '⬜', dir: 'buy', confidence: 72,
        entry: ob.high, sl: parseFloat((ob.low - atrLast * 0.3).toFixed(1)),
        tp1: tp1(ob.high, 'buy'), tp2: structTP,
        note: 'Bullish OB ' + ob.low + '–' + ob.high + ' from ' + ob.date + ' — buy the retest' });
    }
    if (ob.type === 'bearish' && close < ob.low && Math.abs(close - ob.low) <= atrLast * 6) {
      var structTP = parseFloat((ob.low - Math.abs(ob.high - ob.low) * 4).toFixed(1));
      setups.push({ type: 'OB Short Entry', icon: '⬛', dir: 'sell', confidence: 72,
        entry: ob.low, sl: parseFloat((ob.high + atrLast * 0.3).toFixed(1)),
        tp1: tp1(ob.low, 'sell'), tp2: structTP,
        note: 'Bearish OB ' + ob.low + '–' + ob.high + ' from ' + ob.date + ' — sell the retest' });
    }
  });

  // ── 3. AMD Liquidity Sweep entries ───────────────────────────────────────
  if (amd && amd.phase === 'MANIPULATION' && amd.manipLevel) {
    if (amd.dir === 'up') {
      setups.push({ type: 'Liquidity Sweep Long', icon: '◈', dir: 'buy', confidence: 82,
        entry: parseFloat(close.toFixed(1)),
        sl:    parseFloat((amd.manipLevel - atrLast * 0.5).toFixed(1)),
        tp1:   tp1(close, 'buy'),                         // realistic quick target
        tp2:   parseFloat(amd.accumHigh.toFixed(1)),      // range top = structure target
        note:  'AMD: swept lows at ' + amd.manipLevel.toFixed(1) + '. Range top ' + amd.accumHigh.toFixed(1) + ' is full target' });
    }
    if (amd.dir === 'down') {
      setups.push({ type: 'Liquidity Sweep Short', icon: '◈', dir: 'sell', confidence: 82,
        entry: parseFloat(close.toFixed(1)),
        sl:    parseFloat((amd.manipLevel + atrLast * 0.5).toFixed(1)),
        tp1:   tp1(close, 'sell'),
        tp2:   parseFloat(amd.accumLow.toFixed(1)),
        note:  'AMD: swept highs at ' + amd.manipLevel.toFixed(1) + '. Range bottom ' + amd.accumLow.toFixed(1) + ' is full target' });
    }
  }

  // ── 4. Fibonacci + S/R Confluence ────────────────────────────────────────
  if (fib && zones.length) {
    [0.382, 0.5, 0.618].forEach(function(ratio) {
      var lev = fib.levels.filter(function(l){ return l.ratio === ratio; })[0];
      if (!lev) return;
      if (Math.abs(close - lev.price) > atrLast * 2) return;
      var nearZ = zones.filter(function(z){ return Math.abs(z.price - lev.price) <= atrLast * 1.2; })[0];
      if (!nearZ) return;
      var dir  = fib.dir === 'retrace-down' ? 'buy' : 'sell';
      var conf = Math.min(88, 62 + nearZ.strength * 2.5);
      var structTP2 = parseFloat((dir === 'buy'
        ? fib.swingH.price
        : fib.swingL.price).toFixed(1));
      setups.push({
        type: 'Fib ' + (ratio * 100).toFixed(1) + '% + S/R', icon: '◆',
        dir: dir, confidence: Math.round(conf),
        entry: parseFloat(lev.price.toFixed(1)),
        sl:    parseFloat((dir === 'buy' ? lev.price - atrLast * 1.5 : lev.price + atrLast * 1.5).toFixed(1)),
        tp1:   tp1(lev.price, dir),                       // fixed pts
        tp2:   structTP2,                                 // full swing target
        note: 'Fib ' + (ratio * 100) + '% at ' + lev.price.toFixed(1) + ' + ' + nearZ.type + ' zone (' + nearZ.touches + ' touches)',
      });
    });
  }

  return setups.sort(function(a, b){ return b.confidence - a.confidence; });
}

var _swingSetups = [];

function renderSwingLab(setups, sessLevels, obs, eqLevels) {
  var el = document.getElementById('swingLabContent');
  if (!el) return;
  _swingSetups = setups;

  var symEl = document.getElementById('swingLabSymbol');
  if (symEl) symEl.textContent = (ANA_ACTIVE_SYMBOL || '') + ' · ' + ANA_INTERVAL;

  // Session levels
  var sessHtml = '';
  if (sessLevels.length) {
    var close = ANA ? ANA.data[ANA.data.length - 1].close : 0;
    sessHtml = '<div class="swing-section-head">Session Levels</div><div class="swing-sess-grid">' +
      sessLevels.map(function(l) {
        var d = (l.price - close).toFixed(1);
        return '<div class="swing-sess-row">' +
          '<span class="swing-sess-type" style="color:' + l.color + '">' + l.type + '</span>' +
          '<span class="swing-sess-price" style="color:' + l.color + '">' + l.price.toFixed(1) + '</span>' +
          '<span class="swing-sess-dist">' + (parseFloat(d) >= 0 ? '+' : '') + d + '</span>' +
        '</div>';
      }).join('') + '</div>';
  }

  // Equal levels
  var eqHtml = eqLevels.length ? '<div class="swing-section-head">Liquidity Clusters (Equal H/L)</div>' +
    eqLevels.map(function(l) {
      var close = ANA ? ANA.data[ANA.data.length - 1].close : 0;
      var d = (l.price - close).toFixed(1);
      return '<div class="swing-eq-row">' +
        '<span style="color:' + l.color + ';font-size:12px;font-weight:700;font-family:var(--num-font)">' + l.price.toFixed(1) + '</span>' +
        '<span style="color:var(--muted);font-size:10px;flex:1">' + l.label + '</span>' +
        '<span style="color:' + l.color + ';font-size:10px">' + (parseFloat(d) >= 0 ? '+' : '') + d + '</span>' +
      '</div>';
    }).join('') : '';

  // Order blocks
  var obHtml = obs.length ? '<div class="swing-section-head">Unmitigated Order Blocks</div>' +
    obs.map(function(ob) {
      var close = ANA ? ANA.data[ANA.data.length - 1].close : 0;
      var col = ob.type === 'bullish' ? 'var(--green)' : 'var(--red)';
      var lbl = ob.type === 'bullish' ? '▲ BULL OB' : '▼ BEAR OB';
      var d   = (ob.mid - close).toFixed(1);
      return '<div class="swing-ob-row">' +
        '<span class="swing-ob-type" style="color:' + col + '">' + lbl + '</span>' +
        '<span class="swing-ob-zone" style="color:' + col + '">' + ob.low + ' – ' + ob.high + '</span>' +
        '<span class="swing-ob-dist">' + (parseFloat(d) >= 0 ? '+' : '') + d + '</span>' +
        '<span class="swing-ob-date">' + ob.date + '</span>' +
      '</div>';
    }).join('') : '<div style="color:var(--dim);font-size:10px">No unmitigated OBs near price</div>';

  // Setups
  var setupsHtml = !setups.length
    ? '<div class="swing-empty">No high-probability setups detected. Switch to H1/H4 for swing context.</div>'
    : '<div class="swing-section-head">Detected Setups — send as limit order to MT4</div>' +
      setups.map(function(s, idx) {
        var col     = s.dir === 'buy' ? 'var(--green)' : 'var(--red)';
        var dirLbl  = s.dir === 'buy' ? '▲ LONG' : '▼ SHORT';
        var riskPts = Math.abs(s.entry - s.sl);
        var rw1     = riskPts > 0 ? (Math.abs(s.tp1 - s.entry) / riskPts).toFixed(1) : '—';
        var rw2     = riskPts > 0 ? (Math.abs(s.tp2 - s.entry) / riskPts).toFixed(1) : '—';
        var cCol    = s.confidence >= 80 ? 'var(--green)' : s.confidence >= 65 ? 'var(--gold)' : 'var(--muted)';
        // ML probability for this setup direction
        var mlFeats = extractMLFeatures(s.dir);
        var mlProb  = predictWinProb(mlFeats);
        var mlBadge = mlProb !== null
          ? ' <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(0,229,255,.08);color:' +
            (mlProb >= 60 ? 'var(--green)' : mlProb >= 45 ? 'var(--gold)' : 'var(--red)') +
            ';border:1px solid rgba(0,229,255,.2)">ML ' + mlProb + '%</span>'
          : '';
        return '<div class="swing-setup-card">' +
          '<div class="swing-setup-head">' +
            '<span class="swing-setup-type">' + s.icon + ' ' + s.type + '</span>' +
            '<span class="swing-dir-badge" style="color:' + col + ';border-color:' + col + '">' + dirLbl + '</span>' +
            '<span class="swing-conf" style="color:' + cCol + '">' + s.confidence + '% conf.</span>' +
            mlBadge +
          '</div>' +
          '<div class="swing-levels-row">' +
            '<div class="swing-level"><span class="swing-level-lbl">Entry (LMT)</span><span class="swing-level-val">' + s.entry + '</span></div>' +
            '<div class="swing-level"><span class="swing-level-lbl">Stop Loss</span><span class="swing-level-val red">' + s.sl + '</span></div>' +
            '<div class="swing-level"><span class="swing-level-lbl">TP 1</span><span class="swing-level-val green">' + s.tp1 + ' <small>1:' + rw1 + 'R</small></span></div>' +
            '<div class="swing-level"><span class="swing-level-lbl">TP 2</span><span class="swing-level-val green">' + s.tp2 + ' <small>1:' + rw2 + 'R</small></span></div>' +
          '</div>' +
          '<div class="swing-note">' + s.note + '</div>' +
          '<button class="swing-send-btn" onclick="sendSwingToMT4(' + idx + ')">' +
            '&#9654; Send to MT4 &mdash; ' + s.dir.toUpperCase() + ' ' + s.entry +
            ' &nbsp;|&nbsp; <span id="swingBtnLots_' + idx + '">…</span>' +
          '</button>' +
        '</div>';
      }).join('');

  el.innerHTML =
    '<div class="swing-grid"><div>' + sessHtml + eqHtml + '</div><div>' + obHtml + '</div></div>' +
    setupsHtml;

  // Populate button lot labels now that DOM is ready
  updateSwingTotalLots();
}

// Load a specific TF for swing analysis independently of the chart view
function rerunSwingLab(selectedTF) {
  var sym   = ANA_ACTIVE_SYMBOL || 'XAUUSD';
  var tf    = (selectedTF === 'auto' || !selectedTF) ? ANA_INTERVAL : selectedTF;
  var file  = sym + '_' + tf + '.csv';

  var symEl = document.getElementById('swingLabSymbol');
  if (symEl) symEl.textContent = sym + ' · ' + tf;

  // If already loaded, use cached data
  if (ANA_MULTI_LOADED[file] && ANA_MULTI_LOADED[file].length >= 30) {
    _runSwingOnData(ANA_MULTI_LOADED[file], tf);
    return;
  }

  var el = document.getElementById('swingLabContent');
  if (el) el.innerHTML = '<div class="swing-empty">Loading ' + file + '…</div>';

  fetch('data/gold/' + file + '?t=' + Date.now())
    .then(function(r) { return r.ok ? r.text() : Promise.reject('File not found: ' + file); })
    .then(function(txt) {
      var data = parseAnalysisCSV(txt);
      if (data.length < 30) throw new Error('Too few bars');
      ANA_MULTI_LOADED[file] = data;
      _runSwingOnData(data, tf);
    })
    .catch(function(err) {
      if (el) el.innerHTML = '<div class="swing-empty" style="color:var(--red)">' +
        'Could not load ' + file + '. Sync MT4 to get ' + sym + ' ' + tf + ' data.</div>';
    });
}

function _runSwingOnData(data, tf) {
  var closes = data.map(function(d){ return d.close; });
  var atr    = calcATR(data, 14);
  var emas   = { e20: calcEMA(closes,20), e50: calcEMA(closes,50), e200: calcEMA(closes,200) };
  var zones  = detectSRZones(data, atr);
  var fib    = calcFibLevels(data);
  var amd    = detectAMDPhase(data, atr);
  var obs    = detectOrderBlocks(data, atr);
  var sess   = calcSessionLevels(data);
  var eq     = detectEqualLevels(data, atr);
  var rsi    = calcRSI(closes, 14);

  // Temporarily expose obs on ANA so detectSwingSetups can access it
  var prevObs = ANA ? ANA.obs : [];
  if (ANA) ANA.obs = obs;

  var setups = detectSwingSetups(data, emas, zones, atr, fib, amd);
  renderSwingLab(setups, sess, obs, eq);

  if (ANA) ANA.obs = prevObs; // restore

  var symEl = document.getElementById('swingLabSymbol');
  if (symEl) symEl.textContent = (ANA_ACTIVE_SYMBOL || '') + ' · ' + tf + ' · ' + data.length + ' bars';
}

function updateSwingTotalLots() {
  var lot   = parseFloat((document.getElementById('swingLotSize')  || {}).value) || 0.02;
  var pos   = parseInt((document.getElementById('swingPositions')  || {}).value) || 1;
  var total = parseFloat((lot * pos).toFixed(2));
  var el    = document.getElementById('swingTotalLots');
  if (el) el.textContent = total + ' lots';

  // Update all send button lot labels
  _swingSetups.forEach(function(s, idx) {
    var btn = document.getElementById('swingBtnLots_' + idx);
    if (btn) btn.textContent = pos + ' × ' + lot + ' = ' + total + ' lots';
  });
}

function sendSwingToMT4(idx) {
  var s = _swingSetups[idx];
  if (!s) return;

  // Read config
  var lotSize   = parseFloat((document.getElementById('swingLotSize')  || {}).value) || 0.02;
  var positions = parseInt((document.getElementById('swingPositions')   || {}).value) || 1;
  var split     = ((document.getElementById('swingSplit') || {}).value) || 'single';
  var moveBE    = !!(document.getElementById('swingMoveBE') || {}).checked;

  // Build order slices based on TP split strategy
  var slices = []; // [{lots, tp}]

  if (split === 'single' || positions === 1) {
    slices.push({ lots: parseFloat((lotSize * positions).toFixed(2)), tp: s.tp1, tag: '' });

  } else if (split === 'split') {
    var n1 = Math.ceil(positions / 2), n2 = positions - n1;
    slices.push({ lots: parseFloat((lotSize * n1).toFixed(2)), tp: s.tp1, tag: '[1/2 → TP1]' });
    slices.push({ lots: parseFloat((lotSize * n2).toFixed(2)), tp: s.tp2, tag: '[2/2 → TP2]' });

  } else { // thirds
    var n1 = Math.ceil(positions / 3);
    var n2 = Math.ceil((positions - n1) / 2);
    var n3 = positions - n1 - n2;
    if (n1 > 0) slices.push({ lots: parseFloat((lotSize * n1).toFixed(2)), tp: s.tp1, tag: '[1/3 → TP1]' });
    if (n2 > 0) slices.push({ lots: parseFloat((lotSize * n2).toFixed(2)), tp: s.tp2, tag: '[2/3 → TP2]' });
    if (n3 > 0) slices.push({ lots: parseFloat((lotSize * n3).toFixed(2)), tp: s.tp2, tag: '[3/3 → TP2]' });
  }

  var beNote  = moveBE ? ' | Move SL to B/E when TP1 hit' : '';
  var total   = 0;

  slices.forEach(function(sl, i) {
    setTimeout(function() {
      var sig = {
        id:          Date.now() + i * 137 + Math.floor(Math.random() * 100),
        time:        new Date().toISOString(),
        symbol:      ANA_ACTIVE_SYMBOL || 'XAUUSD',
        dir:         s.dir,
        entry:       s.entry,
        sl:          s.sl,
        tp:          sl.tp,
        lot:         sl.lots,
        orderType:   'PENDING',
        basis:       'Swing Lab — ' + s.type + ' ' + sl.tag,
        note:        s.note + beNote,
        status:      'LIVE',
        confluences: {},
        confRequired: 0,
        mt4Status:   null,
        mlFeatures:  extractMLFeatures(s.dir),
      };
      var sigs = loadSigLog();
      sigs.push(sig);
      saveSigLog(sigs);
      sendSignalToMT4(sig.id);
      total++;
      if (total === slices.length) {
        showBotToast('✓ ' + slices.length + ' order' + (slices.length > 1 ? 's' : '') + ' sent to MT4 — ' + s.dir.toUpperCase() + ' ' + s.type, 'ok');
        renderSigLog();
      }
    }, i * 250); // small gap between orders so EA processes each
  });
}

// ── Market Insights ───────────────────────────────────────────────────────────

function calcConfluenceZones(data, emas, zones, fib, atr) {
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var close   = data[data.length - 1].close;
  var tol     = atrLast * 1.3;

  return zones
    .filter(function(z){ return Math.abs(z.distPct) <= 6; })
    .map(function(z) {
      var tags  = [];
      var score = z.strength;

      // S/R tag
      var srLabel = z.type === 'resistance' ? 'RES' : z.type === 'support' ? 'SUP' : 'S/R';
      tags.push({ txt: srLabel + ' ' + z.touches + 'T', cls: 'ins-conf-tag-sr' });

      // EMA proximity
      [{ k: 'e20', l: 'EMA20' }, { k: 'e50', l: 'EMA50' }, { k: 'e200', l: 'EMA200' }].forEach(function(e) {
        var arr = emas[e.k];
        var v   = arr ? arr[arr.length - 1] : null;
        if (v && Math.abs(v - z.price) <= tol) {
          tags.push({ txt: e.l, cls: 'ins-conf-tag-ema' });
          score += 3;
        }
      });

      // Fibonacci proximity
      if (fib) {
        fib.levels.forEach(function(l) {
          if (Math.abs(l.price - z.price) <= tol) {
            tags.push({ txt: 'Fib ' + l.label, cls: 'ins-conf-tag-fib' });
            score += 2;
          }
        });
      }

      // Round number
      var step = close < 2000 ? 25 : 50;
      var mod  = z.price % step;
      if (mod < atrLast * 0.35 || (step - mod) < atrLast * 0.35) {
        tags.push({ txt: 'Round', cls: 'ins-conf-tag-rnd' });
        score += 1.5;
      }

      // AMD level match
      if (ANA && ANA.amd) {
        var amd = ANA.amd;
        if (amd.accumHigh && Math.abs(amd.accumHigh - z.price) <= tol) tags.push({ txt: 'AMD H', cls: 'ins-conf-tag-fib' });
        if (amd.accumLow  && Math.abs(amd.accumLow  - z.price) <= tol) tags.push({ txt: 'AMD L', cls: 'ins-conf-tag-fib' });
      }

      return {
        price:   z.price,
        type:    z.type,
        dir:     z.price < close ? 'buy' : 'sell',
        tags:    tags,
        score:   Math.round(score * 10) / 10,
        distPct: z.distPct,
        touches: z.touches,
      };
    })
    .sort(function(a, b){ return b.score - a.score; })
    .slice(0, 6);
}

function detectFVGs(data, atr) {
  var atrLast  = atr.filter(function(v){ return v; }).slice(-1)[0] || 1;
  var minGap   = atrLast * 0.12;
  var close    = data[data.length - 1].close;
  var fvgs     = [];
  var lookback = Math.min(data.length, 60);

  for (var i = data.length - lookback + 2; i < data.length; i++) {
    var c0 = data[i - 2], c2 = data[i];
    // Bullish FVG: gap between c0.high and c2.low (price ran up through a gap)
    if (c2.low > c0.high + minGap) {
      fvgs.push({ type: 'bullish', top: c2.low, bottom: c0.high,
        mid: (c2.low + c0.high) / 2, date: c2.date, barIdx: i,
        filled: close <= c2.low });
    }
    // Bearish FVG: gap between c2.high and c0.low
    if (c2.high < c0.low - minGap) {
      fvgs.push({ type: 'bearish', top: c0.low, bottom: c2.high,
        mid: (c0.low + c2.high) / 2, date: c2.date, barIdx: i,
        filled: close >= c2.high });
    }
  }
  // Return unfilled FVGs, most recent first
  return fvgs.filter(function(f){ return !f.filled; }).reverse().slice(0, 5);
}

function calcKeyRanges(data) {
  var close = data[data.length - 1].close;
  function snap(bars) {
    if (!bars.length) return null;
    var hi  = Math.max.apply(null, bars.map(function(b){ return b.high; }));
    var lo  = Math.min.apply(null, bars.map(function(b){ return b.low; }));
    var rng = hi - lo || 1;
    var pct = Math.round((close - lo) / rng * 100);
    return { high: hi, low: lo, mid: (hi + lo) / 2, pct: pct, range: rng };
  }
  var today = data.filter(function(d){ return d.date === data[data.length-1].date; });
  return {
    r20:   snap(data.slice(-20)),
    r50:   snap(data.slice(-50)),
    r100:  snap(data.slice(-100)),
    today: snap(today),
  };
}

function calcBias(trend, rsi, amd, ranges, close) {
  var score = 0;
  var factors = [];

  // Trend score (-3 to +3)
  score += trend.total;
  if (trend.total > 0) factors.push('Trend ' + trend.direction);
  else if (trend.total < 0) factors.push('Trend ' + trend.direction);

  // RSI
  var rsiVal = rsi.filter(function(v){ return v; }).slice(-1)[0] || 50;
  if (rsiVal < 35)      { score += 1.5; factors.push('RSI oversold ' + rsiVal.toFixed(0)); }
  else if (rsiVal > 65) { score -= 1.5; factors.push('RSI overbought ' + rsiVal.toFixed(0)); }

  // AMD
  if (amd) {
    if ((amd.phase === 'DELIVERY' || amd.phase === 'MANIPULATION') && amd.dir === 'up')   { score += 2; factors.push('AMD bullish phase'); }
    if ((amd.phase === 'DELIVERY' || amd.phase === 'MANIPULATION') && amd.dir === 'down') { score -= 2; factors.push('AMD bearish phase'); }
  }

  // Price vs 50-bar range (premium/discount)
  if (ranges.r50) {
    var pct = ranges.r50.pct;
    if (pct <= 25)       { score += 1; factors.push('Deep discount (' + pct + '% of 50-bar range)'); }
    else if (pct <= 45)  { score += 0.5; factors.push('Discount zone (' + pct + '%)'); }
    else if (pct >= 75)  { score -= 1; factors.push('Deep premium (' + pct + '% of 50-bar range)'); }
    else if (pct >= 55)  { score -= 0.5; factors.push('Premium zone (' + pct + '%)'); }
  }

  var dir, grade, col;
  if      (score >= 4)  { dir = 'STRONG BUY';  grade = '▲▲'; col = 'var(--green)'; }
  else if (score >= 2)  { dir = 'BUY BIAS';    grade = '▲';  col = 'var(--green)'; }
  else if (score >= 0.5){ dir = 'WEAK BULL';   grade = '△';  col = '#6ecf8a'; }
  else if (score <= -4) { dir = 'STRONG SELL'; grade = '▼▼'; col = 'var(--red)'; }
  else if (score <= -2) { dir = 'SELL BIAS';   grade = '▼';  col = 'var(--red)'; }
  else if (score <= -0.5){ dir = 'WEAK BEAR';  grade = '▽';  col = '#e07070'; }
  else                  { dir = 'NEUTRAL';     grade = '—';  col = 'var(--gold)'; }

  return { dir: dir, grade: grade, col: col, score: score, factors: factors };
}

function renderInsights(data, emas, zones, fib, atr, trend, rsi, amd) {
  var el = document.getElementById('anaInsights');
  if (!el) return;

  var close   = data[data.length - 1].close;
  var conf    = calcConfluenceZones(data, emas, zones, fib, atr);
  var fvgs    = detectFVGs(data, atr);
  var ranges  = calcKeyRanges(data);
  var bias    = calcBias(trend, rsi, amd, ranges, close);

  // ── Bias banner ────────────────────────────────────────────────────────────
  var biasBg  = bias.score >= 2 ? 'rgba(14,203,138,.07)' : bias.score <= -2 ? 'rgba(246,79,87,.07)' : 'rgba(245,185,53,.06)';
  var biasHtml =
    '<div class="ins-bias" style="background:' + biasBg + ';border:1px solid ' + bias.col.replace('var(--green)','rgba(14,203,138,.3)').replace('var(--red)','rgba(246,79,87,.3)').replace('var(--gold)','rgba(245,185,53,.25)') + '">' +
      '<div class="ins-bias-grade" style="color:' + bias.col + '">' + bias.grade + '</div>' +
      '<div class="ins-bias-right">' +
        '<div class="ins-bias-label" style="color:' + bias.col + '">' + bias.dir + '</div>' +
        '<div class="ins-bias-sub">' + bias.factors.join(' &middot; ') + '</div>' +
      '</div>' +
    '</div>';

  // ── Three-column grid ──────────────────────────────────────────────────────
  // Column 1: Confluence zones
  var confRows = conf.length ? conf.map(function(c) {
    var tagsHtml = c.tags.map(function(t){
      return '<span class="ins-conf-tag ' + t.cls + '">' + t.txt + '</span>';
    }).join('');
    var dirCls  = c.dir === 'buy' ? 'ins-conf-buy' : 'ins-conf-sell';
    var dirLbl  = c.dir === 'buy' ? '▲ BUY' : '▼ SELL';
    var dist    = (c.distPct >= 0 ? '+' : '') + c.distPct.toFixed(1) + '%';
    var priceCol = c.dir === 'buy' ? 'var(--green)' : 'var(--red)';
    return '<div class="ins-conf-row">' +
      '<div class="ins-conf-price" style="color:' + priceCol + '">' + c.price.toFixed(1) +
        '<div style="font-size:8px;color:var(--muted);font-weight:400">' + dist + '</div>' +
      '</div>' +
      '<div class="ins-conf-tags">' + tagsHtml + '</div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">' +
        '<span class="ins-conf-score" style="color:' + (c.score >= 12 ? 'var(--green)' : c.score >= 8 ? 'var(--gold)' : 'var(--muted)') + '">' + c.score + '</span>' +
        '<span class="ins-conf-dir ' + dirCls + '">' + dirLbl + '</span>' +
      '</div>' +
    '</div>';
  }).join('') : '<div style="color:var(--dim);font-size:11px">No high-confluence zones near price</div>';

  // Column 2: FVGs
  var fvgRows = fvgs.length ? fvgs.map(function(f) {
    var col  = f.type === 'bullish' ? 'var(--green)' : 'var(--red)';
    var lbl  = f.type === 'bullish' ? '▲ Bull FVG' : '▼ Bear FVG';
    var dist = (close - f.mid);
    var distStr = (dist >= 0 ? '+' : '') + dist.toFixed(1) + ' pts';
    return '<div class="ins-fvg-row">' +
      '<div style="display:flex;flex-direction:column;gap:1px">' +
        '<span style="font-size:8px;color:' + col + ';font-weight:700">' + lbl + '</span>' +
        '<span class="ins-fvg-zone" style="color:' + col + '">' + f.bottom.toFixed(1) + ' – ' + f.top.toFixed(1) + '</span>' +
      '</div>' +
      '<span class="ins-fvg-label">' + f.date + '</span>' +
      '<span class="ins-fvg-dist" style="color:' + col + '">' + distStr + '</span>' +
    '</div>';
  }).join('') : '<div style="color:var(--dim);font-size:11px">No unfilled FVGs in last 60 bars</div>';

  // Column 3: Key ranges with premium/discount bars
  function rangeBar(r, label) {
    if (!r) return '';
    var pctClamped = Math.max(0, Math.min(100, r.pct));
    var fillCol = pctClamped >= 70 ? '#f64f57' : pctClamped <= 30 ? '#0ecb8a' : '#f5b935';
    var zone = pctClamped >= 70 ? 'Premium' : pctClamped <= 30 ? 'Discount' : 'Mid-range';
    return '<div class="ins-range-row">' +
      '<div class="ins-range-head">' +
        '<span class="ins-range-lbl">' + label + ' range</span>' +
        '<span style="font-size:9px;color:' + fillCol + '">' + zone + ' (' + pctClamped + '%)</span>' +
      '</div>' +
      '<div class="ins-range-head">' +
        '<span class="ins-range-lo">' + r.low.toFixed(1) + '</span>' +
        '<span style="font-size:9px;color:var(--muted)">Mid ' + r.mid.toFixed(1) + '</span>' +
        '<span class="ins-range-hi">' + r.high.toFixed(1) + '</span>' +
      '</div>' +
      '<div class="ins-range-bar">' +
        '<div class="ins-range-fill" style="width:' + pctClamped + '%;background:' + fillCol + '22"></div>' +
        '<div class="ins-range-cursor" style="left:' + pctClamped + '%"></div>' +
      '</div>' +
      '<div class="ins-range-pct">Δ range: ' + r.range.toFixed(1) + ' pts</div>' +
    '</div>';
  }

  var rangesHtml =
    rangeBar(ranges.today, 'Today\'s') +
    rangeBar(ranges.r20,   '20-bar') +
    rangeBar(ranges.r50,   '50-bar') +
    rangeBar(ranges.r100,  '100-bar');

  el.innerHTML = biasHtml +
    '<div class="ins-grid">' +
      '<div>' +
        '<div class="ins-section-head">Confluence zones</div>' +
        confRows +
      '</div>' +
      '<div>' +
        '<div class="ins-section-head">Fair Value Gaps (unfilled)</div>' +
        fvgRows +
      '</div>' +
      '<div>' +
        '<div class="ins-section-head">Key ranges &amp; premium / discount</div>' +
        rangesHtml +
      '</div>' +
    '</div>';
}

// ── AMD Phase Detection ───────────────────────────────────────────────────────
function detectAMDPhase(data, atr) {
  if (!data || data.length < 15) return null;

  var n      = data.length;
  var winLen = Math.min(n, 120);   // look back up to 120 bars
  var wData  = data.slice(-winLen);
  var wn     = wData.length;

  // ── Find most recent quiet (accumulation) period — min 5 bars ────────────
  var ranges  = wData.map(function(b) { return b.high - b.low; });
  var sortedR = ranges.slice().sort(function(a, b) { return a - b; });
  var medRange = sortedR[Math.floor(sortedR.length / 2)];
  var quietThreshold = medRange * 0.75;
  var minQuietBars   = 5;   // lowered from 8 so M15/H1 can detect accum

  var accumStart = -1, accumEnd = -1, run = 0;
  for (var i = wn - 1; i >= 0; i--) {
    if (ranges[i] <= quietThreshold) {
      run++;
      if (run === 1) accumEnd = i;
      if (run >= minQuietBars) { accumStart = i; break; }
    } else {
      if (run > 0 && run < minQuietBars) { run = 0; accumEnd = -1; }
    }
  }
  if (accumStart < 0 && run >= 4) { accumStart = wn - run; } // 4-bar fallback
  if (accumStart < 0) return null;

  // ── Accumulation range ────────────────────────────────────────────────────
  var aSlice    = wData.slice(accumStart, (accumEnd >= 0 ? accumEnd : wn - 1) + 1);
  var accumHigh = Math.max.apply(null, aSlice.map(function(b) { return b.high; }));
  var accumLow  = Math.min.apply(null, aSlice.map(function(b) { return b.low; }));
  var accumMid  = (accumHigh + accumLow) / 2;

  var atrLast   = atr.filter(function(v) { return v; }).slice(-1)[0] || 1;
  var tol       = atrLast * 0.25;
  var effEnd    = accumEnd >= 0 ? accumEnd : wn - 1;
  var lastClose = wData[wn - 1].close;

  if (effEnd >= wn - 2) {
    return {
      phase: 'ACCUMULATION', dir: null,
      accumHigh: accumHigh, accumLow: accumLow, accumMid: accumMid,
      accumStartIdx: n - winLen + accumStart, accumEndIdx: n - winLen + effEnd,
      manipLevel: null,
      liquidityZones: [
        { price: accumHigh, label: 'Sell-side liquidity — stops above range', side: 'above' },
        { price: accumLow,  label: 'Buy-side liquidity — stops below range',  side: 'below' },
      ],
    };
  }

  var postData    = wData.slice(effEnd + 1);
  var postHigh    = Math.max.apply(null, postData.map(function(b) { return b.high; }));
  var postLow     = Math.min.apply(null, postData.map(function(b) { return b.low; }));
  var spikedAbove = postHigh > accumHigh + tol;
  var spikedBelow = postLow  < accumLow  - tol;
  var nowAbove    = lastClose > accumHigh + tol;
  var nowBelow    = lastClose < accumLow  - tol;
  var nowInRange  = !nowAbove && !nowBelow;

  var phase, dir, manipLevel, liquidityZones;

  if (spikedBelow && nowAbove) {
    phase = 'DELIVERY'; dir = 'up'; manipLevel = postLow;
    liquidityZones = [
      { price: postLow,   label: 'Manipulation low swept (buy-side liquidity taken)', side: 'below' },
      { price: accumHigh, label: 'Range top — delivery target / resistance',           side: 'above' },
    ];
  } else if (spikedAbove && nowBelow) {
    phase = 'DELIVERY'; dir = 'down'; manipLevel = postHigh;
    liquidityZones = [
      { price: postHigh,  label: 'Manipulation high swept (sell-side liquidity taken)', side: 'above' },
      { price: accumLow,  label: 'Range bottom — delivery target / support',             side: 'below' },
    ];
  } else if (spikedBelow && nowInRange) {
    phase = 'MANIPULATION'; dir = 'up'; manipLevel = postLow;
    liquidityZones = [
      { price: postLow,   label: 'Stop-hunt low — potential long zone', side: 'below' },
      { price: accumHigh, label: 'Upside target if delivery follows',   side: 'above' },
    ];
  } else if (spikedAbove && nowInRange) {
    phase = 'MANIPULATION'; dir = 'down'; manipLevel = postHigh;
    liquidityZones = [
      { price: postHigh,  label: 'Stop-hunt high — potential short zone', side: 'above' },
      { price: accumLow,  label: 'Downside target if delivery follows',    side: 'below' },
    ];
  } else if (nowAbove) {
    phase = 'DISTRIBUTION'; dir = 'up'; manipLevel = null;
    liquidityZones = [
      { price: accumHigh, label: 'Range top — now support (failed break = re-entry)', side: 'below' },
      { price: accumLow,  label: 'Range bottom — major support',                       side: 'below' },
    ];
  } else if (nowBelow) {
    phase = 'DISTRIBUTION'; dir = 'down'; manipLevel = null;
    liquidityZones = [
      { price: accumLow,  label: 'Range bottom — now resistance', side: 'above' },
      { price: accumHigh, label: 'Range top — major resistance',  side: 'above' },
    ];
  } else {
    phase = 'ACCUMULATION'; dir = null; manipLevel = null;
    liquidityZones = [
      { price: accumHigh, label: 'Sell-side liquidity above', side: 'above' },
      { price: accumLow,  label: 'Buy-side liquidity below',  side: 'below' },
    ];
  }

  return {
    phase: phase, dir: dir,
    accumHigh: accumHigh, accumLow: accumLow, accumMid: accumMid,
    accumStartIdx: n - winLen + accumStart, accumEndIdx: n - winLen + effEnd,
    manipLevel: manipLevel, liquidityZones: liquidityZones,
  };
}

function renderAMDPanel(amd) {
  var el = document.getElementById('anaAMD');
  if (!el) return;
  if (!amd) { el.innerHTML = '<div class="amd-empty">Insufficient bars for AMD detection</div>'; return; }

  var phCfg = {
    ACCUMULATION: { col: '#00e5ff', bg: 'rgba(0,229,255,.08)',  bdr: 'rgba(0,229,255,.25)'  },
    MANIPULATION: { col: '#f5b935', bg: 'rgba(245,185,53,.08)', bdr: 'rgba(245,185,53,.3)'  },
    DELIVERY:     { col: '#0ecb8a', bg: 'rgba(14,203,138,.08)', bdr: 'rgba(14,203,138,.3)'  },
    DISTRIBUTION: { col: '#0ecb8a', bg: 'rgba(14,203,138,.08)', bdr: 'rgba(14,203,138,.3)'  },
  };
  var c = phCfg[amd.phase] || phCfg.ACCUMULATION;
  var dirTag = !amd.dir ? '' : amd.dir === 'up' ? ' ▲ LONG' : ' ▼ SHORT';

  var phDesc = {
    ACCUMULATION: 'Price consolidating — smart money building positions. Stops resting above the high and below the low.',
    MANIPULATION: amd.dir === 'up'
      ? 'False sweep below range — buy-side liquidity taken. Bullish delivery expected: watch for reversal and rally through range.'
      : 'False spike above range — sell-side liquidity taken. Bearish delivery expected: watch for reversal and drop through range.',
    DELIVERY: amd.dir === 'up'
      ? 'Swept lows confirmed, now driving higher. Range top is the delivery target. Stay long until target or reversal.'
      : 'Swept highs confirmed, now driving lower. Range bottom is the delivery target. Stay short until target or reversal.',
    DISTRIBUTION: amd.dir === 'up'
      ? 'Bullish breakout — price above range without sweep. Possible direct distribution higher.'
      : 'Bearish breakdown — price below range. Possible direct distribution lower.',
  };

  var zonesHtml = (amd.liquidityZones || []).map(function(z) {
    var zc = z.side === 'above' ? 'var(--red)' : 'var(--green)';
    return '<div class="amd-zone-row">' +
      '<span class="amd-zone-price" style="color:' + zc + '">' + z.price.toFixed(1) + '</span>' +
      '<span class="amd-zone-label">' + z.label + '</span></div>';
  }).join('');

  el.innerHTML =
    '<div class="amd-phase-badge" style="background:' + c.bg + ';border:1px solid ' + c.bdr + ';color:' + c.col + '">' +
      amd.phase + dirTag + '</div>' +
    '<div class="amd-desc">' + (phDesc[amd.phase] || '') + '</div>' +
    '<div class="amd-range-row">' +
      '<span style="color:var(--muted)">Range</span>' +
      '<span style="color:var(--red)">' + amd.accumHigh.toFixed(1) + '</span>' +
      '<span style="color:var(--muted)">&#8596;</span>' +
      '<span style="color:var(--green)">' + amd.accumLow.toFixed(1) + '</span>' +
    '</div>' +
    (amd.manipLevel
      ? '<div class="amd-manip-row">Manip level: <strong style="color:var(--gold)">' + amd.manipLevel.toFixed(1) + '</strong></div>'
      : '') +
    (zonesHtml
      ? '<div class="amd-zones-head">AMD Liquidity Levels</div><div class="amd-zones">' + zonesHtml + '</div>'
      : '');
}

// ── Main Build ───────────────────────────────────────────────────────────────
function buildAnalysis(data) {
  var closes = data.map(function(d){ return d.close; });
  var atr    = calcATR(data, 14);
  var emas   = { e20: calcEMA(closes, 20), e50: calcEMA(closes, 50), e200: calcEMA(closes, 200) };
  var rsi    = calcRSI(closes, 14);
  var zones  = detectSRZones(data, atr);

  var amd  = detectAMDPhase(data, atr);
  var fvgs = detectFVGs(data, atr);
  var obs  = detectOrderBlocks(data, atr);
  ANA = { data: data, atr: atr, emas: emas, rsi: rsi, zones: zones, trend: null, amd: amd, fvgs: fvgs, obs: obs };

  var trend    = analyzeTrend(data, emas, atr);
  ANA.trend    = trend;

  var patterns = scanPatterns(data);
  var fib      = calcFibLevels(data);
  ANA.fib = fib;

  document.getElementById('anaContent').style.display = 'block';

  renderAnaKpis(data, atr, rsi, trend, zones);
  renderSRList(zones, data[data.length-1].close, atr.filter(function(v){ return v; }).slice(-1)[0]);
  renderAMDPanel(amd);
  renderTrendPanel(trend);
  renderPatterns(patterns);
  renderFib(fib, data[data.length-1].close);
  renderInsights(data, emas, zones, fib, atr, trend, rsi, amd);
  renderICTSection(data, emas, zones, atr, fib, amd);

  var sessLevels = calcSessionLevels(data);
  var eqLevels   = detectEqualLevels(data, atr);
  // Swing Lab: use its own TF selector (auto falls back to current chart data)
  var swingTFEl = document.getElementById('swingTFSelect');
  var swingTF   = swingTFEl ? swingTFEl.value : 'auto';
  if (swingTF === 'auto') {
    var swingSetups = detectSwingSetups(data, emas, zones, atr, fib, amd);
    renderSwingLab(swingSetups, sessLevels, obs, eqLevels);
    var symEl = document.getElementById('swingLabSymbol');
    if (symEl) symEl.textContent = (ANA_ACTIVE_SYMBOL || '') + ' · ' + ANA_INTERVAL;
  } else {
    rerunSwingLab(swingTF); // loads dedicated TF file
  }

  // Draw session levels on chart (store on ANA for drawNeonChart)
  ANA.sessLevels = sessLevels;
  ANA.eqLevels   = eqLevels;

  patchSigLogWithCollapse();
  updateSigCollapseBar();
  renderMLPanel();

  var cp = data[data.length-1].close;
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0];
  document.getElementById('anaCurrentPrice').innerHTML =
    'Current: <strong style="color:var(--gold)">' + cp.toFixed(2) + '</strong> &nbsp;|&nbsp; ATR(14): <strong>' +
    atrLast.toFixed(2) + '</strong>';

  // Context panel visibility is handled inside drawAllCharts()
  requestAnimationFrame(function() { drawAllCharts(); });
  renderSigLog(); // re-color LIVE rows with fresh price
}

// ── Draw all charts ──────────────────────────────────────────────────────────
function drawAllCharts() {
  if (!ANA) return;
  var mainData = ANA.data;
  var barCount = Math.min(ANA_BARS, mainData.length);
  var bars     = mainData.slice(-barCount);
  var emaSlice = {
    e20:  ANA.emas.e20.slice(-barCount),
    e50:  ANA.emas.e50.slice(-barCount),
    e200: ANA.emas.e200.slice(-barCount),
  };
  var swings = findSwings(bars, 5);
  drawNeonChart('anaChart', bars, emaSlice, ANA.atr, ANA.zones, swings, ANA_INTERVAL, ANA.fib);

  // Context chart — only when we have a lower-TF file to show as context
  // (e.g. file=M15 viewing H1 → show M15 raw as context; file=H1 viewing H1 → no context)
  var srcMins = TF_MINUTES[ANA_FILE_TF]  || 15;
  var ctxWrap = document.getElementById('anaCtxWrap');
  var mainLbl = document.getElementById('anaMainLabel');
  var ctxLbl  = document.getElementById('anaCtxLabel');

  // Determine if a context TF makes sense (one step below current view, above file TF)
  var ctxTF = null;
  if (ANA_INTERVAL === 'H1'  && srcMins <= 15)  ctxTF = 'M15';
  if (ANA_INTERVAL === 'H4'  && srcMins <= 60)  ctxTF = 'H1';
  if (ANA_INTERVAL === 'D1'  && srcMins <= 240) ctxTF = 'H4';

  if (ctxTF && ANA_RAW_M15) {
    var ctxRaw    = aggregateData(ANA_RAW_M15, ctxTF);
    var ctxBars   = ctxRaw.slice(-200);
    var ctxCloses = ctxBars.map(function(d){ return d.close; });
    var ctxEmas   = { e20: calcEMA(ctxCloses,20), e50: calcEMA(ctxCloses,50), e200: calcEMA(ctxCloses,200) };
    var ctxAtr    = calcATR(ctxBars, 14);
    var ctxSwings = findSwings(ctxBars, 5);
    if (ctxWrap) ctxWrap.style.display = 'block';
    if (mainLbl) mainLbl.firstChild.textContent = ANA_INTERVAL + ' CHART';
    if (ctxLbl)  ctxLbl.textContent = ctxTF + ' CONTEXT';
    drawNeonChart('anaChartCtx', ctxBars, ctxEmas, ctxAtr, ANA.zones, ctxSwings, ctxTF);
  } else {
    if (ctxWrap) ctxWrap.style.display = 'none';
    if (mainLbl) mainLbl.firstChild.textContent = ANA_INTERVAL + ' CHART';
  }

  // Restore scroll position after a sync reload so the user stays in place
  if (ANA_SYNC_SCROLL !== null) {
    var sy = ANA_SYNC_SCROLL;
    ANA_SYNC_SCROLL = null;
    requestAnimationFrame(function() { window.scrollTo(0, sy); });
  }
}

// ── Neon Canvas Chart ────────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
}

function drawNeonChart(canvasId, bars, emas, fullAtr, zones, swings, tf, fib) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;

  var atrLast = fullAtr.filter(function(v){ return v !== null; }).slice(-1)[0] || 1;

  function draw() {
    var DPR = window.devicePixelRatio || 1;
    var W   = canvas.offsetWidth  || 700;
    var H   = canvas.offsetHeight || 340;
    if (W < 10 || H < 10) return;
    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    var ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    var VOL_H  = Math.round(H * 0.18); // bottom 18% for volume
    var pad    = { top: 16, right: 62, bottom: 22 + VOL_H, left: 4 };
    var cW     = W - pad.left - pad.right;
    var cH     = H - pad.top  - pad.bottom;

    // ── Background ────────────────────────────────────────────────────────
    ctx.fillStyle = '#020409';
    ctx.fillRect(0, 0, W, H);

    // ── Dot grid ──────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,229,255,0.03)';
    var dotSpacing = 24;
    for (var gx = pad.left; gx < pad.left + cW; gx += dotSpacing) {
      for (var gy = pad.top; gy < pad.top + cH; gy += dotSpacing) {
        ctx.fillRect(gx, gy, 1, 1);
      }
    }

    // ── Price range ───────────────────────────────────────────────────────
    var priceMax = Math.max.apply(null, bars.map(function(b){ return b.high; }));
    var priceMin = Math.min.apply(null, bars.map(function(b){ return b.low;  }));
    zones.forEach(function(z){
      if (z.price > priceMax) priceMax = z.price;
      if (z.price < priceMin) priceMin = z.price;
    });
    var pad5 = (priceMax - priceMin) * 0.05;
    priceMax += pad5; priceMin -= pad5;
    var pRange = priceMax - priceMin;
    if (pRange === 0) pRange = 1;

    var toY = function(p){ return pad.top + cH * (1 - (p - priceMin) / pRange); };
    var toX = function(i){ return pad.left + (i + 0.5) * (cW / bars.length); };
    var bW  = cW / bars.length;

    // ── Session coloring (M15 / H1 only) ──────────────────────────────────
    if (tf === 'M15' || tf === 'H1') {
      for (var i = 0; i < bars.length; i++) {
        var dt = bars[i].datetime || bars[i].date || '';
        var hour = parseInt(dt.substring(11,13)) || 0;
        var sess = null;
        if (hour >= 2  && hour < 9)  sess = 'rgba(140,90,255,0.04)';   // Asian
        if (hour >= 7  && hour < 12) sess = 'rgba(245,185,53,0.04)';   // London
        if (hour >= 13 && hour < 22) sess = 'rgba(0,229,255,0.035)';   // NY
        if (hour >= 13 && hour < 17) sess = 'rgba(14,203,138,0.045)';  // NY+London overlap
        if (sess) {
          ctx.fillStyle = sess;
          ctx.fillRect(toX(i) - bW/2, pad.top, bW, cH);
        }
      }
    }

    // ── Horizontal grid lines + price labels ──────────────────────────────
    for (var g = 0; g <= 5; g++) {
      var gp = priceMin + pRange * g / 5;
      var gy = toY(gp);
      ctx.strokeStyle = 'rgba(0,229,255,0.06)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(pad.left + cW, gy); ctx.stroke();
      ctx.fillStyle = 'rgba(0,229,255,0.4)';
      ctx.font = '9px Consolas,monospace';
      ctx.textAlign = 'left';
      ctx.fillText(gp.toFixed(0), pad.left + cW + 5, gy + 3);
    }

    // ── S/R zones ─────────────────────────────────────────────────────────
    zones.forEach(function(z) {
      if (z.price < priceMin || z.price > priceMax) return;
      var zy  = toY(z.price);
      var bH  = Math.max(2, Math.abs(toY(z.price - atrLast * 0.18) - toY(z.price + atrLast * 0.18)));
      var col = z.type === 'resistance' ? '#f64f57' : z.type === 'support' ? '#0ecb8a' : '#f5b935';
      ctx.save();
      ctx.globalAlpha = 0.055;
      ctx.fillStyle = col;
      ctx.fillRect(pad.left, zy - bH/2, cW, bH);
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.7;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(pad.left + cW, zy); ctx.stroke();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = col;
      ctx.font = '8px Consolas,monospace';
      ctx.textAlign = 'left';
      ctx.fillText(z.price.toFixed(0), pad.left + cW + 5, zy + 3);
      ctx.restore();
    });

    // ── Fair Value Gaps ───────────────────────────────────────────────────
    if (ANA && ANA.fvgs && ANA.fvgs.length) {
      ANA.fvgs.forEach(function(f) {
        var topY = toY(f.top);
        var botY = toY(f.bottom);
        if (botY < pad.top || topY > pad.top + cH) return;
        topY = Math.max(pad.top, topY);
        botY = Math.min(pad.top + cH, botY);
        var fvgCol = f.type === 'bullish' ? 'rgba(14,203,138,' : 'rgba(246,79,87,';
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle   = fvgCol + '1)';
        ctx.fillRect(pad.left, topY, cW, botY - topY);
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = fvgCol + '0.6)';
        ctx.lineWidth   = 0.6;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(pad.left, topY); ctx.lineTo(pad.left + cW, topY); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad.left, botY); ctx.lineTo(pad.left + cW, botY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle   = fvgCol + '0.9)';
        ctx.font        = '7px Consolas,monospace';
        ctx.textAlign   = 'left';
        ctx.globalAlpha = 0.8;
        ctx.fillText('FVG', pad.left + 3, topY + 9);
        ctx.restore();
      });
    }

    // ── Order Blocks ──────────────────────────────────────────────────────
    if (ANA && ANA.obs && ANA.obs.length) {
      ANA.obs.forEach(function(ob) {
        var topY = toY(ob.high), botY = toY(ob.low);
        if (botY < pad.top || topY > pad.top + cH) return;
        topY = Math.max(pad.top, topY); botY = Math.min(pad.top + cH, botY);
        var obCol = ob.type === 'bullish' ? 'rgba(14,203,138,' : 'rgba(246,79,87,';
        ctx.save();
        ctx.globalAlpha = 0.08; ctx.fillStyle = obCol + '1)';
        ctx.fillRect(pad.left, topY, cW, botY - topY);
        ctx.globalAlpha = 0.5; ctx.strokeStyle = obCol + '0.7)';
        ctx.lineWidth = 0.8; ctx.setLineDash([2, 3]);
        ctx.strokeRect(pad.left, topY, cW, botY - topY);
        ctx.setLineDash([]);
        ctx.fillStyle = obCol + '0.9)'; ctx.font = 'bold 7px Consolas,monospace';
        ctx.textAlign = 'left'; ctx.globalAlpha = 0.85;
        ctx.fillText((ob.type === 'bullish' ? '▲' : '▼') + ' OB', pad.left + 3, topY + 9);
        ctx.restore();
      });
    }

    // ── Session Levels (PDH/PDL/PWH/PWL) ────────────────────────────────
    if (ANA && ANA.sessLevels && ANA.sessLevels.length) {
      ANA.sessLevels.forEach(function(l) {
        var ly = toY(l.price);
        if (ly < pad.top || ly > pad.top + cH) return;
        ctx.save();
        ctx.strokeStyle = l.color; ctx.lineWidth = 0.8;
        ctx.setLineDash(l.type.startsWith('PW') ? [2, 5] : [5, 4]);
        ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.moveTo(pad.left, ly); ctx.lineTo(pad.left + cW, ly); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = l.color; ctx.globalAlpha = 0.85;
        ctx.font = '7px Consolas,monospace'; ctx.textAlign = 'left';
        ctx.fillText(l.type + ' ' + l.price.toFixed(1), pad.left + cW + 5, ly + 3);
        ctx.restore();
      });
    }

    // ── Fibonacci levels ──────────────────────────────────────────────────
    if (fib) {
      var currentClose = bars[bars.length - 1].close;
      var keyFibR = { 0.382: true, 0.5: true, 0.618: true };
      fib.levels.forEach(function(l) {
        if (l.price < priceMin || l.price > priceMax) return;
        var fy    = toY(l.price);
        var isKey = !!keyFibR[l.ratio];
        ctx.save();
        ctx.strokeStyle = isKey ? 'rgba(245,185,53,0.55)' : 'rgba(245,185,53,0.25)';
        ctx.lineWidth   = isKey ? 0.9 : 0.55;
        ctx.setLineDash([5, 6]);
        ctx.shadowColor = isKey ? 'rgba(245,185,53,0.3)' : 'none';
        ctx.shadowBlur  = isKey ? 4 : 0;
        ctx.beginPath(); ctx.moveTo(pad.left, fy); ctx.lineTo(pad.left + cW, fy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur  = 0;
        ctx.fillStyle   = isKey ? 'rgba(245,185,53,0.9)' : 'rgba(245,185,53,0.5)';
        ctx.font        = (isKey ? 'bold ' : '') + '8px Consolas,monospace';
        ctx.textAlign   = 'right';
        ctx.fillText(l.label, pad.left + cW - 3, fy - 2);
        ctx.restore();
      });
    }

    // ── EMAs with glow ────────────────────────────────────────────────────
    function drawEMA(arr, color, w, glowColor) {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = w || 1.2; ctx.setLineDash([]);
      if (glowColor) { ctx.shadowColor = glowColor; ctx.shadowBlur = 6; }
      ctx.beginPath();
      var mv = false;
      for (var i = 0; i < arr.length; i++) {
        if (!arr[i]) continue;
        var x = toX(i), y = toY(arr[i]);
        if (!mv) { ctx.moveTo(x, y); mv = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
    }
    drawEMA(emas.e20,  'rgba(0,229,255,0.85)',  1.4, 'rgba(0,229,255,0.5)');
    drawEMA(emas.e50,  'rgba(245,185,53,0.80)', 1.4, 'rgba(245,185,53,0.4)');
    drawEMA(emas.e200, 'rgba(246,79,87,0.65)',  1.8, 'rgba(246,79,87,0.4)');

    // ── Candlesticks ──────────────────────────────────────────────────────
    var bw = Math.max(1, bW * 0.72);
    for (var i = 0; i < bars.length; i++) {
      var b    = bars[i];
      var bull = b.close >= b.open;
      var col  = bull ? '#00d4aa' : '#ff3355';
      var cx   = toX(i);
      var bTop = toY(Math.max(b.open, b.close));
      var bBot = toY(Math.min(b.open, b.close));
      var bHh  = Math.max(1, bBot - bTop);

      ctx.save();
      if (bull) { ctx.shadowColor = 'rgba(0,212,170,0.35)'; ctx.shadowBlur = 3; }
      else       { ctx.shadowColor = 'rgba(255,51,85,0.3)';  ctx.shadowBlur = 3; }
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(0.6, bw * 0.12);
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(cx, toY(b.high)); ctx.lineTo(cx, toY(b.low)); ctx.stroke();
      ctx.fillStyle = col;
      ctx.globalAlpha = bull ? 0.92 : 0.88;
      ctx.fillRect(cx - bw/2, bTop, bw, bHh);
      ctx.restore();
    }

    // ── Swing markers ─────────────────────────────────────────────────────
    if (swings) {
      // Swing highs: inverted gold triangle above bar + "H"
      swings.highs.forEach(function(sh) {
        if (sh.index >= bars.length) return;
        var cx   = toX(sh.index);
        var sy   = toY(sh.price) - 14;
        var half = 5;
        ctx.save();
        ctx.shadowColor = 'rgba(245,185,53,0.6)'; ctx.shadowBlur = 8;
        ctx.fillStyle = '#f5b935';
        ctx.beginPath();
        ctx.moveTo(cx, sy + half * 1.2);   // bottom point (inverted)
        ctx.lineTo(cx - half, sy);
        ctx.lineTo(cx + half, sy);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(245,185,53,0.85)';
        ctx.font = 'bold 8px Consolas,monospace';
        ctx.textAlign = 'center';
        ctx.fillText('H', cx, sy - 3);
        ctx.restore();
      });

      // Swing lows: cyan upward triangle below bar + "L"
      swings.lows.forEach(function(sl) {
        if (sl.index >= bars.length) return;
        var cx   = toX(sl.index);
        var sy   = toY(sl.price) + 4;
        var half = 5;
        ctx.save();
        ctx.shadowColor = 'rgba(0,229,255,0.6)'; ctx.shadowBlur = 8;
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath();
        ctx.moveTo(cx, sy);                  // top point
        ctx.lineTo(cx - half, sy + half * 1.2);
        ctx.lineTo(cx + half, sy + half * 1.2);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0,229,255,0.85)';
        ctx.font = 'bold 8px Consolas,monospace';
        ctx.textAlign = 'center';
        ctx.fillText('L', cx, sy + half * 1.2 + 9);
        ctx.restore();
      });
    }

    // ── AMD Phase overlay ─────────────────────────────────────────────────
    if (ANA && ANA.amd) {
      var amd = ANA.amd;
      var dataLen  = ANA.data.length;
      var barsLen  = bars.length;
      var barOffset = dataLen - barsLen;

      var cAS = amd.accumStartIdx - barOffset; // chart index for accum start
      var cAE = amd.accumEndIdx   - barOffset; // chart index for accum end

      var phaseColors2 = {
        ACCUMULATION: { fill: 'rgba(0,229,255,.05)',  stroke: 'rgba(0,229,255,.35)',  text: '#00e5ff' },
        MANIPULATION: { fill: 'rgba(245,185,53,.06)', stroke: 'rgba(245,185,53,.45)', text: '#f5b935' },
        DELIVERY:     { fill: 'rgba(14,203,138,.05)', stroke: 'rgba(14,203,138,.4)',  text: '#0ecb8a' },
        DISTRIBUTION: { fill: 'rgba(14,203,138,.04)', stroke: 'rgba(14,203,138,.35)', text: '#0ecb8a' },
      };
      var pc2 = phaseColors2[amd.phase] || phaseColors2.ACCUMULATION;

      // Accumulation box (shaded rectangle over that period on the chart)
      if (cAE >= 0 && cAS < barsLen) {
        var boxX1 = toX(Math.max(0, cAS)) - bW / 2;
        var boxX2 = toX(Math.min(barsLen - 1, cAE)) + bW / 2;
        var boxY1 = toY(amd.accumHigh);
        var boxY2 = toY(amd.accumLow);
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle   = pc2.fill;
        ctx.fillRect(boxX1, boxY1, boxX2 - boxX1, boxY2 - boxY1);
        ctx.strokeStyle = pc2.stroke;
        ctx.lineWidth   = 0.8;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(boxX1, boxY1, boxX2 - boxX1, boxY2 - boxY1);
        ctx.setLineDash([]);
        ctx.fillStyle   = pc2.text;
        ctx.font        = 'bold 7px Consolas,monospace';
        ctx.textAlign   = 'left';
        ctx.shadowColor = pc2.text; ctx.shadowBlur = 4;
        ctx.fillText('ACCUM', boxX1 + 3, boxY1 + 9);
        ctx.restore();
      }

      // Range lines extending to current bar (accumHigh / accumLow)
      var lineStartX = cAE >= 0 ? toX(Math.min(barsLen - 1, cAE)) + bW : pad.left;
      ctx.save();
      ctx.strokeStyle = pc2.stroke;
      ctx.lineWidth   = 0.7;
      ctx.setLineDash([4, 6]);
      ctx.globalAlpha = 0.6;
      var ahY = toY(amd.accumHigh);
      var alY = toY(amd.accumLow);
      if (ahY >= pad.top && ahY <= pad.top + cH) {
        ctx.beginPath(); ctx.moveTo(lineStartX, ahY); ctx.lineTo(pad.left + cW, ahY); ctx.stroke();
        ctx.fillStyle = pc2.text; ctx.font = '7px Consolas,monospace'; ctx.textAlign = 'left';
        ctx.fillText('RNG H ' + amd.accumHigh.toFixed(1), pad.left + cW + 5, ahY + 3);
      }
      if (alY >= pad.top && alY <= pad.top + cH) {
        ctx.beginPath(); ctx.moveTo(lineStartX, alY); ctx.lineTo(pad.left + cW, alY); ctx.stroke();
        ctx.fillStyle = pc2.text; ctx.font = '7px Consolas,monospace'; ctx.textAlign = 'left';
        ctx.fillText('RNG L ' + amd.accumLow.toFixed(1), pad.left + cW + 5, alY + 3);
      }
      ctx.setLineDash([]);
      ctx.restore();

      // Manipulation level (orange dashed line)
      if (amd.manipLevel) {
        var mY = toY(amd.manipLevel);
        if (mY >= pad.top && mY <= pad.top + cH) {
          ctx.save();
          ctx.strokeStyle = 'rgba(246,79,87,.75)';
          ctx.lineWidth   = 1;
          ctx.setLineDash([3, 4]);
          ctx.shadowColor = 'rgba(246,79,87,.4)'; ctx.shadowBlur = 4;
          ctx.beginPath(); ctx.moveTo(pad.left, mY); ctx.lineTo(pad.left + cW, mY); ctx.stroke();
          ctx.setLineDash([]); ctx.shadowBlur = 0;
          ctx.fillStyle = '#f64f57';
          ctx.font = 'bold 7px Consolas,monospace'; ctx.textAlign = 'left';
          ctx.fillText('MANIP ' + amd.manipLevel.toFixed(1), pad.left + cW + 5, mY + 3);
          ctx.restore();
        }
      }

      // Phase label badge at top-right of chart
      ctx.save();
      var phLabel = amd.phase + (amd.dir ? (amd.dir === 'up' ? ' ▲' : ' ▼') : '');
      ctx.font = 'bold 8px Consolas,monospace';
      var lblW = ctx.measureText(phLabel).width + 10;
      var lblX = pad.left + cW - lblW - 2;
      var lblY = pad.top + 4;
      ctx.fillStyle   = pc2.fill.replace('.05', '.18').replace('.06', '.2').replace('.04', '.16');
      ctx.strokeStyle = pc2.stroke;
      ctx.lineWidth   = 0.7;
      ctx.fillRect(lblX, lblY, lblW, 12);
      ctx.strokeRect(lblX, lblY, lblW, 12);
      ctx.fillStyle   = pc2.text;
      ctx.textAlign   = 'left';
      ctx.shadowColor = pc2.text; ctx.shadowBlur = 4;
      ctx.fillText(phLabel, lblX + 5, lblY + 9);
      ctx.restore();
    }

    // ── Current price dashed line ─────────────────────────────────────────
    var lastClose = bars[bars.length-1].close;
    var pricY     = toY(lastClose);
    ctx.save();
    ctx.strokeStyle = 'rgba(0,229,255,0.7)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 4]);
    ctx.shadowColor = 'rgba(0,229,255,0.4)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(pad.left, pricY); ctx.lineTo(pad.left + cW, pricY); ctx.stroke();
    ctx.restore();
    // Price tag
    ctx.save();
    ctx.fillStyle = 'rgba(0,229,255,0.15)';
    ctx.strokeStyle = 'rgba(0,229,255,0.6)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([]);
    var tagW = 50, tagH = 14;
    var tagX = pad.left + cW + 5, tagY = pricY - tagH/2;
    ctx.fillRect(tagX, tagY, tagW, tagH);
    ctx.strokeRect(tagX, tagY, tagW, tagH);
    ctx.fillStyle = '#00e5ff';
    ctx.font = 'bold 9px Consolas,monospace';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,229,255,0.7)'; ctx.shadowBlur = 6;
    ctx.fillText(lastClose.toFixed(1), tagX + tagW/2, pricY + 3.5);
    ctx.restore();

    // ── Volume sub-panel ──────────────────────────────────────────────────
    var volTop    = H - VOL_H;
    var volMax    = Math.max.apply(null, bars.map(function(b){ return b.volume; })) || 1;
    ctx.fillStyle = 'rgba(0,229,255,0.04)';
    ctx.fillRect(pad.left, volTop, cW, VOL_H);

    for (var i = 0; i < bars.length; i++) {
      var b    = bars[i];
      var bull = b.close >= b.open;
      var col  = bull ? 'rgba(0,212,170,0.45)' : 'rgba(255,51,85,0.4)';
      var vH   = (b.volume / volMax) * (VOL_H - 4);
      var cx   = toX(i);
      ctx.fillStyle = col;
      ctx.fillRect(cx - bw/2, volTop + (VOL_H - vH), bw, vH);
    }
    // Volume divider line
    ctx.strokeStyle = 'rgba(0,229,255,0.1)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pad.left, volTop); ctx.lineTo(pad.left + cW, volTop); ctx.stroke();

    // ── Range high / low markers ──────────────────────────────────────────
    var rangeHigh = Math.max.apply(null, bars.map(function(b){ return b.high; }));
    var rangeLow  = Math.min.apply(null, bars.map(function(b){ return b.low; }));
    var rhY = toY(rangeHigh);
    var rlY = toY(rangeLow);
    // Range high — gold dotted span + left pill label
    ctx.save();
    ctx.strokeStyle = 'rgba(245,185,53,0.55)';
    ctx.lineWidth = 0.9; ctx.setLineDash([3, 5]);
    ctx.shadowColor = 'rgba(245,185,53,0.3)'; ctx.shadowBlur = 3;
    ctx.beginPath(); ctx.moveTo(pad.left, rhY); ctx.lineTo(pad.left + cW, rhY); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    // Pill: "▲ H XXXX" at left inside chart
    var pillW = 62, pillH = 13, pillX = pad.left + 2, pillY = rhY - pillH - 2;
    ctx.fillStyle = 'rgba(245,185,53,0.14)';
    ctx.strokeStyle = 'rgba(245,185,53,0.55)'; ctx.lineWidth = 0.7;
    roundRect(ctx, pillX, pillY, pillW, pillH, 3);
    ctx.fillStyle = '#f5b935'; ctx.font = 'bold 8px Consolas,monospace'; ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(245,185,53,0.7)'; ctx.shadowBlur = 5;
    ctx.fillText('▲ H  ' + rangeHigh.toFixed(1), pillX + 4, pillY + pillH - 2);
    ctx.restore();
    // Range low — cyan dotted span + left pill label
    ctx.save();
    ctx.strokeStyle = 'rgba(0,229,255,0.5)';
    ctx.lineWidth = 0.9; ctx.setLineDash([3, 5]);
    ctx.shadowColor = 'rgba(0,229,255,0.25)'; ctx.shadowBlur = 3;
    ctx.beginPath(); ctx.moveTo(pad.left, rlY); ctx.lineTo(pad.left + cW, rlY); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    pillY = rlY + 2;
    ctx.fillStyle = 'rgba(0,229,255,0.1)';
    ctx.strokeStyle = 'rgba(0,229,255,0.5)'; ctx.lineWidth = 0.7;
    roundRect(ctx, pillX, pillY, pillW, pillH, 3);
    ctx.fillStyle = '#00e5ff'; ctx.font = 'bold 8px Consolas,monospace'; ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,229,255,0.7)'; ctx.shadowBlur = 5;
    ctx.fillText('▼ L  ' + rangeLow.toFixed(1), pillX + 4, pillY + pillH - 2);
    ctx.restore();

    // ── Date labels ───────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,229,255,0.35)';
    ctx.font = '8px Consolas,monospace';
    ctx.textAlign = 'center';
    var step = Math.max(1, Math.floor(bars.length / 7));
    for (var i = 0; i < bars.length; i += step) {
      var b0  = bars[i];
      var dt  = b0.datetime || b0.date || '';
      var lbl;
      if (tf === 'M15' || tf === 'H1') {
        // Show date + time: "05-28 14:00"
        var datePart = dt.substring(5, 10);
        var timePart = dt.substring(11, 16);
        lbl = timePart ? datePart + ' ' + timePart : datePart;
      } else if (tf === 'H4') {
        // Show date + hour: "05-28 08h"
        var datePart = dt.substring(5, 10);
        var hourPart = dt.substring(11, 13);
        lbl = hourPart ? datePart + ' ' + hourPart + 'h' : datePart;
      } else {
        // D1 and others: show "MM-DD"
        lbl = (b0.date || dt).substring(5);
      }
      ctx.fillText(lbl, toX(i), H - VOL_H - 5);
    }
  }

  draw();
  var rt;
  window.addEventListener('resize', function(){ clearTimeout(rt); rt = setTimeout(draw, 80); });
}

// ── Render KPIs (neon) ───────────────────────────────────────────────────────
function renderAnaKpis(data, atr, rsi, trend, zones) {
  var last    = data[data.length-1];
  var prev    = data[data.length-2];
  var atrLast = atr.filter(function(v){ return v; }).slice(-1)[0];
  var rsiLast = rsi.filter(function(v){ return v; }).slice(-1)[0];

  var chg    = last.close - prev.close;
  var chgPct = (chg / prev.close * 100);
  var up     = chg >= 0;

  // Day change: compare to first bar of today's date
  var todayBars = data.filter(function(d){ return d.date === last.date; });
  var dayOpen   = todayBars.length ? todayBars[0].open : prev.close;
  var dayChgPct = ((last.close - dayOpen) / dayOpen * 100).toFixed(2);
  var dayUp     = parseFloat(dayChgPct) >= 0;

  var atrHist   = atr.filter(function(v){ return v; }).slice(-100);
  var atrPctile = Math.round(atrHist.filter(function(v){ return v <= atrLast; }).length / atrHist.length * 100);

  var y252  = data.slice(-252);
  var hi52  = Math.max.apply(null, y252.map(function(d){ return d.high; }));
  var lo52  = Math.min.apply(null, y252.map(function(d){ return d.low;  }));

  var nearest = zones.length ? zones.reduce(function(best, z) {
    return Math.abs(z.price - last.close) < Math.abs(best.price - last.close) ? z : best;
  }, zones[0]) : null;

  var rsiLabel = !rsiLast ? '' : rsiLast > 70 ? 'Overbought' : rsiLast < 30 ? 'Oversold' :
                 rsiLast > 60 ? 'Bullish' : rsiLast < 40 ? 'Bearish' : 'Neutral';

  function kpi(accent, valClass, label, val, sub) {
    return '<div class="ana-neon-kpi ' + accent + '">' +
      '<div class="ana-neon-kpi-label">' + label + '</div>' +
      '<div class="ana-neon-kpi-value ' + valClass + '">' + val + '</div>' +
      '<div class="ana-neon-kpi-sub">' + sub + '</div>' +
      '</div>';
  }

  var tCol = trend.colorClass === 'green' ? 'up' : trend.colorClass === 'red' ? 'down' : 'gold';
  var tAccent = trend.colorClass === 'green' ? 'kpi-up' : trend.colorClass === 'red' ? 'kpi-down' : 'kpi-gold';

  var nZoneCol = nearest
    ? (nearest.type === 'support' ? 'up' : nearest.type === 'resistance' ? 'down' : 'gold')
    : 'neutral';
  var nZoneAccent = nearest
    ? (nearest.type === 'support' ? 'kpi-up' : nearest.type === 'resistance' ? 'kpi-down' : 'kpi-gold')
    : 'kpi-neutral';

  document.getElementById('anaKpis').innerHTML =
    kpi(up ? 'kpi-up' : 'kpi-down', up ? 'up' : 'down',
        ANA_ACTIVE_SYMBOL || 'PRICE', last.close.toFixed(2),
        (up?'+':'') + chg.toFixed(2) + ' (' + (up?'+':'') + chgPct.toFixed(2) + '%)') +
    kpi(dayUp ? 'kpi-up' : 'kpi-down', dayUp ? 'up' : 'down',
        'Day Change', (dayUp?'+':'') + dayChgPct + '%',
        'vs open ' + dayOpen.toFixed(1)) +
    kpi(tAccent, tCol,
        'Trend Bias', trend.direction,
        trend.structure) +
    kpi('kpi-cyan', 'cyan',
        'ATR (14)', atrLast.toFixed(2),
        atrPctile + 'th pctile · ' + trend.regime) +
    kpi(rsiLast > 70 ? 'kpi-down' : rsiLast < 30 ? 'kpi-up' : 'kpi-neutral',
        rsiLast > 70 ? 'down' : rsiLast < 30 ? 'up' : 'neutral',
        'RSI (14)', rsiLast ? rsiLast.toFixed(1) : '—',
        rsiLabel) +
    (nearest ?
      kpi(nZoneAccent, nZoneCol,
          'Nearest Zone', nearest.price.toFixed(0),
          nearest.type + ' · ' + Math.abs(nearest.distPct).toFixed(2) + '% away') : '');
}

// ── Render S/R List ──────────────────────────────────────────────────────────
function renderSRList(zones, currentPrice, latestATR) {
  var el = document.getElementById('anaSrList');
  if (!zones.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">No significant zones found</div>';
    return;
  }

  // Split into resistance (above) and support (below), nearest first in each group
  var above = zones.filter(function(z){ return z.price > currentPrice; })
                   .sort(function(a,b){ return a.price - b.price; }); // nearest resistance first
  var below = zones.filter(function(z){ return z.price <= currentPrice; })
                   .sort(function(a,b){ return b.price - a.price; }); // nearest support first

  function srRow(z) {
    var dist = z.price - currentPrice;
    var dStr = (dist >= 0 ? '+' : '') + dist.toFixed(1);
    var col  = z.type === 'resistance' ? 'var(--red)' : z.type === 'support' ? 'var(--green)' : 'var(--gold)';
    var pct  = Math.round(z.strength / 10 * 100);
    var near = Math.abs(dist) <= latestATR * 1.5;
    return '<div class="sr-row' + (near ? ' sr-near' : '') + '">' +
      '<div class="sr-price" style="color:' + col + '">' + z.price.toFixed(1) + '</div>' +
      '<div class="sr-type" style="color:' + col + ';opacity:.7">' +
        (z.type === 'resistance' ? 'RES' : z.type === 'support' ? 'SUP' : 'S/R') +
        (z.isRound ? ' <span class="sr-round">R</span>' : '') +
      '</div>' +
      '<div class="sr-bar-wrap"><div class="sr-bar-fill" style="width:' + pct + '%;background:' + col + '"></div></div>' +
      '<div class="sr-meta">' + z.touches + 'T &nbsp;' + dStr + '</div>' +
      '</div>';
  }

  // Show up to 4 resistance, price divider, up to 4 support
  var resHtml = above.slice(0, 5).reverse().map(srRow).join(''); // farthest → nearest (top to bottom)
  var supHtml = below.slice(0, 5).map(srRow).join('');           // nearest → farthest (top to bottom)

  var priceDiv = '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;margin:3px 0;border-top:1px dashed rgba(0,229,255,.2);border-bottom:1px dashed rgba(0,229,255,.2)">' +
    '<span style="font-size:9px;color:var(--muted);letter-spacing:.06em">PRICE</span>' +
    '<span style="font-size:13px;font-weight:700;color:#00e5ff;font-family:var(--num-font)">' + currentPrice.toFixed(1) + '</span>' +
  '</div>';

  el.innerHTML = (resHtml || '<div style="color:var(--dim);font-size:10px;padding:4px 0">— no resistance above —</div>') +
                 priceDiv +
                 (supHtml || '<div style="color:var(--dim);font-size:10px;padding:4px 0">— no support below —</div>');
}

// ── Render Trend Panel ───────────────────────────────────────────────────────
function renderTrendPanel(t) {
  var el  = document.getElementById('anaTrend');
  var col = t.colorClass === 'green' ? 'var(--green)' : t.colorClass === 'red' ? 'var(--red)' : 'var(--gold)';

  function row(lbl, val, cls) {
    return '<div class="trend-row"><span class="trend-lbl">' + lbl + '</span>' +
           '<span class="trend-val' + (cls ? ' ' + cls : '') + '">' + val + '</span></div>';
  }

  el.innerHTML =
    '<div class="ana-neon-trend-dir" style="color:' + col + ';text-shadow:0 0 12px ' + col + '">' + t.direction + '</div>' +
    '<div class="trend-rows">' +
    row('Structure', t.structure) +
    row('Regime',    t.regime, t.regime === 'TRENDING' ? 'green' : 'amber') +
    row('EMA score', (t.emaScore > 0 ? '+' : '') + t.emaScore + ' / ±3') +
    row('vs EMA 20',  t.dist20  ? (parseFloat(t.dist20)  >= 0 ? '+' : '') + t.dist20  + '%' : '—',
        t.dist20  && parseFloat(t.dist20)  >= 0 ? 'green' : 'red') +
    row('vs EMA 200', t.dist200 ? (parseFloat(t.dist200) >= 0 ? '+' : '') + t.dist200 + '%' : '—',
        t.dist200 && parseFloat(t.dist200) >= 0 ? 'green' : 'red') +
    row('ATR %', t.atrPct.toFixed(2) + '% of price') +
    row('EMA 20',  t.e20  ? t.e20.toFixed(1)  : '—') +
    row('EMA 50',  t.e50  ? t.e50.toFixed(1)  : '—') +
    row('EMA 200', t.e200 ? t.e200.toFixed(1) : '—') +
    '</div>';
}

// ── Render Patterns ──────────────────────────────────────────────────────────
function renderPatterns(patterns) {
  var el  = document.getElementById('anaPatterns');
  var cnt = document.getElementById('anaPatternCount');
  cnt.textContent = patterns.length ? patterns.length + ' found' : '0';

  if (!patterns.length) {
    el.innerHTML = '<div class="ana-empty">No patterns in the last 20 bars</div>';
    return;
  }

  el.innerHTML = patterns.map(function(p) {
    var col  = p.type === 'bullish' ? 'var(--green)' : p.type === 'bearish' ? 'var(--red)' : 'var(--gold)';
    var icon = p.type === 'bullish' ? '&#x25B2;' : p.type === 'bearish' ? '&#x25BC;' : '&#x25A0;';
    var sigC = p.sig === 'very high' ? 'color:var(--green)' : p.sig === 'high' ? 'color:var(--gold)' : 'color:var(--muted)';
    var barDt = (ANA && ANA.data && ANA.data[p.barIdx]) ? (ANA.data[p.barIdx].datetime || ANA.data[p.barIdx].date || '') : p.date;
    var timePart  = barDt.substring(11, 16);
    var dateLabel = p.date + (timePart ? ' <span style="color:var(--cyan);opacity:.8">' + timePart + '</span>' : '');

    // Confirmation + context badges
    var badges = '';
    if (p.confirmed)  badges += '<span class="pat-badge pat-badge-confirmed">&#10003; confirmed</span>';
    else              badges += '<span class="pat-badge pat-badge-unconfirmed">&#8987; pending</span>';
    if (p.atZone)     badges += '<span class="pat-badge pat-badge-zone">S/R zone</span>';
    if (p.amdAlign)   badges += '<span class="pat-badge pat-badge-amd">AMD</span>';

    return '<div class="pattern-row">' +
      '<span class="pattern-icon" style="color:' + col + '">' + icon + '</span>' +
      '<div class="pattern-body">' +
        '<div class="pattern-name" style="color:' + col + '">' + p.name +
          ' <span style="font-size:9px;' + sigC + '">' + p.sig + '</span></div>' +
        '<div class="pattern-badges">' + badges + '</div>' +
        '<div class="pattern-desc">' + p.desc + '</div>' +
        '<div class="pattern-date">' + dateLabel + '</div>' +
      '</div></div>';
  }).join('');
}

// ── Render Fibonacci ─────────────────────────────────────────────────────────
function renderFib(fib, currentPrice) {
  var el = document.getElementById('anaFib');
  if (!fib) { el.innerHTML = '<div class="ana-empty">Not enough swing data for Fibonacci</div>'; return; }

  var keyRatios = { '38.2%': true, '50.0%': true, '61.8%': true };

  var rows = fib.levels.map(function(l) {
    var dist  = l.price - currentPrice;
    var dStr  = (dist >= 0 ? '+' : '') + dist.toFixed(1);
    var isKey = keyRatios[l.label];
    var near  = ANA ? Math.abs(dist) < ANA.atr.filter(function(v){ return v; }).slice(-1)[0] : false;
    var col   = l.ratio === 0.618 || l.ratio === 0.382 ? 'var(--gold)' :
                l.ratio === 0.5 ? 'var(--blue)' : 'var(--text)';
    return '<div class="fib-row' + (near ? ' fib-near' : '') + '">' +
      '<span class="fib-ratio" style="color:' + col + ';font-weight:' + (isKey ? '700' : '400') + '">' + l.label + '</span>' +
      '<span class="fib-price">' + l.price.toFixed(1) + '</span>' +
      '<span class="fib-dist ' + (dist >= 0 ? 'green' : 'red') + '">' + dStr + '</span>' +
      (near ? '<span class="fib-here fib-here-' + (dist > 0 ? 'res' : 'sup') + '">' + (dist > 0 ? 'NEAR ▲ RES' : 'NEAR ▼ SUP') + '</span>' : '') +
      '</div>';
  }).join('');

  el.innerHTML =
    '<div class="fib-header">Swing High <strong>' + fib.swingH.price.toFixed(1) + '</strong>' +
    ' (' + fib.swingH.date + ') &rarr; Swing Low <strong>' + fib.swingL.price.toFixed(1) + '</strong>' +
    ' (' + fib.swingL.date + ')</div>' +
    '<div class="fib-grid">' + rows + '</div>';
}

// ── Live clock ───────────────────────────────────────────────────────────────
function startAnaClock() {
  if (ANA_CLOCK_TIMER) return; // already running
  function tick() {
    var el = document.getElementById('anaClock');
    if (!el) { clearInterval(ANA_CLOCK_TIMER); ANA_CLOCK_TIMER = null; return; }
    var now = new Date();
    var hh  = String(now.getUTCHours()).padStart(2,'0');
    var mm  = String(now.getUTCMinutes()).padStart(2,'0');
    var ss  = String(now.getUTCSeconds()).padStart(2,'0');
    el.textContent = hh + ':' + mm + ':' + ss + ' UTC';
    updateSessionBadge(now);
  }
  tick();
  ANA_CLOCK_TIMER = setInterval(tick, 1000);
}

function updateSessionBadge(now) {
  var el = document.getElementById('anaSessionBadge');
  if (!el) return;
  now = now || new Date();
  var hour = now.getUTCHours();
  var sess, cls;
  if (hour >= 13 && hour < 17) { sess = 'NY+LONDON'; cls = 'sess-overlap'; }
  else if (hour >= 13 && hour < 22) { sess = 'NY';     cls = 'sess-ny'; }
  else if (hour >= 7  && hour < 13) { sess = 'LONDON'; cls = 'sess-london'; }
  else if (hour >= 0  && hour < 7 ) { sess = 'ASIAN';  cls = 'sess-asian'; }
  else                               { sess = 'ASIAN';  cls = 'sess-asian'; }
  el.textContent = sess;
  el.className   = 'ana-session-badge ' + cls;
}

// ── MACD ─────────────────────────────────────────────────────────────────────
function calcMACD(closes, fast, slow, sigPeriod) {
  fast = fast || 12; slow = slow || 26; sigPeriod = sigPeriod || 9;
  var emaFast = calcEMA(closes, fast);
  var emaSlow = calcEMA(closes, slow);
  var macdLine = closes.map(function(_, i) {
    return (emaFast[i] !== null && emaSlow[i] !== null) ? emaFast[i] - emaSlow[i] : null;
  });
  // EMA of MACD line for signal
  var firstValid = -1;
  for (var i = 0; i < macdLine.length; i++) { if (macdLine[i] !== null) { firstValid = i; break; } }
  var sigArr = new Array(closes.length).fill(null);
  if (firstValid >= 0) {
    var subMacd  = macdLine.slice(firstValid).map(function(v){ return v !== null ? v : 0; });
    var subSig   = calcEMA(subMacd, sigPeriod);
    for (var i = 0; i < subSig.length; i++) sigArr[firstValid + i] = subSig[i];
  }
  var histogram = macdLine.map(function(m, i) {
    return (m !== null && sigArr[i] !== null) ? m - sigArr[i] : null;
  });
  return { macd: macdLine, signal: sigArr, histogram: histogram };
}

// ── Bot / Signals — state ─────────────────────────────────────────────────────
var BOT_ENABLED    = false;
var BOT_FEATURES   = { rangeDetect: true, rsiSignals: true, macdCross: true, swingFlags: true };
var BOT_STRATEGIES = { rsiBounce: false, macdEntry: false, structBreak: false, rangeFade: false, asiaBreakout: false, trendFollower: false };

// Trend Follower parameters
var BOT_TF_TREND = 'auto';  // 'auto' | 'up' | 'down'
var BOT_TF_MA    = 20;      // 20 | 50 | 200
var BOT_LOG        = [];
var botOrderType   = localStorage.getItem('wayne_bot_order_type') || 'PENDING';
var botLotSize     = parseFloat(localStorage.getItem('wayne_bot_lot_size') || '0.01') || 0.01;
var BOT_DIRECTION  = localStorage.getItem('wayne_bot_direction') || 'both'; // 'both'|'buy'|'sell'
var BOT_SCAN_TIMER = null;           // setInterval handle for auto-scan
var BOT_SENT_SIGS  = {};             // dedup: key -> timestamp of last dispatch
var BOT_SCAN_INTERVAL_MS  = 30000;   // re-scan every 30 s when bot is ON
var BOT_LAST_SENT_AT      = 0;       // timestamp of last bot dispatch
var BOT_SEND_COOLDOWN_MS  = 15 * 60 * 1000; // 15 min between any bot sends

// Session limits (reset each time bot is toggled ON)
var BOT_MAX_TRADES  = 0;   // 0 = unlimited
var BOT_EXPIRY_TIME = '';  // '' = no expiry  e.g. '17:00'
var BOT_LOSS_LIMIT  = 0;   // 0 = no limit — consecutive losses before auto-disable
var BOT_TRADE_COUNT = 0;   // trades dispatched this session

// ── Tab switching ─────────────────────────────────────────────────────────────
function showBotTab(tab) {
  var ps = document.getElementById('botPanelSignals');
  var pb = document.getElementById('botPanelBot');
  var ts = document.getElementById('botTabSignals');
  var tb = document.getElementById('botTabBot');
  if (ps) ps.style.display = tab === 'signals' ? 'block' : 'none';
  if (pb) pb.style.display = tab === 'bot'     ? 'block' : 'none';
  if (ts) ts.classList.toggle('active', tab === 'signals');
  if (tb) tb.classList.toggle('active', tab === 'bot');
  if (tab === 'signals') {
    renderSigLog();
    refreshSignalPrices(); // immediate price fetch for any LIVE signals
  }
}

// ── Signal log — localStorage persistence ────────────────────────────────────
function loadSigLog() {
  try { return JSON.parse(localStorage.getItem('wayne_signals') || '[]'); } catch(e) { return []; }
}
function saveSigLog(sigs) {
  localStorage.setItem('wayne_signals', JSON.stringify(sigs));
}

function logSignal() {
  var dir   = document.getElementById('sigDir').value;
  var entry = parseFloat(document.getElementById('sigEntry').value);
  var sl    = parseFloat(document.getElementById('sigSL').value);
  var tp    = parseFloat(document.getElementById('sigTP').value);
  var basis = document.getElementById('sigBasis').value.trim();
  var note  = document.getElementById('sigNote').value.trim();
  if (!entry || isNaN(entry) || !sl || isNaN(sl) || !tp || isNaN(tp)) {
    alert('Entry, SL and TP are required'); return;
  }
  // Build blank confluence map
  var confluences = {};
  CONF_DEFS.forEach(function(c){ confluences[c.key] = false; });

  var sigs = loadSigLog();
  sigs.push({
    id:          Date.now(),
    time:        new Date().toISOString(),
    symbol:      ANA_ACTIVE_SYMBOL || '—',
    dir:         dir,
    entry:       entry, sl: sl, tp: tp,
    lot:         botLotSize,
    orderType:   botOrderType,
    basis:       basis, note: note,
    status:      'PENDING',
    confluences: confluences,
    confRequired: CONF_REQUIRED,
    mt4Status:   null,
    mlFeatures:  extractMLFeatures(dir), // capture market conditions at log time
  });
  saveSigLog(sigs);
  ['sigEntry','sigSL','sigTP','sigBasis','sigNote'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  renderSigLog();
}

function updateSignalStatus(id, status) {
  var all  = loadSigLog();
  var orig = all.find(function(s){ return s.id === id; });
  var sigs = all.map(function(s) {
    return s.id === id ? Object.assign({}, s, { status: status }) : s;
  });
  saveSigLog(sigs);
  renderSigLog();

  // Train ML model when a trade is closed as WIN or LOSS
  if ((status === 'WIN' || status === 'LOSS') && orig && orig.mlFeatures) {
    trainMLModel(orig.mlFeatures, status);
  }

  // If transitioning to LIVE, immediately fetch the price for that symbol
  if (status === 'LIVE') {
    var sig = sigs.find(function(s){ return s.id === id; });
    if (sig && sig.symbol) {
      delete SIG_PRICE_CACHE[(sig.symbol||'').toUpperCase()];
      fetchSymbolPrice(sig.symbol, function(){ renderSigLog(); });
    }
  }
}

function toggleConfluence(id, key) {
  var wentLive = false;
  var liveSymbol = null;
  var sigs = loadSigLog().map(function(s) {
    if (s.id !== id || s.status !== 'PENDING') return s;
    var conf = Object.assign({}, s.confluences || {});
    conf[key] = !conf[key];
    var ticked   = CONF_DEFS.filter(function(c){ return conf[c.key]; }).length;
    var required = s.confRequired || CONF_REQUIRED;
    var newStatus = ticked >= required ? 'LIVE' : 'PENDING';
    if (newStatus === 'LIVE' && s.status === 'PENDING') {
      wentLive   = true;
      liveSymbol = s.symbol;
    }
    return Object.assign({}, s, { confluences: conf, status: newStatus });
  });
  saveSigLog(sigs);
  renderSigLog();
  if (wentLive && liveSymbol) {
    delete SIG_PRICE_CACHE[(liveSymbol || '').toUpperCase()];
    fetchSymbolPrice(liveSymbol, function(){ renderSigLog(); });
  }
}

function deleteSignal(id) {
  saveSigLog(loadSigLog().filter(function(s){ return s.id !== id; }));
  renderSigLog();
}

// ── Signal price resolution ───────────────────────────────────────────────────
// Find the best file for a symbol from the known universe.
// Prefers M15 (most bars / most recent timestamp).
function resolveSymbolFile(symbol) {
  if (!symbol || !ANA_SYMBOLS.length) return null;
  var up  = symbol.toUpperCase();
  var all = ANA_SYMBOLS.filter(function(s){ return s.symbol.toUpperCase() === up; });
  if (!all.length) return null;
  var m15 = all.find(function(s){ return /M15/i.test(s.file) || /_15/i.test(s.file); });
  return (m15 || all[0]).file;
}

// Get the most recent close for a symbol.
// Checks (in order): ANA active data → multi-loaded cache → fetch file.
// Calls done(price) when resolved; if async, re-renders sig log after.
function fetchSymbolPrice(symbol, done) {
  var up = symbol ? symbol.toUpperCase() : '';

  // 1 — Active symbol already loaded
  if (ANA_ACTIVE_SYMBOL && ANA_ACTIVE_SYMBOL.toUpperCase() === up && ANA && ANA.data && ANA.data.length) {
    var p = ANA.data[ANA.data.length - 1].close;
    SIG_PRICE_CACHE[up] = { price: p, ts: Date.now() };
    if (done) done(p);
    return;
  }

  // 2 — Already cached in multi-loaded bars
  var file = resolveSymbolFile(symbol);
  if (file && ANA_MULTI_LOADED[file] && ANA_MULTI_LOADED[file].length) {
    var bars = ANA_MULTI_LOADED[file];
    var p    = bars[bars.length - 1].close;
    SIG_PRICE_CACHE[up] = { price: p, ts: Date.now() };
    if (done) done(p);
    return;
  }

  // 3 — Symbol list not loaded yet — load index.json first then retry
  if (!file && !ANA_SYMBOLS.length) {
    fetch('data/gold/index.json')
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(d){
        ANA_SYMBOLS = d.files || [];
        fetchSymbolPrice(symbol, done); // retry with populated list
      })
      .catch(function(){});
    return;
  }

  if (!file) return; // symbol not in universe

  // 4 — Fetch CSV, cache bars, return last close
  fetch('data/gold/' + file)
    .then(function(r){ return r.ok ? r.text() : Promise.reject('HTTP ' + r.status); })
    .then(function(txt){
      var bars = parseAnalysisCSV(txt);
      if (!bars.length) return;
      ANA_MULTI_LOADED[file] = bars;
      var p = bars[bars.length - 1].close;
      SIG_PRICE_CACHE[up] = { price: p, ts: Date.now() };
      if (done) done(p);
    })
    .catch(function(){});
}

// Refresh prices for every unique symbol that has a LIVE signal, then re-render.
function refreshSignalPrices() {
  var sigs    = loadSigLog().filter(function(s){ return s.status === 'LIVE'; });
  if (!sigs.length) { stopSigPricePoller(); return; }

  var symbols = [];
  sigs.forEach(function(s){
    var up = (s.symbol || '').toUpperCase();
    if (up && symbols.indexOf(up) < 0) symbols.push(up);
  });

  var remaining = symbols.length;
  if (!remaining) return;

  symbols.forEach(function(sym){
    // Invalidate cache so we always fetch fresh on a poll tick
    delete SIG_PRICE_CACHE[sym];
    fetchSymbolPrice(sym, function(){
      remaining--;
      if (remaining === 0) renderSigLog();
    });
  });
}

function startSigPricePoller() {
  if (SIG_POLL_TIMER) return;
  SIG_POLL_TIMER = setInterval(function(){
    var live = loadSigLog().filter(function(s){ return s.status === 'LIVE'; });
    if (!live.length) { stopSigPricePoller(); return; }
    refreshSignalPrices();
  }, 30000); // refresh every 30 s
}

function stopSigPricePoller() {
  if (SIG_POLL_TIMER) { clearInterval(SIG_POLL_TIMER); SIG_POLL_TIMER = null; }
}

// ── Inline cell editing for signal entry / SL / TP ───────────────────────────
function editSigField(id, field, td) {
  // Don't nest inputs
  if (td.querySelector('input')) return;

  var sigs = loadSigLog();
  var sig  = sigs.find(function(s){ return s.id === id; });
  if (!sig) return;

  var prev = sig[field];
  td.innerHTML = '';

  var inp = document.createElement('input');
  inp.type      = 'number';
  inp.className = 'sig-inline-input';
  inp.value     = prev;
  inp.step      = '0.01';
  td.appendChild(inp);
  inp.focus();
  inp.select();

  var saved = false;
  function save() {
    if (saved) return;
    saved = true;
    var val = parseFloat(inp.value);
    if (!isNaN(val) && val > 0 && val !== prev) {
      var updated = loadSigLog().map(function(s) {
        if (s.id !== id) return s;
        var copy = Object.assign({}, s);
        copy[field] = val;
        return copy;
      });
      saveSigLog(updated);
    }
    renderSigLog();
  }

  inp.addEventListener('blur',    save);
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  inp.blur();
    if (e.key === 'Escape') { saved = true; renderSigLog(); } // cancel without saving
  });
}

function renderSigLog() {
  var el = document.getElementById('sigTableBody');
  if (!el) return;
  var sigs = loadSigLog();
  if (!sigs.length) {
    el.innerHTML = '<tr><td colspan="9" class="sig-empty">No signals logged yet</td></tr>';
    stopSigPricePoller();
    return;
  }

  var hasLive = false;
  var rows = [];

  sigs.slice().reverse().forEach(function(s) {
    var dt     = s.time ? s.time.substring(0,16).replace('T',' ') : '—';
    var dirCol = s.dir === 'buy' ? 'var(--green)' : 'var(--red)';
    var rr     = (s.entry && s.sl && s.tp) ? Math.abs(s.tp - s.entry) / Math.abs(s.entry - s.sl) : 0;
    var stCls  = 'sig-status-' + s.status.toLowerCase();

    // ── PENDING rows: confluence status badge ─────────────────────────────
    var statusCell = '';
    var confSubRow = '';
    if (s.status === 'PENDING') {
      var conf     = s.confluences || {};
      var required = s.confRequired || CONF_REQUIRED;
      var ticked   = CONF_DEFS.filter(function(c){ return conf[c.key]; }).length;
      var ready    = ticked >= required;
      var pct      = Math.round(ticked / CONF_DEFS.length * 100);

      // Status badge with progress fraction
      statusCell = '<span class="sig-status-badge sig-status-pending' + (ready ? ' sig-conf-ready' : '') + '">' +
        (ready ? '&#10003; READY ' : 'PENDING ') + ticked + '/' + CONF_DEFS.length +
      '</span>';

      // Confluence chips sub-row
      var chips = CONF_DEFS.map(function(c) {
        var on = !!conf[c.key];
        return '<button class="sig-conf-chip' + (on ? ' on' : '') + '" ' +
          'onclick="toggleConfluence(' + s.id + ',\'' + c.key + '\')" title="' + c.desc + '">' +
          (on ? '&#10003; ' : '') + c.label +
        '</button>';
      }).join('');

      var dots = CONF_DEFS.map(function(c, i) {
        return '<span class="sig-conf-dot' + (conf[c.key] ? ' filled' : '') + '"></span>';
      }).join('');

      confSubRow = '<tr class="sig-conf-row' + (ready ? ' sig-conf-row-ready' : '') + '">' +
        '<td colspan="9">' +
          '<div class="sig-conf-wrap">' +
            '<div class="sig-conf-chips">' + chips + '</div>' +
            '<div class="sig-conf-meter">' +
              dots +
              '<span class="sig-conf-label">' + ticked + '/' + required + ' to go live</span>' +
            '</div>' +
          '</div>' +
        '</td>' +
      '</tr>';

    // ── LIVE rows: floating P/L from symbol price cache ───────────────────
    } else if (s.status === 'LIVE' && s.entry) {
      hasLive = true;
      var up      = (s.symbol || '').toUpperCase();
      var cached  = SIG_PRICE_CACHE[up];
      var floatBadge = '';
      if (!cached) {
        fetchSymbolPrice(s.symbol, function(){ renderSigLog(); });
        floatBadge = '<span class="sig-float-badge" style="color:var(--muted)">fetching…</span>';
      } else {
        var move     = s.dir === 'buy' ? cached.price - s.entry : s.entry - cached.price;
        var inProfit = move > 0;
        stCls       += inProfit ? ' sig-live-up' : ' sig-live-down';
        var moveStr  = (move >= 0 ? '+' : '') + move.toFixed(2);
        var age      = Math.round((Date.now() - cached.ts) / 1000);
        var ageStr   = age < 60 ? age + 's ago' : Math.round(age/60) + 'm ago';
        floatBadge   = '<span class="sig-float-badge ' + (inProfit ? 'sig-float-up' : 'sig-float-dn') + '" title="' + ageStr + '">' +
          moveStr + ' @ ' + cached.price.toFixed(2) + '</span>';
      }
      statusCell = '<span class="sig-status-badge sig-status-live">LIVE</span> ' + floatBadge;

    } else {
      statusCell = '<span class="sig-status-badge ' + stCls + '">' + s.status + '</span>';
    }

    var ordType    = (s.orderType || 'PENDING').toUpperCase();
    var ordBadge   = '<span class="sig-order-badge sig-order-' + (ordType === 'MARKET' ? 'mkt' : 'lmt') + '">' + (ordType === 'MARKET' ? 'MKT' : 'LMT') + '</span>';

    var mt4Btn = '';
    if (s.status === 'LIVE') {
      if (!s.mt4Status || s.mt4Status === 'ERROR') {
        mt4Btn = '<button class="sig-mt4-btn" onclick="sendSignalToMT4(' + s.id + ')" title="Send to MT4">' +
          (s.mt4Status === 'ERROR' ? '&#9888; Retry MT4' : '&#9654; MT4') + '</button>';
      } else if (s.mt4Status === 'SENDING') {
        mt4Btn = '<span class="sig-mt4-status sig-mt4-sending">&#8635; Sending</span>';
      } else if (s.mt4Status === 'SENT') {
        mt4Btn = '<span class="sig-mt4-status sig-mt4-sent" title="Waiting for EA to execute">&#8987; Sent</span>';
      } else if (s.mt4Status === 'EXECUTED') {
        mt4Btn = '<span class="sig-mt4-status sig-mt4-exec" title="Ticket ' + (s.mt4Ticket||'') + '">&#10003; #' + (s.mt4Ticket||'exec') + '</span>';
      }
    }

    var mainRow = '<tr class="' + stCls + '">' +
      '<td>' + dt + '</td>' +
      '<td>' + (s.symbol||'—') + '</td>' +
      '<td style="color:' + dirCol + ';font-weight:700">' + s.dir.toUpperCase() + ' ' + ordBadge + '</td>' +
      '<td class="sig-editable" onclick="editSigField(' + s.id + ',\'entry\',this)" title="Click to edit entry">' + s.entry.toFixed(2) + '</td>' +
      '<td class="sig-editable" onclick="editSigField(' + s.id + ',\'sl\',this)"    title="Click to edit SL">'    + s.sl.toFixed(2)    + '</td>' +
      '<td class="sig-editable" onclick="editSigField(' + s.id + ',\'tp\',this)"    title="Click to edit TP">' +
        s.tp.toFixed(2) + ' <small class="sig-rr-tag">' + rr.toFixed(1) + 'R</small>' +
        (function() {
          var prob = predictSignalWinProb(s);
          if (prob === null) return '';
          var col = prob >= 65 ? '#0ecb8a' : prob >= 45 ? '#f5b935' : '#f64f57';
          return ' <span style="font-size:8px;font-weight:700;color:' + col + ';opacity:.85" title="ML win probability">' + prob + '%</span>';
        })() +
      '</td>' +
      '<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (s.basis||'') + '">' + (s.basis||'—') + '</td>' +
      '<td>' + statusCell + '</td>' +
      '<td class="sig-actions">' +
        (s.status === 'PENDING' ? '<button class="sig-act-btn sig-act-live" onclick="updateSignalStatus(' + s.id + ',\'LIVE\')" title="Force live">&#9654;</button>' : '') +
        (s.status === 'LIVE'    ? '<button class="sig-act-btn sig-act-win"  onclick="updateSignalStatus(' + s.id + ',\'WIN\')">WIN</button>'   : '') +
        (s.status === 'LIVE'    ? '<button class="sig-act-btn sig-act-loss" onclick="updateSignalStatus(' + s.id + ',\'LOSS\')">LOSS</button>'  : '') +
        mt4Btn +
        (s.status !== 'CANCEL'  ? '<button class="sig-act-btn sig-act-cancel" onclick="updateSignalStatus(' + s.id + ',\'CANCEL\')">&#10005;</button>' : '') +
        '<button class="sig-act-btn sig-act-del" onclick="deleteSignal(' + s.id + ')" title="Delete">&#x1F5D1;</button>' +
      '</td>' +
    '</tr>';

    rows.push(mainRow);
    if (confSubRow) rows.push(confSubRow);
  });

  el.innerHTML = rows.join('');

  // Start/stop the price poller based on whether any LIVE signals exist
  if (hasLive) startSigPricePoller(); else stopSigPricePoller();
}

// ── Bot master toggle ─────────────────────────────────────────────────────────
// restore=true → page-refresh restore; don't wipe cooldown or session counters
function toggleBotMaster(on, restore) {
  BOT_ENABLED = on;
  localStorage.setItem('wayne_bot_enabled', on ? '1' : '0');

  var el = document.getElementById('botMasterStatus');
  if (el) {
    el.textContent = on ? 'ON' : 'OFF';
    el.className   = 'bot-status-badge ' + (on ? 'bot-status-on' : 'bot-status-off');
  }

  var sw = document.getElementById('botMasterSwitch');
  if (sw) sw.checked = !!on;

  var limRow = document.getElementById('botLimitsRow');
  if (limRow) limRow.style.display = on ? 'flex' : 'none';

  if (on) {
    if (!restore) {
      // Fresh manual enable — reset session counters and cooldown
      BOT_TRADE_COUNT  = 0;
      BOT_LAST_SENT_AT = 0;
      localStorage.setItem('wayne_bot_last_sent', '0');
      BOT_MAX_TRADES  = parseInt((document.getElementById('botMaxTrades')  || {}).value) || 0;
      BOT_EXPIRY_TIME = ((document.getElementById('botExpiryTime') || {}).value || '').trim();
      BOT_LOSS_LIMIT  = parseInt((document.getElementById('botLossLimit')  || {}).value) || 0;
    }
    // Always reset dedup map so stale keys don't block new signals
    BOT_SENT_SIGS = {};
    if (!BOT_SCAN_TIMER) { // guard against double-start on tab switches
      runBotScan();
      BOT_SCAN_TIMER = setInterval(runBotScan, BOT_SCAN_INTERVAL_MS);
    }
  } else {
    if (BOT_SCAN_TIMER) { clearInterval(BOT_SCAN_TIMER); BOT_SCAN_TIMER = null; }
    updateBotStatusBadge();
  }
}

function setBotOrderType(type) {
  botOrderType = type;
  localStorage.setItem('wayne_bot_order_type', type);
  var pb = document.getElementById('botOrdPending');
  var mb = document.getElementById('botOrdMarket');
  if (pb) pb.classList.toggle('active', type === 'PENDING');
  if (mb) mb.classList.toggle('active', type === 'MARKET');
}

function setBotLotSize(val) {
  var v = parseFloat(val);
  botLotSize = (v > 0) ? v : 0.01;
  localStorage.setItem('wayne_bot_lot_size', String(botLotSize));
}

var _recentSigOpen = false;

function toggleRecentSignals() {
  _recentSigOpen = !_recentSigOpen;
  var panel = document.getElementById('recentSigPanel');
  var btn   = document.getElementById('recentSigBtn');
  if (!panel) return;

  if (!_recentSigOpen) {
    panel.style.display = 'none';
    if (btn) btn.style.background = '';
    return;
  }

  var sigs = loadSigLog().slice(-5).reverse(); // last 5, newest first
  if (!sigs.length) {
    panel.innerHTML = '<div class="recent-sig-empty">No signals logged yet</div>';
  } else {
    panel.innerHTML = sigs.map(function(s) {
      var dirCol = s.dir === 'buy' ? 'var(--green)' : 'var(--red)';
      var stCol  = s.status === 'WIN' ? 'var(--green)' : s.status === 'LOSS' ? 'var(--red)' :
                   s.status === 'LIVE' ? 'var(--cyan)' : 'var(--muted)';
      var dt = s.time ? s.time.substring(5, 16).replace('T', ' ') : '—';
      return '<div class="recent-sig-row">' +
        '<span class="recent-sig-time">' + dt + '</span>' +
        '<span style="font-weight:700;color:' + dirCol + '">' + (s.dir || '').toUpperCase() + '</span>' +
        '<span style="font-family:var(--num-font)">' + (s.entry || '—') + '</span>' +
        '<span style="font-family:var(--num-font);color:var(--red)">' + (s.sl || '—') + '</span>' +
        '<span style="font-family:var(--num-font);color:var(--green)">' + (s.tp || '—') + '</span>' +
        '<span style="color:' + stCol + ';font-weight:700;font-size:9px">' + (s.status || '—') + '</span>' +
      '</div>' +
      '<div style="font-size:9px;color:var(--muted);padding:0 6px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (s.basis || s.note || '') + '</div>';
    }).join('');
  }

  panel.style.display = 'block';
  if (btn) btn.style.background = 'rgba(0,229,255,.1)';
}

function setBotDirection(dir) {
  BOT_DIRECTION = dir;
  localStorage.setItem('wayne_bot_direction', dir);
  ['both','buy','sell'].forEach(function(d) {
    var btn = document.getElementById('botDir' + d.charAt(0).toUpperCase() + d.slice(1));
    if (btn) btn.classList.toggle('active', d === dir);
  });
}

function setBotFeature(key, val)   { BOT_FEATURES[key]   = val; }
function setBotStrategy(key, val)  { BOT_STRATEGIES[key] = val; }

function toggleTrendFollowerParams(on) {
  var el = document.getElementById('trendFollowerParams');
  if (el) el.style.display = on ? 'flex' : 'none';
}

function readTrendFollowerParams() {
  BOT_TF_TREND = (document.getElementById('tfTrend') || {}).value || 'auto';
  BOT_TF_MA    = parseInt((document.getElementById('tfMA') || {}).value) || 20;
}

// ── Bot scan ──────────────────────────────────────────────────────────────────
function runBotScan() {
  var mrEl = document.getElementById('botMarketRead');
  if (!ANA || !ANA.data || ANA.data.length < 30) {
    if (mrEl) mrEl.innerHTML = '<div class="bot-mread-empty">Load a symbol in single view first</div>';
    return;
  }

  var data    = ANA.data;
  var closes  = data.map(function(d){ return d.close; });
  var n       = data.length;
  var last    = data[n - 1];

  // ATR / range
  var atrVals  = ANA.atr.filter(function(v){ return v !== null; });
  var atrLast  = atrVals[atrVals.length - 1] || 0;
  var atrPct   = atrLast / last.close * 100;
  var isRanging = atrPct < 0.75;

  // RSI
  var rsiVals = ANA.rsi.filter(function(v){ return v !== null; });
  var rsiVal  = rsiVals[rsiVals.length - 1] || 50;
  var rsiOB   = rsiVal > 70;
  var rsiOS   = rsiVal < 30;

  // MACD
  var macdData      = calcMACD(closes, 12, 26, 9);
  var mLen          = macdData.macd.length;
  var macdNow       = macdData.macd[mLen - 1];
  var sigNow        = macdData.signal[mLen - 1];
  var macdPrev      = macdData.macd[mLen - 2];
  var sigPrev       = macdData.signal[mLen - 2];
  var macdCrossUp   = macdPrev !== null && sigPrev !== null && macdNow !== null && sigNow !== null && macdPrev < sigPrev && macdNow > sigNow;
  var macdCrossDown = macdPrev !== null && sigPrev !== null && macdNow !== null && sigNow !== null && macdPrev > sigPrev && macdNow < sigNow;

  // Swings
  var swings = findSwings(data, 5);
  var swingH = swings.highs.length ? swings.highs[swings.highs.length - 1] : null;
  var swingL = swings.lows.length  ? swings.lows[swings.lows.length  - 1] : null;

  // Render market read grid
  renderBotMarketRead({
    price: last.close, isRanging: isRanging, atrLast: atrLast, atrPct: atrPct,
    rsiVal: rsiVal, rsiOB: rsiOB, rsiOS: rsiOS,
    macdNow: macdNow, sigNow: sigNow, macdCrossUp: macdCrossUp, macdCrossDown: macdCrossDown,
    swingH: swingH, swingL: swingL, trend: ANA.trend,
  });

  // SL override: user-entered pts, else fall back to 1× ATR
  var slPtsEl = document.getElementById('botSlPts');
  var slMove  = (slPtsEl && parseFloat(slPtsEl.value) > 0) ? parseFloat(slPtsEl.value) : atrLast;

  // 50-bar range for context
  var slice50 = data.slice(-50);
  var rHigh50 = Math.max.apply(null, slice50.map(function(b){ return b.high; }));
  var rLow50  = Math.min.apply(null, slice50.map(function(b){ return b.low;  }));
  var rMid50  = (rHigh50 + rLow50) / 2;

  // Build bot log
  BOT_LOG = [];
  var now = new Date().toISOString();
  var price = last.close;

  if (BOT_FEATURES.rangeDetect) {
    if (isRanging) {
      var nearHigh = price >= rHigh50 - atrLast;
      var nearLow  = price <= rLow50  + atrLast;
      if (nearHigh) {
        BOT_LOG.push({ time: now, strategy: 'Range Detect', signal: 'RANGE TOP', dir: 'sell',
          entry: price, sl: price + slMove, tp: rMid50,
          detail: 'At 50-bar high ' + rHigh50.toFixed(2) + ' — fade to mid ' + rMid50.toFixed(2) });
      } else if (nearLow) {
        BOT_LOG.push({ time: now, strategy: 'Range Detect', signal: 'RANGE BTM', dir: 'buy',
          entry: price, sl: price - slMove, tp: rMid50,
          detail: 'At 50-bar low ' + rLow50.toFixed(2) + ' — fade to mid ' + rMid50.toFixed(2) });
      } else {
        BOT_LOG.push({ time: now, strategy: 'Range Detect', signal: 'MID-RANGE', dir: '—',
          detail: 'H ' + rHigh50.toFixed(2) + ' · L ' + rLow50.toFixed(2) + ' · Mid ' + rMid50.toFixed(2) });
      }
    } else {
      BOT_LOG.push({ time: now, strategy: 'Range Detect', signal: 'TRENDING',  dir: '—',
        detail: 'ATR ' + atrPct.toFixed(2) + '% — not ranging' });
    }
  }

  if (BOT_FEATURES.rsiSignals) {
    if (rsiOB) BOT_LOG.push({ time: now, strategy: 'RSI Signal', signal: 'OVERBOUGHT', dir: 'sell',
      entry: price, sl: price + slMove, tp: price - slMove * 2,
      detail: 'RSI ' + rsiVal.toFixed(1) + ' > 70 · SL ' + slMove.toFixed(2) + ' pts' });
    if (rsiOS) BOT_LOG.push({ time: now, strategy: 'RSI Signal', signal: 'OVERSOLD', dir: 'buy',
      entry: price, sl: price - slMove, tp: price + slMove * 2,
      detail: 'RSI ' + rsiVal.toFixed(1) + ' < 30 · SL ' + slMove.toFixed(2) + ' pts' });
  }

  if (BOT_FEATURES.macdCross) {
    if (macdCrossUp) BOT_LOG.push({ time: now, strategy: 'MACD Cross', signal: 'BULL CROSS', dir: 'buy',
      entry: price, sl: price - slMove, tp: price + slMove * 2,
      detail: 'MACD ' + (macdNow||0).toFixed(4) + ' crossed above signal' });
    if (macdCrossDown) BOT_LOG.push({ time: now, strategy: 'MACD Cross', signal: 'BEAR CROSS', dir: 'sell',
      entry: price, sl: price + slMove, tp: price - slMove * 2,
      detail: 'MACD ' + (macdNow||0).toFixed(4) + ' crossed below signal' });
  }

  if (BOT_FEATURES.swingFlags) {
    if (swingH) {
      var nearSH = Math.abs(price - swingH.price) <= atrLast * 1.5;
      BOT_LOG.push({ time: now, strategy: 'Swing Flag', signal: 'SWING HIGH', dir: nearSH ? 'sell' : '—',
        entry: nearSH ? price : null, sl: nearSH ? price + slMove : null, tp: nearSH ? price - slMove * 2 : null,
        detail: 'H: ' + swingH.price.toFixed(2) + ' @ ' + swingH.date + (nearSH ? ' — NEAR' : '') });
    }
    if (swingL) {
      var nearSL = Math.abs(price - swingL.price) <= atrLast * 1.5;
      BOT_LOG.push({ time: now, strategy: 'Swing Flag', signal: 'SWING LOW', dir: nearSL ? 'buy' : '—',
        entry: nearSL ? price : null, sl: nearSL ? price - slMove : null, tp: nearSL ? price + slMove * 2 : null,
        detail: 'L: ' + swingL.price.toFixed(2) + ' @ ' + swingL.date + (nearSL ? ' — NEAR' : '') });
    }
  }

  // Vault strategies
  if (BOT_STRATEGIES.rsiBounce && rsiOS && isRanging) {
    var e = price;
    BOT_LOG.push({ time: now, strategy: 'RSI Bounce', signal: 'BUY SETUP', dir: 'buy',
      entry: e, sl: e - slMove, tp: e + slMove * 2, detail: 'RSI OS + Ranging — SL ' + slMove.toFixed(2) + ' pts' });
  }
  if (BOT_STRATEGIES.macdEntry && (macdCrossUp || macdCrossDown)) {
    var dir2 = macdCrossUp ? 'buy' : 'sell';
    BOT_LOG.push({ time: now, strategy: 'MACD Entry', signal: dir2.toUpperCase() + ' SIGNAL', dir: dir2,
      entry: price,
      sl: dir2 === 'buy' ? price - slMove : price + slMove,
      tp: dir2 === 'buy' ? price + slMove * 2 : price - slMove * 2,
      detail: 'MACD cross — SL ' + slMove.toFixed(2) + ' pts · 2R' });
  }
  if (BOT_STRATEGIES.structBreak) {
    var tStr = ANA.trend ? ANA.trend.structure : '';
    if (tStr.indexOf('HH') >= 0 && swingH && price > swingH.price) {
      BOT_LOG.push({ time: now, strategy: 'Structure Break', signal: 'BULL BREAK', dir: 'buy',
        entry: price, sl: price - slMove, tp: price + slMove * 2, detail: 'Above swing high ' + swingH.price.toFixed(2) });
    }
    if (tStr.indexOf('LL') >= 0 && swingL && price < swingL.price) {
      BOT_LOG.push({ time: now, strategy: 'Structure Break', signal: 'BEAR BREAK', dir: 'sell',
        entry: price, sl: price + slMove, tp: price - slMove * 2, detail: 'Below swing low ' + swingL.price.toFixed(2) });
    }
  }
  if (BOT_STRATEGIES.rangeFade && isRanging) {
    var rBand = (rHigh50 - rLow50) * 0.3;
    if (price > rMid50 + rBand) {
      BOT_LOG.push({ time: now, strategy: 'Range Fade', signal: 'FADE SELL', dir: 'sell',
        entry: price, sl: price + slMove, tp: rMid50, detail: 'Near range top — target mid ' + rMid50.toFixed(2) });
    } else if (price < rMid50 - rBand) {
      BOT_LOG.push({ time: now, strategy: 'Range Fade', signal: 'FADE BUY', dir: 'buy',
        entry: price, sl: price - slMove, tp: rMid50, detail: 'Near range bottom — target mid ' + rMid50.toFixed(2) });
    }
  }

  if (BOT_STRATEGIES.asiaBreakout) {
    var localHour    = new Date().getHours();
    var inAsiaWindow = localHour >= 1 && localHour < 9;
    var pipSz        = 0.01;          // XAUUSD: 1 pip = 0.01
    var tpDist       = 50 * pipSz;    // 50 pips target
    var minSlDist    = 25 * pipSz;    // 25 pip floor for SL

    if (!inAsiaWindow) {
      BOT_LOG.push({ time: now, strategy: 'Asia Breakout', signal: 'WAITING', dir: '—',
        detail: 'Active 01:00–09:00 local · now ' + String(localHour).padStart(2, '0') + ':00' });
    } else {
      // Asian range from last 40 M15 bars (~10 hours)
      var asiaBars  = ANA_RAW_M15 ? ANA_RAW_M15.slice(-40) : data.slice(-40);
      var asiaHigh  = Math.max.apply(null, asiaBars.map(function(b){ return b.high; }));
      var asiaLow   = Math.min.apply(null, asiaBars.map(function(b){ return b.low;  }));

      if (price > asiaHigh) {
        var slBuy = Math.min(asiaLow, price - minSlDist);
        BOT_LOG.push({ time: now, strategy: 'Asia Breakout', signal: 'BULL BREAK', dir: 'buy',
          entry: price, sl: slBuy, tp: price + tpDist,
          detail: 'Break > Asia H ' + asiaHigh.toFixed(2) + ' · TP 50 pips · SL ' + slBuy.toFixed(2) });
      } else if (price < asiaLow) {
        var slSell = Math.max(asiaHigh, price + minSlDist);
        BOT_LOG.push({ time: now, strategy: 'Asia Breakout', signal: 'BEAR BREAK', dir: 'sell',
          entry: price, sl: slSell, tp: price - tpDist,
          detail: 'Break < Asia L ' + asiaLow.toFixed(2) + ' · TP 50 pips · SL ' + slSell.toFixed(2) });
      } else {
        BOT_LOG.push({ time: now, strategy: 'Asia Breakout', signal: 'IN RANGE', dir: '—',
          detail: 'H ' + asiaHigh.toFixed(2) + '  L ' + asiaLow.toFixed(2) + ' — waiting for break' });
      }
    }
  }

  if (BOT_STRATEGIES.trendFollower) {
    readTrendFollowerParams();

    var emaKey = BOT_TF_MA === 200 ? 'e200' : BOT_TF_MA === 50 ? 'e50' : 'e20';
    var emaArr = ANA.emas[emaKey];
    var emaVal = emaArr ? emaArr[emaArr.length - 1] : null;
    var maLbl  = 'EMA' + BOT_TF_MA;

    if (!emaVal) {
      BOT_LOG.push({ time: now, strategy: 'Trend Follower', signal: 'NO DATA', dir: '—',
        detail: maLbl + ' not computed — need more bars' });
    } else {
      // Resolve effective trend direction
      var effTrend = BOT_TF_TREND;
      if (effTrend === 'auto') {
        var tot = ANA.trend ? ANA.trend.total : 0;
        effTrend = tot > 0 ? 'up' : tot < 0 ? 'down' : null;
      }

      var touchZone = atrLast * 0.6; // price within 0.6× ATR of MA = "touching"
      var dist      = price - emaVal; // positive = price above MA
      var touching  = Math.abs(dist) <= touchZone;

      if (!effTrend) {
        BOT_LOG.push({ time: now, strategy: 'Trend Follower', signal: 'NEUTRAL', dir: '—',
          detail: maLbl + ' ' + emaVal.toFixed(2) + ' · trend unclear — set direction manually' });
      } else if (!touching) {
        var awayDir = dist > 0 ? 'above' : 'below';
        BOT_LOG.push({ time: now, strategy: 'Trend Follower', signal: 'WAITING', dir: '—',
          detail: maLbl + ' ' + emaVal.toFixed(2) + ' · price ' + awayDir + ' by ' + Math.abs(dist).toFixed(2) + ' — waiting for touch' });
      } else if (effTrend === 'down') {
        // Downtrend: price has rallied up to the MA → sell
        var slSell = parseFloat((emaVal + atrLast * 1.0).toFixed(2));
        var tpSell = parseFloat((price  - atrLast * 2.0).toFixed(2));
        BOT_LOG.push({ time: now, strategy: 'Trend Follower', signal: 'SELL @ ' + maLbl, dir: 'sell',
          entry: parseFloat(price.toFixed(2)), sl: slSell, tp: tpSell,
          detail: 'Downtrend · rally to ' + maLbl + ' ' + emaVal.toFixed(2) + ' · SL ' + slSell + ' · TP ' + tpSell });
      } else if (effTrend === 'up') {
        // Uptrend: price has pulled back down to the MA → buy
        var slBuy = parseFloat((emaVal - atrLast * 1.0).toFixed(2));
        var tpBuy = parseFloat((price  + atrLast * 2.0).toFixed(2));
        BOT_LOG.push({ time: now, strategy: 'Trend Follower', signal: 'BUY @ ' + maLbl, dir: 'buy',
          entry: parseFloat(price.toFixed(2)), sl: slBuy, tp: tpBuy,
          detail: 'Uptrend · dip to ' + maLbl + ' ' + emaVal.toFixed(2) + ' · SL ' + slBuy + ' · TP ' + tpBuy });
      }
    }
  }

  renderBotLog();

  // Auto-dispatch when bot is ON
  if (BOT_ENABLED) autoBotDispatch();
}

// ── Entry gate — tight quality filter before any dispatch ────────────────────
function passesEntryGate(sig) {
  if (!sig.entry || !sig.sl || !sig.tp || sig.dir === '—') return false;

  // 1. Minimum 1.5:1 RR
  var risk   = Math.abs(sig.entry - sig.sl);
  var reward = Math.abs(sig.tp    - sig.entry);
  if (risk === 0 || reward / risk < 1.5) return false;

  if (!ANA) return false; // no data yet

  // 2. Trend alignment — don't trade against a confirmed trend
  if (ANA.trend) {
    var td = ANA.trend.direction;
    if (sig.dir === 'sell' && (td === 'STRONG BULL' || td === 'BULLISH')) return false;
    if (sig.dir === 'buy'  && (td === 'STRONG BEAR' || td === 'BEARISH')) return false;
  }

  // 3. Entry must be within 2× ATR of a matching S/R zone
  var atrArr  = ANA.atr.filter(function(v){ return v !== null; });
  var atrLast = atrArr[atrArr.length - 1] || 1;
  var hasZone = ANA.zones.some(function(z) {
    if (Math.abs(z.price - sig.entry) > atrLast * 2) return false;
    if (sig.dir === 'buy'  && (z.type === 'support'    || z.type === 'both')) return true;
    if (sig.dir === 'sell' && (z.type === 'resistance' || z.type === 'both')) return true;
    return false;
  });
  if (!hasZone) return false;

  // 4. RSI must not strongly oppose direction
  var rsiArr = ANA.rsi.filter(function(v){ return v !== null; });
  if (rsiArr.length) {
    var rsi = rsiArr[rsiArr.length - 1];
    if (sig.dir === 'buy'  && rsi > 72) return false; // buying into overbought
    if (sig.dir === 'sell' && rsi < 28) return false; // selling into oversold
  }

  return true;
}

// Count consecutive LOSS-marked signals from most recent backwards
function countConsecLosses() {
  var sigs  = loadSigLog();
  var count = 0;
  for (var i = sigs.length - 1; i >= 0; i--) {
    var st = sigs[i].status;
    if      (st === 'LOSS')              count++;
    else if (st === 'WIN' || st === 'BE') break;
    // LIVE / PENDING / CANCEL don't reset or count the streak
  }
  return count;
}

// ── Bot auto-dispatch ─────────────────────────────────────────────────────────
function botSigKey(s) {
  // Dedup key: same strategy + direction + entry (0.1 precision) = same signal
  return (s.strategy + '|' + s.dir + '|' + Math.round((s.entry || 0) * 10)).toLowerCase();
}

function autoBotDispatch() {
  var now      = Date.now();
  var cooldown = 45 * 60 * 1000; // 45-minute cooldown per unique signal
  var sent     = 0;

  // ── 15-min global cooldown — bot can't send twice in quick succession ──────
  var msSinceLast = now - BOT_LAST_SENT_AT;
  if (BOT_LAST_SENT_AT > 0 && msSinceLast < BOT_SEND_COOLDOWN_MS) {
    var minsLeft = Math.ceil((BOT_SEND_COOLDOWN_MS - msSinceLast) / 60000);
    var el = document.getElementById('botMasterStatus');
    if (el) { el.textContent = 'ON · cooldown ' + minsLeft + 'm'; el.className = 'bot-status-badge bot-status-on'; }
    return;
  }

  // ── Expiry check ──────────────────────────────────────────────────────────
  if (BOT_EXPIRY_TIME) {
    var parts  = BOT_EXPIRY_TIME.split(':');
    var expiry = new Date();
    expiry.setHours(parseInt(parts[0]) || 0, parseInt(parts[1]) || 0, 0, 0);
    if (new Date() >= expiry) {
      var sw = document.getElementById('botMasterSwitch');
      if (sw) sw.checked = false;
      toggleBotMaster(false);
      showBotToast('Bot expired at ' + BOT_EXPIRY_TIME + ' — auto-disabled', 'warn');
      return;
    }
  }

  // ── Max trade cap ─────────────────────────────────────────────────────────
  if (BOT_MAX_TRADES > 0 && BOT_TRADE_COUNT >= BOT_MAX_TRADES) {
    var sw = document.getElementById('botMasterSwitch');
    if (sw) sw.checked = false;
    toggleBotMaster(false);
    showBotToast('Max trades reached (' + BOT_MAX_TRADES + ') — bot disabled', 'warn');
    return;
  }

  // ── Loss protection ───────────────────────────────────────────────────────
  if (BOT_LOSS_LIMIT > 0) {
    var losses = countConsecLosses();
    if (losses >= BOT_LOSS_LIMIT) {
      var sw = document.getElementById('botMasterSwitch');
      if (sw) sw.checked = false;
      toggleBotMaster(false);
      showBotToast('Loss protection: ' + losses + ' consecutive losses — bot disabled', 'err');
      return;
    }
  }

  // ── Entry gate + direction filter + cooldown ─────────────────────────────
  BOT_LOG.forEach(function(s) {
    if (!passesEntryGate(s)) return;
    // Skip signals against the allowed direction (BOTH = no filter)
    if (BOT_DIRECTION !== 'both' && s.dir !== '—' && s.dir !== BOT_DIRECTION) return;
    var key = botSigKey(s);
    if (BOT_SENT_SIGS[key] && (now - BOT_SENT_SIGS[key]) < cooldown) return;
    if (BOT_MAX_TRADES > 0 && BOT_TRADE_COUNT >= BOT_MAX_TRADES) return;

    BOT_SENT_SIGS[key] = now;
    dispatchBotSignal(s);
    sent++;
  });

  updateBotStatusBadge(sent);
}

function dispatchBotSignal(s) {
  var blankConf = {};
  CONF_DEFS.forEach(function(c){ blankConf[c.key] = false; });
  var sig = {
    id:           Date.now() + Math.floor(Math.random() * 1000),
    time:         s.time || new Date().toISOString(),
    symbol:       ANA_ACTIVE_SYMBOL || '—',
    dir:          s.dir,
    entry:        s.entry,
    sl:           s.sl,
    tp:           s.tp,
    lot:          botLotSize,
    orderType:    botOrderType,
    basis:        s.strategy + ' — ' + s.signal,
    note:         s.detail || '',
    status:       'LIVE',
    confluences:  blankConf,
    confRequired: CONF_REQUIRED,
    mt4Status:    null,
    mlFeatures:   extractMLFeatures(s.dir), // capture market state for ML training
  };
  var sigs = loadSigLog();
  sigs.push(sig);
  saveSigLog(sigs);
  BOT_TRADE_COUNT++;
  BOT_LAST_SENT_AT = Date.now();
  localStorage.setItem('wayne_bot_last_sent', String(BOT_LAST_SENT_AT)); // survives refresh
  renderSigLog();
  sendSignalToMT4(sig.id);
}

function updateBotStatusBadge(newCount) {
  var el = document.getElementById('botMasterStatus');
  if (!el) return;
  if (!BOT_ENABLED) {
    el.textContent = 'OFF';
    el.className   = 'bot-status-badge bot-status-off';
    return;
  }
  var total = Object.keys(BOT_SENT_SIGS).length;
  el.textContent = newCount ? 'ON · ▶ ' + newCount + ' sent' : (total ? 'ON · ' + total + ' total' : 'ON · scanning');
  el.className   = 'bot-status-badge bot-status-on';
}

function testBotSignal() {
  // Use current chart price so the EA gets valid stops
  var price = ANA && ANA.data && ANA.data.length
    ? ANA.data[ANA.data.length - 1].close
    : 4500;
  var atrVal = ANA && ANA.atr
    ? (ANA.atr.filter(function(v){ return v; }).slice(-1)[0] || 10)
    : 10;
  var sl = parseFloat((price - atrVal).toFixed(2));
  var tp = parseFloat((price + atrVal * 2).toFixed(2));

  var sig = {
    strategy: 'Test Fire',
    signal:   'TEST SIGNAL',
    dir:      'buy',
    entry:    parseFloat(price.toFixed(2)),
    sl:       sl,
    tp:       tp,
    detail:   'Manual test — LMT ' + price.toFixed(2) + ' SL ' + sl + ' TP ' + tp,
    time:     new Date().toISOString(),
  };
  dispatchBotSignal(sig);

  var btn = document.querySelector('.bot-test-btn');
  if (btn) {
    btn.textContent = '⏳ Firing…';
    btn.disabled = true;
    setTimeout(function() { btn.textContent = '⚡ Test'; btn.disabled = false; }, 3000);
  }
}

function renderBotMarketRead(d) {
  var el = document.getElementById('botMarketRead');
  if (!el) return;
  function cell(lbl, val, col) {
    return '<div class="bot-mread-item">' +
      '<span class="bot-mread-lbl">' + lbl + '</span>' +
      '<span class="bot-mread-val" style="color:' + (col || 'var(--text)') + '">' + val + '</span>' +
    '</div>';
  }
  var trendDir = d.trend ? d.trend.direction : '—';
  var trendCol = !d.trend ? 'var(--muted)' :
    d.trend.colorClass === 'green' ? 'var(--green)' :
    d.trend.colorClass === 'red'   ? 'var(--red)'   : 'var(--gold)';
  var rsiColor = d.rsiOB ? 'var(--red)' : d.rsiOS ? 'var(--green)' : 'var(--text)';
  var macdColor = d.macdCrossUp ? 'var(--green)' : d.macdCrossDown ? 'var(--red)' : 'var(--text)';
  var macdLabel = d.macdCrossUp ? '▲ CROSS UP' : d.macdCrossDown ? '▼ CROSS DN' : (d.macdNow || 0).toFixed(4);
  el.innerHTML =
    cell('Price',   d.price.toFixed(2),  'var(--gold)') +
    cell('Regime',  d.isRanging ? 'RANGING' : 'TRENDING', d.isRanging ? 'var(--gold)' : 'var(--cyan)') +
    cell('ATR(14)', d.atrLast.toFixed(2) + ' / ' + d.atrPct.toFixed(2) + '%') +
    cell('Trend',   trendDir, trendCol) +
    cell('RSI(14)', (d.rsiVal || 0).toFixed(1) + (d.rsiOB ? ' OB' : d.rsiOS ? ' OS' : ''), rsiColor) +
    cell('MACD',    macdLabel, macdColor) +
    cell('Swing H', d.swingH ? d.swingH.price.toFixed(2) : '—', 'var(--red)') +
    cell('Swing L', d.swingL ? d.swingL.price.toFixed(2) : '—', 'var(--green)');
}

function renderBotLog() {
  var el = document.getElementById('botSigBody');
  if (!el) return;
  if (!BOT_LOG.length) {
    el.innerHTML = '<tr><td colspan="9" class="sig-empty">No signals generated — run Scan Now</td></tr>';
    return;
  }
  el.innerHTML = BOT_LOG.map(function(s, idx) {
    var dirCol  = s.dir === 'buy' ? 'var(--green)' : s.dir === 'sell' ? 'var(--red)' : 'var(--muted)';
    var hasSetup = s.entry != null && s.sl != null && s.tp != null;
    var rr       = hasSetup ? Math.abs(s.tp - s.entry) / Math.abs(s.entry - s.sl) : 0;
    return '<tr>' +
      '<td>' + (s.time || '').substring(11, 16) + '</td>' +
      '<td>' + s.strategy + '</td>' +
      '<td style="color:' + dirCol + ';font-weight:700">' + s.signal + '</td>' +
      '<td style="color:' + dirCol + '">' + (s.dir !== '—' ? s.dir.toUpperCase() : '—') + '</td>' +
      '<td>' + (hasSetup ? s.entry.toFixed(2) : '—') + '</td>' +
      '<td style="color:var(--red)">' + (hasSetup ? s.sl.toFixed(2) : '—') + '</td>' +
      '<td style="color:var(--green)">' + (hasSetup ? s.tp.toFixed(2) + ' <small style="color:var(--muted)">' + rr.toFixed(1) + 'R</small>' : '—') + '</td>' +
      '<td style="color:var(--muted);font-size:10px">' + s.detail + '</td>' +
      '<td>' + (hasSetup
        ? '<button class="sig-act-btn sig-act-live" onclick="addBotSignalToLog(' + idx + ')" title="Push to Signal Log">&#43; Log</button>'
        : '') + '</td>' +
    '</tr>';
  }).join('');
}

function addBotSignalToLog(idx) {
  var s = BOT_LOG[idx];
  if (!s || !s.entry) return;
  var sigs = loadSigLog();
  var blankConf = {};
  CONF_DEFS.forEach(function(c){ blankConf[c.key] = false; });
  sigs.push({
    id:           Date.now(),
    time:         s.time || new Date().toISOString(),
    symbol:       ANA_ACTIVE_SYMBOL || '—',
    dir:          s.dir,
    entry:        s.entry,
    sl:           s.sl   || 0,
    tp:           s.tp   || 0,
    lot:          botLotSize,
    orderType:    botOrderType,
    basis:        s.strategy + ' — ' + s.signal,
    note:         s.detail || '',
    status:       'PENDING',
    confluences:  blankConf,
    confRequired: CONF_REQUIRED,
    mt4Status:    null,
  });
  saveSigLog(sigs);
  showBotTab('signals');
}

// ── Toast notification ────────────────────────────────────────────────────────
function showBotToast(msg, type) {
  var el = document.getElementById('botToast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'bot-toast bot-toast-' + (type || 'info') + ' bot-toast-show';
  clearTimeout(el._t);
  el._t = setTimeout(function() { el.classList.remove('bot-toast-show'); }, 4000);
}

// ── MT4 Signal Bridge ─────────────────────────────────────────────────────────
function sendSignalToMT4(sigId) {
  var sigs = loadSigLog();
  var sig  = null;
  for (var i = 0; i < sigs.length; i++) { if (sigs[i].id === sigId) { sig = sigs[i]; break; } }
  if (!sig) return;

  sig.mt4Status = 'SENDING';
  saveSigLog(sigs);
  renderSigLog();

  fetch('/api/signal/write', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      id:        sig.id,
      symbol:    sig.symbol,
      dir:       (sig.dir || '').toUpperCase(),
      orderType: (sig.orderType || 'PENDING').toUpperCase(),
      entry:     sig.entry,
      sl:        sig.sl,
      tp:        sig.tp,
      lot:       sig.lot || botLotSize,
      magic:     sig.id,
      timestamp: sig.time,
    }),
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    var s2 = loadSigLog();
    for (var j = 0; j < s2.length; j++) {
      if (s2[j].id !== sigId) continue;
      s2[j].mt4Status = res.ok ? 'SENT' : 'ERROR';
      saveSigLog(s2);
      renderSigLog();
      if (res.ok) {
        showBotToast('✓ Signal file written → ' + (res.file || ''), 'ok');
        pollMT4Status(sigId);
      } else {
        showBotToast('✗ Write failed: ' + (res.error || 'unknown error'), 'err');
      }
      break;
    }
  })
  .catch(function(err) {
    var s2 = loadSigLog();
    for (var j = 0; j < s2.length; j++) {
      if (s2[j].id !== sigId) continue;
      s2[j].mt4Status = 'ERROR';
      saveSigLog(s2); renderSigLog(); break;
    }
    showBotToast('✗ Server unreachable — is py server.py running?', 'err');
  });
}

function pollMT4Status(sigId) {
  var timer = setInterval(function() {
    fetch('/api/signal/status?id=' + sigId)
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.status === 'EXECUTED' || res.status === 'ERROR') {
          clearInterval(timer);
          var s2 = loadSigLog();
          for (var j = 0; j < s2.length; j++) {
            if (s2[j].id !== sigId) continue;
            s2[j].mt4Status  = res.status;
            if (res.ticket)    s2[j].mt4Ticket = res.ticket;
            if (res.fillPrice) s2[j].mt4Fill   = res.fillPrice;
            saveSigLog(s2);
            renderSigLog();
            if (res.status === 'EXECUTED') showBotToast('✓ EA executed — ticket #' + res.ticket, 'ok');
            else showBotToast('✗ EA error: ' + (res.reason || 'check MT4 journal'), 'err');
            break;
          }
        }
      })
      .catch(function() { /* keep polling */ });
  }, 3000);
}

// ── Drag-to-reorder cards ────────────────────────────────────────────────────
var _dragCard = null;

function initCardDrag() {
  var CONTAINERS = ['ana-sidebar-cards', 'ana-main-cards'];

  CONTAINERS.forEach(function(cid) {
    var container = document.getElementById(cid);
    if (!container) return;

    // Find all direct draggable cards (those with a drag handle)
    var cards = container.querySelectorAll(':scope > [id^="dcard-"]');

    cards.forEach(function(card) {
      var handle = card.querySelector('.card-drag-handle');
      if (!handle) return;

      // Only enable dragging via the handle
      handle.addEventListener('mousedown', function() { card.draggable = true; });
      handle.addEventListener('mouseup',   function() { card.draggable = false; });

      card.addEventListener('dragstart', function(e) {
        _dragCard = card;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(function() { card.classList.add('card-dragging'); }, 0);
      });

      card.addEventListener('dragend', function() {
        card.draggable = false;
        card.classList.remove('card-dragging');
        document.querySelectorAll('.card-drag-over').forEach(function(el) {
          el.classList.remove('card-drag-over');
        });
        _dragCard = null;
        saveCardOrder();
      });

      card.addEventListener('dragover', function(e) {
        if (!_dragCard || _dragCard === card) return;
        if (_dragCard.parentNode !== card.parentNode) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.card-drag-over').forEach(function(el) {
          el.classList.remove('card-drag-over');
        });
        card.classList.add('card-drag-over');
      });

      card.addEventListener('dragleave', function(e) {
        if (!card.contains(e.relatedTarget)) card.classList.remove('card-drag-over');
      });

      card.addEventListener('drop', function(e) {
        if (!_dragCard || _dragCard === card) return;
        if (_dragCard.parentNode !== card.parentNode) return;
        e.preventDefault();
        card.classList.remove('card-drag-over');

        var parent   = card.parentNode;
        var children = Array.from(parent.querySelectorAll(':scope > [id^="dcard-"]'));
        var srcIdx   = children.indexOf(_dragCard);
        var dstIdx   = children.indexOf(card);

        if (srcIdx < dstIdx) {
          parent.insertBefore(_dragCard, card.nextElementSibling);
        } else {
          parent.insertBefore(_dragCard, card);
        }
      });
    });
  });

  restoreCardOrder();
}

function saveCardOrder() {
  var order = {};
  ['ana-sidebar-cards', 'ana-main-cards'].forEach(function(cid) {
    var container = document.getElementById(cid);
    if (!container) return;
    order[cid] = Array.from(container.querySelectorAll(':scope > [id^="dcard-"]'))
                      .map(function(c) { return c.id; });
  });
  try { localStorage.setItem('wayne_card_order', JSON.stringify(order)); } catch(e) {}
}

function restoreCardOrder() {
  try {
    var raw = localStorage.getItem('wayne_card_order');
    if (!raw) return;
    var order = JSON.parse(raw);
    Object.keys(order).forEach(function(cid) {
      var container = document.getElementById(cid);
      if (!container) return;
      order[cid].forEach(function(id) {
        var card = document.getElementById(id);
        if (card && card.parentNode === container) container.appendChild(card);
      });
    });
  } catch(e) {}
}

