// ══════════════════════════════════════════════════════════════
//  Master Bot — PostgreSQL Adapter  (V2)
//  Persistenter Datenspeicher: Trades, Equity, Features, Market Mode etc.
//  Graceful Fallback auf JSON/In-Memory wenn DATABASE_URL nicht gesetzt.
// ══════════════════════════════════════════════════════════════
'use strict';

let Pool;
try { Pool = require('pg').Pool; } catch { /* pg nicht installiert → JSON-Fallback */ }

const pool = (Pool && process.env.DATABASE_URL) ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
}) : null;

const available = !!pool;

// ── Schema ─────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id        SERIAL PRIMARY KEY,
  strategie TEXT NOT NULL,
  datum     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pnl       DECIMAL(12,2),
  equity    DECIMAL(12,2),
  side      TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_strat ON trades(strategie, datum DESC);

CREATE TABLE IF NOT EXISTS equity_history (
  id        SERIAL PRIMARY KEY,
  strategie TEXT NOT NULL,
  equity    DECIMAL(12,2),
  ts        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equity_strat ON equity_history(strategie, ts DESC);

CREATE TABLE IF NOT EXISTS performance (
  strategie     TEXT PRIMARY KEY,
  trades_count  INTEGER     DEFAULT 0,
  gewinn        INTEGER     DEFAULT 0,
  verlust       INTEGER     DEFAULT 0,
  gesamt_pnl    DECIMAL(12,2) DEFAULT 0,
  bester        DECIMAL(12,2) DEFAULT 0,
  schlechtester DECIMAL(12,2) DEFAULT 0,
  equity        DECIMAL(12,2) DEFAULT 0,
  win_rate      DECIMAL(6,2)  DEFAULT 0,
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stunden_stats (
  strategie TEXT    NOT NULL,
  stunde    INTEGER NOT NULL,
  wins      INTEGER DEFAULT 0,
  losses    INTEGER DEFAULT 0,
  PRIMARY KEY (strategie, stunde)
);

CREATE TABLE IF NOT EXISTS tuning_history (
  id        SERIAL PRIMARY KEY,
  strategie TEXT NOT NULL,
  ts        TIMESTAMPTZ DEFAULT NOW(),
  aktion    TEXT,
  wr        DECIMAL(6,2),
  konsek    INTEGER,
  risk_pct  DECIMAL(6,3)
);
CREATE INDEX IF NOT EXISTS idx_tuning_strat ON tuning_history(strategie, ts DESC);

CREATE TABLE IF NOT EXISTS market_mode (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  modus           TEXT    NOT NULL DEFAULT 'SIDEWAYS',
  preis           DECIMAL(10,2),
  ema20           DECIMAL(10,4),
  ema50           DECIMAL(10,4),
  atr             DECIMAL(10,4),
  atr_avg         DECIMAL(10,4),
  momentum        DECIMAL(8,2),
  aktualisiert_am TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS features (
  id              SERIAL PRIMARY KEY,
  ts              BIGINT NOT NULL,
  strategie       TEXT,
  side            TEXT,
  equity          DECIMAL(12,2),
  hour            INTEGER,
  weekday         INTEGER,
  recent_wr5      DECIMAL(6,2),
  recent_wr15     DECIMAL(6,2),
  konsek          INTEGER,
  rrr             DECIMAL(6,2),
  ausgefuehrt     BOOLEAN,
  grund           TEXT,
  market_modus    TEXT,
  sl_dist_pct     DECIMAL(8,3),
  reward_pct      DECIMAL(8,3),
  spread          DECIMAL(10,5),
  session_london  INTEGER,
  session_overlap INTEGER,
  drawdown_pct    DECIMAL(8,2),
  pnl             DECIMAL(12,2)
);
CREATE INDEX IF NOT EXISTS idx_features_strat ON features(strategie, ausgefuehrt);

CREATE TABLE IF NOT EXISTS signals (
  id        SERIAL PRIMARY KEY,
  ts        BIGINT NOT NULL,
  strategie TEXT,
  side      TEXT,
  sl        DECIMAL(10,2),
  tp        DECIMAL(10,2)
);
`;

async function init() {
  if (!pool) return false;
  try {
    await pool.query(SCHEMA);
    return true;
  } catch (err) {
    console.error('[DB] Schema-Fehler:', err.message);
    throw err;
  }
}

// ── Trades ─────────────────────────────────────────────────────────────
async function getTrades(strategie, limit = 500) {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT strategie, datum::text as datum, pnl::float, equity::float, side
     FROM trades WHERE strategie=$1 ORDER BY datum ASC LIMIT $2`,
    [strategie, limit]
  );
  return r.rows;
}

async function addTrade(strategie, trade) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO trades (strategie, datum, pnl, equity, side) VALUES ($1,$2,$3,$4,$5)',
    [strategie, trade.datum || new Date().toISOString(), trade.pnl, trade.equity, trade.side]
  );
}

// ── Equity History ──────────────────────────────────────────────────────
async function getEquityHistory(strategie, limit = 500) {
  if (!pool) return [];
  const r = await pool.query(
    'SELECT equity::float, ts FROM equity_history WHERE strategie=$1 ORDER BY ts ASC LIMIT $2',
    [strategie, limit]
  );
  return r.rows;
}

async function addEquity(strategie, equity, ts) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO equity_history (strategie, equity, ts) VALUES ($1,$2,$3)',
    [strategie, equity, ts]
  );
}

// ── Performance ─────────────────────────────────────────────────────────
async function getPerformance(strategie) {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM performance WHERE strategie=$1', [strategie]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    trades:       row.trades_count,
    gewinn:       row.gewinn,
    verlust:      row.verlust,
    gesamtPnL:    parseFloat(row.gesamt_pnl),
    bester:       parseFloat(row.bester),
    schlechtester:parseFloat(row.schlechtester),
    equity:       parseFloat(row.equity),
    winRate:      parseFloat(row.win_rate),
  };
}

async function setPerformance(strategie, p) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO performance (strategie, trades_count, gewinn, verlust, gesamt_pnl, bester, schlechtester, equity, win_rate, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (strategie) DO UPDATE SET
      trades_count=$2, gewinn=$3, verlust=$4, gesamt_pnl=$5,
      bester=$6, schlechtester=$7, equity=$8, win_rate=$9, updated_at=NOW()`,
    [strategie, p.trades, p.gewinn, p.verlust, p.gesamtPnL, p.bester, p.schlechtester, p.equity, p.winRate]
  );
}

// ── Stunden Stats ───────────────────────────────────────────────────────
async function getStunden(strategie) {
  if (!pool) return {};
  const r = await pool.query(
    'SELECT stunde, wins, losses FROM stunden_stats WHERE strategie=$1',
    [strategie]
  );
  const obj = {};
  for (const row of r.rows) obj[row.stunde] = { wins: row.wins, losses: row.losses };
  return obj;
}

async function updateStunden(strategie, stunde, pnl) {
  if (!pool) return;
  const wins   = pnl > 0 ? 1 : 0;
  const losses = pnl < 0 ? 1 : 0;
  await pool.query(`
    INSERT INTO stunden_stats (strategie, stunde, wins, losses) VALUES ($1,$2,$3,$4)
    ON CONFLICT (strategie, stunde) DO UPDATE
      SET wins=stunden_stats.wins+$3, losses=stunden_stats.losses+$4`,
    [strategie, stunde, wins, losses]
  );
}

// ── Tuning History ──────────────────────────────────────────────────────
async function getTuning(strategie) {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT ts::text, aktion, wr::float, konsek, risk_pct::float as "riskPct"
     FROM tuning_history WHERE strategie=$1 ORDER BY ts DESC LIMIT 100`,
    [strategie]
  );
  return r.rows.reverse();
}

async function addTuning(strategie, entry) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO tuning_history (strategie, ts, aktion, wr, konsek, risk_pct) VALUES ($1,$2,$3,$4,$5,$6)',
    [strategie, entry.ts || new Date().toISOString(), entry.aktion, entry.wr, entry.konsek, entry.riskPct]
  );
}

// ── Market Mode ─────────────────────────────────────────────────────────
async function getMarketMode() {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM market_mode WHERE id=1');
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    modus:          row.modus,
    preis:          row.preis    != null ? parseFloat(row.preis)    : null,
    ema20:          row.ema20    != null ? parseFloat(row.ema20)    : null,
    ema50:          row.ema50    != null ? parseFloat(row.ema50)    : null,
    atr:            row.atr      != null ? parseFloat(row.atr)      : null,
    atrAvg:         row.atr_avg  != null ? parseFloat(row.atr_avg)  : null,
    momentum:       row.momentum != null ? parseFloat(row.momentum) : null,
    aktualisiertAm: row.aktualisiert_am  ? row.aktualisiert_am.toISOString() : null,
  };
}

async function setMarketMode(mm) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO market_mode (id, modus, preis, ema20, ema50, atr, atr_avg, momentum, aktualisiert_am)
    VALUES (1,$1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (id) DO UPDATE
      SET modus=$1, preis=$2, ema20=$3, ema50=$4, atr=$5, atr_avg=$6, momentum=$7, aktualisiert_am=NOW()`,
    [mm.modus, mm.preis, mm.ema20, mm.ema50, mm.atr, mm.atrAvg ?? mm.atr_avg, mm.momentum]
  );
}

// ── Features (ML-Training, geteilt mit ml-service) ──────────────────────
async function logFeature(f) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO features
      (ts, strategie, side, equity, hour, weekday, recent_wr5, recent_wr15, konsek, rrr,
       ausgefuehrt, grund, market_modus, sl_dist_pct, reward_pct, spread,
       session_london, session_overlap, drawdown_pct, pnl)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      f.ts, f.strategie, f.side, f.equity, f.hour, f.weekday,
      f.recentWR5, f.recentWR15, f.konsek, f.rrr,
      f.ausgefuehrt, f.grund, f.marketModus, f.slDistPct, f.rewardPct, f.spread,
      f.sessionLondon, f.sessionOverlap, f.drawdownPct, f.pnl ?? null,
    ]
  );
}

async function getFeatures(strategie, limit = 2000) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT ts, strategie, side, equity::float, hour, weekday,
      recent_wr5::float    AS "recentWR5",
      recent_wr15::float   AS "recentWR15",
      konsek, rrr::float, ausgefuehrt, grund,
      market_modus         AS "marketModus",
      sl_dist_pct::float   AS "slDistPct",
      reward_pct::float    AS "rewardPct",
      spread::float, session_london AS "sessionLondon",
      session_overlap      AS "sessionOverlap",
      drawdown_pct::float  AS "drawdownPct",
      pnl::float
    FROM features
    WHERE strategie=$1 AND ausgefuehrt=true AND pnl IS NOT NULL
    ORDER BY ts DESC LIMIT $2`,
    [strategie, limit]
  );
  return r.rows.reverse();  // chronologisch (aelteste zuerst)
}

// ── Signals (Backtest-Replay) ───────────────────────────────────────────
async function addSignal(s) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO signals (ts, strategie, side, sl, tp) VALUES ($1,$2,$3,$4,$5)',
    [s.ts, s.strategie, s.side, s.sl, s.tp]
  );
}

async function getSignals(limit = 200) {
  if (!pool) return [];
  const r = await pool.query(
    'SELECT ts, strategie, side, sl::float, tp::float FROM signals ORDER BY ts DESC LIMIT $1',
    [limit]
  );
  return r.rows.reverse();
}

module.exports = {
  available,
  init,
  getTrades,        addTrade,
  getEquityHistory, addEquity,
  getPerformance,   setPerformance,
  getStunden,       updateStunden,
  getTuning,        addTuning,
  getMarketMode,    setMarketMode,
  logFeature,       getFeatures,
  addSignal,        getSignals,
};
