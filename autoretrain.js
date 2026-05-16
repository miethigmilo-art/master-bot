/**
 * autoretrain.js — HELIX Phase 7: Auto-Retraining Loop
 *
 * Monitors features.jsonl for new labeled samples.
 * When enough new samples have accumulated since the last retrain,
 * automatically triggers /retrain on the ML service.
 *
 * Features:
 *   - Configurable sample threshold (default: 50 new labeled samples)
 *   - Exponential backoff on failure (30s → 60s → 120s → max 30m)
 *   - Tracks retrain history (retrains.jsonl)
 *   - Emits an event on the bus after each retrain
 *   - REST API: GET /api/ml/retrain-status, POST /api/ml/retrain
 *
 * Usage in server.js:
 *   const AutoRetrain = require('./autoretrain');
 *   const retrainer = new AutoRetrain({ featuresPath, mlUrl, addLog, bus, EVENT_TYPES });
 *   retrainer.start();
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const RETRAIN_CFG = {
  NEW_SAMPLES_THRESHOLD: parseInt(process.env.ML_RETRAIN_THRESHOLD || '50', 10),
  CHECK_INTERVAL_MS:     parseInt(process.env.ML_RETRAIN_INTERVAL  || '300', 10) * 1000, // default 5 min
  MAX_BACKOFF_MS:        30 * 60 * 1000,  // 30 min
  MIN_LABELED_TOTAL:     parseInt(process.env.ML_RETRAIN_MIN_TOTAL || '30', 10),
};

class AutoRetrain {
  constructor(opts) {
    this.featuresPath  = opts.featuresPath;
    this.retrainPath   = opts.retrainPath || path.join(path.dirname(opts.featuresPath), 'retrains.jsonl');
    this.mlUrl         = opts.mlUrl;       // e.g. https://ml-service.up.railway.app
    this.addLog        = opts.addLog || console.log.bind(console);
    this.bus           = opts.bus || null;
    this.EVENT_TYPES   = opts.EVENT_TYPES || {};

    this._timer        = null;
    this._running      = false;
    this._backoffMs    = RETRAIN_CFG.CHECK_INTERVAL_MS;
    this._consecutiveErrors = 0;

    this._lastSampleCount = this._countLabeledSamples();
    this._lastRetrainAt   = this._loadLastRetrainTs();
    this._history         = [];
    this._status          = { phase: 'idle', lastCheck: null, lastRetrain: null, error: null };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.addLog('info', `[AutoRetrain] Gestartet — Schwelle: ${RETRAIN_CFG.NEW_SAMPLES_THRESHOLD} neue Samples | Intervall: ${RETRAIN_CFG.CHECK_INTERVAL_MS / 1000}s`);
    this._schedule();
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.addLog('info', '[AutoRetrain] Gestoppt');
  }

  status() {
    return {
      ...this._status,
      running:            this._running,
      mlUrl:              this.mlUrl,
      threshold:          RETRAIN_CFG.NEW_SAMPLES_THRESHOLD,
      intervalMs:         RETRAIN_CFG.CHECK_INTERVAL_MS,
      lastSampleCount:    this._lastSampleCount,
      currentSampleCount: this._countLabeledSamples(),
      newSinceLastRetrain: Math.max(0, this._countLabeledSamples() - this._lastSampleCount),
      history:            this._history.slice(-10),
    };
  }

  /** Trigger a retrain immediately (bypasses threshold check) */
  async triggerNow(strategie) {
    return this._doRetrain(strategie || 'all');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _schedule() {
    if (!this._running) return;
    this._timer = setTimeout(() => {
      this._tick()
        .then(() => { this._backoffMs = RETRAIN_CFG.CHECK_INTERVAL_MS; this._consecutiveErrors = 0; })
        .catch(err => {
          this._consecutiveErrors++;
          this._backoffMs = Math.min(RETRAIN_CFG.MAX_BACKOFF_MS, this._backoffMs * 2);
          this.addLog('warn', `[AutoRetrain] Fehler (${this._consecutiveErrors}): ${err.message} — Backoff: ${this._backoffMs / 1000}s`);
          this._status.error = err.message;
        })
        .finally(() => this._schedule());
    }, this._backoffMs);
  }

  async _tick() {
    this._status.lastCheck = new Date().toISOString();
    if (!this.mlUrl) {
      this._status.phase = 'no-ml-service';
      return;
    }

    const currentCount = this._countLabeledSamples();
    const newSamples   = currentCount - this._lastSampleCount;

    this.addLog('info', `[AutoRetrain] Check: ${currentCount} Samples total, ${newSamples} neu seit letztem Retrain`);

    if (currentCount < RETRAIN_CFG.MIN_LABELED_TOTAL) {
      this._status.phase = `warte auf Minimum (${currentCount}/${RETRAIN_CFG.MIN_LABELED_TOTAL})`;
      return;
    }

    if (newSamples < RETRAIN_CFG.NEW_SAMPLES_THRESHOLD) {
      this._status.phase = `warte auf Schwelle (${newSamples}/${RETRAIN_CFG.NEW_SAMPLES_THRESHOLD})`;
      return;
    }

    this.addLog('info', `[AutoRetrain] Schwelle erreicht (${newSamples} neue Samples) → Starte Retrain`);
    await this._doRetrain('all');
    this._lastSampleCount = currentCount;
  }

  async _doRetrain(strategie) {
    this._status.phase = 'retraining';
    const startTs = Date.now();

    try {
      const result = await this._httpPost(`${this.mlUrl}/retrain`, { strategie });
      const durationMs = Date.now() - startTs;

      const entry = {
        ts:          new Date().toISOString(),
        strategie,
        durationMs,
        samplesUsed: this._countLabeledSamples(),
        result,
      };
      this._history.push(entry);
      this._lastRetrainAt = entry.ts;
      this._status.lastRetrain = entry.ts;
      this._status.phase = 'idle';
      this._status.error = null;

      // Persist to retrains.jsonl
      try { fs.appendFileSync(this.retrainPath, JSON.stringify(entry) + '\n'); } catch {}

      // Emit event on bus
      if (this.bus && this.EVENT_TYPES.AUTOTUNE_TRIGGERED) {
        this.bus.emit_event(this.EVENT_TYPES.AUTOTUNE_TRIGGERED, 'autoretrain', {
          type: 'ML_RETRAIN', strategie, durationMs, result,
        });
      }

      this.addLog('info', `[AutoRetrain] ✅ Retrain abgeschlossen (${durationMs}ms): ${JSON.stringify(result).slice(0, 120)}`);
      return entry;

    } catch (err) {
      this._status.phase = 'idle';
      this._status.error = err.message;
      this.addLog('warn', `[AutoRetrain] ❌ Retrain fehlgeschlagen: ${err.message}`);
      throw err;
    }
  }

  _countLabeledSamples() {
    if (!fs.existsSync(this.featuresPath)) return 0;
    try {
      const content = fs.readFileSync(this.featuresPath, 'utf8');
      const lines   = content.split('\n').filter(Boolean);
      let count = 0;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.label != null) count++;
        } catch {}
      }
      return count;
    } catch { return 0; }
  }

  _loadLastRetrainTs() {
    if (!fs.existsSync(this.retrainPath)) return null;
    try {
      const lines = fs.readFileSync(this.retrainPath, 'utf8').trim().split('\n').filter(Boolean);
      if (!lines.length) return null;
      const last = JSON.parse(lines[lines.length - 1]);
      return last.ts || null;
    } catch { return null; }
  }

  _httpPost(url, body) {
    return new Promise((resolve, reject) => {
      const data    = JSON.stringify(body);
      const parsed  = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const opts    = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + (parsed.search || ''),
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout:  120_000,
      };
      const lib = isHttps ? https : http;
      const req = lib.request(opts, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve({ raw: body, status: res.statusCode }); }
        });
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
      req.write(data);
      req.end();
    });
  }
}

module.exports = { AutoRetrain, RETRAIN_CFG };
