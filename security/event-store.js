'use strict';
// ── HELIX Security Layer 4: Event Store (Replayability) ──────────────────────
// All critical events are appended to data/events.jsonl as JSON-Lines.
// Supports replay, filtering, and correlationId-based trace retrieval.

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const EVENT_STORE_PATH = path.join(__dirname, '..', 'data', 'events.jsonl');

const EVENT_TYPES = {
  SIGNAL_IN:               'SIGNAL_IN',
  ORDER_PLACED:            'ORDER_PLACED',
  ORDER_FILLED:            'ORDER_FILLED',
  ORDER_REJECTED:          'ORDER_REJECTED',
  PNL_BOOKED:              'PNL_BOOKED',
  KILL_SWITCH_ACTIVATED:   'KILL_SWITCH_ACTIVATED',
  KILL_SWITCH_DEACTIVATED: 'KILL_SWITCH_DEACTIVATED',
  WEBHOOK_DUPLICATE:       'WEBHOOK_DUPLICATE',
  ORDER_VALIDATION_FAILED: 'ORDER_VALIDATION_FAILED',
};

class EventStore {
  constructor(filePath) {
    this._path = filePath || EVENT_STORE_PATH;
    // Ensure the data directory exists
    const dir = path.dirname(this._path);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  /**
   * Append a new event to the store.
   * @param {string} type          - one of EVENT_TYPES
   * @param {object} payload       - event data
   * @param {string} correlationId - links events belonging to the same order chain
   * @returns {object} the stored event
   */
  async append(type, payload, correlationId) {
    const event = {
      id:            randomUUID(),
      ts:            Date.now(),
      type,
      payload:       payload || {},
      correlationId: correlationId || null,
    };
    try {
      fs.appendFileSync(this._path, JSON.stringify(event) + '\n');
    } catch (err) {
      console.error('[EventStore] append error:', err.message);
    }
    return event;
  }

  /**
   * Read and optionally filter events within a time range.
   * @param {number} fromTs - Unix ms, inclusive (0 = beginning)
   * @param {number} toTs   - Unix ms, inclusive (Infinity = now)
   * @param {string} type   - optional type filter
   * @returns {Promise<object[]>}
   */
  async replay(fromTs, toTs, type) {
    fromTs = fromTs || 0;
    toTs   = toTs   || Date.now();
    try {
      if (!fs.existsSync(this._path)) return [];
      const lines  = fs.readFileSync(this._path, 'utf8').split('\n').filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.ts < fromTs || ev.ts > toTs) continue;
          if (type && ev.type !== type) continue;
          events.push(ev);
        } catch {}
      }
      return events;
    } catch (err) {
      console.error('[EventStore] replay error:', err.message);
      return [];
    }
  }

  /**
   * Get all events belonging to an order chain (by correlationId).
   * @param {string} correlationId
   * @returns {Promise<object[]>}
   */
  async getByCorrelationId(correlationId) {
    if (!correlationId) return [];
    try {
      if (!fs.existsSync(this._path)) return [];
      const lines  = fs.readFileSync(this._path, 'utf8').split('\n').filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.correlationId === correlationId) events.push(ev);
        } catch {}
      }
      return events;
    } catch (err) {
      console.error('[EventStore] getByCorrelationId error:', err.message);
      return [];
    }
  }
}

const eventStore = new EventStore();

module.exports = { EventStore, eventStore, EVENT_TYPES };
