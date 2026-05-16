'use strict';
/**
 * RSI Mean Reversion Strategy — "pterodactyl"
 * Timeframe: M15  |  RSI(14) oversold/overbought + Bollinger Band confirmation
 * BUY:  RSI < 30 (oversold) + price at/below lower Bollinger Band
 * SELL: RSI > 70 (overbought) + price at/above upper Bollinger Band
 * Tight SL: 1× ATR  |  TP: EMA20 (mean reversion target)
 */
const { BaseStrategy }       = require('./base');
const { rsi, atr, bollinger, ema } = require('./indicators');

class RSIReversionStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    super('pterodactyl', settings, marketData, { ...opts, cooldownMs: 2 * 3600_000 });
    this._defaultTimeframe = 'M15';
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'M15', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 25) return;
    const closes = agg.closes;
    const price  = closes[closes.length - 1];
    const rsi14  = rsi(closes, 14);
    const atrVal = atr(agg.all, 14);
    const bb     = bollinger(closes, 20, 2);
    const ema20  = ema(closes, 20);
    if (!rsi14 || !atrVal || !bb || !ema20) return;

    const minRRR = this.settings.minRRR || 2;

    // Oversold: RSI < 30 + price near lower BB
    if (rsi14 < 30 && price <= bb.lower * 1.002) {
      const sl     = price - atrVal;
      const target = ema20;  // revert to mean
      const dist   = Math.abs(target - price);
      if (dist < atrVal * minRRR) return;  // target too close
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price,
        sl, tp: target, reason: `RSI oversold=${rsi14} at lower BB=${bb.lower.toFixed(2)}` });
    }
    // Overbought: RSI > 70 + price near upper BB
    else if (rsi14 > 70 && price >= bb.upper * 0.998) {
      const sl     = price + atrVal;
      const target = ema20;
      const dist   = Math.abs(price - target);
      if (dist < atrVal * minRRR) return;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price,
        sl, tp: target, reason: `RSI overbought=${rsi14} at upper BB=${bb.upper.toFixed(2)}` });
    }
  }
}

module.exports = RSIReversionStrategy;
