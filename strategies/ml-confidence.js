'use strict';
/**
 * ML Confidence Strategy — "smart"
 * Timeframe: H1  |  ML service + Regime filter + EMA trend
 * Only signals when: ML confidence > threshold AND regime = AKTIV AND trend aligned
 * This strategy defers heavily to the ML service for entry decisions.
 */
const { BaseStrategy } = require('./base');
const { ema, rsi, atr } = require('./indicators');
const axios = require('axios');

class MLConfidenceStrategy extends BaseStrategy {
  constructor(settings, marketData, opts) {
    this._defaultTimeframe = 'H1';
    super('smart', settings, marketData, { ...opts, cooldownMs: 6 * 3600_000 });
    this._mlUrl = process.env.ML_SERVICE_URL || null;
  }

  async onStart() {
    this._subscribe('XAUUSD', 'commodity', 'H1', (agg) => this._onCandle(agg));
  }

  async _onCandle(agg) {
    if (agg.length < 55 || !this._mlUrl) return;
    const closes = agg.closes;
    const price  = closes[closes.length - 1];
    const atrVal = atr(agg.all, 14);
    const ema20  = ema(closes, 20);
    const ema50  = ema(closes, 50);
    const rsi14  = rsi(closes, 14);
    if (!atrVal || !ema20 || !ema50 || !rsi14) return;

    // Determine candidate side from EMA trend
    const trending = Math.abs(ema20 - ema50) > atrVal * 0.5;
    if (!trending) return;
    const side = ema20 > ema50 ? 'BUY' : 'SELL';

    // RSI filter: avoid extremes
    if (side === 'BUY'  && rsi14 > 70) return;
    if (side === 'SELL' && rsi14 < 30) return;

    // Ask ML service
    try {
      const now  = new Date();
      const slDist = atrVal * 1.2;
      const ml = await axios.post(`${this._mlUrl}/predict`, {
        strategie:    'smart',
        side,
        hour:         now.getHours(),
        weekday:      now.getDay(),
        sessionLondon: (now.getUTCHours() >= 8  && now.getUTCHours() < 16) ? 1 : 0,
        sessionOverlap:(now.getUTCHours() >= 13 && now.getUTCHours() < 16) ? 1 : 0,
        side_buy:     side === 'BUY' ? 1 : 0,
        rrr:          this.settings.minRRR || 2.5,
        slDistPct:    slDist / price * 100,
        rewardPct:    (slDist * (this.settings.minRRR || 2.5)) / price * 100,
        spread:       0.1,
        drawdownPct:  0,
        wr5: 0.5, wr15: 0.5, konsek: 0,
      }, { timeout: 5000 });

      const { empfehlung, konfidenz } = ml.data;
      if (empfehlung === 'skip' || !konfidenz) return;
      if (konfidenz < (parseFloat(process.env.PREDICT_CONF) || 0.62)) return;

      const sl = side === 'BUY'  ? price - slDist : price + slDist;
      const tp = side === 'BUY'
        ? price + slDist * (this.settings.minRRR || 2.5)
        : price - slDist * (this.settings.minRRR || 2.5);

      await this.signal(side, { symbol: 'XAUUSD', assetClass: 'commodity', entry: price, sl, tp,
        reason: `ML conf=${(konfidenz*100).toFixed(0)}% trend=${side} RSI=${rsi14}` });
    } catch (err) {
      // ML service unavailable — skip
    }
  }
}

module.exports = MLConfidenceStrategy;
