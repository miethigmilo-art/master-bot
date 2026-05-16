/**
 * sizing.js — HELIX Phase 4: Adaptive Position Sizing
 *
 * Enhances the existing ML × Market × Score × Agents sizing chain with:
 *   1. Kelly Criterion  — statistically optimal fraction based on win-rate + avg R
 *   2. Volatility Adjust — normalise size so each trade risks the same % of price
 *   3. Portfolio Heat    — reduce size when total open risk is high
 *   4. Drawdown Brake    — scale down aggressively near max-drawdown limit
 *
 * All factors are capped and composable.
 * The final factor multiplies the base riskCapital in handleWebhook.
 *
 * Usage:
 *   const { adaptiveSizingFactor, kellyFraction } = require('./sizing');
 *   const kf = kellyFraction(trades);
 *   const af = adaptiveSizingFactor({ trades, equity, maxDrawdownPct, startEquity, atrPct, openRiskPct });
 *   // af ∈ [0.1, 2.0]
 */

'use strict';

// ── Kelly Criterion ─────────────────────────────────────────────────────────

/**
 * kellyFraction(trades, opts)
 *
 * trades: [{ pnl: number }]  (only closed trades with P&L)
 * opts.fractionOf: apply fractional Kelly (default 0.25 = quarter-Kelly)
 * opts.minTrades:  minimum trades before Kelly is used (default 20)
 *
 * Returns a multiplier ∈ [0.5, 2.0]
 *   < 1.0 → reduce size (Kelly says unfavourable edge)
 *   = 1.0 → neutral (not enough data or breakeven)
 *   > 1.0 → increase size (Kelly says positive edge)
 */
function kellyFraction(trades, opts) {
  opts = opts || {};
  const fractionOf  = opts.fractionOf || 0.25;  // quarter-Kelly (conservative)
  const minTrades   = opts.minTrades  || 20;

  const closed = (trades || []).filter(t => t.pnl != null && t.pnl !== 0);
  if (closed.length < minTrades) return 1.0;  // not enough data

  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  if (!wins.length || !losses.length) return 1.0;

  const winRate  = wins.length / closed.length;
  const avgWin   = wins.reduce((s, t) => s + t.pnl, 0)   / wins.length;
  const avgLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);

  if (avgLoss === 0) return 1.0;

  const b = avgWin / avgLoss;     // avg win/avg loss ratio
  const p = winRate;
  const q = 1 - p;

  // Kelly formula: f* = (b*p - q) / b
  const kelly = (b * p - q) / b;

  if (kelly <= 0) return 0.5;    // negative edge → minimum

  // Fractional Kelly → map to multiplier range [0.5, 2.0]
  const fractional = kelly * fractionOf;
  // Baseline: kelly = 0.04 (typical for reasonable edge) → 0.01 quarter → map to 1.0
  // Scale relative to a typical "neutral" kelly of 0.04
  const NEUTRAL_KELLY = 0.04;
  const raw = fractional / (NEUTRAL_KELLY * fractionOf);  // 1.0 at neutral
  return parseFloat(Math.min(2.0, Math.max(0.5, raw)).toFixed(3));
}

// ── Volatility Adjust ───────────────────────────────────────────────────────

/**
 * volatilityFactor(atrPct, targetAtrPct)
 *
 * atrPct:      current ATR as % of price
 * targetAtrPct: the "normal" ATR% we calibrate against (default 0.3%)
 *
 * Returns a factor ∈ [0.5, 1.5]
 *   High volatility → smaller factor (risk stays constant in $ terms)
 *   Low volatility  → larger factor (more room to trade)
 */
function volatilityFactor(atrPct, targetAtrPct) {
  targetAtrPct = targetAtrPct || 0.3;
  if (!atrPct || atrPct <= 0) return 1.0;
  const raw = targetAtrPct / atrPct;
  return parseFloat(Math.min(1.5, Math.max(0.5, raw)).toFixed(3));
}

// ── Portfolio Heat ──────────────────────────────────────────────────────────

/**
 * portfolioHeatFactor(openRiskPct, maxHeatPct)
 *
 * openRiskPct: total risk currently open as % of total portfolio equity
 * maxHeatPct:  cap before we fully stop sizing up (default 5%)
 *
 * Returns a factor ∈ [0.0, 1.0]
 *   0 open risk → 1.0
 *   At maxHeat  → 0.0
 */
function portfolioHeatFactor(openRiskPct, maxHeatPct) {
  maxHeatPct = maxHeatPct || 5.0;
  if (!openRiskPct || openRiskPct <= 0) return 1.0;
  const raw = 1.0 - (openRiskPct / maxHeatPct);
  return parseFloat(Math.min(1.0, Math.max(0.0, raw)).toFixed(3));
}

// ── Drawdown Brake ──────────────────────────────────────────────────────────

/**
 * drawdownBrakeFactor(drawdownPct, maxDrawdownPct)
 *
 * drawdownPct:    current drawdown from peak (%)
 * maxDrawdownPct: the hard stop level (from settings)
 *
 * Returns a factor ∈ [0.1, 1.0]
 *   0% drawdown → 1.0
 *   50% of max  → 0.7 (start braking)
 *   75% of max  → 0.4
 *   90% of max  → 0.15
 */
function drawdownBrakeFactor(drawdownPct, maxDrawdownPct) {
  if (!drawdownPct || drawdownPct <= 0) return 1.0;
  if (!maxDrawdownPct || maxDrawdownPct <= 0) return 1.0;

  const ratio = drawdownPct / maxDrawdownPct;  // 0.0 → 1.0
  if (ratio < 0.5)  return 1.0;
  if (ratio < 0.75) return 1.0 - (ratio - 0.5) * 1.2;  // linear brake
  if (ratio < 0.9)  return 0.7 - (ratio - 0.75) * 1.667;
  return 0.1;
}

// ── Composite Sizing Factor ─────────────────────────────────────────────────

/**
 * adaptiveSizingFactor(opts)
 *
 * opts:
 *   trades          [{ pnl }]   — trade history for Kelly
 *   equity          number      — current account equity
 *   startEquity     number      — initial equity (for drawdown calc)
 *   maxDrawdownPct  number      — hard stop % (from settings)
 *   atrPct          number      — ATR as % of price (optional)
 *   openRiskPct     number      — portfolio open risk % (optional)
 *   kellyOpts       object      — passed to kellyFraction()
 *
 * Returns:
 * {
 *   factor:      number  — final composite multiplier ∈ [0.1, 2.0]
 *   components:  { kelly, volatility, heat, brake }
 *   breakdown:   string — human-readable log line
 * }
 */
function adaptiveSizingFactor(opts) {
  opts = opts || {};

  const kelly  = kellyFraction(opts.trades, opts.kellyOpts);
  const vol    = volatilityFactor(opts.atrPct);
  const heat   = portfolioHeatFactor(opts.openRiskPct);

  const drawdownPct = opts.startEquity > 0
    ? ((opts.startEquity - (opts.equity || opts.startEquity)) / opts.startEquity) * 100
    : 0;
  const brake = drawdownBrakeFactor(drawdownPct, opts.maxDrawdownPct);

  // Compose — brake always applies (safety), others are enhancement/reduction
  const raw    = kelly * vol * heat * brake;
  const factor = parseFloat(Math.min(2.0, Math.max(0.1, raw)).toFixed(3));

  const breakdown = `Kelly=${kelly}× Vol=${vol}× Heat=${heat}× Brake=${brake}× → ${factor}×`;

  return { factor, components: { kelly, volatility: vol, heat, brake }, breakdown };
}

module.exports = { adaptiveSizingFactor, kellyFraction, volatilityFactor, portfolioHeatFactor, drawdownBrakeFactor };
