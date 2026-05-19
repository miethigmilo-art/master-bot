'use strict';
// ── HELIX Security Layer 1: Order Validator ──────────────────────────────────
// Validates every order BEFORE execution. Called from handleWebhook().

const MAX_ORDER_SIZE_USD  = 50_000;
const ALLOWED_SYMBOLS     = ['XAUUSD','EURUSD','GBPUSD','SPX500','US100','BTCUSD','ETHUSD','GOLD','SILVER','OIL_CRUDE','NATURALGAS','COPPER','PLATINUM','US500','US30','DE40','UK100','FR40','JP225','AU200','ES35','HK50','BITCOIN','ETHEREUM','SOLANA','RIPPLE','CARDANO','LITECOIN','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURJPY','GBPJPY','EURGBP','EURCAD','AUDCAD'];
const ALLOWED_SIDES       = ['BUY', 'SELL'];
const ALLOWED_ORDER_TYPES = ['MKT', 'LMT', 'STP'];

/**
 * Validate a fully-formed order object before it reaches the broker.
 * @param {object} order  - { symbol, side, size, entry, sl, tp, orderType, ... }
 * @param {object} settings - strategy settings (riskPct, minRRR, ...)
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateOrder(order, settings) {
  const { symbol, side, size, entry, sl, tp, orderType } = order;
  const minRRR = (settings && settings.minRRR) ? parseFloat(settings.minRRR) : 2.0;

  // 1. Symbol whitelist
  const sym = (symbol || '').toUpperCase().replace(/\s/g, '');
  if (!ALLOWED_SYMBOLS.includes(sym)) {
    return { valid: false, reason: `Symbol '${symbol}' not on whitelist (${ALLOWED_SYMBOLS.join(', ')})` };
  }

  // 2. Side
  if (!ALLOWED_SIDES.includes((side || '').toUpperCase())) {
    return { valid: false, reason: `Side '${side}' must be BUY or SELL` };
  }

  // 3. Size
  const sz = parseFloat(size);
  if (!sz || sz <= 0) {
    return { valid: false, reason: `Size must be > 0 (got ${size})` };
  }
  if (sz > MAX_ORDER_SIZE_USD) {
    return { valid: false, reason: `Size ${sz} exceeds max ${MAX_ORDER_SIZE_USD} USD` };
  }

  // 4 + 5. SL / TP direction check (requires numeric entry)
  const e  = parseFloat(entry);
  const s  = parseFloat(sl);
  const t  = parseFloat(tp);

  if (!isNaN(e) && !isNaN(s) && !isNaN(t)) {
    if (side.toUpperCase() === 'BUY') {
      if (s >= e) return { valid: false, reason: `BUY: SL (${s}) must be < entry (${e})` };
      if (t <= e) return { valid: false, reason: `BUY: TP (${t}) must be > entry (${e})` };
    } else {
      if (s <= e) return { valid: false, reason: `SELL: SL (${s}) must be > entry (${e})` };
      if (t >= e) return { valid: false, reason: `SELL: TP (${t}) must be < entry (${e})` };
    }

    // 6. RRR check
    const slDist = Math.abs(e - s);
    const tpDist = Math.abs(t - e);
    if (slDist > 0) {
      const rrr = parseFloat((tpDist / slDist).toFixed(3));
      if (rrr < minRRR) {
        return { valid: false, reason: `RRR ${rrr} < required minRRR ${minRRR}` };
      }
    }
  }

  // 7. Order type
  if (orderType && !ALLOWED_ORDER_TYPES.includes((orderType || '').toUpperCase())) {
    return { valid: false, reason: `OrderType '${orderType}' not allowed (${ALLOWED_ORDER_TYPES.join(', ')})` };
  }

  return { valid: true };
}

/**
 * Validate a raw webhook payload before any processing.
 * Checks mandatory fields and correct types.
 * @param {object} body - raw request body
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateWebhookPayload(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Request body is missing or not an object' };
  }

  // Required fields
  const required = ['side', 'sl', 'tp'];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return { valid: false, reason: `Missing required field: '${field}'` };
    }
  }

  // Type checks
  if (typeof body.side !== 'string') {
    return { valid: false, reason: `Field 'side' must be a string` };
  }

  const numericFields = ['sl', 'tp'];
  // entry is optional (some strategies calculate it dynamically)
  if (body.entry !== undefined && body.entry !== null) numericFields.push('entry');

  for (const field of numericFields) {
    const v = parseFloat(body[field]);
    if (isNaN(v)) {
      return { valid: false, reason: `Field '${field}' must be a number (got '${body[field]}')` };
    }
  }

  // Side value
  if (!ALLOWED_SIDES.includes(body.side.toUpperCase())) {
    return { valid: false, reason: `Side '${body.side}' must be BUY or SELL` };
  }

  return { valid: true };
}

module.exports = {
  validateOrder,
  validateWebhookPayload,
  ALLOWED_SYMBOLS,
  ALLOWED_SIDES,
  ALLOWED_ORDER_TYPES,
  MAX_ORDER_SIZE_USD,
};
