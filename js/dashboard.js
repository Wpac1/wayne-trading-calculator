'use strict';

var STMT_KEY    = 'wayne_stmt_v1';
var stmtTrades  = [];
var stmtSummary = {};
var stmtCharts  = {};
var logFilter   = 'all';
var logPage     = 1;
var LOG_PAGE_SZ = 10;

var calYear    = 0;
var calMonth   = 0;
var calInited  = false;
var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Tab switching ─────────────────────────────────────────────────────────────

function showTab(tab) {
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  document.getElementById('view-' + tab).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'dashboard') initDashboard();
  if (tab === 'calendar')  initCalendar();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function initDashboard() {
  try {
    var cached = JSON.parse(localStorage.getItem(STMT_KEY) || 'null');
    if (cached && Array.isArray(cached.trades) && cached.trades.length > 0) {
      stmtTrades  = cached.trades;
      stmtSummary = cached.summary || {};
      renderDashboard();
      return;
    }
  } catch(e) {}
  fetchStatement();
}

function fetchStatement() {
  fetch('DetailedStatement.htm')
    .then(function(r) { if (!r.ok) throw new Error('not found'); return r.text(); })
    .then(function(html) { handleFetched(html); })
    .catch(function() {
      document.getElementById('dashLoader').style.display  = 'block';
      document.getElementById('dashContent').style.display = 'none';
    });
}

function reloadStatement() {
  try { localStorage.removeItem(STMT_KEY); } catch(e) {}
  stmtSummary = {};
  destroyCharts();
  document.getElementById('dashContent').style.display = 'none';
  document.getElementById('dashLoader').style.display  = 'none';
  fetchStatement();
}

function handleFetched(html) {
  var result  = parseStatement(html);
  stmtTrades  = result.trades;
  stmtSummary = result.summary;
  cacheStmt();
  renderDashboard();
}

function loadStatementFile(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var result  = parseStatement(e.target.result);
    stmtTrades  = result.trades;
    stmtSummary = result.summary;
    cacheStmt();
    document.getElementById('dashLoader').style.display = 'none';
    renderDashboard();
  };
  reader.readAsText(file);
}

function cacheStmt() {
  try { localStorage.setItem(STMT_KEY, JSON.stringify({ trades: stmtTrades, summary: stmtSummary })); } catch(e) {}
}

// ── Parse DetailedStatement.htm ───────────────────────────────────────────────

function parseStatement(htmlText) {
  var parser  = new DOMParser();
  var doc     = parser.parseFromString(htmlText, 'text/html');
  var trades  = [];
  var summary = {};

  doc.querySelectorAll('table tr').forEach(function(row) {
    var cells = row.querySelectorAll('td');

    // ── Summary rows (Balance, Equity, Deposit, Closed P/L) ──
    if (cells.length >= 2) {
      var label = cells[0].textContent.trim();
      var val2  = cells.length > 2 ? pn(cells[2].textContent) : NaN;
      var val1  = cells.length > 1 ? pn(cells[1].textContent) : NaN;
      if (label === 'Balance:')         summary.balance    = isNaN(val2) ? val1 : val2;
      if (label === 'Closed Trade P/L:') summary.closedPL  = isNaN(val2) ? val1 : val2;
      if (label === 'Deposit/Withdrawal:') summary.deposit = isNaN(val2) ? val1 : val2;

      // Bold cells with colspans carry the summary values
      var bold = row.querySelectorAll('b');
      bold.forEach(function(b) {
        var t = b.textContent.trim();
        if (t === 'Balance:' && bold[1]) summary.balance   = pn(bold[1].textContent);
        if (t === 'Equity:'  && bold[1]) summary.equity    = pn(bold[1].textContent);
        if (t === 'Closed Trade P/L:' && bold[1]) summary.closedPL = pn(bold[1].textContent);
        if (t === 'Deposit/Withdrawal:' && bold[1]) summary.deposit = pn(bold[1].textContent);
        if (t === 'Floating P/L:' && bold[1]) summary.floatingPL = pn(bold[1].textContent);
      });
    }

    if (cells.length < 14) return;

    var type = cells[2].textContent.trim().toLowerCase();
    if (type !== 'buy' && type !== 'sell') return;

    var closeTime = cells[8].textContent.trim();
    if (!closeTime || closeTime.length < 10) return;

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

  return { trades: trades, summary: summary };
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

var MOTIV_OTHERS = [
  { q: 'The goal of a successful trader is to make the best trades. Money is secondary.', a: '— Alexander Elder' },
  { q: 'Risk comes from not knowing what you\'re doing.', a: '— Warren Buffett' },
  { q: 'It\'s not whether you\'re right or wrong, but how much you make when you\'re right and how much you lose when you\'re wrong.', a: '— George Soros' },
  { q: 'The most important thing is to preserve capital. Profits will take care of themselves.', a: '— Paul Tudor Jones' },
  { q: 'Plan the trade and trade the plan.', a: '— Ed Seykota' }
];

function renderMotivation() {
  var existing = document.getElementById('motivCard');
  if (existing) existing.remove();

  var other = MOTIV_OTHERS[Math.floor(Math.random() * MOTIV_OTHERS.length)];
  var html = '<div id="motivCard" class="motiv-card">'
    + '<div class="motiv-label">&#x26A1; Mindset</div>'
    + '<div class="motiv-quote">&ldquo;Dont give the market your Money. Wait and be patient. You need this!&rdquo;</div>'
    + '<div class="motiv-attr">&mdash; Wayne</div>'
    + '<hr class="motiv-sep">'
    + '<div class="motiv-other-q">&ldquo;' + other.q + '&rdquo;</div>'
    + '<div class="motiv-other-a">' + other.a + '</div>'
    + '</div>';

  var kpiGrid = document.getElementById('kpiGrid');
  kpiGrid.insertAdjacentHTML('beforebegin', html);
}

function renderDashboard() {
  destroyCharts();
  logFilter = 'all';
  logPage   = 1;
  document.getElementById('dashContent').style.display = 'block';
  document.getElementById('dashLoader').style.display  = 'none';

  renderMotivation();
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
  var wins    = trades.filter(function(t) { return t.profit > 0; });
  var losses  = trades.filter(function(t) { return t.profit <= 0; });
  var totalPL = trades.reduce(function(s,t) { return s + t.profit; }, 0);
  var winRate = trades.length ? wins.length / trades.length * 100 : 0;
  var avgWin  = wins.length   ? wins.reduce(function(s,t){return s+t.profit;},0)/wins.length : 0;
  var avgLoss = losses.length ? Math.abs(losses.reduce(function(s,t){return s+t.profit;},0)/losses.length) : 0;
  var sumWins = wins.reduce(function(s,t){return s+t.profit;},0);
  var sumLoss = Math.abs(losses.reduce(function(s,t){return s+t.profit;},0));
  var pf      = sumLoss > 0 ? (sumWins/sumLoss).toFixed(2) : '∞';
  var slHits  = trades.filter(function(t) { return t.isSLHit; }).length;

  var byDay = {};
  trades.forEach(function(t) {
    var d = fmtDay(t.closeDate);
    if (d) byDay[d] = (byDay[d]||0) + t.profit;
  });
  var days     = Object.entries(byDay);
  var bestDay  = days.length ? days.reduce(function(a,b){return b[1]>a[1]?b:a;}) : null;
  var worstDay = days.length ? days.reduce(function(a,b){return b[1]<a[1]?b:a;}) : null;

  // Account summary from parsed statement
  var s       = stmtSummary;
  var balance = !isNaN(s.balance)    ? 'R ' + s.balance.toLocaleString()    : '—';
  var equity  = !isNaN(s.equity)     ? 'R ' + s.equity.toLocaleString()     : '—';
  var deposit = !isNaN(s.deposit)    ? 'R ' + s.deposit.toLocaleString()    : '—';
  var floatPL = !isNaN(s.floatingPL) ? (s.floatingPL >= 0 ? '+' : '') + 'R ' + Math.round(s.floatingPL).toLocaleString() : '—';

  // Account block (full-width row at top)
  var acctHtml = '<div class="kpi-row-account">'
    + '<div class="kpi-card kpi-gold"><div class="kpi-label">Account Balance</div><div class="kpi-value">' + balance + '</div><div class="kpi-sub">as of statement date</div></div>'
    + '<div class="kpi-card"><div class="kpi-label">Equity</div><div class="kpi-value">' + equity + '</div><div class="kpi-sub">balance + floating P/L</div></div>'
    + '<div class="kpi-card ' + (!isNaN(s.floatingPL) && s.floatingPL >= 0 ? 'kpi-green' : 'kpi-red') + '"><div class="kpi-label">Floating P/L</div><div class="kpi-value">' + floatPL + '</div><div class="kpi-sub">open positions</div></div>'
    + '<div class="kpi-card"><div class="kpi-label">Net Deposit</div><div class="kpi-value">' + deposit + '</div><div class="kpi-sub">total funded</div></div>'
    + '</div>';

  var kpis = [
    { label:'Closed P/L',    value: rZar(totalPL), sub: trades.length + ' closed trades',     cls: totalPL >= 0 ? 'kpi-green' : 'kpi-red' },
    { label:'Win Rate',      value: winRate.toFixed(1) + '%', sub: wins.length + 'W · ' + losses.length + 'L', cls: winRate >= 50 ? 'kpi-green' : 'kpi-red' },
    { label:'Profit Factor', value: pf, sub: 'wins ÷ losses (gross)', cls: parseFloat(pf) >= 1.5 ? 'kpi-green' : parseFloat(pf) >= 1 ? '' : 'kpi-red' },
    { label:'Avg Win',       value: rZar(avgWin),  sub: 'per winning trade',  cls: 'kpi-green' },
    { label:'Avg Loss',      value: rZar(avgLoss), sub: 'per losing trade',   cls: 'kpi-red' },
    { label:'SL Hits',       value: slHits, sub: trades.length ? (slHits/trades.length*100).toFixed(0) + '% of trades' : '', cls: '' },
    { label:'Best Day',      value: bestDay  ? rZar(bestDay[1])  : '-', sub: bestDay  ? bestDay[0]  : '', cls: 'kpi-green' },
    { label:'Worst Day',     value: worstDay ? rZar(worstDay[1]) : '-', sub: worstDay ? worstDay[0] : '', cls: 'kpi-red' },
  ];

  document.getElementById('kpiGrid').innerHTML = acctHtml
    + kpis.map(function(k) {
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
  logPage   = 1;
  var filtered = applyFilter(stmtTrades);
  renderLogFilters();
  renderTradeLog(filtered);
  if (stmtCharts.winloss) { stmtCharts.winloss.destroy(); stmtCharts.winloss = null; }
  renderWinLossChart(filtered);
}

function goPage(p) {
  logPage = p;
  renderTradeLog(applyFilter(stmtTrades));
}

function applyFilter(trades) {
  if (logFilter === 'all') return trades;
  if (logFilter === 'buy' || logFilter === 'sell') return trades.filter(function(t){return t.type===logFilter;});
  return trades.filter(function(t){return t.item===logFilter;});
}

function renderTradeLog(trades) {
  var sorted   = trades.slice().sort(function(a,b){ return new Date(b.closeDate) - new Date(a.closeDate); });
  var total    = sorted.length;
  var pages    = Math.max(1, Math.ceil(total / LOG_PAGE_SZ));
  logPage      = Math.min(logPage, pages);
  var start    = (logPage - 1) * LOG_PAGE_SZ;
  var pageRows = sorted.slice(start, start + LOG_PAGE_SZ);

  document.getElementById('tradeLogBody').innerHTML = pageRows.map(function(t) {
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

  // Pagination controls
  var paginHtml = '<div class="pagination">'
    + '<span class="pag-info">' + (start+1) + '–' + Math.min(start+LOG_PAGE_SZ, total) + ' of ' + total + '</span>'
    + '<button class="pag-btn" onclick="goPage(' + (logPage-1) + ')" ' + (logPage <= 1 ? 'disabled' : '') + '>&#8592; Prev</button>';

  // Page numbers — show up to 7 around current
  var lo = Math.max(1, logPage-3), hi = Math.min(pages, logPage+3);
  if (lo > 1) paginHtml += '<button class="pag-btn" onclick="goPage(1)">1</button>' + (lo > 2 ? '<span class="pag-gap">…</span>' : '');
  for (var p = lo; p <= hi; p++) {
    paginHtml += '<button class="pag-btn' + (p === logPage ? ' pag-active' : '') + '" onclick="goPage(' + p + ')">' + p + '</button>';
  }
  if (hi < pages) paginHtml += (hi < pages-1 ? '<span class="pag-gap">…</span>' : '') + '<button class="pag-btn" onclick="goPage(' + pages + ')">' + pages + '</button>';

  paginHtml += '<button class="pag-btn" onclick="goPage(' + (logPage+1) + ')" ' + (logPage >= pages ? 'disabled' : '') + '>Next &#8594;</button>'
    + '</div>';

  // Inject after table — use a wrapper div in the dash-card
  var existing = document.getElementById('logPagination');
  if (existing) { existing.innerHTML = paginHtml; }
  else {
    var wrap = document.createElement('div');
    wrap.id  = 'logPagination';
    wrap.innerHTML = paginHtml;
    document.querySelector('.dash-card').appendChild(wrap);
  }
}

// ── P&L Calendar ──────────────────────────────────────────────────────────────

function initCalendar() {
  if (!stmtTrades || stmtTrades.length === 0) {
    try {
      var cached = JSON.parse(localStorage.getItem(STMT_KEY) || 'null');
      if (cached && Array.isArray(cached.trades) && cached.trades.length > 0) {
        stmtTrades  = cached.trades;
        stmtSummary = cached.summary || {};
      }
    } catch(e) {}
  }

  if (!stmtTrades || stmtTrades.length === 0) {
    document.getElementById('calNoData').style.display  = 'block';
    document.getElementById('calContent').style.display = 'none';
    return;
  }

  document.getElementById('calNoData').style.display  = 'none';
  document.getElementById('calContent').style.display = 'block';

  if (!calInited) {
    calInited = true;
    var latest = stmtTrades.reduce(function(a, b) {
      return new Date(a.closeDate) > new Date(b.closeDate) ? a : b;
    });
    if (latest && latest.closeDate) {
      var ld = new Date(latest.closeDate);
      calYear  = ld.getFullYear();
      calMonth = ld.getMonth();
    } else {
      var now = new Date();
      calYear  = now.getFullYear();
      calMonth = now.getMonth();
    }
  }

  renderCalendar();
}

function calChangeMonth(dir) {
  calMonth += dir;
  if (calMonth < 0)  { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0;  calYear++; }
  renderCalendar();
}

function renderCalendar() {
  document.getElementById('calMonthLabel').textContent = MONTH_NAMES[calMonth] + ' ' + calYear;

  var byDay = {};
  stmtTrades.forEach(function(t) {
    if (!t.closeDate) return;
    var d = new Date(t.closeDate);
    if (d.getFullYear() !== calYear || d.getMonth() !== calMonth) return;
    var key = d.getDate();
    if (!byDay[key]) byDay[key] = { pl: 0, trades: 0, wins: 0, losses: 0 };
    byDay[key].pl     += t.profit;
    byDay[key].trades += 1;
    if (t.profit > 0) byDay[key].wins++;
    else byDay[key].losses++;
  });

  var firstDay    = new Date(calYear, calMonth, 1).getDay();
  var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  var today       = new Date();

  var html = '';
  for (var i = 0; i < firstDay; i++) {
    html += '<div class="cal-day cal-empty"></div>';
  }

  for (var d = 1; d <= daysInMonth; d++) {
    var data    = byDay[d];
    var isToday = (today.getFullYear() === calYear && today.getMonth() === calMonth && today.getDate() === d);
    var todayCls = isToday ? ' cal-today' : '';

    if (data) {
      var win   = data.pl >= 0;
      var cls   = 'cal-day ' + (win ? 'cal-win' : 'cal-loss') + todayCls;
      var sign  = win ? '+' : '-';
      var plStr = sign + 'R ' + Math.round(Math.abs(data.pl)).toLocaleString();
      html += '<div class="' + cls + '">'
        + '<div class="cal-dn">' + d + '</div>'
        + '<div class="cal-tc">' + data.trades + ' trade' + (data.trades !== 1 ? 's' : '') + '</div>'
        + '<div class="cal-pl">' + plStr + '</div>'
        + '</div>';
    } else {
      html += '<div class="cal-day cal-blank' + todayCls + '"><div class="cal-dn">' + d + '</div></div>';
    }
  }

  document.getElementById('calGrid').innerHTML = html;

  var monthTrades = stmtTrades.filter(function(t) {
    if (!t.closeDate) return false;
    var cd = new Date(t.closeDate);
    return cd.getFullYear() === calYear && cd.getMonth() === calMonth;
  });

  var sumEl = document.getElementById('calSummary');
  if (monthTrades.length === 0) {
    sumEl.innerHTML = '<div class="cal-no-trades">No trades in ' + MONTH_NAMES[calMonth] + ' ' + calYear + '</div>';
    return;
  }

  var monthPL   = monthTrades.reduce(function(s, t) { return s + t.profit; }, 0);
  var monthWins = monthTrades.filter(function(t) { return t.profit > 0; }).length;
  var monthLoss = monthTrades.filter(function(t) { return t.profit <= 0; }).length;
  var tradeDays = Object.keys(byDay).length;
  var winDays   = Object.keys(byDay).filter(function(k) { return byDay[k].pl > 0; }).length;
  var winRate   = monthTrades.length ? (monthWins / monthTrades.length * 100).toFixed(0) : 0;
  var plSign    = monthPL >= 0 ? '+' : '';

  sumEl.innerHTML = '<div class="cal-sum-grid">'
    + '<div class="cal-sum-card ' + (monthPL >= 0 ? 'csum-green' : 'csum-red') + '">'
    +   '<div class="cal-sum-lbl">Month P&amp;L</div>'
    +   '<div class="cal-sum-val">' + plSign + 'R ' + Math.round(monthPL).toLocaleString() + '</div>'
    + '</div>'
    + '<div class="cal-sum-card">'
    +   '<div class="cal-sum-lbl">Total Trades</div>'
    +   '<div class="cal-sum-val">' + monthTrades.length + '</div>'
    +   '<div class="cal-sum-sub">' + monthWins + 'W &middot; ' + monthLoss + 'L</div>'
    + '</div>'
    + '<div class="cal-sum-card ' + (parseFloat(winRate) >= 50 ? 'csum-green' : 'csum-red') + '">'
    +   '<div class="cal-sum-lbl">Win Rate</div>'
    +   '<div class="cal-sum-val">' + winRate + '%</div>'
    + '</div>'
    + '<div class="cal-sum-card">'
    +   '<div class="cal-sum-lbl">Green Days</div>'
    +   '<div class="cal-sum-val">' + winDays + ' / ' + tradeDays + '</div>'
    +   '<div class="cal-sum-sub">trading days this month</div>'
    + '</div>'
    + '</div>';
}
