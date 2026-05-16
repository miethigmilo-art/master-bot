/**
 * broker.js — HELIX Broker Abstraction Layer
 *
 * Unified interface for all broker adapters.
 * Every adapter must implement:
 *   placeOrder(accountId, order)   → { dealId, status }
 *   cancelOrder(accountId, dealId) → void
 *   getPositions(accountId)        → Position[]
 *   getBalance(accountId)          → number
 *   streamPrices(epic, callback)   → unsubscribe fn
 *
 * Active adapter is selected via env BROKER_ADAPTER (default: 'capitalcom')
 * Set BROKER_ADAPTER=paper for dry-run paper trading.
 */

'use strict';

const axios = require('axios');

// ── Base class ──────────────────────────────────────────────────────────────
class BrokerAdapter {
  constructor(name) { this.name = name; }
  async placeOrder(accountId, order)   { throw new Error(`${this.name}.placeOrder not implemented`); }
  async cancelOrder(accountId, dealId) { throw new Error(`${this.name}.cancelOrder not implemented`); }
  async getPositions(accountId)        { throw new Error(`${this.name}.getPositions not implemented`); }
  async getBalance(accountId)          { throw new Error(`${this.name}.getBalance not implemented`); }
  streamPrices(epic, cb)               { throw new Error(`${this.name}.streamPrices not implemented`); }
}

// ── Capital.com Adapter ─────────────────────────────────────────────────────
class CapitalComAdapter extends BrokerAdapter {
  constructor(sessions, baseUrl) {
    super('capitalcom');
    // sessions: { [strategyName]: { apiKey, email, password, cst, token } }
    this._sessions = sessions;
    this._baseUrl  = baseUrl || process.env.BASE_URL;
  }

  _headers(accountId) {
    const k = this._sessions[accountId];
    if (!k) throw new Error(`Kein Konto konfiguriert für: ${accountId}`);
    return { 'X-CAP-API-KEY': k.apiKey, 'CST': k.cst, 'X-SECURITY-TOKEN': k.token };
  }

  async _login(accountId) {
    const k = this._sessions[accountId];
    if (!k?.apiKey || !k?.email || !k?.password)
      throw new Error(`Fehlende Credentials für ${accountId}`);
    const res = await axios.post(`${this._baseUrl}/session`,
      { identifier: k.email, password: k.password },
      { headers: { 'X-CAP-API-KEY': k.apiKey } });
    k.cst   = res.headers['cst'];
    k.token = res.headers['x-security-token'];
  }

  async _ensureAuth(accountId) {
    if (!this._sessions[accountId]?.cst) await this._login(accountId);
  }

  async _withRetry(accountId, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status === 401) {
        await this._login(accountId);
        return await fn();
      }
      throw err;
    }
  }

  /** order: { epic, direction, size, guaranteedStop, stopLevel, profitLevel } */
  async placeOrder(accountId, order) {
    await this._ensureAuth(accountId);
    const res = await this._withRetry(accountId, () =>
      axios.post(`${this._baseUrl}/positions`, order, { headers: this._headers(accountId) })
    );
    return { dealId: res.data?.dealReference || res.data?.dealId, status: res.data?.status || 'ok', raw: res.data };
  }

  async cancelOrder(accountId, dealId) {
    await this._ensureAuth(accountId);
    await this._withRetry(accountId, () =>
      axios.delete(`${this._baseUrl}/positions/${dealId}`, { headers: this._headers(accountId) })
    );
  }

  async getPositions(accountId) {
    await this._ensureAuth(accountId);
    const res = await this._withRetry(accountId, () =>
      axios.get(`${this._baseUrl}/positions`, { headers: this._headers(accountId) })
    );
    return (res.data.positions || []).map(p => ({
      dealId:    p.position.dealId,
      epic:      p.market?.epic,
      direction: p.position.direction,
      size:      p.position.size,
      openLevel: p.position.openLevel,
      sl:        p.position.stopLevel,
      tp:        p.position.limitLevel,
      pnl:       p.position.pnl,
      raw:       p,
    }));
  }

  async getBalance(accountId) {
    await this._ensureAuth(accountId);
    const res = await this._withRetry(accountId, () =>
      axios.get(`${this._baseUrl}/accounts`, { headers: this._headers(accountId) })
    );
    const bal = res.data.accounts[0]?.balance;
    return bal?.balance ?? bal?.available ?? bal;
  }

  /** Returns an unsubscribe function. Uses Capital.com REST polling (no WS yet). */
  streamPrices(epic, cb, intervalMs = 2000) {
    // Capital.com doesn't expose a public WS for prices in the basic API.
    // Poll the market price endpoint every intervalMs.
    // Replace with WS streaming when Capital.com adds WS support to the account.
    let active = true;
    const accountId = Object.keys(this._sessions)[0]; // use first account for market data

    const poll = async () => {
      if (!active) return;
      try {
        await this._ensureAuth(accountId);
        const res = await axios.get(`${this._baseUrl}/markets/${epic}`, { headers: this._headers(accountId) });
        const snap = res.data?.snapshot;
        if (snap) cb({ epic, bid: snap.bid, ask: snap.offer, ts: Date.now() });
      } catch {}
      if (active) setTimeout(poll, intervalMs);
    };
    poll();
    return () => { active = false; };
  }
}

// ── Paper Broker Adapter ────────────────────────────────────────────────────
// Simulates order execution in memory — no real money, no API calls.
// Useful for testing signal logic end-to-end.
class PaperBrokerAdapter extends BrokerAdapter {
  constructor() {
    super('paper');
    this._positions = {};   // { [accountId]: Position[] }
    this._balances  = {};   // { [accountId]: number }
    this._nextId    = 1;
    this._priceFeeds = {}; // { epic: { bid, ask } }
  }

  _getPositions(accountId) {
    if (!this._positions[accountId]) this._positions[accountId] = [];
    return this._positions[accountId];
  }

  setBalance(accountId, amount) { this._balances[accountId] = amount; }
  setPrice(epic, bid, ask)      { this._priceFeeds[epic] = { bid, ask }; }

  async placeOrder(accountId, order) {
    const dealId = `PAPER-${this._nextId++}`;
    const price  = this._priceFeeds[order.epic];
    const openLevel = price
      ? (order.direction === 'BUY' ? price.ask : price.bid)
      : 0;
    const pos = {
      dealId,
      epic:      order.epic,
      direction: order.direction,
      size:      order.size,
      openLevel,
      sl:        order.stopLevel  || null,
      tp:        order.profitLevel || null,
      pnl:       0,
      raw:       order,
    };
    this._getPositions(accountId).push(pos);
    console.log(`[Paper] ${accountId} → OPEN ${order.direction} ${order.size}x ${order.epic} @ ${openLevel} (${dealId})`);
    return { dealId, status: 'ok' };
  }

  async cancelOrder(accountId, dealId) {
    const arr = this._getPositions(accountId);
    const idx = arr.findIndex(p => p.dealId === dealId);
    if (idx === -1) throw new Error(`Paper: dealId not found: ${dealId}`);
    const [pos] = arr.splice(idx, 1);
    console.log(`[Paper] ${accountId} → CLOSE ${pos.dealId}`);
  }

  async getPositions(accountId) {
    return [...this._getPositions(accountId)];
  }

  async getBalance(accountId) {
    return this._balances[accountId] ?? 10000; // default paper balance
  }

  streamPrices(epic, cb, intervalMs = 1000) {
    let active = true;
    let base = this._priceFeeds[epic]?.bid || 2000;
    const tick = () => {
      if (!active) return;
      const spread = 0.30;
      base = base + (Math.random() - 0.5) * 0.5;
      const bid = parseFloat(base.toFixed(2));
      const ask = parseFloat((base + spread).toFixed(2));
      this._priceFeeds[epic] = { bid, ask };
      cb({ epic, bid, ask, ts: Date.now() });
      setTimeout(tick, intervalMs);
    };
    tick();
    return () => { active = false; };
  }
}

// ── OANDA Stub ──────────────────────────────────────────────────────────────
// Scaffold only — fill in when OANDA credentials are available.
class OandaAdapter extends BrokerAdapter {
  constructor() {
    super('oanda');
    this._baseUrl    = process.env.OANDA_BASE_URL || 'https://api-fxtrade.oanda.com/v3';
    this._token      = process.env.OANDA_TOKEN;
    this._accountIds = {};  // map strategyName → oanda accountId
  }

  _headers() {
    return { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' };
  }

  async placeOrder(accountId, order) {
    // TODO: map HELIX order format → OANDA v3 order format
    throw new Error('OandaAdapter.placeOrder: not yet implemented');
  }
  async cancelOrder(accountId, dealId) { throw new Error('OandaAdapter.cancelOrder: not yet implemented'); }
  async getPositions(accountId)        { throw new Error('OandaAdapter.getPositions: not yet implemented'); }
  async getBalance(accountId)          { throw new Error('OandaAdapter.getBalance: not yet implemented'); }
  streamPrices(epic, cb) { throw new Error('OandaAdapter.streamPrices: not yet implemented'); }
}

// ── Alpaca Stub ─────────────────────────────────────────────────────────────
class AlpacaAdapter extends BrokerAdapter {
  constructor() {
    super('alpaca');
    this._baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
    this._keyId   = process.env.ALPACA_KEY_ID;
    this._secret  = process.env.ALPACA_SECRET;
  }

  _headers() {
    return { 'APCA-API-KEY-ID': this._keyId, 'APCA-API-SECRET-KEY': this._secret };
  }

  async placeOrder(accountId, order) {
    // TODO: map HELIX order → Alpaca order
    throw new Error('AlpacaAdapter.placeOrder: not yet implemented');
  }
  async cancelOrder(accountId, dealId) { throw new Error('AlpacaAdapter.cancelOrder: not yet implemented'); }
  async getPositions(accountId)        { throw new Error('AlpacaAdapter.getPositions: not yet implemented'); }
  async getBalance(accountId)          { throw new Error('AlpacaAdapter.getBalance: not yet implemented'); }
  streamPrices(epic, cb) { throw new Error('AlpacaAdapter.streamPrices: not yet implemented'); }
}

// ── Factory ─────────────────────────────────────────────────────────────────
/**
 * createBroker(sessions)
 *
 * sessions: the KONTEN object from server.js
 *   { mittel: { apiKey, email, password, cst, token }, ... }
 *
 * Reads BROKER_ADAPTER env var to select adapter:
 *   'capitalcom' (default), 'paper', 'oanda', 'alpaca'
 */
function createBroker(sessions) {
  const adapter = (process.env.BROKER_ADAPTER || 'capitalcom').toLowerCase();
  switch (adapter) {
    case 'paper':    return new PaperBrokerAdapter();
    case 'oanda':    return new OandaAdapter();
    case 'alpaca':   return new AlpacaAdapter();
    case 'capitalcom':
    default:         return new CapitalComAdapter(sessions, process.env.BASE_URL);
  }
}

module.exports = {
  createBroker,
  BrokerAdapter,
  CapitalComAdapter,
  PaperBrokerAdapter,
  OandaAdapter,
  AlpacaAdapter,
};
