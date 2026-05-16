// ══════════════════════════════════════════════════════════════
//  Master Bot — System Hardening Module
//
//  1. Circuit Breaker  — ML-Service + Capital.com API
//  2. Signal Dedup     — verhindert Doppel-Trades durch
//                        gleiche Signale in kurzer Zeit
//  3. State Validator  — prüft State-Konsistenz vor jedem Trade
//  4. Metrics          — zählt Fehler, Latenz, Trigger-Rate
// ══════════════════════════════════════════════════════════════
'use strict';

// ── Circuit Breaker ────────────────────────────────────────────
// States: CLOSED (normal) → OPEN (fehler) → HALF_OPEN (probe)
class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name          = name;
    this.threshold     = opts.threshold  || 5;    // Fehler bis OPEN
    this.resetMs       = opts.resetMs    || 60000; // ms bis HALF_OPEN
    this.timeoutMs     = opts.timeoutMs  || 5000;  // Einzel-Call Timeout
    this._state        = 'CLOSED';
    this._failures     = 0;
    this._lastFailure  = null;
    this._successAfterHalf = 0;
  }

  get state() { return this._state; }
  get isOpen() { return this._state === 'OPEN'; }

  async call(fn) {
    // OPEN → prüfen ob Reset-Zeit abgelaufen
    if (this._state === 'OPEN') {
      const elapsed = Date.now() - this._lastFailure;
      if (elapsed < this.resetMs) {
        const err = new Error(`CircuitBreaker [${this.name}] OPEN — ${Math.round((this.resetMs - elapsed) / 1000)}s bis Probe`);
        err.circuitOpen = true;
        throw err;
      }
      this._state = 'HALF_OPEN';
    }

    // Timeout-Wrapper
    const withTimeout = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout nach ${this.timeoutMs}ms`)), this.timeoutMs);
      Promise.resolve(fn()).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
    });

    try {
      const result = await withTimeout;
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _onSuccess() {
    this._failures = 0;
    if (this._state === 'HALF_OPEN') {
      this._state = 'CLOSED';
    }
  }

  _onFailure(err) {
    this._failures++;
    this._lastFailure = Date.now();
    if (this._failures >= this.threshold || this._state === 'HALF_OPEN') {
      this._state = 'OPEN';
    }
  }

  status() {
    return {
      name:     this.name,
      state:    this._state,
      failures: this._failures,
      lastFailure: this._lastFailure ? new Date(this._lastFailure).toISOString() : null,
    };
  }
}

// ── Signal Deduplication ───────────────────────────────────────
// Verhindert dass dasselbe Signal innerhalb von TTL_MS zweimal
// verarbeitet wird (z.B. TradingView schickt manchmal doppelt)
class SignalDedup {
  constructor(ttlMs = 10000) {
    this._seen  = new Map(); // hash → timestamp
    this._ttlMs = ttlMs;
  }

  // Gibt true zurück wenn das Signal ein Duplikat ist
  isDuplicate(strategie, side, sl, tp) {
    this._cleanup();
    const key = `${strategie}:${side}:${sl}:${tp}`;
    if (this._seen.has(key)) return true;
    this._seen.set(key, Date.now());
    return false;
  }

  _cleanup() {
    const now = Date.now();
    for (const [k, ts] of this._seen) {
      if (now - ts > this._ttlMs) this._seen.delete(k);
    }
  }

  status() {
    return { tracked: this._seen.size, ttlMs: this._ttlMs };
  }
}

// ── Metrics Collector ─────────────────────────────────────────
// Zählt Ereignisse und berechnet gleitende Durchschnitte
class Metrics {
  constructor() {
    this._counters  = {};   // { key: count }
    this._latencies = {};   // { key: [ms, ms, ...] } — letzte 20
    this._errors    = {};   // { key: [{ ts, msg }, ...] } — letzte 10
  }

  inc(key, n = 1) {
    this._counters[key] = (this._counters[key] || 0) + n;
  }

  timing(key, ms) {
    if (!this._latencies[key]) this._latencies[key] = [];
    this._latencies[key].push(ms);
    if (this._latencies[key].length > 20) this._latencies[key].shift();
  }

  error(key, msg) {
    if (!this._errors[key]) this._errors[key] = [];
    this._errors[key].push({ ts: new Date().toISOString(), msg: String(msg).slice(0, 200) });
    if (this._errors[key].length > 10) this._errors[key].shift();
    this.inc(`${key}_errors`);
  }

  avgLatency(key) {
    const arr = this._latencies[key];
    if (!arr || !arr.length) return null;
    return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
  }

  snapshot() {
    const result = { counters: { ...this._counters }, latencies: {}, recentErrors: {} };
    for (const k of Object.keys(this._latencies)) {
      result.latencies[k] = { avg: this.avgLatency(k), samples: this._latencies[k].length };
    }
    for (const k of Object.keys(this._errors)) {
      result.recentErrors[k] = this._errors[k];
    }
    return result;
  }
}

// ── State Validator ───────────────────────────────────────────
// Prüft vor jedem Trade ob der State konsistent ist
class StateValidator {
  validate(name, state) {
    const issues = [];
    const { settings, performance, equity } = state;

    if (!settings) issues.push('settings fehlen');
    if (!performance) issues.push('performance fehlen');
    if (equity == null || isNaN(equity)) issues.push(`equity ungültig: ${equity}`);
    if (equity < 0) issues.push(`equity negativ: ${equity}`);
    if (settings?.riskPct <= 0 || settings?.riskPct > 20) issues.push(`riskPct außerhalb Range: ${settings?.riskPct}`);
    if (settings?.startEquity <= 0) issues.push(`startEquity ungültig: ${settings?.startEquity}`);

    return { valid: issues.length === 0, issues };
  }
}

// ── Singleton Exports ─────────────────────────────────────────
const breakers = {
  ml:      new CircuitBreaker('ml-service',   { threshold: 3, resetMs: 30000, timeoutMs: 5000 }),
  broker:  new CircuitBreaker('capital-com',  { threshold: 5, resetMs: 60000, timeoutMs: 8000 }),
};

const dedup   = new SignalDedup(15000);  // 15s Dedup-Fenster
const metrics = new Metrics();
const validator = new StateValidator();

module.exports = { CircuitBreaker, SignalDedup, Metrics, StateValidator, breakers, dedup, metrics, validator };
