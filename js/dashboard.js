'use strict';

var STMT_KEY    = 'wayne_stmt_v1';
var stmtTrades  = [];
var stmtCharts  = {};
var logFilter   = 'all';

// ── Tab switching ─────────────────────────────────────────────────────────────

function showTab(tab) {
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  document.getElementById('view-' + tab).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'dashboard') initDashboard();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function initDashboard() {
  try {
    var cached = JSON.parse(localStorage.getItem(STMT_KEY) || 'null');
    if (cached && Array.isArray(cached.trades) && cached.trades.length > 0) {
      stmtTrades = cached.trades.map(function(t) {
        t.openDate  = t.openDate  ? new Date(t.openDate)  : null;
        t.closeDate = t.closeDate ? new Date(t.closeDate) : null;
        return t;
      });
      renderDashboard();
      return;
    }
  } catch(e) {}
  fetchStatement();
}

function fetchStatement() {
  fetch('DetailedStatement.htm')
    .then(function(r) { if (!r.ok) throw new Error('not found'); return r.text(); })
    .then(function(html) {
      stmtTrades = parseStatement(html);
      cacheStmt();
      renderDashboard();
    })
    .catch(function() {
      document.getElementById('dashLoader').style.display  = 'block';
      document.getElementById('dashContent').style.display = 'none';
    });
}

function reloadStatement() {
  try { localStorage.removeItem(STMT_KEY); } catch(e) {}
  destroyCharts();
  document.getElementById('dashContent').style.display = 'none';
  document.getElementById('dashLoader').style.display  = 'none';
  fetchStatement();
}

function loadStatementFile(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    stmtTrades = parseStatement(e.target.result);
    cacheStmt();
    document.getElementById('dashLoader').style.display = 'none';
    renderDashboard();
  };
  reader.readAsText(file);
}

function cacheStmt() {
  try { localStorage.setItem(STMT_KEY, JSON.stringify({ trades: stmtTrades })); } catch(e) {}
}

// ── Parse DetailedStatement.htm ───────────────────────────────────────────────

function parseStatement(htmlText) {
  var parser = new DOMParser();
  var doc    = parser.parseFromString(htmlText, 'text/html');
  var trades = [];

  doc.querySelectorAll('table tr').forEach(function(row) {
    var cells = row.querySelectorAll('td');
    if (cells.length < 14) return;

    var type = cells[2].textContent.trim().toLowerCase();
    if (type !== 'buy' && type !== 'sell') return;

    var closeTime = cells[8].textContent.trim();
    if (!closeTime || closeTime.length < 10) return; // open trades have no close

    var profit = pn(cells[13].textContent);
    if (isNaN(profit)) return;

    var isSLHit = cells[0].getAttribute('title') === '[sl]';
    var openD   = pd(cells[1].textContent.trim());
    var closeD  = pd(closeTime);

    trades.push({
      ticket:     cells[0].textContent.trim(),
      openTime:   cells[1].textContent.trim(),
      type:       type,
      size:       pn(cells[3].textContent),
      item:       cells[4].textContent.trim().toLowerCase(),
      openPrice:  pn(cells[5].textContent),
      sl:         pn(cells[6].textContent),
      tp:         pn(cells[7].textContent),
      closeTime:  closeTime,
      closePrice: pn(cells[9].textContent),
      profit:     profit,
      isSLHit:    isSLHit,
      isWin:      profit > 0,
      openDate:   openD  ? openD.toISOString()  : null,
      closeDate:  closeD ? closeD.toISOString() : null
    });
  });

  return trades;
}

// helpers
function pn(s) { return parseFloat(String(s).replace(/[\s ]/g, '').replace(',', '.')); }
function pd(s) {
  if (!s) return null;
  var m = s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) : null;
}
function closeD(t) { return t.closeDate ? new Date(t.closeDate) : null; }
function fmtDay(d) {
  if (!d) return '';
  var cd = new Date(d);
  return cd.getFullYear() + '-' + p2(cd.getMonth()+1) + '-' + p2(cd.getDate());
}
function fmtWeek(d) {
  if (!d) return '';
  var cd = new Date(d); cd.setHours(0,0,0,0);
  cd.setDate(cd.getDate() + 3 - (cd.getDay()+6)%7);
  var w1 = new Date(cd.getFullYear(), 0, 4);
  var wk = 1 + Math.round(((cd - w1)/86400000 - 3 + (w1.getDay()+6)%7) / 7);
  return cd.getFullYear() + ' W' + p2(wk);
}
function p2(n) { return n < 10 ? '0'+n : ''+n; }
function rZar(n) { return 'R ' + Math.round(Math.abs(n)).toLocaleString(); }

// ── Chart cleanup ─────────────────────────────────────────────────────────────

function destroyCharts() {
  Object.keys(stmtCharts).forEach(function(k) {
    if (stmtCharts[k]) { stmtCharts[k].destroy(); stmtCharts[k] = null; }
  });
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderDashboard() {
  destroyCharts();
  logFilter = 'all';
  document.getElementById('dashContent').style.display = 'block';
  document.getElementById('dashLoader').style.display  = 'none';

  renderKPIs(stmtTrades);
  renderEquityChart(stmtTrades);
  renderDailyChart(stmtTrades);
  renderWeeklyChart(stmtTrades);
  renderWinLossChart(stmtTrades);
  renderSymbolChart(stmtTrades);
  renderLogFilters();
  renderTradeLog(stmtTrades);
}

// ── KPI cards ─────────────────────────────────────────────────────────────────

function renderKPIs(trades) {
  var wins   = trades.filter(function(t) { return t.profit > 0; });
  var losses = trades.filter(function(t) { return t.profit <= 0; });
  var totalPL = trades.reduce(function(s,t) { return s + t.profit; }, 0);
  var winRate  = trades.length ? wins.length / trades.length * 100 : 0;
  var avgWin   = wins.length   ? wins.reduce(function(s,t){return s+t.profit;},0)/wins.length : 0;
  var avgLoss  = losses.length ? Math.abs(losses.reduce(function(s,t){return s+t.profit;},0)/losses.length) : 0;
  var sumWins  = wins.reduce(function(s,t){return s+t.profit;},0);
  var sumLoss  = Math.abs(losses.reduce(function(s,t){return s+t.profit;},0));
  var pf       = sumLoss > 0 ? (sumWins/sumLoss).toFixed(2) : '∞';
  var slHits   = trades.filter(function(t) { return t.isSLHit; }).length;

  var byDay = {};
  trades.forEach(function(t) {
    var d = fmtDay(t.closeDate);
    if (d) byDay[d] = (byDay[d]||0) + t.profit;
  });
  var days = Object.entries(byDay);
  var bestDay  = days.length ? days.reduce(function(a,b){return b[1]>a[1]?b:a;}) : null;
  var worstDay = days.length ? days.reduce(function(a,b){return b[1]<a[1]?b:a;}) : null;

  var kpis = [
    { label:'Closed P/L',     value: rZar(totalPL), sub: trades.length + ' closed trades',            cls: totalPL >= 0 ? 'kpi-green' : 'kpi-red' },
    { label:'Win Rate',       value: winRate.toFixed(1) + '%', sub: wins.length + 'W  ·  ' + losses.length + 'L', cls: winRate >= 50 ? 'kpi-green' : 'kpi-red' },
    { label:'Profit Factor',  value: pf, sub: 'gross wins ÷ gross losses',             cls: parseFloat(pf) >= 1.5 ? 'kpi-green' : parseFloat(pf) >= 1 ? '' : 'kpi-red' },
    { label:'Avg Win',        value: rZar(avgWin),  sub: 'per winning trade',          cls: 'kpi-green' },
    { label:'Avg Loss',       value: rZar(avgLoss), sub: 'per losing trade',           cls: 'kpi-red' },
    { label:'SL Hits',        value: slHits, sub: trades.length ? (slHits/trades.length*100).toFixed(0) + '% of all trades' : '',  cls: '' },
    { label:'Best Day',       value: bestDay  ? rZar(bestDay[1])  : '-', sub: bestDay  ? bestDay[0]  : '', cls: 'kpi-green' },
    { label:'Worst Day',      value: worstDay ? rZar(worstDay[1]) : '-', sub: worstDay ? worstDay[0] : '', cls: 'kpi-red' },
  ];

  document.getElementById('kpiGrid').innerHTML = kpis.map(function(k) {
    return '<div class="kpi-card ' + k.cls + '">'
      + '<div class="kpi-label">' + k.label + '</div>'
      + '<div class="kpi-value">' + k.value + '</div>'
      + '<div class="kpi-sub">'  + k.sub   + '</div>'
      + '</div>';
  }).join('');
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

var CC = {
  text:   '#5c6b84',
  grid:   '#1c2538',
  green:  '#0ecb8a',
  red:    '#f64f57',
  gold:   '#f5b935',
  blue:   '#4a90f0',
  surf:   '#141c28',
};

function baseOpts(yFmt) {
  return {
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 400 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: CC.surf,
        borderColor: CC.grid,
        borderWidth: 1,
        titleColor: '#cdd5e0',
        bodyColor: CC.text,
        callbacks: {
          label: function(ctx) {
            var v = ctx.parsed.y !== undefined ? ctx.parsed.y : ctx.parsed;
            return ' R ' + Math.round(v).toLocaleString();
          }
        }
      }
    },
    scales: {
      x: { grid: { color: CC.grid }, ticks: { color: CC.text, maxTicksLimit: 10, font: { size: 10 } } },
      y: { grid: { color: CC.grid }, ticks: { color: CC.text, font: { size: 10 }, callback: yFmt || function(v) { return 'R' + Math.round(v/1000) + 'k'; } } }
    }
  };
}

// ── Equity curve ──────────────────────────────────────────────────────────────

function renderEquityChart(trades) {
  var sorted = trades.slice().sort(function(a,b) { return new Date(a.closeDate) - new Date(b.closeDate); });
  var cum = 0; var labels = []; var data = []; var colors = [];
  sorted.forEach(function(t) {
    cum += t.profit;
    labels.push(fmtDay(t.closeDate).slice(5));
    data.push(parseFloat(cum.toFixed(2)));
    colors.push(cum >= 0 ? CC.green : CC.red);
  });

  var ctx = document.getElementById('equityChart').getContext('2d');
  stmtCharts.equity = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        borderColor: CC.green,
        backgroundColor: 'rgba(14,203,138,.06)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2
      }]
    },
    options: baseOpts()
  });
}

// ── Daily P/L ─────────────────────────────────────────────────────────────────

function renderDailyChart(trades) {
  var byDay = {};
  trades.forEach(function(t) {
    var d = fmtDay(t.closeDate);
    if (d) byDay[d] = (byDay[d]||0) + t.profit;
  });
  var entries = Object.entries(byDay).sort(function(a,b){return a[0]<b[0]?-1:1;});
  var ctx = document.getElementById('dailyChart').getContext('2d');
  stmtCharts.daily = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(function(e){return e[0].slice(5);}),
      datasets: [{
        data: entries.map(function(e){return parseFloat(e[1].toFixed(2));}),
        backgroundColor: entries.map(function(e){return e[1]>=0?CC.green:CC.red;}),
        borderRadius: 3
      }]
    },
    options: baseOpts()
  });
}

// ── Weekly P/L ────────────────────────────────────────────────────────────────

function renderWeeklyChart(trades) {
  var byWeek = {};
  trades.forEach(function(t) {
    var w = fmtWeek(t.closeDate);
    if (w) byWeek[w] = (byWeek[w]||0) + t.profit;
  });
  var entries = Object.entries(byWeek).sort(function(a,b){return a[0]<b[0]?-1:1;});
  var ctx = document.getElementById('weeklyChart').getContext('2d');
  stmtCharts.weekly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(function(e){return e[0];}),
      datasets: [{
        data: entries.map(function(e){return parseFloat(e[1].toFixed(2));}),
        backgroundColor: entries.map(function(e){return e[1]>=0?CC.green:CC.red;}),
        borderRadius: 4
      }]
    },
    options: baseOpts()
  });
}

// ── Win/Loss doughnut ─────────────────────────────────────────────────────────

function renderWinLossChart(trades) {
  var wins   = trades.filter(function(t){return t.profit > 0;}).length;
  var losses = trades.filter(function(t){return t.profit <= 0;}).length;
  var ctx = document.getElementById('winlossChart').getContext('2d');
  stmtCharts.winloss = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Wins', 'Losses'],
      datasets: [{
        data: [wins, losses],
        backgroundColor: [CC.green, CC.red],
        borderColor: '#0f1219',
        borderWidth: 3
      }]
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: { color: CC.text, boxWidth: 12, padding: 14, font: { size: 11 } }
        },
        tooltip: {
          backgroundColor: CC.surf, borderColor: CC.grid, borderWidth: 1,
          titleColor: '#cdd5e0', bodyColor: CC.text
        }
      }
    }
  });
}

// ── By instrument bar ─────────────────────────────────────────────────────────

function renderSymbolChart(trades) {
  var bySym = {};
  trades.forEach(function(t) { bySym[t.item] = (bySym[t.item]||0) + t.profit; });
  var entries = Object.entries(bySym).sort(function(a,b){return Math.abs(b[1])-Math.abs(a[1]);});
  var opts = baseOpts();
  opts.indexAxis = 'y';
  opts.scales.y.grid = { display: false };
  opts.scales.x.ticks.callback = function(v){ return 'R'+Math.round(v/1000)+'k'; };
  var ctx = document.getElementById('symbolChart').getContext('2d');
  stmtCharts.symbol = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(function(e){return e[0].toUpperCase();}),
      datasets: [{
        data: entries.map(function(e){return parseFloat(e[1].toFixed(2));}),
        backgroundColor: entries.map(function(e){return e[1]>=0?CC.green:CC.red;}),
        borderRadius: 4
      }]
    },
    options: opts
  });
}

// ── Trade log ─────────────────────────────────────────────────────────────────

function renderLogFilters() {
  var syms = [];
  stmtTrades.forEach(function(t){ if (syms.indexOf(t.item) < 0) syms.push(t.item); });
  var filters = [{ k:'all', label:'All' }, { k:'buy', label:'Buy' }, { k:'sell', label:'Sell' }]
    .concat(syms.map(function(s){ return { k:s, label:s.toUpperCase() }; }));

  document.getElementById('logFilters').innerHTML = filters.map(function(f) {
    return '<button class="log-filter-btn' + (logFilter===f.k?' active':'') + '" onclick="setFilter(\'' + f.k + '\')">' + f.label + '</button>';
  }).join('');
}

function setFilter(f) {
  logFilter = f;
  var filtered = applyFilter(stmtTrades);
  renderLogFilters();
  renderTradeLog(filtered);
  if (stmtCharts.winloss) { stmtCharts.winloss.destroy(); stmtCharts.winloss = null; }
  renderWinLossChart(filtered);
}

function applyFilter(trades) {
  if (logFilter === 'all') return trades;
  if (logFilter === 'buy' || logFilter === 'sell') return trades.filter(function(t){return t.type===logFilter;});
  return trades.filter(function(t){return t.item===logFilter;});
}

function renderTradeLog(trades) {
  var sorted = trades.slice().sort(function(a,b){ return new Date(b.closeDate) - new Date(a.closeDate); });
  document.getElementById('tradeLogBody').innerHTML = sorted.map(function(t) {
    var slBadge  = t.isSLHit ? '<span class="log-sl">SL</span>' : '';
    var profCls  = t.profit >= 0 ? 'profit-pos' : 'profit-neg';
    var dirCls   = t.type === 'buy' ? 'dir-buy' : 'dir-sell';
    var openStr  = t.openTime  ? t.openTime.slice(0,16)  : '';
    var closeStr = t.closeTime ? t.closeTime.slice(0,16) : '';
    return '<tr>'
      + '<td>' + t.ticket + slBadge + '</td>'
      + '<td>' + openStr  + '</td>'
      + '<td>' + closeStr + '</td>'
      + '<td class="' + dirCls  + '">' + t.type.toUpperCase() + '</td>'
      + '<td>' + t.item.toUpperCase() + '</td>'
      + '<td>' + t.size + '</td>'
      + '<td>' + (isNaN(t.openPrice)  ? '-' : t.openPrice.toFixed(2))  + '</td>'
      + '<td>' + (isNaN(t.closePrice) ? '-' : t.closePrice.toFixed(2)) + '</td>'
      + '<td>' + (t.sl > 0 ? t.sl.toFixed(2) : '-') + '</td>'
      + '<td class="' + dirCls + '">' + (t.isWin ? 'WIN' : 'LOSS') + '</td>'
      + '<td class="' + profCls + '">' + (t.profit >= 0 ? '+' : '') + Math.round(t.profit).toLocaleString() + '</td>'
      + '</tr>';
  }).join('');
}
