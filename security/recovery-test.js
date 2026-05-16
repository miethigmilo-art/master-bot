'use strict';
// ── HELIX Security Layer 8: Recovery Tests ───────────────────────────────────
// Automated self-tests run at startup and on demand via /api/recovery/tests.
// Each test is independent; failures are captured and reported, never thrown.

/**
 * Run all security recovery tests.
 * @param {object} deps - injected dependencies (from server.js)
 * @param {object} deps.killSwitch      - KillSwitch singleton
 * @param {object} deps.deduplicator    - Deduplicator singleton
 * @param {Function} deps.validateOrder  - from order-validator
 * @param {Function} deps.validateWebhookPayload - from order-validator
 * @param {object} deps.portfolioManager - PortfolioManager instance (optional)
 * @param {object} deps.broker          - BrokerSandbox-wrapped adapter
 * @returns {Promise<{ allPassed: boolean, results: object[], ts: string }>}
 */
async function runRecoveryTests(deps) {
  deps = deps || {};
  const results = [];

  // ── Test 1: KillSwitch ─────────────────────────────────────────────────────
  await runTest(results, 'KillSwitch: activate → block → deactivate', async () => {
    const ks = deps.killSwitch;
    if (!ks) throw new Error('killSwitch dependency not provided');

    // Ensure clean state
    if (ks.isActive()) ks.deactivate('recovery-test-setup');

    ks.activate('Recovery test', 'recovery-test');
    if (!ks.isActive()) throw new Error('KillSwitch should be active after activate()');

    const st = ks.status();
    if (!st.active)       throw new Error('status().active should be true');
    if (!st.reason)       throw new Error('status().reason should be set');
    if (!st.activatedAt)  throw new Error('status().activatedAt should be set');
    if (st.activatedBy !== 'recovery-test') throw new Error('activatedBy mismatch');

    ks.deactivate('recovery-test');
    if (ks.isActive()) throw new Error('KillSwitch should be inactive after deactivate()');
  });

  // ── Test 2: Deduplication ─────────────────────────────────────────────────
  await runTest(results, 'Deduplicator: same correlationId → duplicate on 2nd call', async () => {
    const dd = deps.deduplicator;
    if (!dd) throw new Error('deduplicator dependency not provided');

    const testId = `RECOVERY-TEST-${Date.now()}`;

    if (dd.isDuplicate(testId)) throw new Error('Should not be duplicate before markSeen');
    dd.markSeen(testId);
    if (!dd.isDuplicate(testId)) throw new Error('Should be duplicate after markSeen');

    // Clean up (use a very short TTL instance for cleanup — we can't wait 5 min)
    // The ID will expire on its own; just verify state is correct now.
  });

  // ── Test 3: OrderValidator ────────────────────────────────────────────────
  await runTest(results, 'OrderValidator: invalid symbol → rejected', async () => {
    const validateOrder = deps.validateOrder;
    if (!validateOrder) throw new Error('validateOrder dependency not provided');

    const bad1 = validateOrder({ symbol: 'AAPL', side: 'BUY', size: 1, entry: 100, sl: 95, tp: 110, orderType: 'MKT' }, { minRRR: 2.0 });
    if (bad1.valid) throw new Error('Should reject unknown symbol AAPL');
    if (!bad1.reason) throw new Error('Should include rejection reason');
  });

  await runTest(results, 'OrderValidator: BUY with SL > entry → rejected', async () => {
    const validateOrder = deps.validateOrder;
    if (!validateOrder) throw new Error('validateOrder dependency not provided');

    // SL above entry for a BUY — clearly wrong
    const bad2 = validateOrder({ symbol: 'XAUUSD', side: 'BUY', size: 1, entry: 1800, sl: 1900, tp: 2000, orderType: 'MKT' }, { minRRR: 2.0 });
    if (bad2.valid) throw new Error('Should reject BUY with SL > entry');
  });

  await runTest(results, 'OrderValidator: valid BUY XAUUSD → passes', async () => {
    const validateOrder = deps.validateOrder;
    if (!validateOrder) throw new Error('validateOrder dependency not provided');

    const good = validateOrder({ symbol: 'XAUUSD', side: 'BUY', size: 500, entry: 1800, sl: 1750, tp: 1900, orderType: 'MKT' }, { minRRR: 1.5 });
    if (!good.valid) throw new Error(`Valid order was rejected: ${good.reason}`);
  });

  // ── Test 4: Portfolio Recovery ────────────────────────────────────────────
  await runTest(results, 'Portfolio: snapshot() returns consistent state', async () => {
    const pm = deps.portfolioManager;
    if (!pm) {
      // Non-fatal — portfolio manager may not be available in all test contexts
      return; // skip
    }
    const snap = pm.snapshot();
    if (typeof snap !== 'object') throw new Error('snapshot() must return an object');
  });

  // ── Test 5: BrokerSandbox ─────────────────────────────────────────────────
  await runTest(results, 'BrokerSandbox: BROKER_SANDBOX=true → no real order sent', async () => {
    const broker = deps.broker;
    if (!broker) throw new Error('broker dependency not provided');

    // Only run this sub-check when sandbox mode is truly active
    if (process.env.BROKER_SANDBOX === 'true') {
      const beforeCount = broker.getInterceptedOrders
        ? broker.getInterceptedOrders().length
        : -1;

      const result = await broker.placeOrder('triceratops', {
        symbol: 'XAUUSD', side: 'BUY', size: 1, orderType: 'MKT',
        stopLevel: 1750, profitLevel: 1900, strategyId: 'triceratops',
      });

      if (!result || result.status !== 'SANDBOX') {
        throw new Error(`Expected SANDBOX status, got: ${JSON.stringify(result)}`);
      }

      if (broker.getInterceptedOrders) {
        const afterCount = broker.getInterceptedOrders().length;
        if (afterCount !== beforeCount + 1) {
          throw new Error('Intercepted order count did not increase');
        }
      }
    } else {
      // Sandbox not active — verify placeOrder method exists
      if (typeof broker.placeOrder !== 'function') {
        throw new Error('broker.placeOrder must be a function');
      }
    }
  });

  const allPassed = results.every(r => r.passed);
  return {
    allPassed,
    results,
    ts: new Date().toISOString(),
    summary: `${results.filter(r => r.passed).length}/${results.length} tests passed`,
  };
}

/**
 * Helper: run a single test, catching errors.
 */
async function runTest(results, name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err.message });
  }
}

module.exports = { runRecoveryTests };
