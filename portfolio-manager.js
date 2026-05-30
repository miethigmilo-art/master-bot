'use strict';
/**
 * portfolio-manager.js — HELIX Virtual Portfolio Manager
 *
 * Manages multiple strategy sub-portfolios within a SINGLE broker account.
 *
 * Core idea:
 *   - Broker holds one account (e.g. $100,000 IBKR account)
 *   - HELIX splits that capital internally into virtual strategy allocations
 *   - Each strategy can only trade within its allocated capital slice
 *   - Risk, drawdown, and exposure are enforced per-strategy BEFORE orders hit the broker
 *
 * "Intelligence suggests. Risk decides. Execution obeys."
 *
 * Usage:
 *   const pm = new PortfolioManager();
 *   pm.setTotalCapital(100000);
 *   pm.setAllocation('momentum_v3', { allocPct: 20, maxDrawdownPct: 8, maxExposurePct: 40 });
 *
 *   const check = pm.checkRisk('momentum_v3', orderSizeUSD);
 *   if (!check.approved) return res.json({ blocked: true, reason: check.reason });
 *
 *   pm.recordTrade('momentum_v3', { pnl: 230, size: 1.5, side: 'BUY', symbol: 'XAUUSD' });
 */

const EventEmitter = require('events');

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  allocPct:       10,   // % of total capital allocated to this strategy
  maxDrawdownPct:  8,   // max drawdown before strategy is paused (% of allocated capital)
  maxExposurePct: 50,   // max open position value as % of allocated capital
  minRRR:          2.0, // minimum reward/risk ratio enforced here
};

// ─────────────────────────────────────────────────────────────────────────────
// VirtualPortfolio — one strategy's capital slice
// ─────────────────────────────────────────────────────────────────────────────
class VirtualPortfolio {
  constructor(strategyId, config = {}) {
    this.strategyId     = strategyId;
    this.allocPct       = config.allocPct       ?? DEFAULTS.allocPct;
    this.maxDrawdownPct = config.maxDrawdownPct  ?? DEFAULTS.maxDrawdownPct;
    this.maxExposurePct = config.maxExposurePct  ?? DEFAULTS.maxExposurePct;
    this.minRRR         = config.minRRR          ?? DEFAULTS.minRRR;

    // Set once total capital is known
    this._totalCapital    = 0;
    this._allocatedCapital = 0;

    // Live state
    this.virtualPnl      = 0;       // cumulative realised PnL
    this.peakEquity      = 0;       // for drawdown calculation
    this.openExposureUSD = 0;       // current open position value
    this.trades          = 0;
    this.wins            = 0;
    this.paused          = false;
    this.pausedReason    = null;
    this.lastTradeAt     = null;
  }

  setCapital(totalCapital) {
    this._totalCapital     = totalCapital;
    this._allocatedCapital = totalCapital * (this.allocPct / 100);
    if (this.peakEquity === 0) this.peakEquity = this._allocatedCapital;
  }

  get allocatedCapital() { return this._allocatedCapital; }

  get currentEquity() {
    return this._allocatedCapital + this.virtualPnl;
  }

  get drawdownPct() {
    if (this.peakEquity <= 0) return 0;
    return Math.max(0, (this.peakEquity - this.currentEquity) / this.peakEquity * 100);
  }

  get winRate() {
    return this.trades > 0 ? (this.wins / this.trades * 100).toFixed(1) : null;
  }

  get availableCapital() {
    return Math.max(0, this.currentEquity - this.openExposureUSD);
  }

  /**
   * checkRisk(orderValueUSD, rrr)
   * Returns { approved: bool, reason: string|null, adjustedSize: number|null }
   */
  checkRisk(orderValueUSD, rrr = null) {
    if (this.paused) {
      return { approved: false, reason: `Strategy paused: ${this.pausedReason}` };
    }
    if (this.drawdownPct >= this.maxDrawdownPct) {
      this.paused = true;
      this.pausedReason = `Max drawdown ${this.maxDrawdownPct}% reached (current: ${this.drawdownPct.toFixed(1)}%)`;
      return { approved: false, reason: this.pausedReason };
    }
    const newExposurePct = ((this.openExposureUSD + orderValueUSD) / this.allocatedCapital) * 100;
    if (newExposurePct > this.maxExposurePct) {
      return {
        approved: false,
        reason: `Exposure limit: adding ${orderValueUSD.toFixed(0)} would reach ${newExposurePct.toFixed(1)}% (max ${this.maxExposurePct}%)`,
      };
    }
    if (orderValueUSD > this.availableCapital) {
      return {
        approved: false,
        reason: `Insufficient capital: need ${orderValueUSD.toFixed(0)}, available ${this.availableCapital.toFixed(0)}`,
      };
    }
    if (rrr !== null && rrr < this.minRRR) {
      return {
        approved: false,
        reason: `RRR ${rrr.toFixed(2)} below minimum ${this.minRRR}`,
      };
    }
    return { approved: true, reason: null };
  }

  /** Call when an order is opened */
  openPosition(valueUSD) {
    this.openExposureUSD += valueUSD;
  }

  /** Call when a position is closed with realised PnL */
  closePosition(valueUSD, pnl) {
    this.openExposureUSD = Math.max(0, this.openExposureUSD - valueUSD);
    this.virtualPnl += pnl;
    this.trades++;
    if (pnl > 0) this.wins++;
    this.lastTradeAt = new Date().toISOString();
    // Update peak equity
    if (this.currentEquity > this.peakEquity) this.peakEquity = this.currentEquity;
    // Auto-resume if drawdown recovered
    if (this.paused && this.drawdownPct < this.maxDrawdownPct * 0.6) {
      this.paused = false;
      this.pausedReason = null;
    }
  }

  resume() {
    this.paused = false;
    this.pausedReason = null;
  }

  snapshot() {
    return {
      strategyId:      this.strategyId,
      allocPct:        this.allocPct,
      allocatedCapital: parseFloat(this.allocatedCapital.toFixed(2)),
      currentEquity:   parseFloat(this.currentEquity.toFixed(2)),
      virtualPnl:      parseFloat(this.virtualPnl.toFixed(2)),
      openExposureUSD: parseFloat(this.openExposureUSD.toFixed(2)),
      availableCapital: parseFloat(this.availableCapital.toFixed(2)),
      drawdownPct:     parseFloat(this.drawdownPct.toFixed(2)),
      maxDrawdownPct:  this.maxDrawdownPct,
      maxExposurePct:  this.maxExposurePct,
      trades:          this.trades,
      wins:            this.wins,
      winRate:         this.winRate,
      paused:          this.paused,
      pausedReason:    this.pausedReason,
      lastTradeAt:     this.lastTradeAt,
    };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// PortfolioManager — orchestrates all strategy allocations
// ─────────────────────────────────────────────────────────────────────────────
class PortfolioManager extends EventEmitter {
  constructor() {
    super();
    this._portfolios    = new Map();  // strategyId → VirtualPortfolio
    this._totalCapital  = 0;
    this._lastSync      = null;
  }

  /**
   * Set total account capital (call after broker.getBalance())
   * Automatically recalculates all virtual allocations.
   */
  setTotalCapital(amount) {
    this._totalCapital = amount;
    this._lastSync = new Date().toISOString();
    for (const vp of this._portfolios.values()) {
      vp.setCapital(amount);
    }
    this.emit('capital_updated', { totalCapital: amount, ts: this._lastSync });
  }

  /**
   * Register or update a strategy allocation.
   * config: { allocPct, maxDrawdownPct, maxExposurePct, minRRR }
   */
  setAllocation(strategyId, config = {}) {
    let vp = this._portfolios.get(strategyId);
    if (!vp) {
      vp = new VirtualPortfolio(strategyId, config);
      this._portfolios.set(strategyId, vp);
    } else {
      Object.assign(vp, {
        allocPct:       config.allocPct       ?? vp.allocPct,
        maxDrawdownPct: config.maxDrawdownPct  ?? vp.maxDrawdownPct,
        maxExposurePct: config.maxExposurePct  ?? vp.maxExposurePct,
        minRRR:         config.minRRR          ?? vp.minRRR,
      });
    }
    if (this._totalCapital > 0) vp.setCapital(this._totalCapital);
    return vp;
  }

  get(strategyId) {
    return this._portfolios.get(strategyId);
  }

  /**
   * Check if an order is approved by risk governance.
   * orderValueUSD = estimated notional value of the order
   * rrr = reward/risk ratio (optional)
   */
  checkRisk(strategyId, orderValueUSD, rrr = null) {
    const vp = this._portfolios.get(strategyId);
    if (!vp) {
      // Strategy not registered — allow through (legacy / unconfigured)
      return { approved: true, reason: null, note: 'strategy not registered in portfolio manager' };
    }
    const result = vp.checkRisk(orderValueUSD, rrr);
    if (!result.approved) {
      this.emit('risk_blocked', { strategyId, reason: result.reason, orderValueUSD, ts: new Date().toISOString() });
    }
    return result;
  }

  /**
   * Record an opened position (call after successful broker.placeOrder)
   */
  openPosition(strategyId, valueUSD) {
    const vp = this._portfolios.get(strategyId);
    if (vp) vp.openPosition(valueUSD);
  }

  /**
   * Record a closed position with PnL (call from PnL webhook handler)
   */
  closePosition(strategyId, valueUSD, pnl) {
    const vp = this._portfolios.get(strategyId);
    if (!vp) return;
    vp.closePosition(valueUSD, pnl);
    this.emit('position_closed', { strategyId, pnl, valueUSD, snapshot: vp.snapshot(), ts: new Date().toISOString() });
    // Emit pause event if strategy just got paused
    if (vp.paused) {
      this.emit('strategy_paused', { strategyId, reason: vp.pausedReason, ts: new Date().toISOString() });
    }
  }

  /**
   * Manually resume a paused strategy
   */
  resume(strategyId) {
    const vp = this._portfolios.get(strategyId);
    if (vp) {
      vp.resume();
      this.emit('strategy_resumed', { strategyId, ts: new Date().toISOString() });
    }
  }

  /**
   * Reset all open exposure (emergency — e.g. after restart or manual call)
   */
  resetAll() {
    for (const vp of this._portfolios.values()) {
      vp.openExposureUSD = 0;
      vp.paused = false;
      vp.pausedReason = null;
    }
    this.emit('reset', { ts: new Date().toISOString() });
  }

  /**
   * Total allocated percentage — should sum to ≤ 100
   */
  get totalAllocatedPct() {
    let sum = 0;
    for (const vp of this._portfolios.values()) sum += vp.allocPct;
    return parseFloat(sum.toFixed(1));
  }

  get unallocatedPct() {
    return Math.max(0, 100 - this.totalAllocatedPct);
  }

  /**
   * Full portfolio snapshot for dashboard / health endpoint
   */
  snapshot() {
    const strategies = {};
    for (const [id, vp] of this._portfolios) strategies[id] = vp.snapshot();
    return {
      totalCapital:     parseFloat(this._totalCapital.toFixed(2)),
      totalAllocatedPct: this.totalAllocatedPct,
      unallocatedPct:   this.unallocatedPct,
      lastSync:         this._lastSync,
      strategies,
    };
  }
}

module.exports = { PortfolioManager, VirtualPortfolio };
