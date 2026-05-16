'use strict';
// ── HELIX Security Layer 3: Kill Switch ──────────────────────────────────────
// Emergency halt. When active: NO new orders, ALL webhooks blocked → 503.

class KillSwitch {
  constructor() {
    this.state = {
      active:      false,
      reason:      '',
      activatedAt: null,
      activatedBy: '',
    };
  }

  /**
   * Activate the kill switch.
   * @param {string} reason - human-readable reason
   * @param {string} by     - who triggered it ('manual', 'auto', agent name, ...)
   */
  activate(reason, by) {
    by = by || 'manual';
    this.state = {
      active:      true,
      reason:      reason || 'No reason given',
      activatedAt: new Date().toISOString(),
      activatedBy: by,
    };
    console.error(`[KillSwitch] ACTIVATED by ${by}: ${reason}`);
  }

  /**
   * Deactivate the kill switch.
   * @param {string} by - who deactivated it
   */
  deactivate(by) {
    by = by || 'manual';
    const was = { ...this.state };
    this.state = {
      active:      false,
      reason:      '',
      activatedAt: null,
      activatedBy: '',
    };
    console.log(`[KillSwitch] Deactivated by ${by} (was active since ${was.activatedAt})`);
  }

  /** @returns {boolean} */
  isActive() {
    return this.state.active;
  }

  /** @returns {object} */
  status() {
    return { ...this.state };
  }
}

// Singleton exported so server.js and routers share the same instance.
const killSwitch = new KillSwitch();

module.exports = { KillSwitch, killSwitch };
