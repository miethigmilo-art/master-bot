/**
 * recovery.js — HELIX Phase 10: Snapshot Recovery + Order Reconciliation
 *
 * Provides:
 *   1. State snapshots every 60s → data/snapshot.json
 *   2. On startup: reconcile open positions at broker vs. local state
 *   3. Event deduplication via persistent seen-IDs set
 *
 * Exported:
 *   startSnapshotLoop(opts)     — begin periodic snapshotting
 *   reconcileOnStartup(opts)    — call once at startup before accepting webhooks
 *   deduplicator(opts)          — returns isDuplicate(eventId) fn + cleanup loop
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Snapshot ────────────────────────────────────────────────────────────────

/**
 * startSnapshotLoop(opts)
 *
 * opts.snapshotPath  — where to write snapshot.json
 * opts.getState      — fn() returning the current serialisable state object
 * opts.addLog        — fn(level, msg)
 * opts.intervalMs    — default 60_000
 *
 * Returns a stop() function.
 */
function startSnapshotLoop(opts) {
  const { snapshotPath, getState, addLog } = opts;
  const intervalMs = opts.intervalMs || 60_000;

  let timer = null;

  function snap() {
    try {
      const state = getState();
      state._snapshotTs = new Date().toISOString();
      fs.writeFileSync(snapshotPath, JSON.stringify(state, null, 2));
    } catch (err) {
      addLog('warn', `[Recovery] Snapshot-Fehler: ${err.message}`);
    }
  }

  function schedule() {
    timer = setTimeout(function() {
      snap();
      schedule();
    }, intervalMs);
  }

  // Write immediately on first call
  snap();
  schedule();
  addLog('info', `[Recovery] Snapshot-Loop gestartet → ${snapshotPath} (${intervalMs / 1000}s)`);

  return function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    addLog('info', '[Recovery] Snapshot-Loop gestoppt');
  };
}

/**
 * loadSnapshot(snapshotPath)
 *
 * Returns the last saved snapshot or null.
 */
function loadSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/**
 * reconcileOnStartup(opts)
 *
 * Compares open positions at the broker (via broker adapter) with the
 * last saved snapshot. Logs discrepancies and optionally auto-closes
 * orphaned positions (positions at broker with no matching local trade).
 *
 * opts.broker          — BrokerAdapter instance
 * opts.konten          — { [name]: {} } strategy accounts
 * opts.snapshotPath    — path to snapshot.json
 * opts.addLog          — fn(level, msg)
 * opts.autoCloseOrphans — boolean, default false (safe)
 *
 * Returns: { reconciled: [], orphans: [], errors: [] }
 */
async function reconcileOnStartup(opts) {
  const { broker, konten, addLog } = opts;
  const autoClose   = opts.autoCloseOrphans || false;
  const snapshot    = loadSnapshot(opts.snapshotPath);
  const result      = { reconciled: [], orphans: [], errors: [] };

  addLog('info', '[Recovery] Starte Reconciliation...');

  for (const name of Object.keys(konten)) {
    try {
      const brokerPositions = await broker.getPositions(name);

      if (!brokerPositions.length) {
        addLog('info', `[Recovery] ${name}: keine offenen Positionen beim Broker`);
        continue;
      }

      // Find positions we know about from snapshot
      const knownTrades = snapshot?.tradeHistory?.[name] || [];
      const knownDealIds = new Set(knownTrades.map(t => t.dealId).filter(Boolean));

      for (const pos of brokerPositions) {
        if (knownDealIds.has(pos.dealId)) {
          addLog('info', `[Recovery] ${name}: ${pos.dealId} bekannt ✓ (${pos.epic} ${pos.direction})`);
          result.reconciled.push({ name, ...pos });
        } else {
          addLog('warn', `[Recovery] ${name}: ORPHAN ${pos.dealId} (${pos.epic} ${pos.direction} size=${pos.size}) — nicht im Snapshot`);
          result.orphans.push({ name, ...pos });

          if (autoClose) {
            try {
              await broker.cancelOrder(name, pos.dealId);
              addLog('warn', `[Recovery] ${name}: Orphan ${pos.dealId} automatisch geschlossen`);
            } catch (closeErr) {
              addLog('error', `[Recovery] ${name}: Orphan-Close fehlgeschlagen: ${closeErr.message}`);
              result.errors.push({ name, dealId: pos.dealId, error: closeErr.message });
            }
          }
        }
      }
    } catch (err) {
      addLog('warn', `[Recovery] ${name}: Reconciliation-Fehler: ${err.message}`);
      result.errors.push({ name, error: err.message });
    }
  }

  addLog('info', `[Recovery] Reconciliation abgeschlossen — Bekannt: ${result.reconciled.length} | Orphans: ${result.orphans.length} | Fehler: ${result.errors.length}`);
  return result;
}

// ── Event Deduplication ─────────────────────────────────────────────────────

/**
 * deduplicator(opts)
 *
 * Prevents the same event (by id) from being processed twice.
 * Uses an in-memory Set with a persistent backing file for cross-restart safety.
 *
 * opts.dedupPath   — path to dedup.json
 * opts.maxAge      — ms to keep event IDs (default: 24h)
 * opts.addLog      — fn(level, msg)
 *
 * Returns { isDuplicate(id), markSeen(id), stop() }
 */
function deduplicator(opts) {
  const dedupPath = opts.dedupPath;
  const maxAge    = opts.maxAge || 24 * 60 * 60 * 1000;
  const addLog    = opts.addLog || (() => {});

  // { id: seenAtMs }
  let seen = {};

  // Load from disk
  if (dedupPath && fs.existsSync(dedupPath)) {
    try {
      seen = JSON.parse(fs.readFileSync(dedupPath, 'utf8'));
    } catch {}
  }

  function persist() {
    if (!dedupPath) return;
    try { fs.writeFileSync(dedupPath, JSON.stringify(seen)); } catch {}
  }

  function evict() {
    const cutoff = Date.now() - maxAge;
    let evicted = 0;
    for (const id of Object.keys(seen)) {
      if (seen[id] < cutoff) { delete seen[id]; evicted++; }
    }
    if (evicted) persist();
  }

  // Evict stale entries every 10 minutes
  const evictTimer = setInterval(evict, 10 * 60 * 1000);
  evict(); // once on startup

  return {
    isDuplicate(id) {
      return Object.prototype.hasOwnProperty.call(seen, id);
    },
    markSeen(id) {
      seen[id] = Date.now();
      persist();
    },
    stop() {
      clearInterval(evictTimer);
      persist();
    },
  };
}

module.exports = { startSnapshotLoop, loadSnapshot, reconcileOnStartup, deduplicator };
