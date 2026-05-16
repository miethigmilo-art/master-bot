'use strict';
/**
 * Trend Following Strategy — "konservativ"
 * Timeframe: H4  |  EMA 50 trend direction + RSI pullback entry
 * BUY:  Price above EMA50 (uptrend) + RSI pulls back to 40-50 zone
 * SELL: Price below EMA50 (downtrend) + RSI rallies to 50-60 zone
 * Wide SL: 2× ATR  |  TP: SL × minRRR  |  Long-term bias
 */
const { BaseStrategy } = require('./base');
const { ema, rsi, atr } = require('./indicators');

class TrendFollowStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    this._defaultTimeframe = 'H4';
    super('konservativ', settings, marketData, { ...opts, cooldownMs: 12 * 3600_000 });
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'H4', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 55) return;
    const closes = agg.closes;
    const price  = closes[closes.length - 1];
    const ema50  = ema(closes, 50);
    const rsi14  = rsi(closes, 14);
    const atrVal = atr(agg.all, 14);
    if (!ema50 || !rsi14 || !atrVal) return;

    const minRRR = this.settings.minRRR || 2;
    const slDist = atrVal * 2;

    // Uptrend: price > EMA50 + RSI pulled back to 40-52 (buying the dip in trend)
    if (price > ema50 && rsi14 >= 40 && rsi14 <= 52) {
      const sl = price - slDist;
      const tp = price + slDist * minRRR;
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Trend BUY: price(${price.toFixed(2)}) > EMA50(${ema50.toFixed(2)}), RSI=${rsi14}` });
    }
    // Downtrend: price < EMA50 + RSI rallied to 48-60 (selling the bounce in trend)
    else if (price < ema50 && rsi14 >= 48 && rsi14 <= 60) {
      const sl = price + slDist;
      const tp = price - slDist * minRRR;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Trend SELL: price(${price.toFixed(2)}) < EMA50(${ema50.toFixed(2)}), RSI=${rsi14}` });
    }
  }
}

module.exports = TrendFollowStrategy;
