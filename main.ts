// Tidepool — a patient dip-buying bot for the btc-race-24h-20261118-1444 race.
//
// The idea: over a day, Bitcoin mostly washes back and forth inside a wide
// band, with one or two real swings. Tidepool sits out the chop and buys
// exactly one swing at a time: only when the close has sunk into the
// bottom fifth of its 10-hour range AND has bounced a little off the
// recent low — so it buys a turn, not a falling knife. It sells once the
// close is back within 2% of the range top — close enough to the top to
// bank the swing, with the 1.2% trailing stop as the backstop if the price
// turns first — or when it slips 1.2% below the best close seen since
// entry. One position at a time, full size, a handful of trades a day at most.
//
// Everything here is deterministic: the only inputs are the closes the
// harness sends, in order. No clock, no network, no randomness, no files.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuning: one flat region of the parameter space, not a sharp peak ---
const LOOKBACK_BARS = 600; // 10 hours of 1-minute closes
const BUY_BAND = 0.22; // buy only in the bottom 22% of the rolling range
const SELL_BAND = 0.02; // sell once back within 2% of the range top
const MIN_RANGE = 0.004; // range must span at least 0.4% to be worth trading
const BOUNCE_WINDOW = 20; // bounce measured against this many recent bars
const BOUNCE_FRACTION = 0.003; // close must sit 0.3% above the recent low
const TRAIL_FRACTION = 0.012; // 1.2% trailing stop below the peak close
const MAX_SLIPPAGE_BPS = 100; // guard against a gap between close and fill
const MIN_HISTORY = 30; // bars of history before any decision

// Closes in USDC, oldest first. The harness sends one bar per batch.
const closes: number[] = [];
// Best close seen since the current position opened; null while flat.
let peakSinceEntry: number | null = null;
// Price scale of the symbol, read from hello (5 for CBBTC: $65,074.47643).
let priceScale = 5;

function rollingRange(): { low: number; high: number } | null {
  if (closes.length < MIN_HISTORY) return null;
  const window = closes.slice(-LOOKBACK_BARS);
  let low = Infinity;
  let high = -Infinity;
  for (const c of window) {
    if (c < low) low = c;
    if (c > high) high = c;
  }
  return { low, high };
}

function recentLow(): number {
  const window = closes.slice(-BOUNCE_WINDOW);
  let low = Infinity;
  for (const c of window) if (c < low) low = c;
  return low;
}

await runBars({
  onHello(state: BarsState): void {
    const symbol = state.symbols.get(SYMBOL);
    if (symbol !== undefined) priceScale = symbol.price_scale;
  },

  onBatch(state: BarsState, _batch: Batch) {
    // Warm-up batches are for building history only; trading is closed.
    if (state.warmingUp) return [];
    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    const close = Number(closeRaw) / 10 ** priceScale;
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;

    if (qty === 0n) {
      peakSinceEntry = null;
      const range = rollingRange();
      if (range === null) return [];
      const span = range.high - range.low;
      if (span / range.low < MIN_RANGE) return [];
      // Sunk into the bottom of the range...
      if (close > range.low + BUY_BAND * span) return [];
      // ...and turning back up off the recent low.
      if (close < recentLow() * (1 + BOUNCE_FRACTION)) return [];
      const spend = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
      if (spend <= 0n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Long: ride it while it climbs, exit into strength or on the trail.
    if (peakSinceEntry === null || close > peakSinceEntry) peakSinceEntry = close;
    const range = rollingRange();
    if (range === null) return [];
    const span = range.high - range.low;
    const atTop = close >= range.high - SELL_BAND * span;
    const stoppedOut = peakSinceEntry !== null && close <= peakSinceEntry * (1 - TRAIL_FRACTION);
    if (!atTop && !stoppedOut) return [];
    return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
