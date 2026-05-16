'use strict';
/**
 * Steady Scalper Strategy — "steady"
 * Ultra-conservative. Timeframe: M5
 * Looks for micro-pullbacks within a well-established short-term trend.
 * Very tight SL (0.5× ATR), very small risk (0.2% per trade).
 * Only trades when conditions are pristine — many signals are filtered out.
 *
 * Rules:
 *   - EMA8 > EMA21 (micro uptrend) + RSI between 45-65 (not overextended)
 *   - Price dips to EMA8 and bounces (close > EMA8 after dip below)
 *   - SL: 0.5× ATR below entry  |  TP: 1× ATR (small but frequent)
 */
const { BaseStrategy }      = require('./base');
const { ema, rsi, atr }     = require('./indicators');

class SteadyScalperStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    super('steady', settings, marketData, { ...opts, cooldownMs: 30 * 60_000 });
    this._defaultTimeframe = 'M5'; // 30min cooldown
    this._prevPrice = null;
    this._prevEma8  = null;
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'M5', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 25) return;
    const closes = agg.closes;
    const price  = closes[closes.length - 1];
    const ema8   = ema(closes, 8);
    const ema21  = ema(closes, 21);
    const rsi14  = rsi(closes, 14);
    const atrVal = atr(agg.all, 14);
    if (!ema8 || !ema21 || !rsi14 || !atrVal) return;

    const prev      = this._prevPrice;
    const prevEma8  = this._prevEma8;
    this._prevPrice = price;
    this._prevEma8  = ema8;
    if (!prev || !prevEma8) return;

    const slDist = atrVal * 0.5;
    const minRRR = this.settings.minRRR || 2;

    // Micro uptrend bounce: EMA8 > EMA21, price was below EMA8 and now crossed back above
    if (ema8 > ema21 && prevEma8 > ema21
        && prev < prevEma8 && price > ema8   // price crossed back above EMA8
        && rsi14 >= 45 && rsi14 <= 65) {
      const sl = price - slDist;
      const tp = price + slDist * minRRR;
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Steady scalp: EMA8 bounce up RSI=${rsi14}` });
    }
    // Micro downtrend bounce: EMA8 < EMA21, price was above EMA8 and crossed back below
    else if (ema8 < ema21 && prevEma8 < ema21
        && prev > prevEma8 && price < ema8
        && rsi14 >= 35 && rsi14 <= 55) {
      const sl = price + slDist;
      const tp = price - slDist * minRRR;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Steady scalp: EMA8 bounce down RSI=${rsi14}` });
    }
  }
}

module.exports = SteadyScalperStrategy;
