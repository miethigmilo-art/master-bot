'use strict';
/**
 * strategies/base.js — BaseStrategy
 *
 * All strategy classes extend this. Strategies generate signals internally
 * and post them to the local webhook endpoint — going through the full
 * HELIX risk/ML pipeline before any order is placed.
 *
 * "Intelligence suggests. Risk decides. Execution obeys."
 */

const EventEmitter = require('events');
const axios        = require('axios');

class BaseStrategy extends EventEmitter {
  constructor(id, settings, marketData, options = {}) {
    super();
    this.id          = id;
    this.settings    = settings;           // from settings.json
    this.marketData  = marketData;         // MarketDataService instance
    this.port        = options.port || process.env.PORT || 8080;
    this.secret      = process.env.WEBHOOK_SECRET || '';
    this._running    = false;
    this._unsubFns   = [];
    this._lastSignal = null;
    this._cooldownMs = options.cooldownMs || 4 * 60 * 60 * 1000; // 4h default cooldown
    this._signalCount = 0;
    this._log        = options.log || console.log;
  }

  /** Override in subclass — called when strategy is ready to trade */
  async onStart() {}

  /** Override in subclass — called on every candle update */
  async onCandle(candles) {}

  start() {
    if (this._running) return;
    this._running = true;
    this._log(`[${this.id}] Strategy started`);
    this.onStart().catch(err => this._log(`[${this.id}] onStart error: ${err.message}`));
  }

  stop() {
    this._running = false;
    for (const fn of this._unsubFns) try { fn(); } catch {}
    this._unsubFns = [];
    this._log(`[${this.id}] Strategy stopped`);
  }

  /** Subscribe to candle feed — automatically cleaned up on stop() */
  _subscribe(symbol, assetClass, timeframe, callback) {
    const unsub = this.marketData.subscribe(symbol, assetClass, timeframe, callback);
    this._unsubFns.push(unsub);
    return unsub;
  }

  /**
   * Emit a trading signal — posts to internal webhook.
   * All risk/ML checks happen in the existing pipeline.
   */
  async signal(side, { symbol, assetClass, entry, sl, tp, reason } = {}) {
    if (!this._running) return;
    if (!this.settings?.enabled) return;

    // Cooldown: prevent signal spam
    if (this._lastSignal) {
      const elapsed = Date.now() - this._lastSignal;
      if (elapsed < this._cooldownMs) {
        this._log(`[${this.id}] Signal suppressed (cooldown: ${Math.round((this._cooldownMs - elapsed) / 60000)}min left)`);
        return;
      }
    }

    const rrr = sl && tp && entry
      ? Math.abs(tp - entry) / Math.abs(entry - sl)
      : this.settings.minRRR || 2;

    if (rrr < (this.settings.minRRR || 2)) {
      this._log(`[${this.id}] Signal suppressed (RRR ${rrr.toFixed(2)} < min ${this.settings.minRRR})`);
      return;
    }

    const payload = {
      strategie:  this.id,
      side,
      epic:       symbol || 'XAUUSD',
      assetClass: assetClass || 'commodity',
      entry:      entry   ? parseFloat(entry.toFixed(4))  : undefined,
      sl:         sl      ? parseFloat(sl.toFixed(4))     : undefined,
      tp:         tp      ? parseFloat(tp.toFixed(4))     : undefined,
      rr:         parseFloat(rrr.toFixed(2)),
      source:     'internal',
      reason:     reason || this.constructor.name,
    };

    this._lastSignal = Date.now();
    this._signalCount++;

    this._log(`[${this.id}] Signal: ${side} ${payload.epic} | SL=${payload.sl} TP=${payload.tp} RRR=${rrr.toFixed(2)} | ${reason}`);
    this.emit('signal', payload);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.secret) headers['x-webhook-secret'] = this.secret;
      await axios.post(
        `http://localhost:${this.port}/webhook/${this.id}`,
        payload,
        { headers, timeout: 10000 }
      );
    } catch (err) {
      this._log(`[${this.id}] Signal delivery error: ${err.message}`);
    }
  }

  status() {
    return {
      id:          this.id,
      running:     this._running,
      signals:     this._signalCount,
      lastSignal:  this._lastSignal ? new Date(this._lastSignal).toISOString() : null,
      cooldownMs:  this._cooldownMs,
      enabled:     this.settings?.enabled || false,
    };
  }
}

module.exports = { BaseStrategy };
