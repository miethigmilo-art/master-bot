'use strict';
/**
 * strategies/market-data.js — Candle Aggregator + Market Data Service
 *
 * Converts broker tick stream → OHLCV candles for strategy consumption.
 * Supports M1, M5, M15, H1, H4 timeframes.
 *
 * Usage:
 *   const md = new MarketDataService(broker);
 *   md.subscribe('XAUUSD', 'commodity', 'H1', (candles) => { ... });
 */

const EventEmitter = require('events');
const axios = require('axios');

// ── Candle Aggregator ────────────────────────────────────────────────────────
class CandleAggregator {
  constructor(symbol, timeframeMs, maxCandles = 200) {
    this.symbol       = symbol;
    this.timeframeMs  = timeframeMs;
    this.maxCandles   = maxCandles;
    this.candles      = [];
    this._current     = null;
    this._periodStart = null;
  }

  onTick(tick) {
    const price = tick.last || (((tick.bid || 0) + (tick.ask || 0)) / 2);
    if (!price) return null;

    const now         = tick.ts || Date.now();
    const periodStart = Math.floor(now / this.timeframeMs) * this.timeframeMs;

    if (!this._current || periodStart !== this._periodStart) {
      if (this._current) {
        this._current.close = price;
        this.candles.push({ ...this._current });
        if (this.candles.length > this.maxCandles) this.candles.shift();
      }
      this._periodStart = periodStart;
      this._current = {
        ts: periodStart, open: price, high: price, low: price, close: price, volume: 0
      };
      return null; // new candle started, previous closed
    }

    this._current.high   = Math.max(this._current.high, price);
    this._current.low    = Math.min(this._current.low,  price);
    this._current.close  = price;
    this._current.volume = (this._current.volume || 0) + 1;
    return null;
  }

  /** Returns completed candles (not including the current open candle) */
  get closed() { return this.candles; }

  /** Returns completed candles + current open candle */
  get all() {
    if (!this._current) return this.candles;
    return [...this.candles, { ...this._current, close: this._current.close }];
  }

  get closes()  { return this.all.map(c => c.close); }
  get highs()   { return this.all.map(c => c.high);  }
  get lows()    { return this.all.map(c => c.low);   }
  get last()    { return this.all[this.all.length - 1] || null; }
  get length()  { return this.all.length; }
}

// Timeframe → milliseconds
const TIMEFRAMES = {
  'M1':  60_000,
  'M5':  5  * 60_000,
  'M15': 15 * 60_000,
  'H1':  60 * 60_000,
  'H4':  4  * 60 * 60_000,
  'D1':  24 * 60 * 60_000,
};


// ── Market Data Service ──────────────────────────────────────────────────────
class MarketDataService extends EventEmitter {
  constructor(broker) {
    super();
    this._broker      = broker;
    this._feeds       = new Map();   // symbol → { unsub, aggregators: Map<tf, CandleAggregator> }
    this._callbacks   = new Map();   // `${symbol}:${tf}` → Set<callback>
  }

  /**
   * Subscribe to candle updates for a symbol + timeframe.
   * callback(candles: CandleAggregator) is called on every tick.
   * Returns unsubscribe function.
   */
  subscribe(symbol, assetClass, timeframe, callback) {
    const key  = `${symbol}:${timeframe}`;
    const tfMs = TIMEFRAMES[timeframe];
    if (!tfMs) throw new Error(`Unknown timeframe: ${timeframe}. Use: ${Object.keys(TIMEFRAMES).join(', ')}`);

    // Register callback
    if (!this._callbacks.has(key)) this._callbacks.set(key, new Set());
    this._callbacks.get(key).add(callback);

    // Create price feed for symbol if not already running
    if (!this._feeds.has(symbol)) {
      const aggregators = new Map();
      const feed = { aggregators };

      const unsub = this._broker.streamPrices(symbol, assetClass, (tick) => {
        for (const [tf, agg] of aggregators) {
          agg.onTick(tick);
          const cbs = this._callbacks.get(`${symbol}:${tf}`);
          if (cbs) for (const cb of cbs) cb(agg);
        }
      });

      feed.unsub = unsub;
      this._feeds.set(symbol, feed);
    }

    // Create aggregator for this timeframe if needed
    const feed = this._feeds.get(symbol);
    if (!feed.aggregators.has(timeframe)) {
      feed.aggregators.set(timeframe, new CandleAggregator(symbol, tfMs));
    }

    return () => {
      const cbs = this._callbacks.get(key);
      if (cbs) { cbs.delete(callback); if (!cbs.size) this._callbacks.delete(key); }
    };
  }

  /**
   * Fetch historical candles from MARKET_DATA_URL (optional).
   * Falls back to empty array (strategies will wait for live data to build up).
   */
  async seedHistory(symbol, timeframe, count = 100) {
    const url = process.env.MARKET_DATA_URL;
    if (!url) return [];
    try {
      const res = await axios.get(url, {
        params: { symbol, resolution: timeframe, max: count },
        timeout: 8000,
      });
      const raw = res.data.prices || res.data.candles || (Array.isArray(res.data) ? res.data : []);
      return raw.map(c => ({
        ts:     new Date(c.snapshotTime || c.time || c.ts).getTime(),
        open:   c.openPrice?.mid  || c.open  || c.o,
        high:   c.highPrice?.mid  || c.high  || c.h,
        low:    c.lowPrice?.mid   || c.low   || c.l,
        close:  c.closePrice?.mid || c.close || c.c,
        volume: c.volume          || c.v     || 0,
      })).filter(c => c.close);
    } catch { return []; }
  }
}

module.exports = { MarketDataService, CandleAggregator, TIMEFRAMES };
