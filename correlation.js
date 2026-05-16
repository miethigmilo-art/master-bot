/**
 * correlation.js — HELIX Phase 5: Multi-Strategie-Korrelations-Filter
 *
 * Prevents over-concentration across correlated instruments and strategies.
 *
 * Two checks:
 *   1. Instrument Concentration  — max N strategies can be long/short the same epic
 *   2. Correlation Matrix Filter — if too much correlated exposure open, block/reduce
 *
 * Exported:
 *   correlationFilter(opts)   → { approved: bool, reason: string, sizingFactor: number }
 *   trackPosition(epic, side, name, open) — update open-position registry
 *   getExposure()             — current exposure snapshot
 */

'use strict';

// ── Static Correlation Matrix ───────────────────────────────────────────────
// Correlation coefficient ∈ [-1, 1]
// 1.0  = perfectly correlated (GOLD & XAUUSD are the same)
// 0.0  = uncorrelated
// -1.0 = perfectly inversely correlated
//
// Only upper triangle needed; lookup is symmetric.
const CORRELATION_MATRIX = {
  'GOLD':   { 'GOLD':1.0, 'XAUUSD':1.0, 'SILVER':0.82, 'PLATINUM':0.70, 'US500':-0.25, 'NAS100':-0.20, 'OIL_CRUDE':0.35, 'EURUSD':0.40, 'GBPUSD':0.38, 'USDJPY':-0.45 },
  'XAUUSD': { 'GOLD':1.0, 'XAUUSD':1.0, 'SILVER':0.82, 'PLATINUM':0.70, 'US500':-0.25, 'NAS100':-0.20, 'OIL_CRUDE':0.35, 'EURUSD':0.40, 'GBPUSD':0.38, 'USDJPY':-0.45 },
  'SILVER': { 'GOLD':0.82, 'XAUUSD':0.82, 'SILVER':1.0, 'PLATINUM':0.78, 'US500':-0.15, 'EURUSD':0.30 },
  'US500':  { 'US500':1.0, 'NAS100':0.92, 'DOW30':0.95, 'GOLD':-0.25, 'OIL_CRUDE':0.30, 'EURUSD':-0.20 },
  'NAS100': { 'NAS100':1.0, 'US500':0.92, 'DOW30':0.88, 'GOLD':-0.20 },
  'DOW30':  { 'DOW30':1.0, 'US500':0.95, 'NAS100':0.88 },
  'EURUSD': { 'EURUSD':1.0, 'GBPUSD':0.80, 'AUDUSD':0.65, 'NZDUSD':0.60, 'USDJPY':-0.70, 'USDCHF':-0.85 },
  'GBPUSD': { 'GBPUSD':1.0, 'EURUSD':0.80, 'AUDUSD':0.55, 'USDJPY':-0.60, 'USDCHF':-0.70 },
  'USDJPY': { 'USDJPY':1.0, 'USDCHF':0.65, 'EURUSD':-0.70, 'GOLD':-0.45 },
  'OIL_CRUDE': { 'OIL_CRUDE':1.0, 'OIL_BRENT':0.97, 'US500':0.30, 'GOLD':0.35 },
  'OIL_BRENT': { 'OIL_BRENT':1.0, 'OIL_CRUDE':0.97, 'US500':0.28 },
};

function getCorrelation(epicA, epicB) {
  if (epicA === epicB) return 1.0;
  const row = CORRELATION_MATRIX[epicA];
  if (row && row[epicB] != null) return row[epicB];
  const rowB = CORRELATION_MATRIX[epicB];
  if (rowB && rowB[epicA] != null) return rowB[epicA];
  return 0.0;  // unknown → treat as uncorrelated
}

// ── Open Position Registry ──────────────────────────────────────────────────
// Tracks which strategies currently have open positions, and in which direction.
// { [epic]: { [strategyName]: 'BUY'|'SELL' } }
const openPositions = {};

/**
 * trackPosition(epic, side, strategyName, isOpen)
 *
 * Call with isOpen=true when an order is placed, isOpen=false when it closes.
 */
function trackPosition(epic, side, strategyName, isOpen) {
  if (!epic || !strategyName) return;
  if (!openPositions[epic]) openPositions[epic] = {};
  if (isOpen) {
    openPositions[epic][strategyName] = side;
  } else {
    delete openPositions[epic][strategyName];
    if (Object.keys(openPositions[epic]).length === 0) delete openPositions[epic];
  }
}

/**
 * getExposure()
 * Returns a snapshot of all open positions by instrument.
 */
function getExposure() {
  const snapshot = {};
  for (const [epic, strategies] of Object.entries(openPositions)) {
    const buys  = Object.values(strategies).filter(s => s === 'BUY').length;
    const sells = Object.values(strategies).filter(s => s === 'SELL').length;
    snapshot[epic] = { strategies: { ...strategies }, buys, sells, total: buys + sells };
  }
  return snapshot;
}

// ── Config ──────────────────────────────────────────────────────────────────
const CORRELATION_CFG = {
  // Max strategies in same direction on same instrument
  MAX_SAME_INSTRUMENT: parseInt(process.env.CORR_MAX_SAME_INSTRUMENT || '3', 10),
  // Correlation threshold above which two instruments are considered related
  CORRELATION_THRESHOLD: parseFloat(process.env.CORR_THRESHOLD || '0.6'),
  // Max correlated-weighted positions before new trade is sized down
  MAX_CORR_EXPOSURE: parseFloat(process.env.CORR_MAX_EXPOSURE || '4.0'),
};

// ── Main Filter ─────────────────────────────────────────────────────────────

/**
 * correlationFilter(opts)
 *
 * opts:
 *   epic          string  — instrument to trade
 *   side          string  — 'BUY' | 'SELL'
 *   strategyName  string  — current strategy
 *
 * Returns:
 * {
 *   approved:    boolean
 *   reason:      string
 *   sizingFactor: number  ∈ [0.0, 1.0]  (1.0 = no change)
 *   exposure:    object   — snapshot of related positions
 * }
 */
function correlationFilter(opts) {
  const { epic, side, strategyName } = opts;

  // ── Check 1: Same instrument concentration ──
  const sameInstrument = openPositions[epic] || {};
  const sameSide = Object.entries(sameInstrument)
    .filter(([name, s]) => s === side && name !== strategyName);

  if (sameSide.length >= CORRELATION_CFG.MAX_SAME_INSTRUMENT) {
    return {
      approved:     false,
      reason:       `Zu viele ${side}-Positionen auf ${epic} (${sameSide.length}/${CORRELATION_CFG.MAX_SAME_INSTRUMENT})`,
      sizingFactor: 0.0,
      exposure:     getExposure(),
    };
  }

  // ── Check 2: Correlated exposure ──
  // Sum correlation-weighted open positions in same direction
  let corrExposure = 0;
  for (const [openEpic, strategies] of Object.entries(openPositions)) {
    const corr = Math.abs(getCorrelation(epic, openEpic));
    if (corr < CORRELATION_CFG.CORRELATION_THRESHOLD) continue;

    for (const [stratName, stratSide] of Object.entries(strategies)) {
      if (stratName === strategyName) continue;
      // Determine effective direction (inversely correlated instruments flip the sign)
      const rawCorr = getCorrelation(epic, openEpic);
      const effectiveSide = rawCorr < 0 ? (stratSide === 'BUY' ? 'SELL' : 'BUY') : stratSide;
      if (effectiveSide === side) corrExposure += corr;
    }
  }

  if (corrExposure >= CORRELATION_CFG.MAX_CORR_EXPOSURE) {
    return {
      approved:     false,
      reason:       `Korrelierte Exposition zu hoch: ${corrExposure.toFixed(1)} ≥ ${CORRELATION_CFG.MAX_CORR_EXPOSURE}`,
      sizingFactor: 0.0,
      exposure:     getExposure(),
    };
  }

  // Size reduction proportional to correlated exposure
  let sizingFactor = 1.0;
  if (corrExposure > 0) {
    // Linear reduction: at 50% of max → 0.75×, at 75% → 0.5×
    const heatRatio = corrExposure / CORRELATION_CFG.MAX_CORR_EXPOSURE;
    sizingFactor = parseFloat(Math.max(0.25, 1.0 - heatRatio * 0.6).toFixed(3));
  }

  return {
    approved:     true,
    reason:       corrExposure > 0 ? `Korr. Exposition: ${corrExposure.toFixed(1)} → Sizing ${sizingFactor}×` : 'OK',
    sizingFactor,
    exposure:     getExposure(),
  };
}

module.exports = {
  correlationFilter,
  trackPosition,
  getExposure,
  getCorrelation,
  CORRELATION_CFG,
};
