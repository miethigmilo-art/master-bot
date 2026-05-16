/**
 * replay.js — HELIX Phase 9: Replay Engine
 *
 * Reconstructs a complete trade timeline from the correlationId audit trail.
 * Reads events from the EventBus audit log and the DB, groups them by
 * correlationId, and renders a structured timeline with timing deltas.
 *
 * API endpoints (mounted in server.js):
 *   GET  /api/replay/:correlationId   → full timeline for one trade
 *   GET  /api/replay                  → list of replayable correlationIds
 *   POST /api/replay/simulate         → dry-run: replay signal through current logic
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Timeline Builder ────────────────────────────────────────────────────────

/**
 * buildTimeline(events)
 *
 * events: Event[] sorted by timestamp (ascending)
 * Each event: { id, type, source, timestamp, payload, correlationId }
 *
 * Returns:
 * {
 *   correlationId,
 *   strategie,
 *   epic,
 *   side,
 *   startTs,   // ms since epoch
 *   endTs,
 *   durationMs,
 *   stages: [{ type, source, ts, deltaMs, payload }],
 *   outcome: 'WIN' | 'LOSS' | 'UNKNOWN',
 *   pnl: number | null,
 * }
 */
function buildTimeline(events) {
  if (!events || events.length === 0) return null;

  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.timestamp || a.ts).getTime();
    const tb = new Date(b.timestamp || b.ts).getTime();
    return ta - tb;
  });

  const first  = sorted[0];
  const last   = sorted[sorted.length - 1];
  const startTs = new Date(first.timestamp || first.ts).getTime();
  const endTs   = new Date(last.timestamp  || last.ts).getTime();

  const stages = sorted.map(ev => {
    const ts       = new Date(ev.timestamp || ev.ts).getTime();
    const deltaMs  = ts - startTs;
    return {
      type:    ev.type,
      source:  ev.source || 'unknown',
      ts:      new Date(ts).toISOString(),
      deltaMs,
      payload: ev.payload || {},
    };
  });

  // Extract key fields from SIGNAL_RECEIVED stage
  const sigRec = stages.find(s => s.type === 'SIGNAL_RECEIVED');
  const ordPla = stages.find(s => s.type === 'ORDER_PLACED');
  const pnlRec = stages.find(s => s.type === 'PNL_RECORDED');

  const strategie = sigRec?.payload?.strategie || first.payload?.strategie || '?';
  const epic      = sigRec?.payload?.epic      || ordPla?.payload?.epic     || 'GOLD';
  const side      = sigRec?.payload?.side      || ordPla?.payload?.side     || '?';
  const pnl       = pnlRec?.payload?.pnl ?? null;

  let outcome = 'UNKNOWN';
  if (pnl !== null) outcome = pnl > 0 ? 'WIN' : 'LOSS';

  return {
    correlationId: first.correlationId || first.id,
    strategie,
    epic,
    side,
    startTs,
    endTs,
    durationMs: endTs - startTs,
    stages,
    outcome,
    pnl,
  };
}

// ── Audit Log Reader ────────────────────────────────────────────────────────

/**
 * loadAuditEvents(auditPath, limit)
 *
 * Reads newline-delimited JSON from the audit log file.
 * Returns events as an array, most recent first.
 */
function loadAuditEvents(auditPath, limit) {
  limit = limit || 5000;
  if (!fs.existsSync(auditPath)) return [];
  try {
    const lines = fs.readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    // Most recent first
    return events.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// ── Group by correlationId ──────────────────────────────────────────────────

function groupByCorrelationId(events) {
  const map = {};
  for (const ev of events) {
    const cid = ev.correlationId || ev.payload?.correlationId;
    if (!cid) continue;
    if (!map[cid]) map[cid] = [];
    map[cid].push(ev);
  }
  return map;
}

// ── Replay Engine ───────────────────────────────────────────────────────────

class ReplayEngine {
  constructor(opts) {
    this.auditPath = opts.auditPath;   // path to audit.jsonl
    this.db        = opts.db || null;  // optional DB module
    this.addLog    = opts.addLog || console.log.bind(console);
  }

  /** Returns list of available correlationIds with summary info */
  async listReplays(limit) {
    limit = limit || 200;
    const events  = loadAuditEvents(this.auditPath, 10000);
    const grouped = groupByCorrelationId(events);
    const summaries = [];

    for (const [cid, evs] of Object.entries(grouped)) {
      const tl = buildTimeline(evs);
      if (!tl) continue;
      summaries.push({
        correlationId: cid,
        strategie:     tl.strategie,
        epic:          tl.epic,
        side:          tl.side,
        startTs:       tl.startTs,
        durationMs:    tl.durationMs,
        stageCount:    tl.stages.length,
        outcome:       tl.outcome,
        pnl:           tl.pnl,
      });
    }

    // Sort newest first
    summaries.sort((a, b) => b.startTs - a.startTs);
    return summaries.slice(0, limit);
  }

  /** Returns full timeline for a single correlationId */
  async getTimeline(correlationId) {
    const events  = loadAuditEvents(this.auditPath, 10000);
    const grouped = groupByCorrelationId(events);
    const evs     = grouped[correlationId];

    if (!evs || evs.length === 0) {
      // Try DB fallback
      if (this.db && this.db.getEventsByCorrelationId) {
        const dbEvs = await this.db.getEventsByCorrelationId(correlationId).catch(() => []);
        if (dbEvs.length) return buildTimeline(dbEvs);
      }
      return null;
    }

    return buildTimeline(evs);
  }

  /**
   * simulate(signal, handlerFn)
   *
   * Dry-run: feeds a historical signal through handlerFn (the webhook handler)
   * with a mock request/response to see what the bot would decide today.
   *
   * signal: { strategie, side, sl, tp, epic }
   * handlerFn: async (req, res, name) — the handleWebhook function
   *
   * Returns the response body without touching real orders.
   */
  async simulate(signal, handlerFn) {
    let responseBody = null;
    const mockReq = {
      body: { ...signal, _replay: true },
    };
    const mockRes = {
      status(code) { this._status = code; return this; },
      json(body)   { responseBody = { ...body, _httpStatus: this._status || 200 }; return this; },
      _status: 200,
    };

    try {
      await handlerFn(mockReq, mockRes, signal.strategie);
    } catch (err) {
      return { error: err.message, _replay: true };
    }

    return responseBody || { _replay: true, _noResponse: true };
  }
}

// ── Express Router Factory ──────────────────────────────────────────────────

/**
 * createReplayRouter(engine, handleWebhook)
 *
 * Returns an Express router with replay endpoints.
 * Mount with: app.use('/api/replay', createReplayRouter(engine, handleWebhook))
 */
function createReplayRouter(engine, handleWebhook) {
  const router = require('express').Router();

  // GET /api/replay — list replayable correlationIds
  router.get('/', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '100', 10);
      const list  = await engine.listReplays(limit);
      res.json({ count: list.length, replays: list });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/replay/:correlationId — full timeline
  router.get('/:correlationId', async (req, res) => {
    try {
      const tl = await engine.getTimeline(req.params.correlationId);
      if (!tl) return res.status(404).json({ error: 'Correlation ID nicht gefunden' });
      res.json(tl);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/replay/simulate — dry-run signal through current bot logic
  router.post('/simulate', async (req, res) => {
    try {
      const signal = req.body;
      if (!signal.strategie || !signal.side || !signal.sl || !signal.tp)
        return res.status(400).json({ error: 'Fehlende Felder: strategie, side, sl, tp' });
      const result = await engine.simulate(signal, handleWebhook);
      res.json({ _simulated: true, input: signal, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { ReplayEngine, createReplayRouter, buildTimeline, loadAuditEvents, groupByCorrelationId };
