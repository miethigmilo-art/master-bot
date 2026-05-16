'use strict';
/**
 * Session Trader Strategy — "triceratops"
 * Trades the first momentum burst at London Open (08:00 UTC) and NY Open (13:30 UTC).
 * Logic: First 15min candle direction at session open = bias for next 2h
 * BUY:  Opening candle bullish (close > open) + price above session open
 * SELL: Opening candle bearish + price below session open
 */
const { BaseStrategy } = require('./base');
const { ema, atr, momentum } = require('./indicators');

const LONDON_OPEN_UTC = 8;   // 08:00 UTC
const NY_OPEN_UTC     = 13;  // 13:30 UTC (we use 13 for simplicity)
const SESSION_WINDOW  = 2;   // trade only within 2h of session open

class SessionTraderStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    super('triceratops', settings, marketData, { ...opts, cooldownMs: 5 * 3600_000 });
    this._defaultTimeframe = 'M15';
    this._lastSessionHour = -1;
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'M15', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 10) return;
    const now     = new Date();
    const utcH    = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();

    // Only trade at/after session opens, within the window
    const isLondon = utcH >= LONDON_OPEN_UTC && utcH < LONDON_OPEN_UTC + SESSION_WINDOW;
    const isNY     = utcH >= NY_OPEN_UTC     && utcH < NY_OPEN_UTC     + SESSION_WINDOW;
    if (!isLondon && !isNY) return;

    // Fire once per session open hour
    const sessionHour = isLondon ? LONDON_OPEN_UTC : NY_OPEN_UTC;
    if (this._lastSessionHour === sessionHour) return;

    const closes = agg.closes;
    const candles = agg.all;
    const price   = closes[closes.length - 1];
    const atrVal  = atr(candles, 14);
    const mom     = momentum(closes, 4);  // momentum over last 4 × 15min = 1h
    if (!atrVal || mom === null) return;

    this._lastSessionHour = sessionHour;
    const session = isLondon ? 'London' : 'NY';
    const minRRR  = this.settings.minRRR || 2;
    const slDist  = atrVal * 1.2;

    if (mom > 0.05) {   // bullish momentum at open
      const sl = price - slDist;
      const tp = price + slDist * minRRR;
      await this.signal('BUY', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `${session} open momentum BUY (mom=${mom.toFixed(3)}%)` });
    } else if (mom < -0.05) {  // bearish momentum at open
      const sl = price + slDist;
      const tp = price - slDist * minRRR;
      await this.signal('SELL', { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `${session} open momentum SELL (mom=${mom.toFixed(3)}%)` });
    }
  }
}

module.exports = SessionTraderStrategy;
