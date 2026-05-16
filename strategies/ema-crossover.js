'use strict';
/**
 * EMA Crossover Strategy — "mittel"
 * Timeframe: H1  |  EMA 20 / EMA 50
 * BUY:  EMA20 crosses above EMA50, price above both, ATR confirms volatility
 * SELL: EMA20 crosses below EMA50, price below both
 * SL: 1.5× ATR from entry  |  TP: SL × minRRR
 */
const { BaseStrategy } = require('./base');
const { ema, atr }     = require('./indicators');

class EMACrossoverStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    super('mittel', settings, marketData, { ...opts, cooldownMs: 4 * 3600_000 });
    this._defaultTimeframe = 'H1';
    this._prevEma20 = null;
    this._prevEma50 = null;
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'H1', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 55) return;
    const closes = agg.closes;
    const highs   = agg.highs;
    const lows    = agg.lows;

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const atrVal = atr(agg.all, 14);
    if (!ema20 || !ema50 || !atrVal) return;

    const price = closes[closes.length - 1];
    const prev20 = this._prevEma20;
    const prev50 = this._prevEma50;
    this._prevEma20 = ema20;
    this._prevEma50 = ema50;
    if (prev20 === null || prev50 === null) return;

    const slDist = atrVal * 1.5;
    const minRRR = this.settings.minRRR || 2;

    // BUY: golden cross
    if (prev20 <= prev50 && ema20 > ema50 && price > ema20) {
      const sl = price - slDist;
      const tp = price + slDist * minRRR;
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `EMA cross up (EMA20=${ema20.toFixed(2)} > EMA50=${ema50.toFixed(2)})` });
    }
    // SELL: death cross
    else if (prev20 >= prev50 && ema20 < ema50 && price < ema20) {
      const sl = price + slDist;
      const tp = price - slDist * minRRR;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `EMA cross down (EMA20=${ema20.toFixed(2)} < EMA50=${ema50.toFixed(2)})` });
    }
  }
}

module.exports = EMACrossoverStrategy;
