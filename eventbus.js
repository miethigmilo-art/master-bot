// ══════════════════════════════════════════════════════════════
//  Master Bot — Event Bus (V1: in-process EventEmitter)
//
//  Zentrale Nervenbahn des Systems:
//  Market → signal-stream → risk-stream → execution-stream → Dashboard
//
//  API ist Redis-kompatibel — Upgrade auf Redis Streams ohne Code-Änderungen möglich.
//  Alle Events haben dasselbe Schema:
//  { id, correlationId, type, source, timestamp, payload }
// ══════════════════════════════════════════════════════════════
'use strict';

const { EventEmitter } = require('events');
const { randomUUID }   = require('crypto');

// ── Event Streams ──────────────────────────────────────────────────────────────
const STREAMS = {
  MARKET:    'market-stream',    // Marktdaten, Market Mode Changes
  SIGNAL:    'signal-stream',    // TradingView Signale eingehend
  RISK:      'risk-stream',      // Risk Engine Entscheidungen
  EXECUTION: 'execution-stream', // Order Placement + Results
  SYSTEM:    'system-stream',    // Health, Errors, AutoTune Events
};

// ── Event Types ────────────────────────────────────────────────────────────────
const EVENT_TYPES = {
  // market-stream
  MARKET_MODE_UPDATED: 'MARKET_MODE_UPDATED',
  PRICE_UPDATE:        'PRICE_UPDATE',

  // signal-stream
  SIGNAL_RECEIVED:     'SIGNAL_RECEIVED',  // Rohes TradingView Signal
  SIGNAL_ENRICHED:     'SIGNAL_ENRICHED',  // Signal + Equity + RRR

  // risk-stream
  RISK_APPROVED:       'RISK_APPROVED',    // Signal darf getraded werden
  RISK_REJECTED:       'RISK_REJECTED',    // Signal blockiert (mit Grund)
  RISK_SIZED:          'RISK_SIZED',       // Approved + berechnete Positionsgröße

  // execution-stream
  ORDER_PLACED:        'ORDER_PLACED',
  ORDER_FAILED:        'ORDER_FAILED',
  PNL_RECORDED:        'PNL_RECORDED',

  // system-stream
  AUTOTUNE_TRIGGERED:  'AUTOTUNE_TRIGGERED',
  SCORE_CHANGED:       'SCORE_CHANGED',
  ERROR:               'ERROR',
};

// ── Event Factory ──────────────────────────────────────────────────────────────
// correlationId: optional root-event ID that threads SIGNAL_RECEIVED -> ORDER_PLACED -> PNL_RECORDED
function createEvent(type, source, payload, correlationId) {
  if (payload === undefined) payload = {};
  if (correlationId === undefined) correlationId = null;
  return {
    id:            randomUUID(),
    correlationId: correlationId || (payload && payload.correlationId) || null,
    type,
    source,
    stream:        streamForType(type),
    timestamp:     Date.now(),
    payload,
  };
}

function streamForType(type) {
  if (['MARKET_MODE_UPDATED','PRICE_UPDATE'].includes(type))         return STREAMS.MARKET;
  if (['SIGNAL_RECEIVED','SIGNAL_ENRICHED'].includes(type))          return STREAMS.SIGNAL;
  if (['RISK_APPROVED','RISK_REJECTED','RISK_SIZED'].includes(type)) return STREAMS.RISK;
  if (['ORDER_PLACED','ORDER_FAILED','PNL_RECORDED'].includes(type)) return STREAMS.EXECUTION;
  return STREAMS.SYSTEM;
}

// ── Bus ────────────────────────────────────────────────────────────────────────
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._log    = [];      // Ring-Buffer fuer Debug/Replay
    this._maxLog = 500;
    this._stats  = {};      // { type: count }
  }

  // Publish ein Event auf den Bus
  publish(event) {
    // Ring-Buffer
    this._log.push(event);
    if (this._log.length > this._maxLog) this._log.shift();

    // Stats
    this._stats[event.type] = (this._stats[event.type] || 0) + 1;

    // Emit: nach Stream UND nach Typ — Subscriber koennen beides nutzen
    this.emit(event.stream, event);
    this.emit(event.type,   event);
    this.emit('*',          event);  // Wildcard fuer Logging/Dashboard
  }

  // Kurzform: Event erzeugen + direkt publishen
  // correlationId optional: trackt Signal durch alle Stages
  emit_event(type, source, payload, correlationId) {
    if (correlationId === undefined) correlationId = null;
    const event = createEvent(type, source, payload, correlationId);
    this.publish(event);
    return event;
  }

  // Alle Events mit gegebener correlationId aus dem Ring-Buffer (Audit Trace)
  trace(correlationId) {
    return this._log.filter(function(e) {
      return e.correlationId === correlationId || e.id === correlationId;
    });
  }

  // Stream abonnieren
  subscribe(streamOrType, handler) {
    this.on(streamOrType, handler);
    return function() { this.off(streamOrType, handler); }.bind(this);
  }

  // Letzten N Events aus dem Log (fuer Replay/Debug)
  replay(n) {
    if (n === undefined) n = 50;
    return this._log.slice(-n);
  }

  // Stats
  stats() {
    const s = Object.assign({}, this._stats);
    s.total = this._log.length;
    return s;
  }
}

// Singleton — einmal pro Prozess
const bus = new EventBus();

module.exports = {
  bus,
  STREAMS,
  EVENT_TYPES,
  createEvent,
};
