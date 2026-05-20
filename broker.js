'use strict';
/**
 * broker.js — HELIX Broker Abstraction Layer v2
 *
 * Architecture:  HELIX → BrokerAdapter interface → Concrete Adapter → Exchange
 *
 * Adapters:
 *   IBKRAdapter   — Interactive Brokers TWS API (primary, via IB Gateway)
 *   PaperAdapter  — In-process simulation (dry-run / CI)
 *   OandaAdapter  — OANDA REST API (stub, ready to implement)
 *   AlpacaAdapter — Alpaca REST API (stub, ready to implement)
 *
 * Selection: BROKER_ADAPTER env var
 *   'ibkr'  (default) — requires IB Gateway running
 *   'paper'            — in-process simulation, no external deps
 *   'oanda' / 'alpaca' — stubs
 *
 * Generic HELIX order (adapters translate to broker-specific format):
 *   {
 *     symbol:        'XAUUSD',           // never hardcoded — comes from signal
 *     assetClass:    'commodity',        // 'forex'|'stock'|'future'|'commodity'|'cfd'
 *     side:          'BUY'|'SELL',
 *     size:          1.5,
 *     orderType:     'MKT'|'LMT'|'STP', // default MKT
 *     limitPrice:    null,               // LMT orders
 *     stopPrice:     null,               // STP orders
 *     stopLevel:     1900.00,            // stop-loss price
 *     profitLevel:   1950.00,            // take-profit price
 *     strategyId:    'momentum_v3',
 *     correlationId: 'uuid',
 *     tif:           'GTC',
 *   }
 *
 * Normalised Position:
 *   { symbol, side, size, avgPrice, unrealisedPnl, strategyId }
 */

const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────────────
// Base Adapter Interface
// ─────────────────────────────────────────────────────────────────────────────
class BrokerAdapter extends EventEmitter {
  constructor(name) {
    super();
    this.name        = name;
    this._connected  = false;
    this._latencyMs  = 0;
    this._reconnects = 0;
    this._errors     = 0;
    this._lastError  = null;
  }

  async placeOrder(strategyId, order)        { throw new Error(`${this.name}.placeOrder not implemented`); }
  async cancelOrder(strategyId, dealId)      { throw new Error(`${this.name}.cancelOrder not implemented`); }
  async modifyOrder(strategyId, dealId, upd) { throw new Error(`${this.name}.modifyOrder not implemented`); }
  async getPositions(strategyId)             { throw new Error(`${this.name}.getPositions not implemented`); }
  async getBalance()                         { throw new Error(`${this.name}.getBalance not implemented`); }
  streamPrices(symbol, assetClass, callback) { throw new Error(`${this.name}.streamPrices not implemented`); }
  streamOrders(callback)                     { throw new Error(`${this.name}.streamOrders not implemented`); }
  async reconnect()                          { throw new Error(`${this.name}.reconnect not implemented`); }
  async healthCheck()                        { throw new Error(`${this.name}.healthCheck not implemented`); }

  health() {
    return {
      adapter:    this.name,
      connected:  this._connected,
      latencyMs:  this._latencyMs,
      reconnects: this._reconnects,
      errors:     this._errors,
      lastError:  this._lastError,
    };
  }

  _recordLatency(ms) { this._latencyMs = ms; }

  _recordError(msg) {
    this._errors++;
    this._lastError = { msg, ts: new Date().toISOString() };
    this.emit('broker_event', { type: 'broker_error', adapter: this.name, msg, ts: this._lastError.ts });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// IBKR Adapter  (Interactive Brokers, via @stoqey/ib → IB Gateway socket)
//
// IB Gateway setup options:
//   A) Docker: ghcr.io/gnzsnz/ib-gateway  (recommended for Railway)
//      IBKR_HOST=ibkr-gateway  IBKR_PORT=4002 (paper) / 4001 (live)
//   B) Local TWS: IBKR_HOST=127.0.0.1  IBKR_PORT=7497 (paper) / 7496 (live)
//
// Required env vars:
//   IBKR_HOST, IBKR_PORT, IBKR_CLIENT_ID, IBKR_ACCOUNT
//
// Optional env vars:
//   IBKR_CONTRACTS_JSON — JSON map of custom symbol→contract overrides
//   IBKR_FUT_EXPIRY     — futures expiry e.g. '202509'
// ─────────────────────────────────────────────────────────────────────────────
class IBKRAdapter extends BrokerAdapter {
  constructor() {
    super('ibkr');
    this._host      = process.env.IBKR_HOST      || 'localhost';
    this._port      = parseInt(process.env.IBKR_PORT || '4002', 10);
    this._clientId  = parseInt(process.env.IBKR_CLIENT_ID || '1', 10);
    this._account   = process.env.IBKR_ACCOUNT   || '';

    this._ib             = null;
    this._nextOrderId    = 1;
    this._pendingOrders  = new Map();  // orderId → { resolve, reject, strategyId, correlationId }
    this._positions      = new Map();  // symbol → Position
    this._priceStreams   = new Map();  // tickerId → { symbol, assetClass, callback, bid, ask, last }
    this._nextTickerId   = 100;
    this._accountCache   = { balance: 0, ts: 0 };
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;

    this._initIB();
  }

  _initIB() {
    let IBApi, EventName, OrderAction, OrderType, SecType;
    try {
      ({ IBApi, EventName, OrderAction, OrderType, SecType } = require('@stoqey/ib'));
    } catch (e) {
      console.error('[IBKR] @stoqey/ib not installed. Run: npm install @stoqey/ib');
      console.error('[IBKR] Falling back to paper mode behaviour until installed.');
      this._recordError('module_missing: @stoqey/ib — run npm install @stoqey/ib');
      return;
    }

    this._IBEnums = { OrderAction, OrderType, SecType };

    const ib = new IBApi({ host: this._host, port: this._port, clientId: this._clientId });
    this._ib = ib;

    ib.on(EventName.connected, () => {
      this._connected = true;
      this._reconnectDelay = 2000;
      console.log(`[IBKR] Connected → ${this._host}:${this._port}`);
      this.emit('broker_event', { type: 'connected', adapter: 'ibkr', ts: new Date().toISOString() });
      ib.reqIds(1);
      ib.reqPositions();
      if (this._account)
        ib.reqAccountSummary(1, 'All', 'TotalCashValue,NetLiquidation,AvailableFunds');
    });

    ib.on(EventName.disconnected, () => {
      this._connected = false;
      console.warn('[IBKR] Disconnected — scheduling reconnect');
      this.emit('broker_event', { type: 'reconnect', adapter: 'ibkr', ts: new Date().toISOString() });
      this._scheduleReconnect();
    });

    ib.on(EventName.nextValidId, (orderId) => {
      this._nextOrderId = orderId;
      console.log(`[IBKR] nextValidId=${orderId}`);
    });

    ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
      const pending = this._pendingOrders.get(orderId);
      const ts = new Date().toISOString();
      this.emit('broker_event', {
        type: 'order_status', adapter: 'ibkr', orderId, status,
        filled, remaining, avgFillPrice, ts,
        strategyId:    pending?.strategyId,
        correlationId: pending?.correlationId,
      });
      if (status === 'Filled' && pending) {
        this._recordLatency(Date.now() - (pending.t0 || Date.now()));
        pending.resolve({ dealId: String(orderId), status: 'filled', filled, avgFillPrice });
        this._pendingOrders.delete(orderId);
        this.emit('broker_event', {
          type: 'fill_received', adapter: 'ibkr', orderId, filled, avgFillPrice, ts,
          strategyId: pending.strategyId, correlationId: pending.correlationId,
        });
      } else if (['Cancelled', 'Inactive', 'ApiCancelled'].includes(status) && pending) {
        pending.reject(new Error(`Order ${orderId} ${status}`));
        this._pendingOrders.delete(orderId);
      }
    });

    ib.on(EventName.position, (account, contract, pos, avgCost) => {
      const symbol = contract.symbol;
      if (pos === 0) {
        this._positions.delete(symbol);
      } else {
        this._positions.set(symbol, {
          symbol, side: pos > 0 ? 'BUY' : 'SELL',
          size: Math.abs(pos), avgPrice: avgCost, unrealisedPnl: null,
        });
      }
    });

    ib.on(EventName.accountSummary, (reqId, account, tag, value) => {
      if (['NetLiquidation', 'TotalCashValue'].includes(tag)) {
        this._accountCache = { balance: parseFloat(value) || 0, ts: Date.now() };
      }
    });

    ib.on(EventName.tickPrice, (tickerId, field, price) => {
      const stream = this._priceStreams.get(tickerId);
      if (!stream || price <= 0) return;
      if (field === 1) stream.bid = price;
      if (field === 2) stream.ask = price;
      if (field === 4) stream.last = price;
      if (stream.bid || stream.ask)
        stream.callback({ symbol: stream.symbol, bid: stream.bid, ask: stream.ask, last: stream.last, ts: Date.now() });
    });

    ib.on(EventName.error, (id, code, msg) => {
      // Codes 1100-2999: mostly informational / warnings
      if (code >= 1100 && code < 3000) {
        console.warn(`[IBKR] Info ${code}: ${msg}`);
        this.emit('broker_event', { type: 'broker_warning', adapter: 'ibkr', code, msg, ts: new Date().toISOString() });
        return;
      }
      console.error(`[IBKR] Error ${code} (id=${id}): ${msg}`);
      this._recordError(`${code}: ${msg}`);
      const pending = this._pendingOrders.get(id);
      if (pending) {
        pending.reject(new Error(`IBKR error ${code}: ${msg}`));
        this._pendingOrders.delete(id);
        this.emit('broker_event', {
          type: 'rejected_order', adapter: 'ibkr', orderId: id, code, msg, ts: new Date().toISOString(),
          strategyId: pending.strategyId, correlationId: pending.correlationId,
        });
      }
    });

    ib.connect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnects++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(60000, this._reconnectDelay * 2);
      console.log(`[IBKR] Reconnect #${this._reconnects}…`);
      try { this._ib?.connect(); } catch {}
    }, this._reconnectDelay);
  }

  /** Resolve generic HELIX symbol → IBKR Contract object */
  _resolveContract(symbol, assetClass) {
    const { SecType } = this._IBEnums || {};
    const sym = (symbol || '').toUpperCase();

    // Custom overrides via env (JSON map: {"XAUUSD": {...contractFields}})
    if (process.env.IBKR_CONTRACTS_JSON) {
      try {
        const custom = JSON.parse(process.env.IBKR_CONTRACTS_JSON);
        if (custom[sym]) return custom[sym];
      } catch {}
    }

    switch ((assetClass || '').toLowerCase()) {
      case 'forex':
        return { symbol: sym.slice(0, 3), secType: 'CASH', exchange: 'IDEALPRO', currency: sym.slice(3) || 'USD' };
      case 'commodity': case 'cmdty':
        if (sym === 'XAUUSD' || sym === 'GOLD')
          return { symbol: 'XAUUSD', secType: 'CMDTY', exchange: 'SMART', currency: 'USD' };
        if (sym === 'XAGUSD' || sym === 'SILVER')
          return { symbol: 'XAGUSD', secType: 'CMDTY', exchange: 'SMART', currency: 'USD' };
        return { symbol: sym, secType: 'CMDTY', exchange: 'SMART', currency: 'USD' };
      case 'future': case 'fut':
        return { symbol: sym, secType: 'FUT', exchange: 'SMART', currency: 'USD',
                 lastTradeDateOrContractMonth: process.env.IBKR_FUT_EXPIRY || '' };
      case 'cfd':
        return { symbol: sym, secType: 'CFD', exchange: 'SMART', currency: 'USD' };
      case 'stock': case 'stk': default:
        return { symbol: sym, secType: 'STK', exchange: 'SMART', currency: 'USD' };
    }
  }

  async placeOrder(strategyId, order) {
    if (!this._ib) throw new Error('IBKR: @stoqey/ib not installed');
    if (!this._connected) throw new Error('IBKR: not connected to IB Gateway');

    const { OrderAction, OrderType } = this._IBEnums;
    const orderId  = this._nextOrderId++;
    const contract = this._resolveContract(order.symbol, order.assetClass);
    const t0 = Date.now();

    const action = order.side === 'BUY' ? OrderAction.BUY : OrderAction.SELL;
    const ibOrder = {
      orderId,
      action,
      totalQuantity: order.size,
      orderType: order.orderType === 'LMT' ? OrderType.LMT
               : order.orderType === 'STP' ? OrderType.STP
               : OrderType.MKT,
      lmtPrice: order.limitPrice  || undefined,
      auxPrice: order.stopPrice   || undefined,
      tif:      order.tif         || 'GTC',
      account:  this._account     || undefined,
      transmit: !(order.stopLevel || order.profitLevel), // false if bracket children follow
    };

    // Bracket order: parent + SL child + TP child
    const children = [];
    const oppAction = order.side === 'BUY' ? OrderAction.SELL : OrderAction.BUY;
    if (order.stopLevel) {
      const slId = this._nextOrderId++;
      children.push({ orderId: slId, action: oppAction, totalQuantity: order.size,
                      orderType: OrderType.STP, auxPrice: order.stopLevel,
                      tif: 'GTC', account: this._account || undefined,
                      parentId: orderId, transmit: !order.profitLevel });
    }
    if (order.profitLevel) {
      const tpId = this._nextOrderId++;
      children.push({ orderId: tpId, action: oppAction, totalQuantity: order.size,
                      orderType: OrderType.LMT, lmtPrice: order.profitLevel,
                      tif: 'GTC', account: this._account || undefined,
                      parentId: orderId, transmit: true });
    }

    this.emit('broker_event', {
      type: 'order_submitted', adapter: 'ibkr', orderId, strategyId,
      correlationId: order.correlationId, symbol: order.symbol,
      side: order.side, size: order.size, ts: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingOrders.delete(orderId);
        reject(new Error(`IBKR order ${orderId} timed out after 30s`));
      }, 30000);

      this._pendingOrders.set(orderId, {
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
        reject:  (e) => { clearTimeout(timeout); reject(e); },
        strategyId, correlationId: order.correlationId, t0,
      });

      this._ib.placeOrder(orderId, contract, ibOrder);
      for (const child of children) this._ib.placeOrder(child.orderId, contract, child);
    });
  }

  async cancelOrder(strategyId, dealId) {
    if (!this._connected) throw new Error('IBKR: not connected');
    const orderId = parseInt(dealId, 10);
    this._ib.cancelOrder(orderId);
    this.emit('broker_event', {
      type: 'order_cancelled', adapter: 'ibkr', orderId, strategyId, ts: new Date().toISOString(),
    });
  }

  async modifyOrder(strategyId, dealId, updates) {
    await this.cancelOrder(strategyId, dealId);
    return this.placeOrder(strategyId, updates);
  }

  async getPositions(strategyId) {
    return [...this._positions.values()];
  }

  async getBalance() {
    return this._accountCache.balance;
  }

  streamPrices(symbol, assetClass, callback) {
    if (!this._ib || !this._connected) return () => {};
    const tickerId = this._nextTickerId++;
    const contract = this._resolveContract(symbol, assetClass);
    this._priceStreams.set(tickerId, { symbol, assetClass, callback, bid: null, ask: null, last: null });
    this._ib.reqMktData(tickerId, contract, '', false, false, []);
    return () => {
      try { this._ib.cancelMktData(tickerId); } catch {}
      this._priceStreams.delete(tickerId);
    };
  }

  streamOrders(callback) {
    const handler = (ev) => {
      if (['order_status', 'fill_received', 'rejected_order', 'order_submitted'].includes(ev.type))
        callback(ev);
    };
    this.on('broker_event', handler);
    return () => this.off('broker_event', handler);
  }

  async reconnect() {
    this._reconnects++;
    try { this._ib?.disconnect(); } catch {}
    await new Promise(r => setTimeout(r, 1500));
    this._initIB();
  }

  async healthCheck() {
    return {
      ...this.health(),
      host:        this._host,
      port:        this._port,
      clientId:    this._clientId,
      account:     this._account,
      openOrders:  this._pendingOrders.size,
      positions:   this._positions.size,
      priceFeeds:  this._priceStreams.size,
      balance:     this._accountCache.balance,
      balanceAgeS: this._accountCache.ts
                   ? Math.round((Date.now() - this._accountCache.ts) / 1000)
                   : null,
    };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Paper Broker Adapter  (in-process simulation — no external dependencies)
// ─────────────────────────────────────────────────────────────────────────────
class PaperBrokerAdapter extends BrokerAdapter {
  constructor() {
    super('paper');
    this._connected = true;
    this._positions = new Map();
    this._orders    = new Map();
    this._nextId    = 1;
    this._balance   = parseFloat(process.env.PAPER_BALANCE || '100000');
    this._prices    = new Map();
  }

  async placeOrder(strategyId, order) {
    const dealId = `PAPER-${String(this._nextId++).padStart(6, '0')}`;
    const price  = this._prices.get(order.symbol)
                || (order.side === 'BUY'
                    ? (order.stopLevel  ? order.stopLevel  * 1.02 : 1000)
                    : (order.stopLevel  ? order.stopLevel  * 0.98 : 1000));
    const pos = {
      dealId, symbol: order.symbol, side: order.side, size: order.size,
      avgPrice: price, strategyId, correlationId: order.correlationId,
      stopLevel: order.stopLevel, profitLevel: order.profitLevel,
    };
    this._orders.set(dealId, pos);
    this._positions.set(`${strategyId}:${order.symbol}`, pos);
    this.emit('broker_event', {
      type: 'fill_received', adapter: 'paper', dealId, strategyId,
      correlationId: order.correlationId, symbol: order.symbol,
      side: order.side, size: order.size, avgFillPrice: price, ts: new Date().toISOString(),
    });
    return { dealId, status: 'filled', filled: order.size, avgFillPrice: price };
  }

  async cancelOrder(strategyId, dealId) {
    const pos = this._orders.get(dealId);
    if (pos) this._positions.delete(`${pos.strategyId}:${pos.symbol}`);
    this._orders.delete(dealId);
  }

  async modifyOrder(strategyId, dealId, updates) {
    const pos = this._orders.get(dealId);
    if (!pos) throw new Error(`Paper: order ${dealId} not found`);
    Object.assign(pos, updates);
    return { dealId, status: 'modified' };
  }

  async getPositions(strategyId) {
    const all = [...this._positions.values()];
    return strategyId ? all.filter(p => p.strategyId === strategyId) : all;
  }

  async getBalance() { return this._balance; }

  streamPrices(symbol, assetClass, callback) {
    let price = this._prices.get(symbol) || 1000;
    const iv = setInterval(() => {
      price += (Math.random() - 0.5) * price * 0.0003;
      price = Math.max(0.01, price);
      this._prices.set(symbol, price);
      callback({ symbol, bid: price * 0.9998, ask: price * 1.0002, last: price, ts: Date.now() });
    }, 1000);
    return () => clearInterval(iv);
  }

  streamOrders(callback) {
    const h = ev => callback(ev);
    this.on('broker_event', h);
    return () => this.off('broker_event', h);
  }

  async reconnect() { this._connected = true; }

  async healthCheck() {
    return {
      ...this.health(),
      balance:    this._balance,
      openOrders: this._orders.size,
      positions:  this._positions.size,
      note:       'paper simulation — no real orders',
    };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Stubs (implement REST clients here when ready)
// ─────────────────────────────────────────────────────────────────────────────
class OandaAdapter extends BrokerAdapter {
  constructor() { super('oanda'); }
  async placeOrder()   { throw new Error('OandaAdapter: not yet implemented'); }
  async cancelOrder()  { throw new Error('OandaAdapter: not implemented'); }
  async modifyOrder()  { throw new Error('OandaAdapter: not implemented'); }
  async getPositions() { return []; }
  async getBalance()   { return 0; }
  streamPrices()       { return () => {}; }
  streamOrders()       { return () => {}; }
  async reconnect()    {}
  async healthCheck()  { return { ...this.health(), note: 'stub — not yet implemented' }; }
}

class AlpacaAdapter extends BrokerAdapter {
  constructor() { super('alpaca'); }
  async placeOrder()   { throw new Error('AlpacaAdapter: not yet implemented'); }
  async cancelOrder()  { throw new Error('AlpacaAdapter: not implemented'); }
  async modifyOrder()  { throw new Error('AlpacaAdapter: not implemented'); }
  async getPositions() { return []; }
  async getBalance()   { return 0; }
  streamPrices()       { return () => {}; }
  streamOrders()       { return () => {}; }
  async reconnect()    {}
  async healthCheck()  { return { ...this.health(), note: 'stub — not yet implemented' }; }
}


// ─────────────────────────────────────────────────────────────────────────────
// Capital.com Adapter  (REST API — demo + live)
//
// Required env vars:
//   BASE_URL    — e.g. https://demo-api-capital.backend-capital.com/api/v1
//   API_KEY     — X-CAP-API-KEY (shown in Capital.com dashboard)
//   API_SECRET  — account password used to create session
//   EMAIL       — Capital.com account e-mail
//
// Optional:
//   BROKER_ADAPTER=capital   (set this in Railway to activate)
// ─────────────────────────────────────────────────────────────────────────────
class CapitalComAdapter extends BrokerAdapter {
  constructor() {
    super('capital');
    this._baseUrl      = (process.env.BASE_URL || 'https://api-capital.backend-capital.com/api/v1').replace(/\/$/, '');
    this._apiKey       = process.env.API_KEY    || '';
    this._password     = process.env.API_SECRET || '';
    this._email        = process.env.EMAIL      || '';
    this._cst          = null;
    this._secToken     = null;
    this._tokenExpiry  = 0;
    this._balance      = 0;
    this._sessionTimer = null;

    // Rate limiter: max 4 requests/second to Capital.com demo API
    this._reqQueue      = [];
    this._lastReqAt     = 0;
    this._reqIntervalMs = 250;   // 250ms between requests = 4/s

    // Retry startup connect up to 3 times (Capital.com demo occasionally 401s on first call)
    this._startupConnect();
  }

  async _startupConnect(attempt = 0) {
    try {
      await this._connect();
    } catch (err) {
      const status = err.response?.status;
      console.error(`[Capital.com] Initial connect failed (attempt ${attempt + 1}): ${err.message}`);
      this._recordError(err.message);
      // 401 = bad credentials — do NOT retry (would trigger account lockout)
      // Only retry on network errors or 5xx
      if (attempt < 3 && status !== 401 && status !== 403) {
        setTimeout(() => this._startupConnect(attempt + 1), 5000 * (attempt + 1));
      } else if (status === 401) {
        console.error('[Capital.com] 401 Unauthorized — check EMAIL, API_KEY, API_SECRET env vars. Not retrying.');
      }
    }
  }

  // Normalize common symbol names to Capital.com epic format
  _normalizeEpic(symbol) {
    const MAP = {
      GOLD:   'XAUUSD',
      SILVER: 'XAGUSD',
      OIL:    'XTIUSD',
      US500:  'US500',
      NAS100: 'NAS100',
      BTCUSD: 'BCHUSD',
    };
    const custom = process.env.CAPITAL_EPIC_MAP || '';
    if (custom) {
      for (const pair of custom.split(',')) {
        const [from, to] = pair.split('=').map(s => s.trim());
        if (from && to && symbol.toUpperCase() === from.toUpperCase()) return to;
      }
    }
    return MAP[symbol.toUpperCase()] || symbol;
  }

  // Throttled request — all axios calls go through here
  _req(fn) {
    return new Promise((resolve, reject) => {
      this._reqQueue.push({ fn, resolve, reject });
      this._drainQueue();
    });
  }

  _drainQueue() {
    if (!this._reqQueue.length) return;
    const now  = Date.now();
    const wait = Math.max(0, this._lastReqAt + this._reqIntervalMs - now);
    setTimeout(async () => {
      if (!this._reqQueue.length) return;
      const { fn, resolve, reject } = this._reqQueue.shift();
      this._lastReqAt = Date.now();
      try { resolve(await fn()); } catch (e) { reject(e); }
      this._drainQueue();
    }, wait);
  }

  // Retry on 429 with exponential backoff (1.5s, 3s, 6s)
  async _withRetry(fn, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const status = err.response?.status;
        const code   = err.response?.data?.errorCode || '';
        if ((status === 429 || code.includes('too-many') || code.includes('rate')) && attempt < retries) {
          const delay = 1500 * Math.pow(2, attempt);
          console.warn(`[Capital.com] Rate limited — retry ${attempt + 1}/${retries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  async _connect() {
    const axios = require('axios');
    const res = await axios.post(
      `${this._baseUrl}/session`,
      { identifier: this._email, password: this._password },
      { headers: { 'X-CAP-API-KEY': this._apiKey, 'Content-Type': 'application/json' } },
    );
    this._cst         = res.headers['cst'];
    this._secToken    = res.headers['x-security-token'];
    this._tokenExpiry = Date.now() + 9 * 60 * 1000;
    this._connected   = true;
    console.log('[Capital.com] Session established');
    this.emit('broker_event', { type: 'connected', adapter: 'capital', ts: new Date().toISOString() });
    if (this._sessionTimer) clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(
      () => this._connect().catch(e => this._recordError(e.message)),
      8 * 60 * 1000,
    );
  }

  async _headers() {
    if (!this._cst || Date.now() >= this._tokenExpiry) await this._connect();
    return { 'CST': this._cst, 'X-SECURITY-TOKEN': this._secToken, 'Content-Type': 'application/json' };
  }

  async placeOrder(strategyId, order) {
    const axios = require('axios');
    const t0      = Date.now();
    const headers = await this._headers();
    const epic = this._normalizeEpic(order.symbol);
    const body = {
      epic, direction: order.side, size: order.size, guaranteedStop: false,
    };
    if (order.stopLevel)   body.stopLevel   = order.stopLevel;
    if (order.profitLevel) body.profitLevel = order.profitLevel;
    let res;
    try {
      res = await this._withRetry(() =>
        this._req(() => axios.post(`${this._baseUrl}/positions`, body, { headers }))
      );
    } catch (err) {
      const msg = err.response?.data?.errorCode || err.response?.data?.message || err.message;
      this._recordError(msg);
      throw new Error(`Capital.com placeOrder failed: ${msg}`);
    }
    const dealRef = res.data?.dealReference;
    const dealId  = res.data?.dealId || dealRef || `CAP-${Date.now()}`;
    this._recordLatency(Date.now() - t0);
    this.emit('broker_event', {
      type: 'fill_received', adapter: 'capital', dealId, dealRef, strategyId,
      correlationId: order.correlationId, symbol: order.symbol,
      side: order.side, size: order.size, ts: new Date().toISOString(),
    });
    return { dealId, dealReference: dealRef, status: 'filled', filled: order.size };
  }

  async cancelOrder(strategyId, dealId) {
    const axios = require('axios');
    const headers = await this._headers();
    try {
      await this._req(() => axios.delete(`${this._baseUrl}/positions/${dealId}`, { headers }));
    } catch (err) {
      const msg = err.response?.data?.errorCode || err.message;
      this._recordError(msg);
      throw new Error(`Capital.com cancelOrder failed: ${msg}`);
    }
    this.emit('broker_event', { type: 'order_cancelled', adapter: 'capital', dealId, strategyId, ts: new Date().toISOString() });
  }

  async modifyOrder(strategyId, dealId, updates) {
    const axios = require('axios');
    const headers = await this._headers();
    const body = {};
    if (updates.stopLevel   != null) body.stopLevel   = updates.stopLevel;
    if (updates.profitLevel != null) body.profitLevel = updates.profitLevel;
    if (updates.size        != null) body.size        = updates.size;
    try {
      await this._req(() => axios.put(`${this._baseUrl}/positions/${dealId}`, body, { headers }));
    } catch (err) {
      const msg = err.response?.data?.errorCode || err.message;
      this._recordError(msg);
      throw new Error(`Capital.com modifyOrder failed: ${msg}`);
    }
    return { dealId, status: 'modified' };
  }

  async getPositions() {
    const axios = require('axios');
    try {
      const headers = await this._headers();
      const res = await this._req(() => axios.get(`${this._baseUrl}/positions`, { headers }));
      return (res.data?.positions || []).map(p => ({
        symbol: p.market?.epic, side: p.position?.direction, size: p.position?.size,
        avgPrice: p.position?.openLevel, unrealisedPnl: p.position?.upl,
        dealId: p.position?.dealId, strategyId: null,
      }));
    } catch (e) { this._recordError(e.message); return []; }
  }

  async getBalance() {
    const axios = require('axios');
    try {
      const headers = await this._headers();
      const res = await this._req(() => axios.get(`${this._baseUrl}/accounts`, { headers }));
      const acct = (res.data?.accounts || [])[0];
      this._balance = acct?.balance?.available ?? acct?.balance?.balance ?? 0;
      return this._balance;
    } catch (e) { this._recordError(e.message); return this._balance; }
  }

  streamPrices(symbol, assetClass, callback) {
    const axios = require('axios');
    const priceInterval = parseInt(process.env.CAPITAL_PRICE_INTERVAL || '8000', 10);
    const iv = setInterval(async () => {
      try {
        const headers = await this._headers();
        const res = await this._req(() => axios.get(`${this._baseUrl}/markets/${symbol}`, { headers }));
        const snap = res.data?.snapshot;
        if (snap) callback({ symbol, bid: snap.bid, ask: snap.offer, last: ((snap.bid||0)+(snap.offer||0))/2, ts: Date.now() });
      } catch {}
    }, priceInterval);
    return () => clearInterval(iv);
  }

  streamOrders(callback) {
    const h = ev => callback(ev);
    this.on('broker_event', h);
    return () => this.off('broker_event', h);
  }

  async reconnect() {
    this._connected = false; this._cst = null; this._secToken = null; this._tokenExpiry = 0;
    await this._connect();
  }

  async healthCheck() {
    return {
      ...this.health(),
      baseUrl:          this._baseUrl,
      email:            this._email,
      hasSession:       !!this._cst,
      sessionExpiresIn: this._tokenExpiry ? `${Math.max(0,Math.round((this._tokenExpiry-Date.now())/1000))}s` : 'n/a',
      balance:          this._balance,
    };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────
function createBroker() {
  const adapter = (process.env.BROKER_ADAPTER || 'ibkr').toLowerCase();
  switch (adapter) {
    case 'paper':   return new PaperBrokerAdapter();
    case 'oanda':   return new OandaAdapter();
    case 'alpaca':  return new AlpacaAdapter();
    case 'capital': return new CapitalComAdapter();
    case 'ibkr':
    default:        return new IBKRAdapter();
  }
}

module.exports = {
  createBroker,
  BrokerAdapter,
  IBKRAdapter,
  PaperBrokerAdapter,
  OandaAdapter,
  AlpacaAdapter,
  CapitalComAdapter,
};
