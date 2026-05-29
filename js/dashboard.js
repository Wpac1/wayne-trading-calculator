'use strict';

var STMT_KEY    = 'wayne_stmt_v1';
var FLAGS_KEY   = 'wayne_trade_flags';
var COMMENTS_KEY = 'wayne_flag_cmt_list';
var stmtTrades  = [];
var stmtSummary = {};
var stmtCharts  = {};
var logFilter   = 'all';
var logPage     = 1;
var LOG_PAGE_SZ = 10;

// Multi-account
var activeAccount = 1;
var acctPrefix    = 'R';
var stmtTradesHF  = [];
var stmtSummaryHF = {};
var xlsxTrades    = [];

var calYear    = 0;
var calMonth   = 0;
var calInited  = false;
var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Trade flag helpers (system trade tagging) ─────────────────────────────────

function loadTradeFlags() {
  try { return JSON.parse(localStorage.getItem(FLAGS_KEY) || '{}'); } catch(e) { return {}; }
}
function saveTradeFlags(flags) { localStorage.setItem(FLAGS_KEY, JSON.stringify(flags)); }

// ── Saved comment list (for autocomplete + CRUD) ──────────────────────────────
function loadSavedComments() {
  try { return JSON.parse(localStorage.getItem(COMMENTS_KEY) || '[]'); } catch(e) { return []; }
}
function saveSavedComments(list) { localStorage.setItem(COMMENTS_KEY, JSON.stringify(list)); }

function addSavedComment(comment) {
  if (!comment) return;
  var list = loadSavedComments();
  if (list.indexOf(comment) < 0) { list.unshift(comment); saveSavedComments(list); }
}
function deleteSavedComment(comment) {
  saveSavedComments(loadSavedComments().filter(function(c){ return c !== comment; }));
  renderModalCommentChips();
  populateCommentDatalist();
}
function populateCommentDatalist() {
  var dl = document.getElementById('commentSuggestions');
  if (!dl) return;
  dl.innerHTML = loadSavedComments().map(function(c) {
    return '<option value="' + c.replace(/"/g, '&quot;') + '">';
  }).join('');
}
function renderModalCommentChips() {
  var el = document.getElementById('flagCommentChips');
  if (!el) return;
  var list = loadSavedComments();
  if (!list.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:10px;font-style:italic">Type a comment above — it will be saved for reuse</span>';
    return;
  }
  el.innerHTML = list.map(function(c) {
    var safe  = c.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    var click = 'document.getElementById(\'flagModalComment\').value=\'' + safe + '\'';
    return '<span class="comment-chip" onclick="' + click + '" title="Click to use">' +
      c + '<button class="comment-chip-del" onclick="event.stopPropagation();deleteSavedComment(\'' + safe + '\')" title="Delete">&#10005;</button>' +
    '</span>';
  }).join('');
}

function openFlagModal(ticket) {
  var flags = loadTradeFlags();
  var key   = String(ticket);
  document.getElementById('flagModalTicket').textContent = ticket;
  document.getElementById('flagModalTicketVal').value    = key;
  document.getElementById('flagModalComment').value      = flags[key] ? (flags[key].comment || '') : '';
  populateCommentDatalist();
  renderModalCommentChips();
  document.getElementById('flagModal').style.display = 'flex';
  setTimeout(function(){ document.getElementById('flagModalComment').focus(); }, 60);
}
function cancelFlagModal() { document.getElementById('flagModal').style.display = 'none'; }
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter'  && document.getElementById('flagModal').style.display !== 'none') saveFlaggedTrade();
  if (e.key === 'Escape' && document.getElementById('flagModal').style.display !== 'none') cancelFlagModal();
});
function saveFlaggedTrade() {
  var key     = document.getElementById('flagModalTicketVal').value;
  var comment = document.getElementById('flagModalComment').value.trim();
  var flags   = loadTradeFlags();
  flags[key]  = { isSystem: true, comment: comment, flaggedAt: new Date().toISOString() };
  saveTradeFlags(flags);
  addSavedComment(comment);
  cancelFlagModal();
  renderTradeLog(applyFilter(stmtTrades));
  renderKPIs(stmtTrades);
  renderCategoryBadges();
}
function unflagTrade(ticket) {
  var flags = loadTradeFlags();
  delete flags[String(ticket)];
  saveTradeFlags(flags);
  renderTradeLog(applyFilter(stmtTrades));
  renderKPIs(stmtTrades);
  renderCategoryBadges();
}

// ── System category badges ────────────────────────────────────────────────────
function renderCategoryBadges() {
  var section = document.getElementById('sysCatSection');
  var el      = document.getElementById('sysCategoryBadges');
  if (!el) return;

  var flags = loadTradeFlags();
  var keys  = Object.keys(flags);
  if (!section) return;
  if (!keys.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  // Group by comment
  var cats = {};
  keys.forEach(function(ticket) {
    var f   = flags[ticket];
    var cat = (f.comment || '').trim() || 'Uncategorised';
    if (!cats[cat]) cats[cat] = { wins: 0, losses: 0, pl: 0 };
    var trade = stmtTrades.find(function(t){ return String(t.ticket) === ticket; });
    if (trade) {
      if (trade.profit > 0) cats[cat].wins++;
      else cats[cat].losses++;
      cats[cat].pl += trade.profit;
    }
  });

  var sorted = Object.keys(cats).map(function(cat) {
    var d     = cats[cat];
    var total = d.wins + d.losses;
    var wr    = total ? d.wins / total * 100 : 0;
    return { cat: cat, wins: d.wins, losses: d.losses, total: total, wr: wr, pl: d.pl };
  }).sort(function(a,b){ return b.total - a.total; }).slice(0, 10);

  var active = logFilter.indexOf('sys:') === 0 ? logFilter.slice(4) : null;

  el.innerHTML = sorted.map(function(d) {
    var wrCls  = d.wr >= 60 ? 'sys-cat-good' : d.wr < 40 && d.total > 0 ? 'sys-cat-bad' : '';
    var actCls = active === d.cat ? ' sys-cat-active' : '';
    var plStr  = (d.pl >= 0 ? '+' : '') + 'R' + Math.round(d.pl).toLocaleString();
    var safe   = d.cat.replace(/'/g, "\\'");
    return '<div class="sys-cat-badge ' + wrCls + actCls + '" onclick="filterByCategory(\'' + safe + '\')" title="Filter trade log by this category">' +
      '<span class="sys-cat-name">' + d.cat + '</span>' +
      '<span class="sys-cat-stats">' + d.total + ' · ' + d.wr.toFixed(0) + '% WR · ' + plStr + '</span>' +
    '</div>';
  }).join('');
}

function filterByCategory(cat) {
  logFilter = cat ? 'sys:' + cat : 'all';
  logPage   = 1;
  renderLogFilters();
  var filtered = applyFilter(stmtTrades);
  renderTradeLog(filtered);
  if (stmtCharts.winloss) { stmtCharts.winloss.destroy(); stmtCharts.winloss = null; }
  renderWinLossChart(filtered);
  renderCategoryBadges(); // re-render to update active state
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function showTab(tab) {
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  document.getElementById('view-' + tab).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'dashboard') initDashboard();
  if (tab === 'calendar')  initCalendar();
  if (tab === 'analysis')  initAnalysis();
  var fsync = document.getElementById('anaFloatSync');
  if (fsync) fsync.style.display = tab === 'analysis' ? 'flex' : 'none';
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function initDashboard() {
  fetchXlsx();
  if (activeAccount === 2 && xlsxTrades.length > 0) { renderDashboard(); return; }
  try {
    var cached = JSON.parse(localStorage.getItem(STMT_KEY) || 'null');
    if (cached && Array.isArray(cached.trades) && cached.trades.length > 0) {
      stmtTrades  = cached.trades;
      stmtSummary = cached.summary || {};
      stmtTradesHF  = stmtTrades;
      stmtSummaryHF = stmtSummary;
      renderDashboard();
      return;
    }
  } catch(e) {}
  fetchStatement();
}

function fetchStatement() {
  // Prefer WayneStatement.csv (EA export); fall back to DetailedStatement.htm
  fetch('data/statement/WayneStatement.csv')
    .then(function(r) { if (!r.ok) throw new Error('no csv'); return r.text(); })
    .then(function(csv) { handleFetchedCSV(csv); })
    .catch(function() {
      fetch('DetailedStatement.htm')
        .then(function(r) { if (!r.ok) throw new Error('not found'); return r.text(); })
        .then(function(html) { handleFetched(html); })
        .catch(function() {
          document.getElementById('dashLoader').style.display  = 'block';
          document.getElementById('dashContent').style.display = 'none';
        });
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

function syncMT4() {
  var btn    = document.getElementById('syncBtn');
  var status = document.getElementById('syncStatus');
  btn.disabled   = true;
  btn.textContent = '⟳ Syncing…';
  status.style.color = 'var(--muted)';
  status.textContent  = '';

  fetch('/api/sync', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        btn.textContent    = '✓ Synced';
        status.style.color = 'var(--green)';
        status.textContent = 'MT4 files copied';
        setTimeout(function() {
          btn.textContent = '↧ Sync MT4';
          btn.disabled    = false;
          status.textContent = '';
          reloadStatement();
        }, 1500);
      } else {
        btn.textContent    = '✗ Failed';
        status.style.color = 'var(--red)';
        status.textContent = data.output ? data.output.split('\n')[0] : 'sync error';
        setTimeout(function() {
          btn.textContent = '↧ Sync MT4';
          btn.disabled    = false;
        }, 4000);
      }
    })
    .catch(function() {
      btn.textContent    = '↧ Sync MT4';
      btn.disabled       = false;
      status.style.color = 'var(--red)';
      status.textContent = 'Server not running — use: py server.py';
    });
}

function handleFetched(html) {
  var result    = parseStatement(html);
  stmtTrades    = result.trades;
  stmtSummary   = result.summary;
  stmtTradesHF  = stmtTrades;
  stmtSummaryHF = stmtSummary;
  cacheStmt();
  renderDashboard();
}

function handleFetchedCSV(csv) {
  var result    = parseWayneCSV(csv);
  stmtTrades    = result.trades;
  stmtSummary   = result.summary;
  stmtTradesHF  = stmtTrades;
  stmtSummaryHF = stmtSummary;
  cacheStmt();
  renderDashboard();
}

function loadStatementFile(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var text   = e.target.result;
    var isCSV  = file.name.toLowerCase().endsWith('.csv') || text.trimStart().startsWith('# ACCOUNT_SUMMARY');
    var result = isCSV ? parseWayneCSV(text) : parseStatement(text);
    stmtTrades    = result.trades;
    stmtSummary   = result.summary;
    stmtTradesHF  = stmtTrades;
    stmtSummaryHF = stmtSummary;
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


// -- Parse WayneStatement.csv (EA export) -------------------------------------

function parseWayneCSV(text) {
  var trades  = [];
  var summary = {};
  var lines   = text.split('\n');
  var headers = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    if (line === '# ACCOUNT_SUMMARY') {
      var sl    = (lines[i + 1] || '').trim();
      var parts = sl.split(',');
      var sm    = {};
      for (var j = 0; j < parts.length - 1; j += 2) sm[parts[j].trim()] = parts[j + 1].trim();
      summary.balance  = parseFloat(sm['balance']  || '0');
      summary.equity   = parseFloat(sm['equity']   || '0');
      summary.currency = sm['currency'] || 'ZAR';
      continue;
    }
    if (line.startsWith('#')) continue;

    if (!headers) {
      if (line.startsWith('ticket,')) { headers = line.split(','); }
      continue;
    }

    var cols = line.split(',');
    if (cols.length < headers.length) continue;

    var row = {};
    for (var k = 0; k < headers.length; k++) row[headers[k]] = (cols[k] || '').trim();

    if (row['status'] !== 'closed') continue;
    var type = (row['type'] || '').toLowerCase();
    if (type !== 'buy' && type !== 'sell') continue;

    var profit = parseFloat(row['net_profit'] || row['profit'] || '0');
    if (isNaN(profit)) continue;

    var openD  = pdCSV(row['open_time']);
    var closeD = pdCSV(row['close_time']);

    trades.push({
      ticket:     row['ticket'],
      openTime:   row['open_time'],
      type:       type,
      size:       parseFloat(row['lots']),
      item:       (row['symbol'] || '').toLowerCase(),
      openPrice:  parseFloat(row['open_price']),
      sl:         parseFloat(row['sl']),
      tp:         parseFloat(row['tp']),
      closeTime:  row['close_time'],
      closePrice: parseFloat(row['close_price']),
      profit:     profit,
      isSLHit:    row['comment'] === '[sl]',
      isWin:      profit > 0,
      openDate:   openD  ? openD.toISOString()  : null,
      closeDate:  closeD ? closeD.toISOString() : null
    });
  }

  summary.closedPL = trades.reduce(function(a, t) { return a + t.profit; }, 0);
  return { trades: trades, summary: summary };
}

function pdCSV(s) {
  if (!s) return null;
  var m = s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) : null;
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
function rZar(n) { return acctPrefix + ' ' + Math.round(Math.abs(n)).toLocaleString(); }

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
    + '<div class="motiv-attr">&mdash; You</div>'
    + '<hr class="motiv-sep">'
    + '<div class="motiv-other-q">&ldquo;' + other.q + '&rdquo;</div>'
    + '<div class="motiv-other-a">' + other.a + '</div>'
    + '</div>';

  var kpiGrid = document.getElementById('kpiGrid');
  kpiGrid.insertAdjacentHTML('beforebegin', html);
}

function syncAcctTabs() {
  document.querySelectorAll('.acct-tab').forEach(function(b) { b.classList.remove('active'); });
  var el = document.getElementById('acct-tab-' + activeAccount);
  if (el) el.classList.add('active');
  var badge = document.getElementById('acct2badge');
  if (badge) {
    if (xlsxTrades.length > 0) {
      badge.textContent = xlsxTrades.length + ' trades';
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  }
}

function renderDashboard() {
  destroyCharts();
  logFilter = 'all';
  logPage   = 1;
  syncAcctTabs();
  document.getElementById('dashContent').style.display = 'block';
  document.getElementById('dashLoader').style.display  = 'none';

  renderMotivation();
  renderKPIs(stmtTrades);
  renderCategoryBadges();
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

  // System trades stats
  var flags       = loadTradeFlags();
  var sysTrades   = trades.filter(function(t){ return !!flags[String(t.ticket)]; });
  var sysWins     = sysTrades.filter(function(t){ return t.profit > 0; });
  var sysLosses   = sysTrades.filter(function(t){ return t.profit <= 0; });
  var sysWR       = sysTrades.length ? sysWins.length / sysTrades.length * 100 : 0;
  var sysPL       = sysTrades.reduce(function(s,t){ return s + t.profit; }, 0);
  var sysKpiVal   = sysTrades.length ? sysWR.toFixed(1) + '%' : '—';
  var sysKpiSub   = sysTrades.length
    ? sysTrades.length + ' trades · ' + sysWins.length + 'W ' + sysLosses.length + 'L · ' + rZar(sysPL)
    : 'No flagged trades yet';

  var kpis = [
    { label:'Closed P/L',    value: rZar(totalPL), sub: trades.length + ' closed trades',     cls: totalPL >= 0 ? 'kpi-green' : 'kpi-red' },
    { label:'Win Rate',      value: winRate.toFixed(1) + '%', sub: wins.length + 'W · ' + losses.length + 'L', cls: winRate >= 50 ? 'kpi-green' : 'kpi-red' },
    { label:'Profit Factor', value: pf, sub: 'wins ÷ losses (gross)', cls: parseFloat(pf) >= 1.5 ? 'kpi-green' : parseFloat(pf) >= 1 ? '' : 'kpi-red' },
    { label:'Avg Win',       value: rZar(avgWin),  sub: 'per winning trade',  cls: 'kpi-green' },
    { label:'Avg Loss',      value: rZar(avgLoss), sub: 'per losing trade',   cls: 'kpi-red' },
    { label:'SL Hits',       value: slHits, sub: trades.length ? (slHits/trades.length*100).toFixed(0) + '% of trades' : '', cls: '' },
    { label:'Best Day',      value: bestDay  ? rZar(bestDay[1])  : '-', sub: bestDay  ? bestDay[0]  : '', cls: 'kpi-green' },
    { label:'Worst Day',     value: worstDay ? rZar(worstDay[1]) : '-', sub: worstDay ? worstDay[0] : '', cls: 'kpi-red' },
    { label:'System Win Rate', value: sysKpiVal, sub: sysKpiSub, cls: sysTrades.length ? (sysWR >= 50 ? 'kpi-green kpi-sys' : 'kpi-red kpi-sys') : 'kpi-sys' },
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
            return ' ' + acctPrefix + ' ' + Math.round(v).toLocaleString();
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

  var html = filters.map(function(f) {
    return '<button class="log-filter-btn' + (logFilter===f.k?' active':'') + '" onclick="setFilter(\'' + f.k + '\')">' + f.label + '</button>';
  }).join('');

  // If a category is active, add a clear chip
  if (logFilter.indexOf('sys:') === 0) {
    var catName = logFilter.slice(4);
    html += '<span class="log-cat-active-chip">' + catName +
      ' <button class="log-cat-clear" onclick="setFilter(\'all\')" title="Clear filter">&#10005;</button></span>';
  }

  document.getElementById('logFilters').innerHTML = html;
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
  if (logFilter === 'buy' || logFilter === 'sell') return trades.filter(function(t){ return t.type === logFilter; });
  if (logFilter.indexOf('sys:') === 0) {
    var cat   = logFilter.slice(4);
    var flags = loadTradeFlags();
    return trades.filter(function(t) {
      var f = flags[String(t.ticket)];
      return f && ((f.comment || '').trim() || 'Uncategorised') === cat;
    });
  }
  return trades.filter(function(t){ return t.item === logFilter; });
}

function renderTradeLog(trades) {
  var sorted   = trades.slice().sort(function(a,b){ return new Date(b.closeDate) - new Date(a.closeDate); });
  var total    = sorted.length;
  var pages    = Math.max(1, Math.ceil(total / LOG_PAGE_SZ));
  logPage      = Math.min(logPage, pages);
  var start    = (logPage - 1) * LOG_PAGE_SZ;
  var pageRows = sorted.slice(start, start + LOG_PAGE_SZ);

  var flags = loadTradeFlags();
  document.getElementById('tradeLogBody').innerHTML = pageRows.map(function(t) {
    var slBadge  = t.isSLHit ? '<span class="log-sl">SL</span>' : '';
    var profCls  = t.profit >= 0 ? 'profit-pos' : 'profit-neg';
    var dirCls   = t.type === 'buy' ? 'dir-buy' : 'dir-sell';
    var openStr  = t.openTime  ? t.openTime.slice(0,16)  : '';
    var closeStr = t.closeTime ? t.closeTime.slice(0,16) : '';
    var key      = String(t.ticket);
    var flag     = flags[key];
    var sysTd    = flag
      ? '<span class="log-sys-badge" title="' + (flag.comment || 'System trade') + '">SYS</span>'
        + ' <button class="log-unflag-btn" onclick="unflagTrade(\'' + key + '\')" title="Remove flag">&#10005;</button>'
      : '<button class="log-flag-btn" onclick="openFlagModal(\'' + key + '\')">Flag</button>';
    return '<tr class="' + (flag ? 'log-row-sys' : '') + '">'
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
      + '<td class="log-sys-cell">' + sysTd + '</td>'
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

// ── Account 2 (XLSX) ──────────────────────────────────────────────────────────

function fetchXlsx() {
  if (typeof XLSX === 'undefined') return;
  fetch('trading-activity.xlsx')
    .then(function(r) { if (!r.ok) throw new Error(); return r.arrayBuffer(); })
    .then(function(buf) {
      var result  = parseXlsx(buf);
      xlsxTrades  = result.trades;
      syncAcctTabs();
    })
    .catch(function() {});
}

function pdXlsx(s) {
  if (!s || s === '-') return null;
  var d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function parseXlsx(buffer) {
  var wb   = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  var ws   = wb.Sheets[wb.SheetNames[0]];
  var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  var trades = [];
  for (var i = 1; i < rows.length; i++) {
    var r         = rows[i];
    var closeDate = r[1];
    if (!closeDate || closeDate === '-') continue;

    var profit = parseFloat(r[10]);
    if (isNaN(profit)) continue;

    var openD  = pdXlsx(String(r[0]));
    var closeD = pdXlsx(String(closeDate));

    // Action on close row is the closing direction; opening is opposite
    var closeAction = r[4] ? r[4].toLowerCase() : 'sell';
    var openType    = closeAction === 'sell' ? 'buy' : 'sell';

    trades.push({
      ticket:     String(r[2] || ''),
      openTime:   r[0] ? String(r[0]) : '',
      type:       openType,
      size:       parseFloat(r[5]) || 0,
      item:       r[3] ? String(r[3]).toLowerCase() : '',
      openPrice:  parseFloat(r[6]) || 0,
      sl:         0,
      tp:         0,
      closeTime:  String(closeDate),
      closePrice: parseFloat(r[8]) || 0,
      profit:     profit,
      isSLHit:    false,
      isWin:      profit > 0,
      openDate:   openD  ? openD.toISOString()  : null,
      closeDate:  closeD ? closeD.toISOString() : null,
    });
  }
  return { trades: trades, summary: {} };
}

function setAccount(n) {
  if (n === activeAccount) return;
  activeAccount = n;
  if (n === 2) {
    stmtTrades  = xlsxTrades;
    stmtSummary = {};
    acctPrefix  = '$';
    var sub = document.getElementById('dashSub');
    if (sub) sub.textContent = 'Account 2 · trading-activity.xlsx · USD';
  } else {
    stmtTrades  = stmtTradesHF;
    stmtSummary = stmtSummaryHF;
    acctPrefix  = 'R';
    var sub = document.getElementById('dashSub');
    if (sub) sub.textContent = 'Account 1 · ZAR';
  }
  calInited = false;
  destroyCharts();
  logFilter = 'all';
  logPage   = 1;
  renderDashboard();
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
      var plStr = sign + acctPrefix + ' ' + Math.round(Math.abs(data.pl)).toLocaleString();
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
    +   '<div class="cal-sum-val">' + plSign + acctPrefix + ' ' + Math.round(monthPL).toLocaleString() + '</div>'
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
