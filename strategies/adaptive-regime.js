'use strict';
/**
 * Adaptive Regime Strategy — "adaptive"
 * Detects market regime from price action and applies the appropriate sub-strategy:
 *   BULL     → Momentum: buy pullbacks to EMA20
 *   BEAR     → Momentum: sell rallies to EMA20
 *   SIDEWAYS → Range: buy near range low, sell near range high
 *   HIGH_VOL → Sit out (too risky for this strategy)
 */
const { BaseStrategy }              = require('./base');
const { ema, atr, rsi, bollinger }  = require('./indicators');

class AdaptiveRegimeStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    super('adaptive', settings, marketData, { ...opts, cooldownMs: 3 * 3600_000 });
    this._defaultTimeframe = 'H1';
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'H1', (agg) => this._onCandle(agg));
  }

  _detectRegime(closes, candles) {
    const ema20  = ema(closes, 20);
    const ema50  = ema(closes, 50);
    const atrVal = atr(candles, 14);
    const atrSlice = candles.slice(-28).map((_, i, a) => {
      if (i === 0) return 0;
      const h = a[i].high, l = a[i].low, pc = a[i-1].close;
      return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    });
    const atrAvg = atrSlice.slice(-14).reduce((s, v) => s + v, 0) / 14;
    if (!ema20 || !ema50 || !atrVal) return 'UNKNOWN';

    const price = closes[closes.length - 1];
    if (atrVal > atrAvg * 1.8) return 'HIGH_VOL';
    if (price > ema20 && ema20 > ema50) return 'BULL';
    if (price < ema20 && ema20 < ema50) return 'BEAR';
    return 'SIDEWAYS';
  }

  async _onCandle(agg) {
    if (agg.length < 55) return;
    const closes  = agg.closes;
    const candles = agg.all;
    const price   = closes[closes.length - 1];
    const regime  = this._detectRegime(closes, candles);

    const atrVal = atr(candles, 14);
    const ema20  = ema(closes, 20);
    const rsi14  = rsi(closes, 14);
    const bb     = bollinger(closes, 20, 2);
    if (!atrVal || !ema20 || !rsi14 || !bb) return;

    const minRRR = this.settings.minRRR || 2;

    if (regime === 'BULL' && rsi14 < 45 && price < ema20 * 1.001) {
      // Pullback buy in uptrend
      const sl = price - atrVal * 1.5;
      const tp = price + atrVal * 1.5 * minRRR;
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Adaptive BULL pullback RSI=${rsi14}` });

    } else if (regime === 'BEAR' && rsi14 > 55 && price > ema20 * 0.999) {
      // Rally sell in downtrend
      const sl = price + atrVal * 1.5;
      const tp = price - atrVal * 1.5 * minRRR;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Adaptive BEAR rally RSI=${rsi14}` });

    } else if (regime === 'SIDEWAYS') {
      // Range: buy near lower BB, sell near upper BB
      if (price <= bb.lower * 1.001 && rsi14 < 35) {
        const sl = price - atrVal;
        const tp = bb.mid;
        if ((tp - price) / (price - sl) >= minRRR) {
          await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
            reason: `Adaptive SIDEWAYS range buy RSI=${rsi14}` });
        }
      } else if (price >= bb.upper * 0.999 && rsi14 > 65) {
        const sl = price + atrVal;
        const tp = bb.mid;
        if ((price - tp) / (sl - price) >= minRRR) {
          await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
            reason: `Adaptive SIDEWAYS range sell RSI=${rsi14}` });
        }
      }
    }
    // HIGH_VOL: no trades
  }
}

module.exports = AdaptiveRegimeStrategy;
