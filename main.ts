// btc-cent-forecast-01 entry (Node 22, standard library only): a short-horizon
// Bitcoin forecaster. It reads one case at a time — BTC's 1-minute closes for the
// 72 hours up to a checkpoint — and writes ONE guess: the close 240 minutes after
// the checkpoint, scored on mean absolute error in cents, so the guess must be an
// honest conditional median, never a shaded-up or shaded-down bet.
//
// Model: damped short-term trend (see README.md for the calibration).
//   1. Fit an OLS line to the log prices of the last 60 minutes.
//   2. Extrapolate its slope over the 240-minute horizon, shrunk by 0.20 —
//      Bitcoin's 4-hour drift is mostly noise, so only a fifth of the fitted
//      trend is carried forward.
//   3. Cap the forecast's log-move from the checkpoint close at +/-0.008
//      (0.8%): a trend fit on one hour can spike, and the cap bounds the damage
//      when the market turns instead of continuing.
//   4. Anchor on the checkpoint's own close (the last price), kept on the price
//      grid's 5 decimals and inside the scorer's (0, 10,000,000) bounds.
//
// The program is fully deterministic: no clock, no randomness, no network, no
// data beyond the case file it is given. Two runs on the same case write the
// same bytes.
//
// I/O contract (same as the kit's starter): read every <id>.in in the input
// directory (MAKEFUN_INPUT_DIR, else /input), write <id>.out to the output
// directory (MAKEFUN_OUTPUT_DIR, else /output) as
// {"forecasts":[{"case":"<id>","price":<number>}]}, exactly one row per case.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The smallest positive price on the grid: one unit of its 5 decimals. */
const MIN_PRICE = 0.00001;
/** The largest grid price below the scorer's exclusive 10,000,000-dollar cap. */
const MAX_PRICE = 9_999_999.99999;

/** Minutes of log prices the trend line is fitted on. */
const TREND_WINDOW_MIN = 60;
/** Forecast horizon in minutes (fixed by the competition). */
const HORIZON_MIN = 240;
/** Shrinkage applied to the extrapolated drift: only this share of the fitted
 *  60-minute trend is carried 240 minutes forward. */
const SHRINK = 0.2;
/** Cap on |log(forecast / checkpoint close)|: the forecast never moves more
 *  than 0.8% away from the checkpoint close. */
const MAX_LOG_MOVE = 0.008;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  markets: CaseMarket[];
}

/** x kept on the grid's 5 decimals and inside the scorer's (0, 10,000,000). */
const price5 = (x: number): number => Math.round(Math.min(MAX_PRICE, Math.max(MIN_PRICE, x)) * 1e5) / 1e5;

/**
 * OLS slope of log-prices over their last `n` points, per minute.
 * x is 0..n-1, y the log prices; returns 0 when the fit is degenerate.
 */
function olsSlope(logPrices: number[], n: number): number {
  const m = Math.min(n, logPrices.length);
  const ys = logPrices.slice(logPrices.length - m);
  const xMean = (m - 1) / 2;
  let yMean = 0;
  for (const y of ys) yMean += y;
  yMean /= m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    const dx = i - xMean;
    num += dx * (ys[i] as number - yMean);
    den += dx * dx;
  }
  if (den === 0) return 0;
  const slope = num / den;
  return Number.isFinite(slope) ? slope : 0;
}

/** The forecast for one market: checkpoint close moved by the damped trend. */
function forecast(m: CaseMarket): number {
  if (!Array.isArray(m.prices) || m.prices.length < 2) {
    throw new Error(`market ${m.id} has fewer than 2 prices`);
  }
  const last = m.prices[m.prices.length - 1] as number;
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) {
    throw new Error(`market ${m.id}'s last price is not a finite positive number`);
  }
  // Only the window the trend is fitted on needs logs; the rest of the case
  // is never read, so a longer case costs nothing extra.
  const windowStart = Math.max(0, m.prices.length - TREND_WINDOW_MIN);
  const logPrices: number[] = [];
  for (let i = windowStart; i < m.prices.length; i++) {
    const p = m.prices[i] as number;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
      throw new Error(`market ${m.id} holds a non-finite or non-positive price`);
    }
    logPrices.push(Math.log(p));
  }
  const slope = olsSlope(logPrices, TREND_WINDOW_MIN);
  let move = slope * HORIZON_MIN * SHRINK;
  if (!Number.isFinite(move)) move = 0;
  move = Math.min(MAX_LOG_MOVE, Math.max(-MAX_LOG_MOVE, move));
  return price5(last * Math.exp(move));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!Array.isArray(c.markets) || c.markets.length !== 1) throw new Error(`${file} does not hold exactly one market`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts: [{ case: id, price: forecast(c.markets[0] as CaseMarket) }] })}\n`);
}
