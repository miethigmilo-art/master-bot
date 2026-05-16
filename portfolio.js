/**
 * portfolio.js — HELIX Phase 6: Portfolio-Level Risk Management
 *
 * Tracks and enforces risk limits across ALL strategies simultaneously.
 * Unlike per-strategy checks (maxDrawdown, tagsStopPct), this operates
 * on the AGGREGATE portfolio view.
 *
 * Checks:
 *   1. Total open positions cap (PORTFOLIO_MAX_OPEN)
 *   2. Max concurrent positions per instrument (PORTFOLIO_MAX_PER_EPIC)
 *   3. Portfolio daily loss cap (PORTFOLIO_DAILY_LOSS_PCT)
 *   4. Total capital at risk (PORTFOLIO_MAX_RISK_PCT — sum of all SL distances)
 *
 * Usage in server.js:
 *   const portfolioRisk = require('./portfolio');
 *   // On startup:
 *   portfolioRisk.reset();
 *   // Before placing order:
 *   const check = portfolioRisk.checkGate({ epic, name, equity, riskCapital, totalEquity });
 *   if (!check.approved) return res.json({ status: 'uebersprungen', grund: check.reason });
 *   // After order placed:
 *   portfolioRisk.registerTrade({ epic, name, riskCapital });
 *   // After trade closed:
 *   portfolioRisk.closeTrade({ epic, name, pnl });
 */

'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  MAX_OPEN:          parseInt(process.env.PORTFOLIO_MAX_OPEN       || '6',    10),
  MAX_PER_EPIC:      parseInt(process.env.PORTFOLIO_MAX_PER_EPIC   || '3',    10),
  DAILY_LOSS_PCT:    parseFloat(process.env.PORTFOLIO_DAILY_LOSS_PCT || '5.0'),
  MAX_RISK_PCT:      parseFloat(process.env.PORTFOLIO_MAX_RISK_PCT   || '8.0'),
};

// ── State ────────────────────────────────────────────────────────────────────
// openTrades: { [tradeKey: `${name}:${epic}`]: { epic, name, riskCapital, ts } }
let openTrades   = {};
let dailyPnl     = 0;
let dailyReset   = startOfDay();

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function checkDailyReset() {
  if (Date.now() > dailyReset + 86_400_000) {
    dailyPnl   = 0;
    dailyReset = startOfDay();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function reset() {
  openTrades = {};
  dailyPnl   = 0;
  dailyReset = startOfDay();
}

/**
 * checkGate(opts)
 *
 * opts:
 *   epic         string  — instrument
 *   name         string  — strategy name
 *   totalEquity  number  — sum of all strategy equities
 *   riskCapital  number  — the capital being risked on this trade (in account currency)
 *
 * Returns { approved: boolean, reason: string, metrics: object }
 */
function checkGate(opts) {
  checkDailyReset();
  const { epic, name, totalEquity, riskCapital } = opts;

  const openList   = Object.values(openTrades);
  const totalOpen  = openList.length;
  const epicOpen   = openList.filter(t => t.epic === epic).length;
  const totalAtRisk = openList.reduce((s, t) => s + (t.riskCapital || 0), 0);
  const totalRiskPct = totalEquity > 0 ? (totalAtRisk / totalEquity) * 100 : 0;
  const dailyLossPct = totalEquity > 0 ? (dailyPnl / totalEquity) * 100 : 0;

  const metrics = { totalOpen, epicOpen, totalAtRisk, totalRiskPct, dailyPnl, dailyLossPct };

  // Check 1: Max open positions
  if (totalOpen >= CFG.MAX_OPEN) {
    return { approved: false, reason: `Portfolio: Max. offene Positionen erreicht (${totalOpen}/${CFG.MAX_OPEN})`, metrics };
  }

  // Check 2: Max per epic
  if (epicOpen >= CFG.MAX_PER_EPIC) {
    return { approved: false, reason: `Portfolio: Max. Positionen für ${epic} erreicht (${epicOpen}/${CFG.MAX_PER_EPIC})`, metrics };
  }

  // Check 3: Daily portfolio loss cap
  if (dailyPnl < 0 && Math.abs(dailyLossPct) >= CFG.DAILY_LOSS_PCT) {
    return { approved: false, reason: `Portfolio: Tagesverlust ${dailyLossPct.toFixed(1)}% ≥ Limit ${CFG.DAILY_LOSS_PCT}%`, metrics };
  }

  // Check 4: Total capital at risk
  const projectedRiskPct = totalEquity > 0 ? ((totalAtRisk + (riskCapital || 0)) / totalEquity) * 100 : 0;
  if (projectedRiskPct >= CFG.MAX_RISK_PCT) {
    return { approved: false, reason: `Portfolio: Risiko-Cap erreicht (${projectedRiskPct.toFixed(1)}% ≥ ${CFG.MAX_RISK_PCT}%)`, metrics };
  }

  return { approved: true, reason: 'OK', metrics };
}

/**
 * registerTrade(opts)
 * Call after a trade is successfully placed.
 */
function registerTrade(opts) {
  const key = `${opts.name}:${opts.epic}`;
  openTrades[key] = { epic: opts.epic, name: opts.name, riskCapital: opts.riskCapital || 0, ts: Date.now() };
}

/**
 * closeTrade(opts)
 * Call when a trade closes (from PnL webhook).
 * opts.pnl: realized P&L in account currency
 */
function closeTrade(opts) {
  const key = `${opts.name}:${opts.epic || ''}`;
  // Try exact key first, then scan for strategy name
  if (openTrades[key]) {
    delete openTrades[key];
  } else {
    const found = Object.keys(openTrades).find(k => k.startsWith(opts.name + ':'));
    if (found) delete openTrades[found];
  }
  if (opts.pnl != null) {
    checkDailyReset();
    dailyPnl += opts.pnl;
  }
}

/**
 * snapshot()
 * Returns full current portfolio risk state for dashboard.
 */
function snapshot() {
  checkDailyReset();
  const openList     = Object.values(openTrades);
  const totalAtRisk  = openList.reduce((s, t) => s + (t.riskCapital || 0), 0);

  // Group by epic
  const byEpic = {};
  for (const t of openList) {
    if (!byEpic[t.epic]) byEpic[t.epic] = [];
    byEpic[t.epic].push(t.name);
  }

  return {
    config:        CFG,
    openTrades:    openList,
    byEpic,
    totalOpen:     openList.length,
    totalAtRisk,
    dailyPnl,
    ts:            new Date().toISOString(),
  };
}

module.exports = { checkGate, registerTrade, closeTrade, snapshot, reset, CFG };
