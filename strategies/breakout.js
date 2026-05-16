'use strict';
/**
 * Breakout Strategy — "aggressiv"
 * Timeframe: H1  |  20-bar Donchian Channel
 * BUY:  price breaks above 20-bar high with ATR expansion
 * SELL: price breaks below 20-bar low with ATR expansion
 * SL: opposite side of channel  |  TP: SL × minRRR
 */
const { BaseStrategy } = require('./base');
const { atr, avg }     = require('./indicators');

class BreakoutStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    this._defaultTimeframe = 'H1';
    super('aggressiv', settings, marketData, { ...opts, cooldownMs: 3 * 3600_000 });
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'H1', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 25) return;
    const all    = agg.all;
    const closes = agg.closes;
    const highs  = agg.highs;
    const lows   = agg.lows;

    const price    = closes[closes.length - 1];
    const atrVal   = atr(all, 14);
    const atrAvg   = avg(all.slice(-14).map((_, i, a) => {
      const h = a[i].high, l = a[i].low;
      return h - l;
    }), 14);
    if (!atrVal || !atrAvg) return;

    // Confirmed breakout: ATR expanding (volatility picking up)
    const atrExpanding = atrVal > atrAvg * 1.1;

    const high20 = Math.max(...highs.slice(-21, -1));  // exclude current candle
    const low20  = Math.min(...lows.slice(-21, -1));
    const channelWidth = high20 - low20;
    const minRRR = this.settings.minRRR || 2;

    if (atrExpanding && price > high20) {
      const sl = low20;
      const slDist = price - sl;
      const tp = price + slDist * minRRR;
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Breakout above 20H high=${high20.toFixed(2)}, ATR expanding` });
    } else if (atrExpanding && price < low20) {
      const sl = high20;
      const slDist = sl - price;
      const tp = price - slDist * minRRR;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `Breakout below 20H low=${low20.toFixed(2)}, ATR expanding` });
    }
  }
}

module.exports = BreakoutStrategy;
