'use strict';
// ── HELIX Security Layer 2: Secret Management ────────────────────────────────
// Central place for all secrets. Never hardcode. Sanitises logs.

const SENSITIVE_KEYS = [
  'password', 'passwd', 'secret', 'token', 'key', 'auth',
  'apikey', 'api_key', 'authorization', 'credential', 'private',
  'access_token', 'refresh_token', 'webhook_secret',
];

const REQUIRED_SECRETS = ['API_SECRET'];

/**
 * Retrieve a secret from environment variables.
 * Throws if the variable is not set.
 * @param {string} name - env var name
 * @returns {string}
 */
function getSecret(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Required secret ${name} is not set`);
  return val;
}

/**
 * Recursively sanitise an object/value before logging.
 * Replaces sensitive field values with '***REDACTED***'.
 * @param {*} obj
 * @param {number} depth - internal recursion depth guard
 * @returns {*}
 */
function sanitizeForLog(obj, depth) {
  depth = depth || 0;
  if (depth > 10) return obj; // guard against circular structures

  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // If the whole value looks like a bearer token / JWT, redact it
    if (/^(Bearer\s+)?[A-Za-z0-9\-_=+/]{20,}$/.test(obj.trim())) return '***REDACTED***';
    return obj;
  }
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLog(item, depth + 1));
  }

  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase().replace(/[-_.]/g, '');
    if (SENSITIVE_KEYS.some(sk => lk.includes(sk))) {
      clean[k] = '***REDACTED***';
    } else {
      clean[k] = sanitizeForLog(v, depth + 1);
    }
  }
  return clean;
}

/**
 * Startup check: all mandatory env-vars must be set.
 * Exits process with code 1 if any are missing.
 */
function validateSecrets() {
  const missing = REQUIRED_SECRETS.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`FATAL: Missing required secrets: ${missing.join(', ')}`);
    console.error('Set the missing environment variables and restart the server.');
    process.exit(1);
  }
}

module.exports = { getSecret, sanitizeForLog, validateSecrets, REQUIRED_SECRETS };
