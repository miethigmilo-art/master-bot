// ══════════════════════════════════════════════════════════════
//  Master Bot — Signal Generator (V4 #14)
//
//  Generiert eigene BUY/SELL Signale ohne TradingView:
//  Capital.com REST (1-Min OHLCV) → EMA/ATR Indikatoren
//  → EMA Crossover Signal → POST an eigenen Webhook
//
//  Konfiguration (ENV):
//    SIGNAL_GEN_ENABLED   = "true"   (default: false)
//    SIGNAL_GEN_STRATEGIE = "mittel" (welcher Account genutzt wird)
//    SIGNAL_GEN_RRR       = "2.0"    (Risk/Reward Ratio)
//    SIGNAL_GEN_ATR_SL    = "1.5"    (SL = ATR * Faktor)
//    SIGNAL_GEN_INTERVAL  = "60"     (Sekunden zwischen Prüfungen)
// ══════════════════════════════════════════════════════════════
'use strict';

const axios = require('axios');

// ── Indikatoren ───────────────────────────────────────────────

// EMA (Exponential Moving Average) über Schlusskurse
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce(function(s, v) { return s + v; }, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

// ATR (Average True Range) über letzten N Kerzen
function atr(candles, period) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < recent.length; i++) {
    const high  = recent[i].highPrice ? recent[i].highPrice.bid : recent[i].high;
    const low   = recent[i].lowPrice  ? recent[i].lowPrice.bid  : recent[i].low;
    const close = recent[i-1].closePrice ? recent[i-1].closePrice.bid : recent[i-1].close;
    if (high == null || low == null || close == null) continue;
    trs.push(Math.max(high - low, Math.abs(high - close), Math.abs(low - close)));
  }
  if (!trs.length) return null;
  return trs.reduce(function(s, v) { return s + v; }, 0) / trs.length;
}

// RSI (Relative Strength Index) als zusaetzlicher Filter
function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i] - recent[i-1];
    if (delta >= 0) gains  += delta;
    else            losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// Kerzen-Normalisierung: Capital.com Preisformat → einheitlich
function normalizeCandle(c) {
  return {
    open:   (c.openPrice  ? c.openPrice.bid  : c.open)  || 0,
    high:   (c.highPrice  ? c.highPrice.bid  : c.high)  || 0,
    low:    (c.lowPrice   ? c.lowPrice.bid   : c.low)   || 0,
    close:  (c.closePrice ? c.closePrice.bid : c.close) || 0,
    ts:     c.snapshotTime || c.ts,
  };
}

// ── Signal Detection ─────────────────────────────────────────
// Erkennt Signale über 3 Methoden: EMA-Crossover, Trend-Continuation, RSI-Momentum
// Gibt { side: 'BUY'|'SELL'|null, entry, sl, tp, grund } zurück
function detectSignal(candles, rrr, atrSlFactor) {
  if (candles.length < 60) return { side: null, grund: 'Zu wenig Kerzen (' + candles.length + ')' };

  const norm   = candles.map(normalizeCandle);
  const closes = norm.map(function(c) { return c.close; });

  // EMA-Werte: aktuell + letzten 5 Kerzen für Crossover-Fenster
  const ema20now  = ema(closes, 20);
  const ema50now  = ema(closes, 50);
  const ema20p1   = ema(closes.slice(0, -1), 20);
  const ema50p1   = ema(closes.slice(0, -1), 50);
  const ema20p3   = ema(closes.slice(0, -3), 20);
  const ema50p3   = ema(closes.slice(0, -3), 50);
  const ema20p5   = ema(closes.slice(0, -5), 20);
  const ema50p5   = ema(closes.slice(0, -5), 50);

  if (!ema20now || !ema50now) return { side: null, grund: 'EMA Berechnung fehlgeschlagen' };

  const currentAtr = atr(candles, 14);
  if (!currentAtr || currentAtr <= 0) return { side: null, grund: 'ATR Berechnung fehlgeschlagen' };

  // ATR-Filter: 0.005% Minimum — filtert nur tote, völlig flache Märkte heraus
  const entry  = closes[closes.length - 1];
  const atrPct = currentAtr / entry * 100;
  if (atrPct < 0.005) {
    return { side: null, grund: 'ATR zu klein (' + atrPct.toFixed(3) + '%) — Markt zu flach' };
  }

  const rsiVal  = rsi(closes, 14);
  const rsiPrev = rsi(closes.slice(0, -1), 14);

  // ── Signal 1: EMA Crossover (letzten 5 Kerzen) ──────────────
  const crossBuy  = (ema20p5 <= ema50p5 && ema20now > ema50now) ||
                    (ema20p3 <= ema50p3 && ema20p1  > ema50p1);
  const crossSell = (ema20p5 >= ema50p5 && ema20now < ema50now) ||
                    (ema20p3 >= ema50p3 && ema20p1  < ema50p1);

  // ── Signal 2: Trend-Continuation (EMA-Richtung + RSI-Fenster) ─
  // EMA20 klar über EMA50 UND RSI in gesundem Kaufbereich → BUY
  const emaDeltaPct = Math.abs(ema20now - ema50now) / ema50now * 100;
  const trendBuy  = ema20now > ema50now && emaDeltaPct >= 0.01 &&
                    rsiVal && rsiVal >= 42 && rsiVal <= 63;
  const trendSell = ema20now < ema50now && emaDeltaPct >= 0.01 &&
                    rsiVal && rsiVal >= 37 && rsiVal <= 58;

  // ── Signal 3: RSI-Momentum (RSI überquert 50 in beide Richtungen) ─
  const rsiBuy  = rsiPrev && rsiVal && rsiPrev < 50 && rsiVal >= 50 && rsiVal < 68;
  const rsiSell = rsiPrev && rsiVal && rsiPrev > 50 && rsiVal <= 50 && rsiVal > 32;

  const signalBuy  = crossBuy  || trendBuy  || rsiBuy;
  const signalSell = crossSell || trendSell || rsiSell;

  // Beim Conflict (beide aktiv) → kein Trade
  if (signalBuy && signalSell) {
    return { side: null, grund: 'Widersprüchliche Signale — kein Trade' };
  }

  // Precision: 5 Dezimalstellen für Forex, 2 für Commodities/Indizes
  const prec = entry < 100 ? 5 : 2;
  const fmt  = (n) => parseFloat(n.toFixed(prec));

  if (signalBuy) {
    if (rsiVal && rsiVal > 72) return { side: null, grund: 'BUY geblockt — RSI overbought (' + rsiVal.toFixed(0) + ')' };
    const sl = fmt(entry - currentAtr * atrSlFactor);
    const tp = fmt(entry + (entry - sl) * rrr);
    const typ = crossBuy ? 'EMA-Crossover' : trendBuy ? 'Trend-Continuation' : 'RSI-Momentum';
    return {
      side: 'BUY', entry: fmt(entry), sl, tp,
      atr: parseFloat(currentAtr.toFixed(6)),
      rsi: rsiVal ? parseFloat(rsiVal.toFixed(1)) : null,
      ema20: parseFloat(ema20now.toFixed(6)),
      ema50: parseFloat(ema50now.toFixed(6)),
      grund: typ + ' BUY | RSI=' + (rsiVal ? rsiVal.toFixed(0) : '?') + ' | ATR=' + atrPct.toFixed(3) + '%',
    };
  }

  if (signalSell) {
    if (rsiVal && rsiVal < 28) return { side: null, grund: 'SELL geblockt — RSI oversold (' + rsiVal.toFixed(0) + ')' };
    const sl = fmt(entry + currentAtr * atrSlFactor);
    const tp = fmt(entry - (sl - entry) * rrr);
    const typ = crossSell ? 'EMA-Crossover' : trendSell ? 'Trend-Continuation' : 'RSI-Momentum';
    return {
      side: 'SELL', entry: fmt(entry), sl, tp,
      atr: parseFloat(currentAtr.toFixed(6)),
      rsi: rsiVal ? parseFloat(rsiVal.toFixed(1)) : null,
      ema20: parseFloat(ema20now.toFixed(6)),
      ema50: parseFloat(ema50now.toFixed(6)),
      grund: typ + ' SELL | RSI=' + (rsiVal ? rsiVal.toFixed(0) : '?') + ' | ATR=' + atrPct.toFixed(3) + '%',
    };
  }

  const trend = ema20now > ema50now ? 'bullisch' : 'bearisch';
  return { side: null, grund: 'Kein Signal — ' + trend + ' | RSI=' + (rsiVal ? rsiVal.toFixed(0) : '?') };
}

// ── Main Loop ─────────────────────────────────────────────────
class SignalGenerator {
  constructor(opts) {
    this.baseUrl       = opts.baseUrl;
    this.getHeaders    = opts.getHeaders;     // async fn(strategie) → headers
    this.ensureAuth    = opts.ensureAuth;     // async fn(strategie)
    this.addLog        = opts.addLog;         // fn(level, msg)
    this.strategie     = opts.strategie || 'mittel';
    this.port          = opts.port;
    this.rrr           = parseFloat(opts.rrr       || '2.0');
    this.atrSlFactor   = parseFloat(opts.atrSlFactor || '1.5');
    this.intervalMs    = parseInt(opts.intervalMs  || '60000', 10);
    this.epic          = opts.epic || 'GOLD';
    this.resolution    = opts.resolution || 'MINUTE';
    this.candleCount   = opts.candleCount || 100;
    this.secret        = opts.secret || '';
    this._timer        = null;
    this._running      = false;
    this._lastSignalTs = 0;
    this._cooldownMs   = 5 * 60 * 1000;  // 5 min zwischen Signalen
    this.autoRoute     = opts.autoRoute || false;
    this._stats        = { checks: 0, signals: 0, errors: 0, lastCheck: null, lastSignal: null };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.addLog('info', '[SigGen] Gestartet — Strategie: ' + this.strategie + ' | Epic: ' + this.epic + ' | RRR: ' + this.rrr + ' | Intervall: ' + (this.intervalMs/1000) + 's');
    this._schedule();
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.addLog('info', '[SigGen] Gestoppt');
  }

  status() {
    return Object.assign({}, this._stats, {
      running:    this._running,
      strategie:  this.strategie,
      epic:       this.epic,
      rrr:        this.rrr,
      intervalMs: this.intervalMs,
      cooldownRemainingMs: Math.max(0, this._cooldownMs - (Date.now() - this._lastSignalTs)),
    });
  }

  _schedule() {
    if (!this._running) return;
    this._timer = setTimeout(function() {
      this._tick().catch(function(err) {
        this.addLog('warn', '[SigGen] Fehler: ' + err.message);
        this._stats.errors++;
      }.bind(this)).finally(function() {
        this._schedule();
      }.bind(this));
    }.bind(this), this.intervalMs);
  }

  async _tick() {
    this._stats.checks++;
    this._stats.lastCheck = new Date().toISOString();

    // Auth sicherstellen
    try { await this.ensureAuth(this.strategie); } catch(e) {
      throw new Error('Auth fehlgeschlagen: ' + e.message);
    }

    // Kerzen holen
    const hdrs = await this.getHeaders(this.strategie);
    const res = await axios.get(this.baseUrl + '/prices/' + this.epic, {
      headers: hdrs,
      params:  { resolution: this.resolution, max: this.candleCount },
      timeout: 15000,
    });
    const candles = res.data.prices || [];
    if (candles.length < 55) {
      this.addLog('info', '[SigGen] Nur ' + candles.length + ' Kerzen — noch nicht genug');
      return;
    }

    // Signal erkennen
    const sig = detectSignal(candles, this.rrr, this.atrSlFactor);

    if (!sig.side) {
      this.addLog('info', '[SigGen] Kein Signal — ' + sig.grund);
      return;
    }

    // Cooldown prüfen
    const timeSinceLast = Date.now() - this._lastSignalTs;
    if (this._lastSignalTs > 0 && timeSinceLast < this._cooldownMs) {
      this.addLog('info', '[SigGen] Cooldown aktiv (' + Math.round((this._cooldownMs - timeSinceLast) / 1000) + 's) — Signal ignoriert');
      return;
    }

    // Signal an eigenen Webhook senden
    this.addLog('info', '[SigGen] Signal erkannt: ' + sig.side + ' | ' + sig.grund + ' | SL=' + sig.sl + ' TP=' + sig.tp + ' ATR=' + sig.atr);
    await this._fireWebhook(sig);
    this._lastSignalTs = Date.now();
    this._stats.signals++;
    this._stats.lastSignal = { ts: new Date().toISOString(), side: sig.side, grund: sig.grund };
  }

  async _fireWebhook(sig) {
    const payload = {
      side:    sig.side,
      sl:      sig.sl,
      tp:      sig.tp,
      epic:    this.epic,   // Welches Asset gehandelt werden soll
      secret:  this.secret,
      // Zusatz-Info fuer Logging
      _source:   'signal_generator',
      _epic:     this.epic,
      _strategie: this.strategie,
      _ema20:    sig.ema20,
      _ema50:    sig.ema50,
      _atr:      sig.atr,
      _rsi:      sig.rsi,
      _grund:    sig.grund,
    };
    // Wenn strategie 'auto' → Auto-Routing (jeder freie Bot kann es nehmen)
    // Wenn spezifisch → direkt an diese Strategie
    const endpoint = this.autoRoute ? 'auto' : this.strategie;
    const url = 'http://localhost:' + this.port + '/webhook/' + endpoint;
    try {
      const r = await axios.post(url, payload, { timeout: 30000 });
      this.addLog('info', '[SigGen] Webhook-Antwort (' + endpoint + '): ' + JSON.stringify(r.data));
    } catch(err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      this.addLog('warn', '[SigGen] Webhook-Fehler: ' + detail);
      throw err;
    }
  }
}

// ── Multi-Asset Scanner ──────────────────────────────────────────────────────
//
//  Scans a configurable list of instruments simultaneously.
//  Each instrument is checked independently; signals fire to their own webhooks.
//
//  Config (from server.js):
//    instruments: [
//      { epic: 'GOLD',   strategie: 'mittel',   rrr: 2.0, resolution: 'MINUTE', candleCount: 100 },
//      { epic: 'EURUSD', strategie: 'optimiert', rrr: 2.5, resolution: 'MINUTE_5', candleCount: 100 },
//      { epic: 'US500',  strategie: 'aggressiv', rrr: 2.0, resolution: 'MINUTE_15', candleCount: 100 },
//    ]
//
//  Environment override — comma-separated list of epics to scan:
//    SIGNAL_SCAN_EPICS=GOLD,EURUSD,US500
//    SIGNAL_SCAN_STRATEGIE=mittel   (used for all if not per-instrument)

class MultiAssetScanner {
  constructor(opts) {
    this.baseUrl      = opts.baseUrl;
    this.getHeaders   = opts.getHeaders;
    this.ensureAuth   = opts.ensureAuth;
    this.addLog       = opts.addLog;
    this.port         = opts.port;
    this.secret       = opts.secret || '';
    this.intervalMs   = parseInt(opts.intervalMs || '60000', 10);
    this.rrr          = parseFloat(opts.rrr       || '2.0');
    this.atrSlFactor  = parseFloat(opts.atrSlFactor || '1.5');
    this.cooldownMs   = 5 * 60 * 1000;

    // Strategies for round-robin distribution (passed from server.js)
    this.strategies   = opts.strategies || [];

    // Build instrument list from opts or env
    this.instruments  = this._buildInstrumentList(opts.instruments);

    this._generators  = [];
    this._running     = false;
    this._stats       = {};
  }

  _buildInstrumentList(provided) {
    // Env override takes precedence
    if (process.env.SIGNAL_SCAN_EPICS) {
      const epics    = process.env.SIGNAL_SCAN_EPICS.split(',').map(e => e.trim());
      const stratBase= process.env.SIGNAL_SCAN_STRATEGIE;
      const pool     = (this.strategies && this.strategies.length) ? this.strategies : (stratBase ? [stratBase] : ['stegosaurus']);
      const res      = process.env.SIGNAL_GEN_RESOLUTION || 'MINUTE';
      const candles  = parseInt(process.env.SIGNAL_GEN_CANDLES || '100', 10);
      return epics.map((epic, idx) => ({
        epic,
        // Round-robin across all available strategies — each epic gets its own strategy slot
        strategie:   pool[idx % pool.length],
        rrr:         this.rrr,
        resolution:  res,
        candleCount: candles,
      }));
    }
    // Default multi-asset list when nothing else is configured
    if (!provided || !provided.length) {
      const strat = process.env.SIGNAL_GEN_STRATEGIE || 'stegosaurus';
      const res   = process.env.SIGNAL_GEN_RESOLUTION || 'MINUTE';
      // If a single SIGNAL_GEN_EPIC is set, use that only (backwards compat)
      if (process.env.SIGNAL_GEN_EPIC) {
        return [{ epic: process.env.SIGNAL_GEN_EPIC, strategie: strat, rrr: this.rrr, resolution: res, candleCount: 100 }];
      }
      // Otherwise scan a broad default universe
      // Capital.com epic names — verified format (NO MT4 names like XAUUSD/BITCOIN/ETHEREUM)
      return [
        { epic: 'GOLD',       strategie: strat, rrr: 2.0, resolution: res,           candleCount: 100 },
        { epic: 'SILVER',     strategie: strat, rrr: 2.0, resolution: 'MINUTE_5',    candleCount: 100 },
        { epic: 'OIL_CRUDE',  strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
        { epic: 'EURUSD',     strategie: strat, rrr: 2.5, resolution: 'MINUTE_5',    candleCount: 100 },
        { epic: 'GBPUSD',     strategie: strat, rrr: 2.5, resolution: 'MINUTE_5',    candleCount: 100 },
        { epic: 'USDJPY',     strategie: strat, rrr: 2.5, resolution: 'MINUTE_5',    candleCount: 100 },
        { epic: 'AUDUSD',     strategie: strat, rrr: 2.5, resolution: 'MINUTE_5',    candleCount: 100 },
        { epic: 'US500',      strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
        { epic: 'US100',      strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
        { epic: 'DE40',       strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
        { epic: 'UK100',      strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
        { epic: 'BTCUSD',     strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
        { epic: 'ETHUSD',     strategie: strat, rrr: 2.0, resolution: 'MINUTE_15',   candleCount: 100 },
      ];
    }
    return provided;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.addLog('info', `[Scanner] Gestartet — ${this.instruments.length} Instrument(e): ${this.instruments.map(i => i.epic).join(', ')}`);

    // Create one SignalGenerator per instrument — staggered start to avoid rate limiting
    const STAGGER_MS = 8000; // 8s between each instrument start
    this._generators = this.instruments.map((inst, idx) => {
      const gen = new SignalGenerator({
        baseUrl:      this.baseUrl,
        getHeaders:   this.getHeaders,
        ensureAuth:   this.ensureAuth,
        addLog:       this.addLog,
        strategie:    inst.strategie,
        port:         this.port,
        rrr:          inst.rrr || this.rrr,
        atrSlFactor:  this.atrSlFactor,
        intervalMs:   this.intervalMs,
        epic:         inst.epic,
        resolution:   inst.resolution || 'MINUTE',
        candleCount:  inst.candleCount || 100,
        secret:       this.secret,
        autoRoute:    true,  // Signal geht an /webhook/auto → freier Bot übernimmt
      });
      this._stats[inst.epic] = { epic: inst.epic, strategie: inst.strategie };
      // Stagger: first instrument starts immediately, each subsequent one 8s later
      if (idx === 0) {
        gen.start();
      } else {
        setTimeout(() => { if (this._running) gen.start(); }, idx * STAGGER_MS);
      }
      return gen;
    });
  }

  stop() {
    this._running = false;
    this._generators.forEach(g => g.stop());
    this._generators = [];
    this.addLog('info', '[Scanner] Gestoppt');
  }

  status() {
    return {
      running:     this._running,
      instruments: this.instruments,
      generators:  this._generators.map(g => g.status()),
    };
  }

  /** Hot-add a new instrument without restarting */
  addInstrument(inst) {
    if (!this._running) { this.instruments.push(inst); return; }
    const gen = new SignalGenerator({
      baseUrl:     this.baseUrl,
      getHeaders:  this.getHeaders,
      ensureAuth:  this.ensureAuth,
      addLog:      this.addLog,
      strategie:   inst.strategie,
      port:        this.port,
      rrr:         inst.rrr || this.rrr,
      atrSlFactor: this.atrSlFactor,
      intervalMs:  this.intervalMs,
      epic:        inst.epic,
      resolution:  inst.resolution || 'MINUTE',
      candleCount: inst.candleCount || 100,
      secret:      this.secret,
      autoRoute:   true,
    });
    this.instruments.push(inst);
    this._generators.push(gen);
    gen.start();
    this.addLog('info', `[Scanner] Instrument hinzugefügt: ${inst.epic} → ${inst.strategie}`);
  }

  /** Hot-remove an instrument by epic */
  removeInstrument(epic) {
    const idx = this._generators.findIndex(g => g.epic === epic);
    if (idx === -1) return false;
    this._generators[idx].stop();
    this._generators.splice(idx, 1);
    this.instruments = this.instruments.filter(i => i.epic !== epic);
    this.addLog('info', `[Scanner] Instrument entfernt: ${epic}`);
    return true;
  }
}

module.exports = { SignalGenerator, MultiAssetScanner, detectSignal, ema, atr, rsi };
