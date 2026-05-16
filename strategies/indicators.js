'use strict';
/**
 * strategies/indicators.js — Technical indicator library
 * All functions are pure (no side effects), operate on close arrays or candle arrays.
 */

/** Simple Moving Average */
function sma(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Exponential Moving Average */
function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return parseFloat(val.toFixed(6));
}

/** RSI (Wilder smoothing) */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(0, d))  / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

/** ATR — candles: [{high, low, close}] */
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) val = (val * (period - 1) + trs[i]) / period;
  return parseFloat(val.toFixed(6));
}

/** Bollinger Bands */
function bollinger(closes, period = 20, stdMult = 2) {
  const mid = sma(closes, period);
  if (!mid) return null;
  const slice = closes.slice(-period);
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - mid, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + std * stdMult, mid, lower: mid - std * stdMult, std };
}

/** Rolling highest high / lowest low */
function donchian(highs, lows, period) {
  if (highs.length < period) return null;
  const h = highs.slice(-period), l = lows.slice(-period);
  return { high: Math.max(...h), low: Math.min(...l) };
}

/** MACD */
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);
  if (!fastEMA || !slowEMA) return null;
  const macdLine = fastEMA - slowEMA;
  // For signal line we need macd history — simplified: use last N closes
  return { macd: parseFloat(macdLine.toFixed(6)), signal: null, histogram: null };
}

/** Momentum: (close[n] - close[n-period]) / close[n-period] * 100 */
function momentum(closes, period = 10) {
  if (closes.length < period + 1) return null;
  const now  = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return parseFloat(((now - past) / past * 100).toFixed(4));
}

/** Average of last N values */
function avg(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

module.exports = { sma, ema, rsi, atr, bollinger, donchian, macd, momentum, avg };
