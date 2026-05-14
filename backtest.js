// ══════════════════════════════════════════════════════════════
//  Master Bot — Backtesting Engine (V2)
//  Analysiert Trade-Historie + simuliert Trades gegen historische Preise
//  Walk-Forward Validation für konsistente Performance-Messung
// ══════════════════════════════════════════════════════════════
'use strict';

const axios = require('axios');

// ── Historische Kerzen von Capital.com holen ──────────────────
async function fetchCandles(baseUrl, authHeaders, epic, resolution = 'HOUR', count = 500) {
  const res = await axios.get(`${baseUrl}/prices/${epic}`, {
    headers: authHeaders,
    params:  { resolution, max: Math.min(count, 1000) },
    timeout: 15000,
  });
  return res.data.prices || [];
}

// ── Performance-Metriken aus Trade-Liste ──────────────────────
// trades = [{ pnl, datum }]
function berechneMetriken(trades) {
  if (!trades || !trades.length) return null;
  const gewinne  = trades.filter(t => t.pnl > 0);
  const verluste = trades.filter(t => t.pnl < 0);

  const bruttoGewinn  = gewinne.reduce((s, t) => s + t.pnl, 0);
  const bruttoVerlust = Math.abs(verluste.reduce((s, t) => s + t.pnl, 0));
  const profitFactor  = bruttoVerlust > 0 ? bruttoGewinn / bruttoVerlust : bruttoGewinn > 0 ? 9.99 : 0;

  // Max Drawdown (absolut)
  let peak = 0, maxDD = 0, kapital = 0;
  for (const t of trades) {
    kapital += t.pnl;
    if (kapital > peak) peak = kapital;
    const dd = peak - kapital;
    if (dd > maxDD) maxDD = dd;
  }

  // Vereinfachter Sharpe Ratio
  const returns = trades.map(t => t.pnl);
  const avg     = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance= returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length;
  const stdDev  = Math.sqrt(variance);
  const sharpe  = stdDev > 0 ? parseFloat(((avg / stdDev) * Math.sqrt(252)).toFixed(2)) : 0;

  return {
    trades:       trades.length,
    gewinne:      gewinne.length,
    verluste:     verluste.length,
    winRate:      parseFloat(((gewinne.length / trades.length) * 100).toFixed(1)),
    gesamtPnL:    parseFloat(trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdown:  parseFloat(maxDD.toFixed(2)),
    sharpe,
    avgGewinn:    gewinne.length  ? parseFloat((bruttoGewinn  / gewinne.length).toFixed(2))  : 0,
    avgVerlust:   verluste.length ? parseFloat((bruttoVerlust / verluste.length).toFixed(2)) : 0,
    expectancy:   parseFloat(avg.toFixed(2)),
  };
}

// ── Strategie-Score (0–100 Punkte) ───────────────────────────
// Gewichtung: Win Rate 35% | Profit Factor 30% | Sharpe 20% | Drawdown 15%
function berechneStrategieScore(metriken) {
  if (!metriken || metriken.trades < 5) return null;

  const wrScore  = Math.min((metriken.winRate  / 65)  * 35, 35);     // 65% WR = Voll-Punkte
  const pfScore  = Math.min((metriken.profitFactor / 2.0) * 30, 30); // PF 2.0 = Voll-Punkte
  const shScore  = Math.min(Math.max((metriken.sharpe / 1.5) * 20, 0), 20);
  const ddAbzug  = Math.min((metriken.maxDrawdown / 200) * 15, 15);  // 200€ DD = Voll-Abzug

  return Math.max(0, Math.round(wrScore + pfScore + shScore - ddAbzug));
}

// ── Walk-Forward Validation ───────────────────────────────────
// Teilt Trades in N Zeitfenster und misst Konsistenz der Performance
function walkForwardTest(trades, fensterAnzahl = 4) {
  if (!trades || trades.length < fensterAnzahl * 5) return null;

  // Nach Datum sortieren
  const sorted = [...trades].sort((a, b) => new Date(a.datum) - new Date(b.datum));
  const fSize  = Math.floor(sorted.length / fensterAnzahl);
  const results = [];

  for (let i = 0; i < fensterAnzahl; i++) {
    const start = i * fSize;
    const end   = i === fensterAnzahl - 1 ? sorted.length : start + fSize;
    const fensterTrades = sorted.slice(start, end);

    results.push({
      fenster:    i + 1,
      von:        fensterTrades[0]?.datum?.substring(0, 10),
      bis:        fensterTrades[fensterTrades.length - 1]?.datum?.substring(0, 10),
      metriken:   berechneMetriken(fensterTrades),
    });
  }

  // Konsistenz: Wie viele Fenster sind profitabel?
  const profitabeleFenster = results.filter(r => r.metriken?.gesamtPnL > 0).length;
  const konsistenz = parseFloat((profitabeleFenster / fensterAnzahl * 100).toFixed(0));

  return { fenster: results, konsistenz, profitabeleFenster, gesamt: fensterAnzahl };
}

// ── Analyse nach Handelsstunde ────────────────────────────────
function analyseNachStunde(trades) {
  const stunden = {};
  for (const t of trades) {
    const h = new Date(t.datum).getHours();
    if (!stunden[h]) stunden[h] = [];
    stunden[h].push(t);
  }
  return Object.entries(stunden)
    .map(([h, ts]) => ({ stunde: parseInt(h), ...berechneMetriken(ts) }))
    .sort((a, b) => a.stunde - b.stunde);
}

// ── Analyse nach Wochentag ─────────────────────────────────────
function analyseNachWochentag(trades) {
  const TAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const wt = {};
  for (const t of trades) {
    const d = new Date(t.datum).getDay();
    if (!wt[d]) wt[d] = [];
    wt[d].push(t);
  }
  return Object.entries(wt)
    .map(([d, ts]) => ({ tag: TAGE[d], tagNr: parseInt(d), ...berechneMetriken(ts) }))
    .sort((a, b) => a.tagNr - b.tagNr);
}

// ── Analyse nach Side (BUY vs SELL) ──────────────────────────
function analyseNachSide(trades) {
  const buy  = trades.filter(t => t.side === 'BUY');
  const sell = trades.filter(t => t.side === 'SELL');
  return {
    BUY:  berechneMetriken(buy),
    SELL: berechneMetriken(sell),
  };
}

// ── Preis-basierter Einzel-Trade Simulator ────────────────────
// Simuliert ob SL oder TP auf Folgekerzen getroffen wurde
function simuliereTrade(candles, signalIdx, side, slPct, rrr) {
  if (signalIdx >= candles.length) return null;
  const mid   = c => ((c?.bid || 0) + (c?.ask || 0)) / 2 || 0;
  const entry = mid(candles[signalIdx].closePrice);
  if (!entry) return null;

  const slDist = entry * (slPct / 100);
  const sl = side === 'BUY' ? entry - slDist : entry + slDist;
  const tp = side === 'BUY' ? entry + slDist * rrr : entry - slDist * rrr;

  for (let i = signalIdx + 1; i < Math.min(signalIdx + 200, candles.length); i++) {
    const high = mid(candles[i].highPrice);
    const low  = mid(candles[i].lowPrice);
    if (!high || !low) continue;

    if (side === 'BUY') {
      if (low  <= sl) return { ergebnis: 'verlust', pnl: -slDist, entry, sl, tp, kerzen: i - signalIdx };
      if (high >= tp) return { ergebnis: 'gewinn',  pnl: slDist * rrr, entry, sl, tp, kerzen: i - signalIdx };
    } else {
      if (high >= sl) return { ergebnis: 'verlust', pnl: -slDist, entry, sl, tp, kerzen: i - signalIdx };
      if (low  <= tp) return { ergebnis: 'gewinn',  pnl: slDist * rrr, entry, sl, tp, kerzen: i - signalIdx };
    }
  }
  return { ergebnis: 'offen', pnl: 0, entry, sl, tp, kerzen: 200 };
}

// ── Preis-basierter Vollbacktest ──────────────────────────────
// Generiert automatisch Signale basierend auf EMA-Crossover + handelt sie
// Verwendung: wenn keine historischen TradingView-Signale vorhanden
function preisBacktest(candles, config = {}) {
  const {
    ema_schnell = 9,
    ema_langsam = 21,
    slPct       = 0.5,   // SL = 0.5% vom Entry
    rrr         = 2.0,   // Risk:Reward Ratio
    mindestAbstand = 3,  // Kerzen Pause zwischen Trades
  } = config;

  const mid    = c => ((c?.bid || 0) + (c?.ask || 0)) / 2 || 0;
  const closes = candles.map(c => mid(c.closePrice));

  // EMA berechnen
  function ema(werte, periode) {
    if (werte.length < periode) return [];
    const k = 2 / (periode + 1);
    let e = werte.slice(0, periode).reduce((a, b) => a + b, 0) / periode;
    const result = new Array(periode - 1).fill(null);
    result.push(e);
    for (let i = periode; i < werte.length; i++) {
      e = werte[i] * k + e * (1 - k);
      result.push(e);
    }
    return result;
  }

  const emaS = ema(closes, ema_schnell);
  const emaL = ema(closes, ema_langsam);

  const simulierteSignale = [];
  let letzterTrade = -mindestAbstand;

  for (let i = ema_langsam; i < candles.length - 1; i++) {
    if (i - letzterTrade < mindestAbstand) continue;
    if (!emaS[i] || !emaL[i] || !emaS[i-1] || !emaL[i-1]) continue;

    // EMA Crossover
    const kreuzungAuf  = emaS[i-1] <= emaL[i-1] && emaS[i] > emaL[i];
    const kreuzungAb   = emaS[i-1] >= emaL[i-1] && emaS[i] < emaL[i];

    let side = null;
    if (kreuzungAuf) side = 'BUY';
    if (kreuzungAb)  side = 'SELL';
    if (!side) continue;

    const ergebnis = simuliereTrade(candles, i, side, slPct, rrr);
    if (ergebnis && ergebnis.ergebnis !== 'offen') {
      simulierteSignale.push({ ...ergebnis, side, kerzeIdx: i, ts: candles[i].snapshotTime });
      letzterTrade = i + ergebnis.kerzen;
      i += ergebnis.kerzen;
    }
  }

  const tradeList = simulierteSignale.map(s => ({ pnl: s.pnl, datum: s.ts, side: s.side }));
  return {
    config: { ema_schnell, ema_langsam, slPct, rrr },
    signale:  simulierteSignale.length,
    metriken: berechneMetriken(tradeList),
    walkForward: walkForwardTest(tradeList, 4),
    stunden: analyseNachStunde(tradeList),
    wochentage: analyseNachWochentag(tradeList),
  };
}

// ── Vollständige Strategie-Analyse ────────────────────────────
// Analysiert vorhandene Trade-History einer Strategie
function analysiereStrategie(trades) {
  if (!trades || trades.length < 2) return { fehler: 'Zu wenig Trades (min. 2)' };

  const metriken = berechneMetriken(trades);
  const score    = berechneStrategieScore(metriken);
  const wf       = walkForwardTest(trades, Math.min(4, Math.floor(trades.length / 5)));

  return {
    metriken,
    score,
    walkForward: wf,
    stunden:    analyseNachStunde(trades),
    wochentage: analyseNachWochentag(trades),
    sides:      analyseNachSide(trades),
    bewertet:   new Date().toISOString(),
  };
}

module.exports = {
  fetchCandles,
  berechneMetriken,
  berechneStrategieScore,
  walkForwardTest,
  analyseNachStunde,
  analyseNachWochentag,
  analyseNachSide,
  simuliereTrade,
  preisBacktest,
  analysiereStrategie,
};
