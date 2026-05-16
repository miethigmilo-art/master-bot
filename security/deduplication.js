'use strict';
// ── HELIX Security Layer 6: Event Deduplication ──────────────────────────────
// Prevents duplicate order execution on network retries.
// Uses an in-memory Set with TTL. correlationId is the dedup key.

class Deduplicator {
  /**
   * @param {number} ttlMs - how long a correlationId is remembered (default 5 min)
   */
  constructor(ttlMs) {
    this.ttlMs = ttlMs || 5 * 60_000; // 5 minutes
    this._seen = new Set();
  }

  /**
   * Check whether this correlationId was already processed.
   * @param {string} correlationId
   * @returns {boolean}
   */
  isDuplicate(correlationId) {
    if (!correlationId) return false;
    return this._seen.has(correlationId);
  }

  /**
   * Mark a correlationId as processed.
   * It will be automatically removed after TTL.
   * @param {string} correlationId
   */
  markSeen(correlationId) {
    if (!correlationId) return;
    this._seen.add(correlationId);
    setTimeout(() => {
      this._seen.delete(correlationId);
    }, this.ttlMs);
  }

  /** @returns {{ size: number, ttlMs: number }} */
  status() {
    return { size: this._seen.size, ttlMs: this.ttlMs };
  }

  /** Clear all tracked IDs (useful for tests). */
  clear() {
    this._seen.clear();
  }
}

// Singleton with default 5-minute TTL
const deduplicator = new Deduplicator(5 * 60_000);

module.exports = { Deduplicator, deduplicator };
