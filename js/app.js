'use strict';

var tps = [];
var pcs = [];
var ACCOUNT_BAL = 18000;
var DOLLAR_OPTS = [1,2,3,4,5,6,7,8,10,12,15,20,25,30,40,50];
var STORAGE_KEY   = 'wayne_calc_v1';
var TRADES_KEY    = 'wayne_trades_v1';

// ── Helpers ──────────────────────────────────────────────────────────────────

function g(id) { return document.getElementById(id); }
function fz(n) { return 'R ' + Math.round(Math.abs(n)).toLocaleString(); }

function pipOpts(sel) {
  return DOLLAR_OPTS.map(function(d) {
    return '<option value="' + d + '"' + (d === sel ? ' selected' : '') + '>$' + d + ' (' + d * 10 + ' pips)</option>';
  }).join('');
}

function lotsOpts(sel, max) {
  var h = '';
  for (var i = 1; i <= max; i++) h += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + i + ' lot' + (i > 1 ? 's' : '') + '</option>';
  return h;
}

function getPCPrice(pc) {
  var entry = parseFloat(g('entry').value) || 4546;
  var sign = g('dir').value === 'sell' ? -1 : 1;
  return entry + sign * pc.dollar;
}

// ── localStorage ─────────────────────────────────────────────────────────────

function saveState() {
  var state = {
    dir:   g('dir').value,
    zar:   g('zar').value,
    entry: g('entry').value,
    sl:    g('sl').value,
    ls:    g('ls').value,
    np:    g('np').value,
    tps:   tps,
    pcs:   pcs
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}

function loadState() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    var s = JSON.parse(raw);
    if (s.dir)   g('dir').value   = s.dir;
    if (s.zar)   g('zar').value   = s.zar;
    if (s.entry) g('entry').value = s.entry;
    if (s.sl)    g('sl').value    = s.sl;
    if (s.ls)    g('ls').value    = s.ls;
    if (s.np)    g('np').value    = s.np;
    if (Array.isArray(s.tps) && s.tps.length) tps = s.tps;
    if (Array.isArray(s.pcs) && s.pcs.length) pcs = s.pcs;
    return true;
  } catch(e) { return false; }
}

// ── Partial closes ────────────────────────────────────────────────────────────

function renderPCs() {
  var container = g('pcContainer');
  container.innerHTML = '';
  var np = parseInt(g('np').value) || 3;
  var ls = parseFloat(g('ls').value) || 0.01;
  var zar = parseFloat(g('zar').value) || 18.5;
  var dollarPerLot = ls * 100 * zar;

  pcs.forEach(function(pc, i) {
    var price = getPCPrice(pc);
    var profit = pc.dollar * dollarPerLot * pc.lots;
    var block = document.createElement('div');
    block.className = 'pc-block' + (pc.enabled ? ' active' : '');
    block.innerHTML =
      '<div class="pc-top">'
        + '<input type="checkbox" ' + (pc.enabled ? 'checked' : '') + ' onchange="togglePC(' + i + ',this.checked)">'
        + '<span class="pc-label">' + pc.label + '</span>'
        + '<span class="pc-badge ' + (pc.enabled ? 'on' : 'off') + '">' + (pc.enabled ? '&#x1F512; +' + fz(profit) : 'Inactive') + '</span>'
        + (pcs.length > 1 ? '<button class="del-pc-btn" onclick="removePC(' + i + ')">&#x2715;</button>' : '')
      + '</div>'
      + '<div class="pc-controls' + (pc.enabled ? '' : ' pc-disabled') + '">'
        + '<div class="pc-col"><label>Close at ($ move)</label><select onchange="updatePC(' + i + ',\'dollar\',this.value)">' + pipOpts(pc.dollar) + '</select></div>'
        + '<div class="pc-col"><label>Price</label><div class="pc-price">' + price.toFixed(1) + '</div></div>'
        + '<div class="pc-col"><label>Lots to close</label><select onchange="updatePC(' + i + ',\'lots\',this.value)">' + lotsOpts(pc.lots, np) + '</select></div>'
        + '<div class="pc-col"><label>Profit locked</label><div class="pc-result">' + fz(profit) + '</div></div>'
      + '</div>';
    container.appendChild(block);
  });

  var activePCs = pcs.filter(function(p) { return p.enabled; });
  if (activePCs.length > 0) {
    g('pcSummary').style.display = 'block';
    var total = 0; var rows = '';
    activePCs.forEach(function(pc) {
      var profit = pc.dollar * dollarPerLot * pc.lots;
      total += profit;
      rows += '<div class="sum-row"><span style="color:#666">' + pc.label + ' — ' + pc.lots + ' lot' + (pc.lots > 1 ? 's' : '') + ' @ $' + pc.dollar + ' move (' + pc.dollar * 10 + ' pips)</span><span style="font-weight:700;color:#1d9e75">+' + fz(profit) + '</span></div>';
    });
    rows += '<div class="sum-row" style="border-top:2px solid #c0dd97;margin-top:4px;padding-top:10px"><span style="font-weight:700">Total locked</span><span style="font-weight:700;color:#1d9e75;font-size:15px">+' + fz(total) + '</span></div>';
    g('pcSummaryRows').innerHTML = rows;
  } else {
    g('pcSummary').style.display = 'none';
  }
}

function togglePC(i, v) { pcs[i].enabled = v; calc(); }
function updatePC(i, key, val) {
  if (key === 'dollar') pcs[i].dollar = parseFloat(val) || 5;
  if (key === 'lots')   pcs[i].lots   = parseInt(val) || 1;
  calc();
}
function removePC(i) { pcs.splice(i, 1); pcs.forEach(function(p, idx) { p.label = 'Close ' + (idx + 1); }); calc(); }
function addPC() {
  pcs.push({ enabled: false, dollar: 5, lots: 1, label: 'Close ' + (pcs.length + 1) });
  calc();
}

// ── Take profit levels ────────────────────────────────────────────────────────

function renderTPs(rem, dollarPerLot, slDist, entry) {
  var container = g('tpContainer');
  container.innerHTML = '';
  tps.forEach(function(tp, i) {
    var dist = Math.abs(tp.val - entry);
    var profit = dist * dollarPerLot * rem;
    var rrr = slDist > 0 ? (dist / slDist).toFixed(1) : '0';
    var rrc = parseFloat(rrr) >= 2 ? '#0ecb8a' : parseFloat(rrr) >= 1.5 ? '#f5b935' : '#f64f57';
    var row = document.createElement('div');
    row.className = 'tp-row';
    row.innerHTML = '<label>' + tp.label + '</label>'
      + '<input type="number" value="' + tp.val.toFixed(1) + '" step="0.1" onchange="updateTP(' + i + ',this.value)">'
      + '<span class="tp-info">$' + dist.toFixed(1) + ' &middot; ' + Math.round(dist * 10) + ' pips &middot; ' + fz(profit) + '</span>'
      + '<span style="font-size:12px;font-weight:700;min-width:36px;text-align:right;color:' + rrc + '">1:' + rrr + '</span>'
      + (tps.length > 1 ? '<button class="del-btn" onclick="removeTP(' + i + ')">&#x2715;</button>' : '<span style="width:38px"></span>');
    container.appendChild(row);
  });
}

function updateTP(i, val) { tps[i].val = parseFloat(val) || tps[i].val; calc(); }
function addTP() {
  var entry = parseFloat(g('entry').value) || 4546;
  var sl    = parseFloat(g('sl').value) || 4560;
  var dir   = g('dir').value;
  var slDist = Math.abs(sl - entry);
  var sign  = dir === 'sell' ? -1 : 1;
  var last  = tps.length > 0 ? tps[tps.length - 1].val : entry;
  tps.push({ val: parseFloat((last + sign * slDist).toFixed(1)), label: 'TP' + (tps.length + 1) });
  calc();
}
function removeTP(i) { tps.splice(i, 1); tps.forEach(function(tp, idx) { tp.label = 'TP' + (idx + 1); }); calc(); }
function autoFill() {
  var entry  = parseFloat(g('entry').value) || 4546;
  var sl     = parseFloat(g('sl').value) || 4560;
  var dir    = g('dir').value;
  var slDist = Math.abs(sl - entry);
  var sign   = dir === 'sell' ? -1 : 1;
  tps = [
    { val: parseFloat((entry + sign * slDist * 1.5).toFixed(1)), label: 'TP1' },
    { val: parseFloat((entry + sign * slDist * 2).toFixed(1)),   label: 'TP2' },
    { val: parseFloat((entry + sign * slDist * 3).toFixed(1)),   label: 'TP3' },
    { val: parseFloat((entry + sign * slDist * 5).toFixed(1)),   label: 'TP4' },
  ];
  calc();
}

// ── Main calc ─────────────────────────────────────────────────────────────────

function calc() {
  var zar   = parseFloat(g('zar').value) || 18.5;
  var dir   = g('dir').value;
  var entry = parseFloat(g('entry').value) || 4546;
  var sl    = parseFloat(g('sl').value) || 4560;
  var ls    = parseFloat(g('ls').value) || 0.01;
  var np    = parseInt(g('np').value) || 3;

  g('lsVal').textContent = ls.toFixed(2);
  g('npVal').textContent = np;
  g('totalPill').textContent = (ls * np).toFixed(2) + ' lots';

  var slDist      = Math.abs(sl - entry);
  var slPips      = Math.round(slDist * 10);
  var dollarPerLot = ls * 100 * zar;
  var grossRisk   = slDist * dollarPerLot * np;

  g('risk').textContent    = fz(grossRisk);
  g('riskSub').textContent = '$' + slDist.toFixed(1) + ' · ' + slPips + ' pips';
  g('perDollar').textContent = fz(dollarPerLot * np);

  var activePCs      = pcs.filter(function(p) { return p.enabled; });
  var lockedLots     = activePCs.reduce(function(s, p) { return s + p.lots; }, 0);
  var lockedProfit   = activePCs.reduce(function(s, p) { return s + p.dollar * dollarPerLot * p.lots; }, 0);
  var remainingLots  = Math.max(np - lockedLots, 0);

  var grossRiskRemaining = slDist * dollarPerLot * remainingLots;
  var netRisk    = Math.max(grossRiskRemaining - lockedProfit, 0);
  var isFreeRide = lockedProfit >= grossRiskRemaining;
  var netRiskPct = (netRisk / ACCOUNT_BAL * 100).toFixed(2);

  var netRiskEl = g('netRisk');
  var boxNet    = g('boxNetRisk');
  if (activePCs.length > 0) {
    if (isFreeRide) {
      netRiskEl.textContent = 'FREE RIDE';
      netRiskEl.style.color = '#4a90f0';
      netRiskEl.style.fontSize = '14px';
      boxNet.className = 'box highlight';
      g('netRiskSub').textContent = 'locked > SL loss 🎉';
    } else {
      netRiskEl.textContent = fz(netRisk);
      netRiskEl.style.color = netRisk < grossRisk / 2 ? '#f5b935' : '#f64f57';
      netRiskEl.style.fontSize = '18px';
      boxNet.className = 'box';
      g('netRiskSub').textContent = netRiskPct + '% of account';
    }
    g('riskAdjustBox').style.display = 'block';
    g('adjGrossRisk').textContent = '-' + fz(grossRisk);
    g('adjLocked').textContent    = '+' + fz(lockedProfit);
    g('adjNetRisk').textContent   = isFreeRide ? 'FREE RIDE 🎉 (R' + Math.round(lockedProfit - grossRiskRemaining).toLocaleString() + ' guaranteed)' : '-' + fz(netRisk);
    g('adjNetRisk').style.color   = isFreeRide ? '#4a90f0' : netRisk < grossRisk / 2 ? '#f5b935' : '#f64f57';
    g('adjNetPct').textContent    = isFreeRide ? '0% — you cannot lose' : netRiskPct + '%';
  } else {
    netRiskEl.textContent = fz(grossRisk);
    netRiskEl.style.color = '#f64f57';
    netRiskEl.style.fontSize = '18px';
    boxNet.className = 'box';
    g('netRiskSub').textContent = 'no locks yet';
    g('riskAdjustBox').style.display = 'none';
  }

  g('lockedProfit').textContent  = fz(lockedProfit);
  g('lockedSub').textContent     = lockedLots + ' lot' + (lockedLots !== 1 ? 's' : '') + ' closed';
  g('remainingPill').textContent = remainingLots + ' lot' + (remainingLots !== 1 ? 's' : '') + ' remaining';

  renderPCs();
  renderTPs(remainingLots, dollarPerLot, slDist, entry);

  var bestTP    = tps.length > 0 ? tps[tps.length - 1] : null;
  var tpProfit  = bestTP ? Math.abs(bestTP.val - entry) * dollarPerLot * remainingLots : 0;
  var bestRRR   = bestTP && slDist > 0 ? Math.abs(bestTP.val - entry) / slDist : 0;
  g('tpProfit').textContent    = fz(tpProfit);
  g('tpProfitSub').textContent = remainingLots + ' lots to TP' + tps.length;
  g('totalProfit').textContent = fz(lockedProfit + tpProfit);

  // Breakdown table
  var html = '<tr style="background:rgba(246,79,87,.08)">'
    + '<td style="color:#f64f57">Stop loss</td>'
    + '<td style="color:#aaa">' + sl.toFixed(1) + '</td>'
    + '<td style="color:#f64f57">$' + slDist.toFixed(1) + '</td>'
    + '<td style="color:#5c6b84">' + slPips + '</td>'
    + '<td style="color:#5c6b84">' + np + '</td>'
    + '<td style="color:#f64f57;font-weight:700">-' + fz(grossRisk) + '</td>'
    + '<td style="color:#f64f57">gross</td>'
    + '</tr>';

  if (activePCs.length > 0) {
    html += '<tr style="background:rgba(245,185,53,.08)">'
      + '<td style="color:#f5b935" colspan="5">Net real risk (after locks)</td>'
      + '<td style="color:' + (isFreeRide ? '#4a90f0' : netRisk < grossRisk / 2 ? '#f5b935' : '#f64f57') + ';font-weight:700">' + (isFreeRide ? 'FREE RIDE 🎉' : '-' + fz(netRisk)) + '</td>'
      + '<td></td></tr>';
  }

  activePCs.forEach(function(pc) {
    var price  = getPCPrice(pc);
    var pips   = pc.dollar * 10;
    var profit = pc.dollar * dollarPerLot * pc.lots;
    var rrr    = slDist > 0 ? (pc.dollar / slDist).toFixed(1) : '0';
    html += '<tr style="background:rgba(14,203,138,.06)">'
      + '<td style="color:#0ecb8a">&#x1F512; ' + pc.label + '</td>'
      + '<td style="color:#5c6b84">' + price.toFixed(1) + '</td>'
      + '<td style="color:#5c6b84">$' + pc.dollar + '</td>'
      + '<td style="color:#5c6b84">' + pips + '</td>'
      + '<td style="color:#0ecb8a">' + pc.lots + '</td>'
      + '<td style="color:#0ecb8a;font-weight:700">+' + fz(profit) + '</td>'
      + '<td style="color:#f5b935">1:' + rrr + '</td>'
      + '</tr>';
  });

  tps.forEach(function(tp) {
    var dist   = Math.abs(tp.val - entry);
    var pips   = Math.round(dist * 10);
    var profit = dist * dollarPerLot * remainingLots;
    var rrr    = slDist > 0 ? (dist / slDist).toFixed(1) : '0';
    var rrc    = parseFloat(rrr) >= 2 ? '#0ecb8a' : parseFloat(rrr) >= 1.5 ? '#f5b935' : '#f64f57';
    html += '<tr style="background:rgba(14,203,138,.04)">'
      + '<td style="color:#0ecb8a">&#x1F3AF; ' + tp.label + '</td>'
      + '<td style="color:#5c6b84">' + tp.val.toFixed(1) + '</td>'
      + '<td style="color:#5c6b84">$' + dist.toFixed(1) + '</td>'
      + '<td style="color:#5c6b84">' + pips + '</td>'
      + '<td style="color:#0ecb8a">' + remainingLots + '</td>'
      + '<td style="color:#0ecb8a;font-weight:700">+' + fz(profit) + '</td>'
      + '<td style="color:' + rrc + ';font-weight:700">1:' + rrr + '</td>'
      + '</tr>';
  });

  html += '<tr style="border-top:1px solid #1c2538;background:rgba(255,255,255,.03)">'
    + '<td colspan="5" style="font-weight:700">Total (locked + best TP)</td>'
    + '<td style="color:#0ecb8a;font-weight:700;font-size:14px">+' + fz(lockedProfit + tpProfit) + '</td>'
    + '<td></td></tr>';
  g('tbl').innerHTML = html;

  var verd = g('verdict');
  if (isFreeRide) { verd.className = 'verdict vfree'; verd.textContent = '🎉 Free ride — locked profit covers SL risk. You cannot lose on this trade!'; }
  else if (bestRRR >= 2.5) { verd.className = 'verdict vg'; verd.textContent = '✓ Strong setup — reward well above risk'; }
  else if (bestRRR >= 1.5) { verd.className = 'verdict vo'; verd.textContent = '⚠ Acceptable — consider widening TP'; }
  else { verd.className = 'verdict vb'; verd.textContent = '✗ Weak — RRR below 1.5, reconsider'; }

  // Dollar move table
  var moves = [1,2,3,4,5,6,7,8,10,12,15,20,25,30,40,50];
  var dhtml = '';
  moves.forEach(function(d) {
    var pips = d * 10;
    var perL = d * dollarPerLot;
    var tot  = perL * np;
    var rrr  = slDist > 0 ? (d / slDist).toFixed(1) : '0';
    var rrc  = parseFloat(rrr) >= 2 ? '#0ecb8a' : parseFloat(rrr) >= 1 ? '#f5b935' : '#f64f57';
    var tags = '';
    tps.forEach(function(tp) { if (Math.abs(d - Math.abs(tp.val - entry)) < 0.3) tags += ' <span style="font-size:10px;background:rgba(14,203,138,.15);color:#0ecb8a;padding:1px 6px;border-radius:99px">' + tp.label + '</span>'; });
    activePCs.forEach(function(pc) { if (d === pc.dollar) tags += ' <span style="font-size:10px;background:rgba(245,185,53,.15);color:#f5b935;padding:1px 6px;border-radius:99px">&#x1F512;</span>'; });
    var hiSL = Math.abs(d - slDist) < 0.3;
    if (hiSL) tags += ' <span style="font-size:10px;background:rgba(246,79,87,.15);color:#f64f57;padding:1px 6px;border-radius:99px">SL</span>';
    var bg = tags.includes('TP') ? 'background:rgba(14,203,138,.04);' : tags.includes('🔒') ? 'background:rgba(14,203,138,.06);' : hiSL ? 'background:rgba(246,79,87,.08);' : '';
    dhtml += '<tr style="' + bg + '">'
      + '<td>$' + d + tags + '</td>'
      + '<td style="color:#5c6b84">' + pips + '</td>'
      + '<td style="color:#0ecb8a">' + fz(perL) + '</td>'
      + '<td style="color:#0ecb8a;font-weight:700">' + fz(tot) + '</td>'
      + '<td style="color:' + rrc + ';font-weight:600">1:' + rrr + '</td>'
      + '</tr>';
  });
  g('dollarTbl').innerHTML = dhtml;

  saveState();
}

// ── Trade journal ─────────────────────────────────────────────────────────────

function loadTrades() {
  try { return JSON.parse(localStorage.getItem(TRADES_KEY) || '[]'); } catch(e) { return []; }
}

function saveTrades(trades) {
  try { localStorage.setItem(TRADES_KEY, JSON.stringify(trades)); } catch(e) {}
}

function saveTrade() {
  var zar    = parseFloat(g('zar').value) || 18.5;
  var dir    = g('dir').value;
  var entry  = parseFloat(g('entry').value) || 4546;
  var sl     = parseFloat(g('sl').value) || 4560;
  var ls     = parseFloat(g('ls').value) || 0.01;
  var np     = parseInt(g('np').value) || 3;
  var note   = (g('tradeNote').value || '').trim();

  var slDist        = Math.abs(sl - entry);
  var dollarPerLot  = ls * 100 * zar;
  var grossRisk     = slDist * dollarPerLot * np;

  var activePCs     = pcs.filter(function(p) { return p.enabled; });
  var lockedLots    = activePCs.reduce(function(s, p) { return s + p.lots; }, 0);
  var lockedProfit  = activePCs.reduce(function(s, p) { return s + p.dollar * dollarPerLot * p.lots; }, 0);
  var remainingLots = Math.max(np - lockedLots, 0);
  var grossRiskRem  = slDist * dollarPerLot * remainingLots;
  var netRisk       = Math.max(grossRiskRem - lockedProfit, 0);
  var isFreeRide    = lockedProfit >= grossRiskRem;

  var bestTP    = tps.length > 0 ? tps[tps.length - 1] : null;
  var tpProfit  = bestTP ? Math.abs(bestTP.val - entry) * dollarPerLot * remainingLots : 0;
  var bestRRR   = bestTP && slDist > 0 ? Math.abs(bestTP.val - entry) / slDist : 0;

  var verdictText = isFreeRide ? 'Free ride' : bestRRR >= 2.5 ? 'Strong setup' : bestRRR >= 1.5 ? 'Acceptable' : 'Weak';
  var verdictClass = isFreeRide ? 'vfree' : bestRRR >= 2.5 ? 'vg' : bestRRR >= 1.5 ? 'vo' : 'vb';

  var trade = {
    id:            Date.now(),
    timestamp:     new Date().toLocaleString('en-ZA'),
    note:          note,
    direction:     dir,
    zarRate:       zar,
    entry:         entry,
    sl:            sl,
    slDistance:    parseFloat(slDist.toFixed(2)),
    slPips:        Math.round(slDist * 10),
    lotSize:       ls,
    positions:     np,
    totalLots:     parseFloat((ls * np).toFixed(2)),
    grossRisk:     Math.round(grossRisk),
    netRisk:       Math.round(netRisk),
    isFreeRide:    isFreeRide,
    lockedProfit:  Math.round(lockedProfit),
    lockedLots:    lockedLots,
    remainingLots: remainingLots,
    tpProfit:      Math.round(tpProfit),
    totalProfit:   Math.round(lockedProfit + tpProfit),
    bestRRR:       parseFloat(bestRRR.toFixed(2)),
    verdict:       verdictText,
    verdictClass:  verdictClass,
    partialCloses: activePCs.map(function(pc) {
      return { label: pc.label, dollar: pc.dollar, pips: pc.dollar * 10, lots: pc.lots, profit: Math.round(pc.dollar * dollarPerLot * pc.lots) };
    }),
    takeProfits: tps.map(function(tp) {
      var d = Math.abs(tp.val - entry);
      return { label: tp.label, price: tp.val, dollar: parseFloat(d.toFixed(2)), pips: Math.round(d * 10), rrr: parseFloat((slDist > 0 ? d / slDist : 0).toFixed(2)) };
    })
  };

  var trades = loadTrades();
  trades.unshift(trade);
  saveTrades(trades);
  g('tradeNote').value = '';
  renderHistory();

  var btn = g('saveFlash') || document.createElement('span');
  btn.id = 'saveFlash';
  btn.style.cssText = 'font-size:12px;color:#1d9e75;font-weight:700;transition:opacity 1s';
  btn.textContent = 'Saved!';
  var bar = document.querySelector('.save-bar');
  if (!document.getElementById('saveFlash')) bar.appendChild(btn);
  btn.style.opacity = '1';
  setTimeout(function() { btn.style.opacity = '0'; }, 1500);
}

function renderHistory() {
  var trades = loadTrades();
  var section = g('historySection');
  var list    = g('historyList');
  var countEl = g('historyCount');

  if (trades.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  countEl.textContent = trades.length + ' trade' + (trades.length !== 1 ? 's' : '');

  list.innerHTML = trades.map(function(t, i) {
    var partialHtml = '';
    if (t.partialCloses && t.partialCloses.length > 0) {
      partialHtml = '<div class="trade-partials"><strong>Partial closes locked:</strong> '
        + t.partialCloses.map(function(pc) {
            return pc.label + ' — ' + pc.lots + ' lot' + (pc.lots > 1 ? 's' : '') + ' @ $' + pc.dollar + ' (R' + pc.profit.toLocaleString() + ')';
          }).join(' &nbsp;|&nbsp; ')
        + '</div>';
    }
    var tpHtml = t.takeProfits && t.takeProfits.length > 0
      ? t.takeProfits.map(function(tp) { return tp.label + ' ' + tp.price + ' (1:' + tp.rrr + ')'; }).join(' · ')
      : '—';

    return '<div class="trade-card">'
      + '<div class="trade-card-header">'
      +   '<span class="trade-ts">' + t.timestamp + '</span>'
      +   '<span class="trade-dir ' + t.direction + '">' + t.direction.toUpperCase() + '</span>'
      +   '<span class="trade-note-text">' + (t.note || '') + '</span>'
      +   '<button class="trade-del-btn" onclick="deleteTrade(' + i + ')" title="Remove">&#x2715;</button>'
      + '</div>'
      + '<div class="trade-grid">'
      +   '<div class="trade-stat"><div class="ts-lbl">Entry</div><div class="ts-val">' + t.entry + '</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">Stop loss</div><div class="ts-val">' + t.sl + ' ($' + t.slDistance + ' / ' + t.slPips + ' pips)</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">Lots</div><div class="ts-val">' + t.totalLots + ' (' + t.positions + ' &times; ' + t.lotSize + ')</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">ZAR/USD</div><div class="ts-val">' + t.zarRate + '</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">Gross risk</div><div class="ts-val" style="color:#e24b4a">R ' + t.grossRisk.toLocaleString() + '</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">Net risk</div><div class="ts-val" style="color:' + (t.isFreeRide ? '#4a90f0' : '#f64f57') + '">' + (t.isFreeRide ? 'FREE RIDE' : 'R ' + t.netRisk.toLocaleString()) + '</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">Locked profit</div><div class="ts-val" style="color:#1d9e75">R ' + t.lockedProfit.toLocaleString() + '</div></div>'
      +   '<div class="trade-stat"><div class="ts-lbl">Best RRR</div><div class="ts-val">1:' + t.bestRRR + '</div></div>'
      + '</div>'
      + partialHtml
      + '<div style="margin-top:8px;font-size:11px;color:#999">TPs: ' + tpHtml + '</div>'
      + '<div class="trade-verdict ' + t.verdictClass + '">' + t.verdict + '</div>'
      + '</div>';
  }).join('');
}

function deleteTrade(i) {
  var trades = loadTrades();
  trades.splice(i, 1);
  saveTrades(trades);
  renderHistory();
}

function clearHistory() {
  if (!confirm('Clear all saved trades?')) return;
  saveTrades([]);
  renderHistory();
}

function exportTrades() {
  var trades = loadTrades();
  if (trades.length === 0) { alert('No saved trades yet.'); return; }
  var blob = new Blob([JSON.stringify(trades, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = 'wayne-trades-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(function init() {
  var restored = loadState();
  if (!restored) {
    addPC();
    autoFill();
  } else {
    calc();
  }
  renderHistory();
})();
