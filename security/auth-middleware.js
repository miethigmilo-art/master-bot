'use strict';
// ── HELIX Security Layer 5: Dashboard Auth Middleware ────────────────────────
// Token-based authentication for all API endpoints and the dashboard.
// Token is checked against DASHBOARD_TOKEN env var (SHA-256 hash comparison).
// If DASHBOARD_TOKEN is not set, auth is DISABLED (local dev mode).

const crypto = require('crypto');

// Paths that are always public (no auth required)
const PUBLIC_PATHS = [
  '/api/trading212',
  '/health',
  '/api/health',
];

// Webhook paths have their own secret-checking — exclude them from dashboard auth
const WEBHOOK_PREFIX = '/webhook';
const PNL_PREFIX     = '/pnl';

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) {
    // Still do the compare to avoid timing leak
    crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Validate a submitted token against DASHBOARD_TOKEN.
 * DASHBOARD_TOKEN can be stored as plain text or as its SHA-256 hex digest.
 * @param {string} submitted
 * @returns {boolean}
 */
function validateToken(submitted) {
  const stored = process.env.DASHBOARD_TOKEN;
  if (!stored) return false; // auth disabled — handled by authMiddleware before calling this

  // Accept plain-text match
  if (safeEqual(submitted, stored)) return true;

  // Accept SHA-256 hex digest of the submitted token matching the stored hash
  const hashed = crypto.createHash('sha256').update(submitted).digest('hex');
  return safeEqual(hashed, stored);
}

/**
 * Express middleware. Placed BEFORE all routes (except /health and /webhook*).
 * Reads token from:
 *   1. Authorization: Bearer <token>  header
 *   2. ?token=<token>                query parameter
 */
function authMiddleware(req, res, next) {
  // If DASHBOARD_TOKEN is not set → auth disabled (local dev)
  if (!process.env.DASHBOARD_TOKEN) return next();

  const p = req.path;

  // Public paths — always allow
  if (PUBLIC_PATHS.some(pp => p === pp || p.startsWith(pp + '/'))) return next();

  // Webhooks and PnL endpoints — have their own secret validation
  if (p.startsWith(WEBHOOK_PREFIX) || p.startsWith(PNL_PREFIX)) return next();

  // Static files (dashboard HTML/JS/CSS)
  if (!p.startsWith('/api/') && !p.startsWith('/ws')) {
    // Let static files through; token enforcement happens in the dashboard JS
    return next();
  }

  // Extract token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    || (req.query && req.query.token)
    || '';

  if (!token || !validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized — valid DASHBOARD_TOKEN required' });
  }

  next();
}

module.exports = { authMiddleware, validateToken };
