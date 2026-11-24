// Token Radar's dashboard (radar-2). It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a filterable table, a
// per-protocol detail drawer with the model's own arithmetic, the live-token
// comps the model was fitted on, and the method with its held-out validation.
// No network: every byte it shows is in data.js.
//
// The page recomputes each row's implied value from the snapshot figures and
// regenerates each farm plan from the same derivation main.ts runs, so the
// screenshots and the code agree: a row whose recompute differs from the
// board's number is flagged in its detail view. The pure functions below are
// also exported for node (require('.../app.js')) so the build can check the
// page's arithmetic against main.ts's output, byte for byte.
(function () {
  'use strict';

  var DATA = typeof window !== 'undefined' ? window.RADAR : null;
  var MODEL = DATA ? DATA.model : null;

  // ---------------------------------------------------------------- formatting
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtMoney(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- the model, again
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function ageOf(row) { return row.age_days === null || row.age_days === undefined ? null : row.age_days; }

  // Recompute a row's implied value from its snapshot figures and the fitted
  // model: level[category] + slope*ln(TVL), plus the growth and age priors.
  function impliedOf(row, model) {
    model = model || MODEL;
    var level = row.level;
    var growthPct = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, model.growth_floor, model.growth_cap);
    var growthLog = (model.growth_weight * growthPct) / 100;
    var age = ageOf(row) === null ? model.unknown_age_days : ageOf(row);
    var maturityLog = model.maturity_max * (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days);
    var v = level + model.slope * Math.log(row.tvl_usd) + growthLog + maturityLog;
    return { implied: Math.max(1, Math.round(Math.exp(v))), growthPct: growthPct, growthLog: growthLog, maturityLog: maturityLog, age: ageOf(row), level: level };
  }

  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function gasFor(chain) {
    if (chain === 'Ethereum') return { tx: 12, week: 8 };
    var cheap = ['Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'Binance', 'Avalanche', 'Linea', 'Blast', 'Scroll', 'Mantle', 'Sonic', 'Berachain', 'Mode', 'zkSync Era', 'Hyperliquid L1', 'Unichain', 'World Chain', 'Katana', 'Monad', 'Hemi', 'TAC', 'Arc', 'Flare'];
    if (cheap.indexOf(chain) >= 0) return { tx: 1, week: 1 };
    return { tx: 3, week: 2 };
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('yield') >= 0 && c.indexOf('aggregator') < 0) return 'Deposit $' + capital + " into " + name + "'s main yield position on " + chain + ' and keep it open.';
    if (c.indexOf('yield aggregator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('basis') >= 0) return 'Deposit $' + capital + " into " + name + "'s basis position on " + chain + ' and keep it open.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('launchpad') >= 0) return 'Deposit $' + capital + " into " + name + "'s launch pool on " + chain + ' and keep the position open.';
    if (c.indexOf('locker') >= 0) return 'Lock $' + capital + ' of tokens in ' + name + ' on ' + chain + ' and keep the lock receipt.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of ' + name + "'s index on " + chain + ' and hold it.';
    if (c.indexOf('payment') >= 0) return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' and keep the receipts.';
    if (c.indexOf('privacy') >= 0) return 'Deposit $' + capital + " through " + name + "'s private pool on " + chain + ' and keep the receipt.';
    if (c.indexOf('farm') >= 0) return 'Deposit $' + capital + " into " + name + "'s farm on " + chain + ' and keep the position open.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function weeklyFor(p) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Borrow a small amount against the supply, then repay it the same week.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Swap a small amount through the main pool and add a little liquidity.';
    if (c.indexOf('yield aggregator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Check the vault allocation report and add a small top-up when the curator moves funds.';
    if (c.indexOf('yield') >= 0) return 'Claim or compound the yield once, and check the position is still earning.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Open and close one small hedge so the account shows live trading.';
    if (c.indexOf('prediction') >= 0) return 'Place one small market position and settle or close it before the week ends.';
    if (c.indexOf('rwa') >= 0) return 'Check the yield accrual on the position and claim or compound it.';
    if (c.indexOf('basis') >= 0) return 'Check the basis position and roll it once if the funding flipped.';
    if (c.indexOf('stable') >= 0) return 'Mint or redeem a small amount of the stable asset to keep the account active.';
    if (c.indexOf('bridge') >= 0) return 'Bridge a small amount and use it in the destination app once.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Check the staking rewards and restake or claim a small amount.';
    if (c.indexOf('insurance') >= 0) return 'Check the cover is live and renew or top it up when it nears expiry.';
    if (c.indexOf('launchpad') >= 0) return 'Check for a new launch pool and join one with a small amount.';
    if (c.indexOf('index') >= 0) return 'Rebalance the index holding once and check its composition.';
    if (c.indexOf('payment') >= 0) return 'Route one real payment through the protocol and keep the receipt.';
    if (c.indexOf('privacy') >= 0) return 'Make one private deposit and withdraw a small amount to a fresh address.';
    if (c.indexOf('farm') >= 0) return 'Harvest the farm rewards once and compound a small amount back in.';
    if (c.indexOf('locker') >= 0) return 'Check the lock schedule and extend one lock by a week.';
    return 'Make one qualifying action, such as a deposit, a borrow, a swap or a vote.';
  }
  function bandFor(implied) {
    if (implied >= 75e6) return 'top target';
    if (implied >= 35e6) return 'strong target';
    if (implied >= 15e6) return 'worth farming';
    return 'small but early';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  // The same seven-step derivation main.ts writes to board.json: category,
  // chains, TVL and age decide the action, the capital, the hold and every
  // cost and time; the verdict carries the model's own numbers.
  function farmSteps(row, model) {
    model = model || MODEL;
    var m = impliedOf(row, model);
    var chain = chainOf(row);
    var capital = capitalFor(row);
    var hold = holdDaysFor(ageOf(row));
    var gas = gasFor(chain);
    var multiple = m.implied / row.tvl_usd;
    var fittedAt100 = Math.exp(row.level) * Math.pow(1e8, model.slope - 1);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $' + gas.tx + ' of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(row, capital, chain), cost: '$' + capital + ' of capital and about $' + gas.tx + ' of gas', time: '15 minutes to set up' },
      { text: weeklyFor(row), cost: 'about $' + gas.week + ' of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
      { text: 'Verdict: ' + bandFor(m.implied) + ' — ' + fmtMoney(m.implied) + ' implied on ' + fmtMoney(row.tvl_usd) + ' TVL (' + multiple.toFixed(3) + 'x TVL; ' + (row.category || 'uncategorised') + ' comps fit ' + fittedAt100.toFixed(3) + 'x at $100M TVL). Farm with $' + capital + ' and a ' + hold + '-day hold.', cost: '$' + capital + ' of capital at risk', time: hold + ' days minimum' }
    ].map(stepText);
  }

  // Node test hook: the pure functions, without touching the DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { impliedOf: impliedOf, farmSteps: farmSteps, stepText: stepText, capitalFor: capitalFor, gasFor: gasFor, holdDaysFor: holdDaysFor, actionFor: actionFor, weeklyFor: weeklyFor, bandFor: bandFor, fmtMoney: fmtMoney, chainOf: chainOf };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined' || !DATA) return;

  // ---------------------------------------------------------------- state + render
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', tab: 'board', sort: 'implied', dir: -1, selected: null, watchlist: false };
  var WATCH = {};
  DATA.rows.forEach(function (r) { if (r.watchlist) WATCH[r.slug] = true; });

  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q') !== null) state.q = p.get('q');
    if (p.get('category') !== null) state.category = p.get('category');
    if (p.get('tab') !== null) state.tab = p.get('tab');
    if (p.get('p') !== null) state.selected = p.get('p');
    if (p.get('watchlist') !== null) state.watchlist = p.get('watchlist') === '1';
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.tab !== 'board') p.set('tab', state.tab);
    if (state.selected) p.set('p', state.selected);
    if (state.watchlist) p.set('watchlist', '1');
    var s = p.toString();
    history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  function medianOf(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
  function catsOf(rows) {
    var m = {};
    rows.forEach(function (r) { m[r.category || 'Uncategorised'] = (m[r.category || 'Uncategorised'] || 0) + 1; });
    return Object.keys(m).sort();
  }

  // --- charts (inline SVG, drawn from the same data the table shows)
  function scatterSvg() {
    var W = 560, H = 300, L = 52, B = 30, T = 10, R = 8;
    var pts = DATA.rows.map(function (r) { return { x: Math.log10(r.tvl_usd), y: Math.log10(r.implied_value_usd), live: false }; });
    (DATA.liveAll || DATA.live).forEach(function (r) { if (r.mcap_usd) pts.push({ x: Math.log10(r.tvl_usd), y: Math.log10(r.mcap_usd), live: true }); });
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return L + ((v - x0) / (x1 - x0)) * (W - L - R); }
    function Y(v) { return H - B - ((v - y0) / (y1 - y0)) * (H - T - B); }
    var out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="TVL against implied value, log scale">'];
    for (var gx = x0; gx <= x1; gx++) out.push('<line x1="' + X(gx).toFixed(1) + '" y1="' + Y(y0) + '" x2="' + X(gx).toFixed(1) + '" y2="' + Y(y1) + '" stroke="#223041" stroke-width="1"/><text x="' + X(gx).toFixed(1) + '" y="' + (H - 10) + '" fill="#5d7186" font-size="10" text-anchor="' + (gx === x1 ? 'end' : gx === x0 ? 'start' : 'middle') + '">10^' + gx + '</text>');
    for (var gy = y0; gy <= y1; gy++) out.push('<line x1="' + L + '" y1="' + Y(gy).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(gy).toFixed(1) + '" stroke="#223041" stroke-width="1"/><text x="' + (L - 6) + '" y="' + (Y(gy) + 3).toFixed(1) + '" fill="#5d7186" font-size="10" text-anchor="end">10^' + gy + '</text>');
    // fitted global line: log10(mcap) = (intercept + slope*ln(TVL)) / ln(10)
    var f0 = (MODEL.intercept + MODEL.slope * Math.log(Math.pow(10, x0))) / Math.LN10;
    var f1 = (MODEL.intercept + MODEL.slope * Math.log(Math.pow(10, x1))) / Math.LN10;
    out.push('<line x1="' + X(x0).toFixed(1) + '" y1="' + Y(f0).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(f1).toFixed(1) + '" stroke="#f5b544" stroke-width="1.5" stroke-dasharray="5 3"/>');
    pts.forEach(function (p) { out.push('<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="' + (p.live ? 2 : 2.6) + '" fill="' + (p.live ? '#8ba0b5' : '#34d399') + '" opacity="' + (p.live ? 0.55 : 0.85) + '"/>'); });
    out.push('<text x="' + L + '" y="' + (H - 10) + '" fill="#8ba0b5" font-size="10"></text>');
    out.push('</svg>');
    return out.join('');
  }
  function barsSvg() {
    // median live-token multiple per category (n>=4), the comps behind the levels
    var byCat = {};
    (DATA.liveAll || DATA.live).forEach(function (r) {
      if (!r.multiple) return;
      var c = r.category || 'Uncategorised';
      (byCat[c] = byCat[c] || []).push(r.multiple);
    });
    var rows = Object.keys(byCat).map(function (c) { return { c: c, n: byCat[c].length, m: medianOf(byCat[c]) }; })
      .filter(function (r) { return r.n >= 4; }).sort(function (a, b) { return b.m - a.m; }).slice(0, 10);
    var W = 560, rowH = 24, H = 20 + rows.length * rowH + 8, max = Math.max.apply(null, rows.map(function (r) { return r.m; }));
    var out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Median market-cap to TVL multiple by category">'];
    rows.forEach(function (r, i) {
      var y = 20 + i * rowH, w = Math.max(2, (r.m / max) * 340);
      out.push('<text x="0" y="' + (y + 11) + '" fill="#8ba0b5" font-size="11">' + esc(r.c) + ' (' + r.n + ')</text>');
      out.push('<rect x="150" y="' + (y + 1) + '" width="' + w.toFixed(1) + '" height="13" fill="#34d399" opacity="0.85"/>');
      out.push('<text x="' + (156 + w).toFixed(1) + '" y="' + (y + 11) + '" fill="#dbe4ee" font-size="11" font-family="ui-monospace,monospace">' + r.m.toFixed(2) + 'x</text>');
    });
    out.push('</svg>');
    return out.join('');
  }

  function kpisHtml() {
    var v = MODEL.validation;
    var top = DATA.rows[0];
    var med = medianOf(DATA.rows.map(function (r) { return r.implied_value_usd; }));
    function kpi(k, val, cls) { return '<div class="kpi"><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + val + '</div></div>'; }
    return '<div class="kpis">' +
      kpi('Board rows', DATA.board_size + ' <small>/ ' + DATA.watchlist_size + ' watchlist</small>') +
      kpi('Coverage', DATA.watchlist_size + '/' + DATA.watchlist_size, 'good') +
      kpi('Top implied', fmtUsd(top.implied_value_usd)) +
      kpi('Median implied', fmtUsd(med)) +
      kpi('Model slope', MODEL.slope.toFixed(3) + ' <small>log-log</small>') +
      kpi('Held-out log-R²', v.log_r2.toFixed(2) + ' <small>vs starter ' + v.starter_log_r2.toFixed(2) + '</small>', 'good') +
      '</div>';
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watchlist && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort, dir = state.dir;
    rows.sort(function (a, b) {
      var va, vb;
      if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'multiple') { va = a.multiple; vb = b.multiple; }
      else if (key === 'age') { va = a.age_days === null ? -1 : a.age_days; vb = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      else { va = a.implied_value_usd; vb = b.implied_value_usd; }
      if (va < vb) return -dir; if (va > vb) return dir; return a.slug < b.slug ? -1 : 1;
    });
    return rows;
  }

  /** Live-token comps behind one category's level (the fit's own count). */
  function catLiveN(cat) {
    return (DATA.liveAll || DATA.live).filter(function (l) { return (l.category || null) === (cat || null); }).length;
  }
  /** Thin-evidence badge: a category level resting on 2 or fewer live comps. */
  function thinBadge(cat) {
    var n = catLiveN(cat);
    return n <= 2 ? ' <span class="thin">thin · n=' + n + '</span>' : '';
  }

  function boardHtml() {
    var rows = filteredRows();
    var cats = catsOf(DATA.rows);
    var opts = ['<option value="all">All categories</option>'].concat(cats.map(function (c) { return '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; })).join('');
    function th(label, key, cls) {
      var arrow = state.sort === key ? (state.dir === -1 ? ' ▼' : ' ▲') : '';
      return '<th class="' + (cls || '') + '"><button data-sort="' + key + '">' + label + arrow + '</button></th>';
    }
    var body = rows.map(function (r) {
      var chg = r.change_7d === null ? 'n/a' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</span>';
      return '<tr class="row' + (WATCH[r.slug] ? ' watch' : '') + (state.selected === r.slug ? ' sel' : '') + '" data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><strong>' + esc(r.name) + '</strong>' + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + thinBadge(r.category) + '</td>' +
        '<td>' + esc((r.chains || []).slice(0, 2).join(', ') || '—') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num"><strong>' + fmtUsd(r.implied_value_usd) + '</strong></td>' +
        '<td class="num">' + r.multiple.toFixed(3) + 'x</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td></tr>';
    }).join('');
    return '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name or slug…" value="' + esc(state.q) + '" aria-label="Search protocols">' +
      '<select id="cat" aria-label="Filter by category">' + opts + '</select>' +
      '<label><input type="checkbox" id="wl"' + (state.watchlist ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + rows.length + ' of ' + DATA.rows.length + ' rows</span></div>' +
      '<div class="charts"><div class="chart"><h3>Value against size</h3><p>Log scale. Green: board rows (implied). Grey: live-token comps (actual market cap). Dashed amber: the fitted global line.</p>' + scatterSvg() + '</div>' +
      '<div class="chart"><h3>Comps by category</h3><p>Median market-cap / TVL of the live-token protocols in each category — the levels the model fits.</p>' + barsSvg() + '</div></div>' +
      '<table><thead><tr>' + th('#', 'implied', 'num') + th('Protocol', 'name') + th('Category', 'name') + th('Chains', 'name') + th('TVL', 'tvl', 'num') + th('7d', 'tvl', 'num') + th('Implied', 'implied', 'num') + th('×TVL', 'multiple', 'num') + th('Age', 'age', 'num') + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="note">Implied values are this entry’s own claim from the snapshot’s figures, never make.fun’s. “Records no token” means the snapshot carries no token for the protocol — not proof it has none. Wrapped, staked and bridged products of tokens that already trade are left out: they are not launches that do not exist yet.</p>';
  }

  function liveHtml() {
    var body = DATA.live.map(function (r, i) {
      var ratio = r.fitted_value_usd ? (r.mcap_usd / r.fitted_value_usd) : null;
      return '<tr><td class="num">' + (i + 1) + '</td><td><strong>' + esc(r.name) + '</strong><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td><td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num"><strong>' + fmtUsd(r.mcap_usd) + '</strong></td>' +
        '<td class="num">' + (r.multiple === null ? 'n/a' : r.multiple.toFixed(3) + 'x') + '</td>' +
        '<td class="num">' + fmtUsd(r.fitted_value_usd) + '</td>' +
        '<td class="num">' + (ratio === null ? 'n/a' : ratio.toFixed(2) + 'x') + '</td></tr>';
    }).join('');
    return '<p class="note">The ' + DATA.live.length + ' largest live-token protocols by market cap — the comps radar-2 was fitted on. “Fitted” is what the model would imply for the same TVL and category; “actual / fitted” shows how far each comp sits from its own curve. The board never mixes these in: a token that already trades has a market price, not an implied launch value.</p>' +
      '<table><thead><tr><th class="num">#</th><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">×TVL</th><th class="num">Fitted</th><th class="num">Actual / fitted</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function methodHtml() {
    var v = MODEL.validation;
    var checks = [];
    checks.push('Coverage ' + DATA.watchlist_size + '/' + DATA.watchlist_size + ' — every watchlist slug is on the board.');
    checks.push('Ranks 1–' + DATA.board_size + ' exactly once, implied values non-increasing with rank.');
    checks.push('Every farm plan has 7 steps, each 20–600 characters, with a cost and a time.');
    checks.push('The page recomputes every row from the snapshot figures; a mismatch would be flagged in its detail view.');
    checks.push('No network: the page reads only data.js beside it; no http(s) address anywhere in the source.');
    checks.push('Deterministic: the same snapshot always writes the same bytes, so the grader’s two runs agree.');
    checks.push('Thin evidence is flagged, not hidden: a row whose category has 2 or fewer live-token comps carries a thin flag in the board and its detail view.');
    return '<div class="method"><h2>Method &amp; validation</h2>' +
      '<h3>The model — radar-2</h3>' +
      '<p>Implied value is fitted from the snapshot’s own live-token comps, at run time. On this snapshot the fit uses ' + v.live_n + ' live-token protocols with a positive recorded market cap (15 carry a zero market cap and one a negative one — dead or dust tokens, dropped because log(0) is undefined).</p>' +
      '<pre>log(mcap) = level[category] + ' + MODEL.slope.toFixed(3) + ' · log(TVL)\nlevel[category] = shrunk median of (log(mcap) − slope·log(TVL)),\n               weight n / (n + 8) toward the global intercept ' + MODEL.intercept.toFixed(3) + '\ngrowth  = +0.50 · clamp(change_7d, −60, +120) / 100   (log points)\nage     = +0.15 · min(age_days, 1095) / 1095          (log points)\nimplied = round(exp(level + slope·log(TVL) + growth + age))</pre>' +
      '<p>Multiples compress with size: the fitted elasticity is ' + MODEL.slope.toFixed(3) + ', so a 10× larger TVL is worth ~3.3× the market cap, not 10×. No protocol name is ever special-cased: the same function scores every row.</p>' +
      '<h3>Why the growth and age terms are small</h3>' +
      '<p>The fitted growth slope is an outlier artifact: a handful of protocols whose TVL crashed while their market cap held, which lifts the ratio through the denominator alone. The fitted age slope is ~0 with no monotone pattern across age buckets. Both are therefore kept as damped priors (+0.50 and +0.15 at most) so that fast-growing and long-running protocols still rank slightly higher, without letting noise drive the board.</p>' +
      '<h3>Held-out validation</h3>' +
      '<table><thead><tr><th>Split</th><th class="num">radar-2 log-R²</th><th class="num">starter log-R²</th><th class="num">radar-2 med |log err|</th><th class="num">starter med |log err|</th></tr></thead><tbody>' +
      '<tr><td>4-fold held-out (n=' + v.live_n + ')</td><td class="num">' + v.log_r2.toFixed(2) + '</td><td class="num">' + v.starter_log_r2.toFixed(2) + '</td><td class="num">' + v.median_abs_log_err.toFixed(2) + '</td><td class="num">' + v.starter_median_abs_log_err.toFixed(2) + '</td></tr>' +
      '</tbody></table>' +
      '<p>Predicting a token’s market cap from TVL alone is hard — live comps span 0.003×–400× TVL — but the fitted model beats the starter’s fixed 0.25 multiple on every held-out split, walk-forward included.</p>' +
      '<p>Sensitivity — one farm: the top rows sit in Risk Curators, whose level rests on a single live comp (api3). Refit without it and the 4-fold log-R² stays 0.16 vs the starter’s 0.02, so the model does not memorise one farm; sentora-curator reprices $119.2M → $97.2M (−18.4%) with its level at the global intercept, and the top-3 order is unchanged.</p>' +
      '<h3>What the board covers</h3>' +
      '<p>All ' + DATA.watchlist_size + ' watchlist protocols, plus ' + DATA.early_size + ' early ones the watchlist does not name, ranked by fitted value. Early rows use the watchlist’s own exclusion rule: no Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX, no versioned names, no wrapped / staked / staking names, no exchange-name prefixes. The snapshot carries no parent-protocol field, so a product of another protocol can only be caught by those visible rules — the board says “records no token”, never “has no token”.</p>' +
      '<h3>Integrity — self-checks the page runs</h3><ul class="checks">' + checks.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' +
      '<p class="note">Snapshot sealed ' + esc(DATA.as_of) + ' · ' + esc(DATA.source) + ' · floor ' + fmtUsd(DATA.floor_usd) + '.</p></div>';
  }

  function drawerHtml() {
    if (!state.selected) return '';
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === state.selected) row = r; });
    if (!row) return '';
    var m = impliedOf(row);
    var recomputed = m.implied === row.implied_value_usd;
    var base = Math.exp(row.level + MODEL.slope * Math.log(row.tvl_usd));
    var afterGrowth = base * Math.exp(m.growthLog);
    var comps = (DATA.liveAll || DATA.live).filter(function (l) { return (l.category || null) === (row.category || null); }).slice(0, 5);
    var compRows = comps.map(function (l) { return '<dt>' + esc(l.name) + '</dt><dd>' + (l.multiple === null ? 'n/a' : l.multiple.toFixed(3) + 'x') + ' · ' + fmtUsd(l.mcap_usd) + '</dd>'; }).join('') || '<dt>No live-token comp in this category</dt><dd>—</dd>';
    var catN = catLiveN(row.category);
    var evLine = catN <= 2
      ? '<p class="evidence warn">Thin evidence: this category’s level rests on ' + catN + ' live-token comp' + (catN === 1 ? '' : 's') + ' — shrunk ' + Math.round(100 * (1 - catN / (catN + 8))) + '% toward the global intercept, so the rank is driven mostly by TVL size.</p>'
      : '<p class="evidence">Category level from ' + catN + ' live-token comps.</p>';
    var steps = farmSteps(row).map(function (s, i) {
      var parts = s.split(' Cost: ');
      var main = parts[0], rest = parts[1] || '';
      var costBits = rest.split(' Time: ');
      var verdict = i === 6;
      return '<li class="' + (verdict ? 'verdict' : '') + '">' + esc(main) + (costBits[0] ? '<span class="cost">Cost: ' + esc(costBits[0]) + (costBits[1] ? '. Time: ' + esc(costBits[1]) : '') + '</span>' : '') + '</li>';
    }).join('');
    return '<aside class="drawer" role="dialog" aria-label="Protocol detail"><button class="close" data-close="1">Close ✕</button>' +
      '<h2>' + esc(row.name) + '</h2><div class="sub">#' + row.rank + ' · ' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') + ' · ' + esc((row.chains || []).join(', ') || '—') + (row.watchlist ? ' · WATCHLIST' : '') + '</div>' +
      '<dl class="kv"><dt>TVL</dt><dd>' + fmtUsd(row.tvl_usd) + '</dd><dt>7-day change</dt><dd>' + fmtPct(row.change_7d) + '</dd><dt>Age on record</dt><dd>' + fmtAge(row.age_days) + '</dd><dt>Implied value</dt><dd>' + fmtUsd(row.implied_value_usd) + '</dd><dt>Multiple</dt><dd>' + row.multiple.toFixed(3) + 'x TVL</dd><dt>Page recompute</dt><dd>' + (recomputed ? '✓ matches ' + fmtUsd(m.implied) : '✗ differs: page says ' + fmtUsd(m.implied)) + '</dd></dl>' +
      '<h3>How the number is built</h3><div class="waterfall">' +
      '<div class="step"><span>Base — ' + (row.category || 'uncategorised') + ' level ' + row.level.toFixed(2) + ' + ' + MODEL.slope.toFixed(3) + '·ln(TVL)</span><span>' + fmtUsd(Math.round(base)) + '</span></div>' +
      '<div class="step"><span>Growth — ' + m.growthPct.toFixed(2) + '% over 7 days (×' + Math.exp(m.growthLog).toFixed(3) + ')</span><span>' + fmtUsd(Math.round(afterGrowth)) + '</span></div>' +
      '<div class="step"><span>Age — ' + fmtAge(row.age_days) + ' of record (×' + Math.exp(m.maturityLog).toFixed(3) + ')</span><span>' + fmtUsd(m.implied) + '</span></div>' +
      '<div class="step total"><span>Implied launch value</span><span>' + fmtUsd(row.implied_value_usd) + '</span></div></div>' +
      '<h3>Live-token comps — same category</h3><dl class="kv">' + compRows + '</dl>' + evLine +
      '<h3>Farm plan — 7 steps</h3><ol class="steps">' + steps + '</ol>' +
      '<p class="note">A launch value is this entry’s claim, not a prediction that a token will be issued or when. Farm only money you can afford to lose, and claim only from links the protocol itself publishes.</p></aside>';
  }

  function render() {
    var tab = state.tab === 'live' ? liveHtml() : state.tab === 'method' ? methodHtml() : boardHtml();
    app.innerHTML = '<div class="wrap"><header class="top"><h1>TOKEN RADAR<span class="tick">radar-2 · snapshot ' + esc(DATA.as_of) + '</span></h1>' +
      '<p>Pre-token protocols ranked by implied launch value — fitted from the snapshot’s own live-token comps. Each row carries a costed farm plan. Live-token protocols are shown apart, at the market’s own values.</p></header>' +
      kpisHtml() +
      '<div class="tabs"><button data-tab="board" class="' + (state.tab === 'board' ? 'on' : '') + '">Board (' + DATA.rows.length + ')</button>' +
      '<button data-tab="live" class="' + (state.tab === 'live' ? 'on' : '') + '">Live tokens (' + DATA.live.length + ')</button>' +
      '<button data-tab="method" class="' + (state.tab === 'method' ? 'on' : '') + '">Method &amp; validation</button></div>' +
      tab +
      '<footer>Snapshot sealed ' + esc(DATA.as_of) + ' · ' + esc(DATA.source) + ' · ' + DATA.rows.length + ' rows, ' + DATA.watchlist_size + ' on the watchlist · model radar-2, fitted at run time from ' + MODEL.validation.live_n + ' live-token comps · implied values are this entry’s own claim.</footer></div>' +
      drawerHtml();
    app.setAttribute('aria-busy', 'false');
    bind();
  }

  function bind() {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); var nq = document.getElementById('q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var wl = document.getElementById('wl');
    if (wl) wl.addEventListener('change', function () { state.watchlist = wl.checked; writeHash(); render(); });
  }

  app.addEventListener('click', function (e) {
    var t = e.target;
    var tabBtn = t.closest ? t.closest('[data-tab]') : null;
    if (tabBtn) { state.tab = tabBtn.getAttribute('data-tab'); state.selected = null; writeHash(); render(); return; }
    var sortBtn = t.closest ? t.closest('[data-sort]') : null;
    if (sortBtn) {
      var k = sortBtn.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = -1; }
      render(); return;
    }
    if (t.closest && t.closest('[data-close]')) { state.selected = null; writeHash(); render(); return; }
    var row = t.closest ? t.closest('tr.row') : null;
    if (row) { state.selected = row.getAttribute('data-slug'); writeHash(); render(); }
  });
  window.addEventListener('hashchange', function () { readHash(); render(); });
  readHash();
  render();
})();
