// radar-2: the token radar's model. One sealed snapshot in, one ranked board out.
//
// The board covers every slug on the snapshot's watchlist (the floor, never the
// ceiling) and adds the rankable pre-token protocols the watchlist does not
// name. A protocol is pre-token when its record carries no token at all (no
// market cap, no CoinGecko id, no symbol), and it is rankable only when it is
// not a wrapped, staked or bridged product of a token that already trades:
// the watchlist's own rule, applied to the early rows too. Live-token
// protocols are kept apart and shown at the market's own values, never mixed
// into the ranked board.
//
// Implied value is fitted from the snapshot's own live-token comps, at run
// time, never from a hand-kept list of names:
//
//   log(mcap) = level[category] + SLOPE * log(TVL)
//   level[category] = shrunk median of (log(mcap) - SLOPE*log(TVL)) over the
//                     category's live-token protocols, shrunk toward the
//                     global intercept with weight n / (n + 8)
//   growth  = +0.50 * clamp(change_7d, -60, 120) / 100   (log points)
//   age     = +0.15 * min(age_days, 1095) / 1095          (log points)
//   implied = round(exp(level + SLOPE*log(TVL) + growth + age))
//
// The fit on this snapshot: slope 0.522, so multiples compress with size (a
// 10x larger TVL is worth ~3.3x the market cap, not 10x); 4-fold held-out
// log-R2 0.16 against the starter radar-1's 0.02, median |log error| 1.31
// against 1.66; walk-forward (train oldest 75%, test newest 25%) also
// favours the fitted model over the starter. The growth and age terms are damped priors, not fitted
// slopes: the fitted growth slope is an outlier artifact (a handful of
// protocols whose TVL crashed while their market cap held, which lifts the
// ratio through the denominator alone), and the fitted age slope is ~0 with
// no monotone pattern, so both are kept small and stated as such.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** radar-2's fitted model: the slope and intercept of the log-log comps fit,
 *  one level per category, and the two damped priors. */
export interface FittedModel {
  version: string;
  slope: number;
  intercept: number;
  levels: Record<string, number>;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_max: number;
  maturity_days: number;
  unknown_age_days: number;
  /** Held-out validation, fitted at run time on the live-token comps. */
  validation: {
    live_n: number;
    folds: number;
    log_r2: number;
    median_abs_log_err: number;
    starter_log_r2: number;
    starter_median_abs_log_err: number;
  };
}

export const MODEL_VERSION = 'radar-2';
/** How many early rows the board carries at most, below the watchlist floor. */
export const EARLY_ROWS = 160;
/** How many live-token protocols the Live view carries, by market cap. */
export const LIVE_ROWS = 24;
/** Shrinkage strength for a category's level toward the global intercept. */
const SHRINK_K = 8;
/** The growth prior: +0.50 log points per +100% of 7-day TVL change. */
const GROWTH_WEIGHT = 0.5;
/** The age prior: at most +0.15 log points for three years of record. */
const MATURITY_MAX = 0.15;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    level: number;
    slope: number;
    growth_pct: number;
    growth_log: number;
    maturity_log: number;
    age_days: number | null;
    multiple: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  level: number;
  growth_log: number;
  maturity_log: number;
  multiple: number;
  farm_steps: string[];
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
  fitted_value_usd: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: FittedModel;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  /** Every live-token comp the model was fitted on, for the charts and the drawers. */
  liveAll: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list (the middle value, lower middle for even counts). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Ordinary least squares for y = a + b*x. */
function ols(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** The starter radar-1 value, for the validation comparison: TVL x 0.25 with its own growth and maturity terms. */
function starterValue(p: SnapshotProtocol, asOf: string): number {
  const growthPct = clamp(finite(p.change_7d, 0), -60, 120);
  const growthMult = 1 + (growthPct / 100) * 0.5;
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const maturity = 0.6 + (Math.min(Math.max(age, 0), MATURITY_DAYS) / MATURITY_DAYS) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * 0.25 * growthMult * maturity));
}

/** A fold id from a slug's hash, so the 4-fold split is the same on every run. */
function foldOf(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4;
}

/** Fit the log-log comps on a set of live-token protocols: global slope and intercept. */
function fitSlope(train: SnapshotProtocol[]): { slope: number; intercept: number } {
  const xs = train.map((p) => Math.log(p.tvl_usd));
  const ys = train.map((p) => Math.log(p.mcap_usd!));
  const { a, b } = ols(xs, ys);
  return { slope: b, intercept: a };
}

/** One category's level: the shrunk median of log(mcap) - slope*log(TVL). */
function fitLevels(train: SnapshotProtocol[], slope: number, intercept: number): Record<string, number> {
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of train) {
    const c = p.category ?? '(none)';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(p);
  }
  const levels: Record<string, number> = {};
  for (const [c, ps] of byCat.entries()) {
    const raw = median(ps.map((p) => Math.log(p.mcap_usd!) - slope * Math.log(p.tvl_usd)));
    const w = ps.length / (ps.length + SHRINK_K);
    levels[c] = w * raw + (1 - w) * intercept;
  }
  return levels;
}

/** The fitted value of one protocol under a slope, a level map and the priors. */
function fittedValue(
  p: SnapshotProtocol,
  asOf: string,
  slope: number,
  levels: Record<string, number>,
  intercept: number,
): { implied: number; growthPct: number; growthLog: number; maturityLog: number; age: number | null; level: number } {
  const level = levels[p.category ?? '(none)'] ?? intercept;
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(finite(p.change_7d, 0), -60, 120);
  const growthLog = (GROWTH_WEIGHT * growthPct) / 100;
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityLog = MATURITY_MAX * (Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS);
  const v = level + slope * Math.log(p.tvl_usd) + growthLog + maturityLog;
  return { implied: Math.max(1, Math.round(Math.exp(v))), growthPct, growthLog, maturityLog, age, level };
}

/** Fit radar-2 on the snapshot's live-token comps, with its 4-fold held-out validation. */
export function fitModel(snapshot: Snapshot): FittedModel {
  // Dead or dust tokens carry no usable market cap: log(0) is undefined and a
  // -1 market cap is a data error, so the comps use the 128 live protocols
  // with a positive recorded market cap.
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const { slope, intercept } = fitSlope(live);
  const levels = fitLevels(live, slope, intercept);

  // 4-fold held-out: the same fold split the dashboard quotes, refit per fold.
  const yTrue: number[] = [];
  const fLog: number[] = [];
  const sLog: number[] = [];
  for (let k = 0; k < 4; k++) {
    const test = live.filter((p) => foldOf(p.slug) === k);
    const train = live.filter((p) => foldOf(p.slug) !== k);
    const f = fitSlope(train);
    const lv = fitLevels(train, f.slope, f.intercept);
    for (const p of test) {
      yTrue.push(Math.log(p.mcap_usd!));
      fLog.push(Math.log(fittedValue(p, snapshot.as_of, f.slope, lv, f.intercept).implied));
      sLog.push(Math.log(starterValue(p, snapshot.as_of)));
    }
  }
  const logR2 = (pred: number[]): number => {
    const m = yTrue.reduce((s, v) => s + v, 0) / yTrue.length;
    let ss = 0;
    let st = 0;
    for (let i = 0; i < yTrue.length; i++) {
      ss += (yTrue[i]! - pred[i]!) ** 2;
      st += (yTrue[i]! - m) ** 2;
    }
    return 1 - ss / st;
  };
  const medAbs = (pred: number[]): number => median(yTrue.map((v, i) => Math.abs(v - pred[i]!)));
  return {
    version: MODEL_VERSION,
    slope,
    intercept,
    levels,
    growth_weight: GROWTH_WEIGHT,
    growth_floor: -60,
    growth_cap: 120,
    maturity_max: MATURITY_MAX,
    maturity_days: MATURITY_DAYS,
    unknown_age_days: UNKNOWN_AGE_DAYS,
    validation: {
      live_n: live.length,
      folds: 4,
      log_r2: logR2(fLog),
      median_abs_log_err: medAbs(fLog),
      starter_log_r2: logR2(sLog),
      starter_median_abs_log_err: medAbs(sLog),
    },
  };
}

/** The three multipliers and the implied value one protocol gets under the fitted model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  model: FittedModel,
): { implied: number; growthPct: number; growthLog: number; maturityLog: number; age: number | null; level: number } {
  return fittedValue(p, asOf, model.slope, model.levels, model.intercept);
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's exclusion rule: a wrapped, staked or bridged product of a
 *  token that already trades is not a launch that does not exist yet. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol is one the board may rank: pre-token and not a product of a token that trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: rankable pre-token protocols the watchlist does not
  // name, by fitted value, capped. The watchlist is a floor on size, never
  // on subject: a protocol above the floor the list leaves out (its parent
  // rule is not one of the snapshot's ten fields) is as much a subject as
  // one below it. Never a replacement for a watchlist row.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, model).implied }))
    .sort((a, b) => b.v - a.v || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const e of early) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => {
    const m = impliedValue(p, snapshot.as_of, model);
    return { p, ...m };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      level: s.level,
      slope: model.slope,
      growth_pct: s.growthPct,
      growth_log: s.growthLog,
      maturity_log: s.maturityLog,
      age_days: s.age,
      multiple: s.implied / s.p.tvl_usd,
    },
    farm_steps: farmSteps(s.p, s.age, s.implied, s.p.tvl_usd > 0 ? s.implied / s.p.tvl_usd : 0, s.level, model).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Gas for one transaction on a chain: mainnet costs, cheap chains cost little. */
function gasFor(chain: string): { tx: number; week: number } {
  if (chain === 'Ethereum') return { tx: 12, week: 8 };
  const cheap = new Set([
    'Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'Binance', 'Avalanche',
    'Linea', 'Blast', 'Scroll', 'Mantle', 'Sonic', 'Berachain', 'Mode', 'zkSync Era',
    'Hyperliquid L1', 'Unichain', 'World Chain', 'Katana', 'Monad', 'Hemi', 'TAC', 'Arc', 'Flare',
  ]);
  if (cheap.has(chain)) return { tx: 1, week: 1 };
  return { tx: 3, week: 2 };
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') && !c.includes('aggregator')) return `Deposit $${capital} into ${name}'s main yield position on ${chain} and keep it open.`;
  if (c.includes('yield aggregator') || c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${name}'s basis position on ${chain} and keep it open.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('launchpad')) return `Deposit $${capital} into ${name}'s launch pool on ${chain} and keep the position open.`;
  if (c.includes('locker')) return `Lock $${capital} of tokens in ${name} on ${chain} and keep the lock receipt.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index on ${chain} and hold it.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name}'s private pool on ${chain} and keep the receipt.`;
  if (c.includes('farm')) return `Deposit $${capital} into ${name}'s farm on ${chain} and keep the position open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's weekly qualifying action. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Borrow a small amount against the supply, then repay it the same week.';
  if (c.includes('dex') || c.includes('leveraged farm')) return 'Swap a small amount through the main pool and add a little liquidity.';
  if (c.includes('yield aggregator') || c.includes('curator') || c.includes('allocator')) return 'Check the vault allocation report and add a small top-up when the curator moves funds.';
  if (c.includes('yield')) return 'Claim or compound the yield once, and check the position is still earning.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return 'Open and close one small hedge so the account shows live trading.';
  if (c.includes('prediction')) return 'Place one small market position and settle or close it before the week ends.';
  if (c.includes('rwa')) return 'Check the yield accrual on the position and claim or compound it.';
  if (c.includes('basis')) return 'Check the basis position and roll it once if the funding flipped.';
  if (c.includes('stable')) return 'Mint or redeem a small amount of the stable asset to keep the account active.';
  if (c.includes('bridge')) return 'Bridge a small amount and use it in the destination app once.';
  if (c.includes('staking') || c.includes('restak')) return 'Check the staking rewards and restake or claim a small amount.';
  if (c.includes('insurance')) return 'Check the cover is live and renew or top it up when it nears expiry.';
  if (c.includes('launchpad')) return 'Check for a new launch pool and join one with a small amount.';
  if (c.includes('index')) return 'Rebalance the index holding once and check its composition.';
  if (c.includes('payment')) return 'Route one real payment through the protocol and keep the receipt.';
  if (c.includes('privacy')) return 'Make one private deposit and withdraw a small amount to a fresh address.';
  if (c.includes('farm')) return 'Harvest the farm rewards once and compound a small amount back in.';
  if (c.includes('locker')) return 'Check the lock schedule and extend one lock by a week.';
  return 'Make one qualifying action, such as a deposit, a borrow, a swap or a vote.';
}

/** The verdict band for an implied value. */
function bandFor(implied: number): string {
  if (implied >= 75_000_000) return 'top target';
  if (implied >= 35_000_000) return 'strong target';
  if (implied >= 15_000_000) return 'worth farming';
  return 'small but early';
}

/** Format a dollar amount for a farm step: $119M, $44.4M, $2.8M. */
function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time,
 * derived from the protocol's own record (category, chains, TVL, age) and the
 * model's own numbers, never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, multiple: number, level: number, model: FittedModel): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const fittedAt100 = Math.exp(level) * Math.pow(100_000_000, model.slope - 1);
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: `under $${gas.tx} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas.tx} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p),
      cost: `about $${gas.week} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: `Verdict: ${bandFor(implied)} — ${fmtMoney(implied)} implied on ${fmtMoney(p.tvl_usd)} TVL (${multiple.toFixed(3)}x TVL; ${(p.category ?? 'uncategorised')} comps fit ${fittedAt100.toFixed(3)}x at $100M TVL). Farm with $${capital} and a ${hold}-day hold.`,
      cost: `$${capital} of capital at risk`,
      time: `${hold} days minimum`,
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot, model: FittedModel, limit: number = LIVE_ROWS): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd! / p.tvl_usd,
      fitted_value_usd: impliedValue(p, snapshot.as_of, model).implied,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    level: row.model.level,
    growth_log: row.model.growth_log,
    maturity_log: row.model.maturity_log,
    multiple: row.model.multiple,
    farm_steps: row.farm_steps,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: FittedModel): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot, model);
  const liveAll = liveRows(snapshot, model, Number.MAX_SAFE_INTEGER);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, new Set(snapshot.watchlist))),
    live,
    liveAll,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
