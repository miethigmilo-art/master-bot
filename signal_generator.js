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
// Erkennt EMA(20/50) Crossover mit ATR und RSI Filter
// Gibt { side: 'BUY'|'SELL'|null, entry, sl, tp, grund } zurück
function detectSignal(candles, rrr, atrSlFactor) {
  if (candles.length < 60) return { side: null, grund: 'Zu wenig Kerzen (' + candles.length + ')' };

  const norm   = candles.map(normalizeCandle);
  const closes = norm.map(function(c) { return c.close; });

  // Aktuelle und vorherige EMA-Werte für Crossover-Erkennung
  const closesNow  = closes;
  const closesPrev = closes.slice(0, -1);

  const ema20now  = ema(closesNow,  20);
  const ema50now  = ema(closesNow,  50);
  const ema20prev = ema(closesPrev, 20);
  const ema50prev = ema(closesPrev, 50);

  if (!ema20now || !ema50now || !ema20prev || !ema50prev) {
    return { side: null, grund: 'EMA Berechnung fehlgeschlagen' };
  }

  const currentAtr = atr(candles, 14);
  if (!currentAtr || currentAtr <= 0) {
    return { side: null, grund: 'ATR Berechnung fehlgeschlagen' };
  }

  // ATR als Volatilitaets-Filter: mindestens 0.05% des Preises
  const entry = closes[closes.length - 1];
  const atrPct = currentAtr / entry * 100;
  if (atrPct < 0.05) {
    return { side: null, grund: 'ATR zu klein (' + atrPct.toFixed(3) + '%) — kein klarer Markt' };
  }

  const rsiVal = rsi(closes, 14);

  // EMA Crossover Erkennung
  const crossBuy  = ema20prev <= ema50prev && ema20now > ema50now;  // EMA20 kreuzt EMA50 von unten
  const crossSell = ema20prev >= ema50prev && ema20now < ema50now;  // EMA20 kreuzt EMA50 von oben

  // RSI Filter: kein Overbought bei BUY, kein Oversold bei SELL
  if (crossBuy) {
    if (rsiVal && rsiVal > 75) return { side: null, grund: 'BUY-Signal aber RSI overbought (' + rsiVal.toFixed(0) + ')' };
    const sl = parseFloat((entry - currentAtr * atrSlFactor).toFixed(2));
    const tp = parseFloat((entry + (entry - sl) * rrr).toFixed(2));
    return {
      side:  'BUY',
      entry: parseFloat(entry.toFixed(2)),
      sl, tp,
      atr:   parseFloat(currentAtr.toFixed(4)),
      rsi:   rsiVal ? parseFloat(rsiVal.toFixed(1)) : null,
      ema20: parseFloat(ema20now.toFixed(4)),
      ema50: parseFloat(ema50now.toFixed(4)),
      grund: 'EMA20(' + ema20now.toFixed(2) + ') kreuzt EMA50(' + ema50now.toFixed(2) + ') aufwaerts',
    };
  }

  if (crossSell) {
    if (rsiVal && rsiVal < 25) return { side: null, grund: 'SELL-Signal aber RSI oversold (' + rsiVal.toFixed(0) + ')' };
    const sl = parseFloat((entry + currentAtr * atrSlFactor).toFixed(2));
    const tp = parseFloat((entry - (sl - entry) * rrr).toFixed(2));
    return {
      side:  'SELL',
      entry: parseFloat(entry.toFixed(2)),
      sl, tp,
      atr:   parseFloat(currentAtr.toFixed(4)),
      rsi:   rsiVal ? parseFloat(rsiVal.toFixed(1)) : null,
      ema20: parseFloat(ema20now.toFixed(4)),
      ema50: parseFloat(ema50now.toFixed(4)),
      grund: 'EMA20(' + ema20now.toFixed(2) + ') kreuzt EMA50(' + ema50now.toFixed(2) + ') abwaerts',
    };
  }

  // Kein Crossover — nur Status zurückgeben
  const trend = ema20now > ema50now ? 'EMA20>EMA50 (bullisch)' : 'EMA20<EMA50 (bearisch)';
  return { side: null, grund: 'Kein Crossover — ' + trend + ' | RSI=' + (rsiVal ? rsiVal.toFixed(0) : '?') };
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
      side:   sig.side,
      sl:     sig.sl,
      tp:     sig.tp,
      secret: this.secret,
      // Zusatz-Info fuer Logging
      _source: 'signal_generator',
      _ema20:  sig.ema20,
      _ema50:  sig.ema50,
      _atr:    sig.atr,
      _rsi:    sig.rsi,
    };
    const url = 'http://localhost:' + this.port + '/webhook/' + this.strategie;
    try {
      const r = await axios.post(url, payload, { timeout: 30000 });
      this.addLog('info', '[SigGen] Webhook-Antwort: ' + JSON.stringify(r.data));
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

    // Build instrument list from opts or env
    this.instruments  = this._buildInstrumentList(opts.instruments);

    this._generators  = [];
    this._running     = false;
    this._stats       = {};
  }

  _buildInstrumentList(provided) {
    // Env override takes precedence
    if (process.env.SIGNAL_SCAN_EPICS) {
      const stratBase = process.env.SIGNAL_SCAN_STRATEGIE || 'stegosaurus';
      return process.env.SIGNAL_SCAN_EPICS.split(',').map(epic => ({
        epic:        epic.trim(),
        strategie:   stratBase,
        rrr:         this.rrr,
        resolution:  process.env.SIGNAL_GEN_RESOLUTION || 'MINUTE',
        candleCount: parseInt(process.env.SIGNAL_GEN_CANDLES || '100', 10),
      }));
    }
    // Default: single gold instrument (backwards compat)
    if (!provided || !provided.length) {
      return [{
        epic:        process.env.SIGNAL_GEN_EPIC || 'GOLD',
        strategie:   process.env.SIGNAL_GEN_STRATEGIE || 'stegosaurus',
        rrr:         this.rrr,
        resolution:  process.env.SIGNAL_GEN_RESOLUTION || 'MINUTE',
        candleCount: 100,
      }];
    }
    return provided;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.addLog('info', `[Scanner] Gestartet — ${this.instruments.length} Instrument(e): ${this.instruments.map(i => i.epic).join(', ')}`);

    // Create one SignalGenerator per instrument
    this._generators = this.instruments.map(inst => {
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
      });
      this._stats[inst.epic] = { epic: inst.epic, strategie: inst.strategie };
      gen.start();
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
