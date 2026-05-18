'use strict';
// ── HELIX Security Layer 7: Broker Sandbox ───────────────────────────────────
// Wraps the real BrokerAdapter.
// When BROKER_SANDBOX=true → all placeOrder/cancelOrder calls are intercepted
// and logged but NOT forwarded to the live broker.
// All other adapter methods are transparently proxied to the real adapter.

class BrokerSandbox {
  /**
   * @param {object} realAdapter - the live broker adapter (IBKRAdapter / PaperAdapter)
   */
  constructor(realAdapter) {
    this._real             = realAdapter;
    this._sandboxMode      = process.env.BROKER_SANDBOX === 'true';
    this._interceptedOrders = [];

    if (this._sandboxMode) {
      console.log('[BrokerSandbox] 🟡 SANDBOX MODE ACTIVE — orders will NOT be sent to broker');
    }
  }

  /** @returns {boolean} */
  get sandboxMode() { return this._sandboxMode; }

  // ── Order Interception ──────────────────────────────────────────────────────

  async placeOrder(strategyId, order) {
    if (this._sandboxMode) {
      const fakeResult = {
        dealId:      `SANDBOX-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        status:      'SANDBOX',
        sandboxMode: true,
      };
      this._interceptedOrders.push({
        ts:         new Date().toISOString(),
        strategyId,
        order:      { ...order },
        result:     fakeResult,
      });
      console.log(`[BrokerSandbox] Intercepted placeOrder [${strategyId}]:`, JSON.stringify(order));
      return fakeResult;
    }
    return this._real.placeOrder(strategyId, order);
  }

  async cancelOrder(strategyId, orderId) {
    if (this._sandboxMode) {
      console.log(`[BrokerSandbox] Intercepted cancelOrder [${strategyId}]: ${orderId}`);
      return { status: 'SANDBOX_CANCELLED', orderId };
    }
    return this._real.cancelOrder(strategyId, orderId);
  }

  // ── Transparent Proxy for all other methods ─────────────────────────────────

  async getBalance(strategyId)         { return this._real.getBalance(strategyId); }
  async getPositions(strategyId)       { return this._real.getPositions(strategyId); }
  async modifyOrder(strategyId, dealId, changes) { return this._real.modifyOrder(strategyId, dealId, changes); }
  async healthCheck()                  { return this._real.healthCheck(); }
  async reconnect()                    { return this._real.reconnect(); }
  streamPrices(symbol, assetClass, cb) { return this._real.streamPrices(symbol, assetClass, cb); }
  streamOrders(cb)                     { return this._real.streamOrders(cb); }

  // Forward EventEmitter methods if the adapter is an EventEmitter
  on(event, listener)   { if (this._real.on)   this._real.on(event, listener);   return this; }
  off(event, listener)  { if (this._real.off)  this._real.off(event, listener);  return this; }
  emit(event, ...args)  { if (this._real.emit) this._real.emit(event, ...args);  return this; }

  // ── Sandbox inspection ──────────────────────────────────────────────────────

  /** @returns {object[]} - copy of intercepted orders */
  getInterceptedOrders() {
    return [...this._interceptedOrders];
  }

  clearIntercepted() {
    this._interceptedOrders = [];
  }
}

module.exports = { BrokerSandbox };
