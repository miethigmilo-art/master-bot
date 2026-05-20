require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const { WebSocketServer } = require('ws');

// ── Security Layer: Startup Checks ───────────────────────────────────────────
const { validateSecrets, sanitizeForLog } = require('./security/secrets');
validateSecrets();  // exits with code 1 if API_SECRET is missing

const { validateOrder, validateWebhookPayload } = require('./security/order-validator');
const { killSwitch }                            = require('./security/kill-switch');
const { eventStore, EVENT_TYPES: SEC_EVENT_TYPES } = require('./security/event-store');
const { authMiddleware }                        = require('./security/auth-middleware');
const { deduplicator: secDeduplicator }         = require('./security/deduplication');
const { BrokerSandbox }                         = require('./security/broker-sandbox');
const { runRecoveryTests }                      = require('./security/recovery-test');
// ─────────────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
// Auth middleware must be registered BEFORE static files and all routes
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const PORT     = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL;
const _mlRaw   = process.env.ML_SERVICE_URL || null;
const ML_URL   = _mlRaw ? (_mlRaw.startsWith('http') ? _mlRaw : `https://${_mlRaw}`) : null;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Backtesting Engine ────────────────────────────────
const BT = require('./backtest');
const db = require('./db');
const { bus, STREAMS, EVENT_TYPES } = require('./eventbus');
const { RiskEngine } = require('./risk_engine');
const { aggregateAgents } = require('./agents');
const { breakers, dedup, metrics, validator } = require('./hardening');
const { SignalGenerator, MultiAssetScanner, detectSignal } = require('./signal_generator');
const { createBroker } = require('./broker');
const { ReplayEngine, createReplayRouter } = require('./replay');
const { startSnapshotLoop, reconcileOnStartup, deduplicator } = require('./recovery');
const { AutoRetrain } = require('./autoretrain');
const { adaptiveSizingFactor } = require('./sizing');
const { correlationFilter, trackPosition } = require('./correlation');
const portfolioRisk = require('./portfolio');
const { PortfolioManager } = require('./portfolio-manager');

// ── Settings ──────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
let SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
// Original-Werte merken (für AutoTune-Wiederherstellung)
const SETTINGS_ORIGINAL = JSON.parse(JSON.stringify(SETTINGS));

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(SETTINGS, null, 2));
}

// ── Strategy Registry ────────────────────────────────
// Strategies are defined by SETTINGS keys — no per-account credentials.
// A single broker account (IBKR) is orchestrated centrally.
// Set BROKER_ADAPTER=paper for simulation mode.
const STRATEGY_IDS = Object.keys(SETTINGS);

// ── Broker + Portfolio Manager ────────────────────────
const broker = new BrokerSandbox(createBroker());   // reads BROKER_ADAPTER env var; sandboxed when BROKER_SANDBOX=true
const portfolioManager = new PortfolioManager();

// Wire broker events into EventBus
broker.on('broker_event', (ev) => {
  bus.emit_event(ev.type, 'broker', ev, ev.correlationId);
  broadcast('broker_event', ev);
});

// Initialise virtual portfolios from SETTINGS
// Each strategy gets an equal share by default; override via PORTFOLIO_CONFIG_JSON
function initPortfolioAllocations() {
  let customConfig = {};
  try {
    if (process.env.PORTFOLIO_CONFIG_JSON) customConfig = JSON.parse(process.env.PORTFOLIO_CONFIG_JSON);
  } catch {}
  const equalShare = parseFloat((100 / STRATEGY_IDS.length).toFixed(1));
  for (const id of STRATEGY_IDS) {
    const s = SETTINGS[id] || {};
    portfolioManager.setAllocation(id, {
      allocPct:       customConfig[id]?.allocPct       ?? equalShare,
      maxDrawdownPct: customConfig[id]?.maxDrawdownPct ?? (s.maxDrawdownPct || 20),
      maxExposurePct: customConfig[id]?.maxExposurePct ?? 60,
      minRRR:         customConfig[id]?.minRRR         ?? (s.minRRR || 2.0),
    });
  }
}
initPortfolioAllocations();

// Sync portfolio capital from broker balance periodically
async function syncPortfolioCapital() {
  try {
    const balance = await broker.getBalance();
    if (balance > 0) portfolioManager.setTotalCapital(balance);
  } catch {}
}

// ── State ─────────────────────────────────────────────
const PERF_PATH   = path.join(DATA_DIR, 'performance.json');
const EQUITY_PATH = path.join(DATA_DIR, 'equity.json');
const TRADES_PATH = path.join(DATA_DIR, 'trades.json');

let performance   = loadJSON(PERF_PATH,   buildDefaultPerf());
let equityHistory = loadJSON(EQUITY_PATH, {});
let tradeHistory  = loadJSON(TRADES_PATH, {});
let tagesStart    = {};
let letzteEquity  = {};
let aktiveTrades  = {};
let sigGen = null;  // Signal Generator Instanz (V4 #14)
let letzterTrade  = {};
let logs          = [];

// ── AutoTune State ────────────────────────────────────
const TUNING_PATH   = path.join(DATA_DIR, 'tuning.json');
const STUNDEN_PATH  = path.join(DATA_DIR, 'stunden.json');  // FIX 4: Persistenz-Pfad
let tuningHistory   = loadJSON(TUNING_PATH, {});
let stundenStats    = loadJSON(STUNDEN_PATH, {});  // FIX 4: Beim Start aus Datei laden

// FIX 1: Pending Features für PnL-Feedback Loop
// Speichert Feature-Objekte ausgeführter Trades bis der PnL bekannt ist
const pendingFeatures = {};

// ── Market Mode State ─────────────────────────────────────────────────
const MARKET_MODE_PATH = path.join(DATA_DIR, 'market_mode.json');
let marketMode = loadJSON(MARKET_MODE_PATH, { modus: 'SIDEWAYS', ema20: null, ema50: null, atr: null, atrAvg: null, aktualisiertAm: null });

// AutoTune Schwellen
const TUNING = {
  WR_REDUCE:          0.40,  // unter 40% Rolling-WR → Risk halbieren
  WR_RESTORE:         0.55,  // über 55% Rolling-WR → Risk wiederherstellen
  RISK_FACTOR:        0.50,  // Risk auf 50% des Originals reduzieren
  MIN_TRADES:         8,     // mindestens X Trades bevor Tuning greift
  KONSEK_REDUCE:      3,     // X konsek. Verluste → Risk halbieren
  HOUR_MIN_TRADES:    10,    // min. Trades pro Stunde für Stunden-Auswertung
  HOUR_BAD_WR:        0.30,  // WR in einer Stunde unter 30% → schlechte Stunde
};

// Smart Regime
const SMART = { modus: 'AKTIV', pauseBis: null, geaendertAm: null, rollendeWR: null, konsekVerluste: 0 };
const WR_PAUSE = 0.35, WR_VORSICHTIG = 0.42, KONSE_MAX = 4, PAUSE_MS = 2 * 60 * 60 * 1000;

// ── Market Mode Konfiguration ─────────────────────────────────────────
// sizingFaktor:    multipliziert ML-Sizing (z.B. 0.7 × 1.0× ML = 0.7× Position)
// konfidenzAdjust: verschiebt den ML-Schwellwert (positiv = strenger, negativ = lockerer)
const BASIS_KONFIDENZ = parseFloat(process.env.PREDICT_CONF || '0.62');

const MARKET_MODES = {
  PANIC:    { emoji: '🆘', sizingFaktor: 0.0, konfidenzAdjust: +0.10 },  // blockiert (PANIC = kein Trading)
  HIGH_VOL: { emoji: '⚡', sizingFaktor: 0.7, konfidenzAdjust: +0.06 },  // 0.62 + 0.06 = 0.68 (strenger)
  BEAR:     { emoji: '🐻', sizingFaktor: 0.8, konfidenzAdjust: +0.03 },  // 0.62 + 0.03 = 0.65 (vorsichtiger)
  SIDEWAYS: { emoji: '➡️', sizingFaktor: 1.0, konfidenzAdjust:  0.00 },  // 0.62       = normal
  BULL:     { emoji: '🐂', sizingFaktor: 1.2, konfidenzAdjust: -0.04 },  // 0.62 - 0.04 = 0.58 (aggressiver)
};

function buildDefaultPerf() {
  const p = {};
  STRATEGY_IDS.forEach(n => { p[n] = { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bester: 0, schlechtester: 0, equity: SETTINGS[n]?.startEquity || 1000, winRate: 0 }; });
  return p;
}

function loadJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function saveJSON(p, d) {
  try { fs.writeFileSync(p, JSON.stringify(d)); } catch {}
}

// ── WebSocket Broadcast ───────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function addLog(level, msg) {
  const entry = { level, msg, ts: new Date().toISOString() };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  broadcast('log', entry);
  console.log(`[${level}] ${msg}`);
}

// ── Event Bus Helpers ───────────────────────────────────
function waitForRiskDecision(signalEventId, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      bus.off(STREAMS.RISK, handler);
      reject(new Error('Risk Engine Timeout'));
    }, timeoutMs);
    function handler(event) {
      if (!event.payload || event.payload.signalEventId !== signalEventId) return;
      clearTimeout(timer);
      bus.off(STREAMS.RISK, handler);
      resolve(event);
    }
    bus.on(STREAMS.RISK, handler);
  });
}

bus.subscribe('*', function(event) {
  broadcast('bus_event', { stream: event.stream, type: event.type, source: event.source, ts: event.timestamp });
});

// ── Audit Persistence: write every bus event to audit.jsonl ─────────────────
// This feeds the Replay Engine (Phase 9) with durable event history.
const AUDIT_PATH = path.join(DATA_DIR, 'audit.jsonl');
bus.subscribe('*', function(event) {
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(event) + '\n');
  } catch {}
});

// ── Broker Auth ──────────────────────────────────────
// Auth is handled inside broker adapter (IBKRAdapter/PaperAdapter).
async function ensureAuth(_name) { /* no-op — adapter manages connection */ }

// ── Capital.com Market Data Session ──────────────────
// Used by the Signal Generator to fetch historical price data.
// Order execution goes through IBKR; only market data comes from Capital.com.
const _capSession = {
  cst:       null,
  secToken:  null,
  expiresAt: 0,
};

async function _capitalLogin() {
  const url      = (process.env.BASE_URL || 'https://demo-api-capital.backend-capital.com/api/v1') + '/session';
  const apiKey   = process.env.API_KEY;
  const email    = process.env.EMAIL;
  const password = process.env.PASSWORD;
  if (!apiKey || !email || !password) throw new Error('Capital.com market-data credentials missing (API_KEY / EMAIL / PASSWORD)');
  const r = await axios.post(url, { identifier: email, password }, {
    headers: { 'X-CAP-API-KEY': apiKey, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  _capSession.cst      = r.headers['cst'];
  _capSession.secToken = r.headers['x-security-token'];
  _capSession.expiresAt = Date.now() + 9 * 60 * 1000; // refresh before 10-min expiry
  addLog('info', '[CapData] Capital.com market-data session refreshed');
}

async function getCapitalHeaders() {
  if (!_capSession.cst || Date.now() > _capSession.expiresAt) {
    await _capitalLogin();
  }
  return {
    'X-CAP-API-KEY':     process.env.API_KEY,
    'CST':               _capSession.cst,
    'X-SECURITY-TOKEN':  _capSession.secToken,
    'Content-Type':      'application/json',
  };
}

async function getEquity(name) {
  // Equity = strategy's virtual allocation within the single broker account
  const vp = portfolioManager.get(name);
  if (vp) return vp.currentEquity;
  // Fallback: proportional share of total broker balance
  const balance = await broker.getBalance().catch(() => 0);
  return balance / Math.max(1, STRATEGY_IDS.length);
}

async function getPositions(name) {
  const positions = await broker.getPositions(name).catch(() => []);
  // Filter to positions tagged with this strategyId (IBKR doesn't tag — return all)
  return positions;
}


async function placeOrder(strategyId, order) {
  // Route through broker abstraction — adapter handles protocol details
  // order must be in HELIX generic format: { symbol, assetClass, side, size,
  //   stopLevel, profitLevel, strategyId, correlationId, ... }
  return broker.placeOrder(strategyId, { ...order, strategyId });
}

async function closePositions(strategyId, symbol) {
  // Close all open positions for this strategy+symbol via broker
  try {
    const positions = await broker.getPositions(strategyId);
    const toClose = positions.filter(p =>
      (!symbol || p.symbol === symbol || p.symbol === (symbol || '').toUpperCase())
    );
    for (const pos of toClose) {
      const closeOrder = {
        symbol:      pos.symbol,
        assetClass:  pos.assetClass || 'commodity',
        side:        pos.side === 'BUY' ? 'SELL' : 'BUY',
        size:        pos.size,
        orderType:   'MKT',
        strategyId,
      };
      await broker.placeOrder(strategyId, closeOrder);
    }
  } catch (err) {
    addLog('warn', `⚠️ [${strategyId}] closePositions: ${err.message}`);
  }
}

// ── Telegram ──────────────────────────────────────────
async function tg(msg) {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' });
  } catch {}
}

// ── Regime (Smart) ────────────────────────────────────
function berechneRegime() {
  const trades = tradeHistory['smart'] || [];
  let konsek = 0;
  for (let i = trades.length - 1; i >= 0; i--) { if (trades[i].pnl < 0) konsek++; else break; }
  SMART.konsekVerluste = konsek;
  const fenster = trades.slice(-15);
  if (fenster.length < 5) { SMART.rollendeWR = null; return 'AKTIV'; }
  const wr = fenster.filter(t => t.pnl > 0).length / fenster.length;
  SMART.rollendeWR = parseFloat((wr * 100).toFixed(1));
  if (konsek >= KONSE_MAX || wr < WR_PAUSE) return 'PAUSE';
  if (wr < WR_VORSICHTIG) return 'VORSICHTIG';
  return 'AKTIV';
}

async function pruefeRegime() {
  if (SMART.modus === 'PAUSE' && SMART.pauseBis && Date.now() < SMART.pauseBis)
    return { geblockt: true, grund: `PAUSE – noch ${Math.round((SMART.pauseBis - Date.now()) / 60000)} Min.` };
  const neu = berechneRegime();
  if (neu !== SMART.modus) {
    const alt = SMART.modus;
    SMART.modus = neu;
    SMART.geaendertAm = new Date().toISOString();
    SMART.pauseBis = neu === 'PAUSE' ? Date.now() + PAUSE_MS : null;
    await tg(`${neu === 'AKTIV' ? '🟢' : neu === 'VORSICHTIG' ? '🟡' : '🔴'} [Smart] Regime: ${alt} → ${neu}`);
    broadcast('regime', SMART);
    addLog('info', `🔄 [smart] Regime: ${alt} → ${neu}`);
  }
  if (SMART.modus === 'PAUSE') return { geblockt: true, grund: 'PAUSE aktiv' };
  return { geblockt: false, modus: SMART.modus };
}

// ── Performance Update ────────────────────────────────
function updatePerf(name, pnl) {
  const p = performance[name];
  p.trades++;
  p.gesamtPnL = parseFloat((p.gesamtPnL + pnl).toFixed(2));
  if (pnl > 0) { p.gewinn++; if (pnl > p.bester) p.bester = pnl; }
  else { p.verlust++; if (pnl < p.schlechtester) p.schlechtester = pnl; }
  p.winRate = parseFloat(((p.gewinn / p.trades) * 100).toFixed(1));
  saveJSON(PERF_PATH, performance);
  db.setPerformance(name, p).catch(() => {});
  broadcast('performance', { name, perf: p });
}

function addEquity(name, equity) {
  if (!equityHistory[name]) equityHistory[name] = [];
  const _ts = Date.now();
  equityHistory[name].push({ ts: _ts, equity });
  if (equityHistory[name].length > 500) equityHistory[name].shift();
  saveJSON(EQUITY_PATH, equityHistory);
  db.addEquity(name, equity, _ts).catch(() => {});
  broadcast('equity', { name, equity, ts: _ts });
}

function addTrade(name, trade) {
  if (!tradeHistory[name]) tradeHistory[name] = [];
  tradeHistory[name].push(trade);
  if (tradeHistory[name].length > 500) tradeHistory[name].shift();
  saveJSON(TRADES_PATH, tradeHistory);
  db.addTrade(name, trade).catch(() => {});
  trackStunde(name, trade.pnl);
}

// ── Stunden-Tracking ──────────────────────────────────
function trackStunde(name, pnl) {
  const h = new Date().getHours();
  if (!stundenStats[name]) stundenStats[name] = {};
  if (!stundenStats[name][h]) stundenStats[name][h] = { wins: 0, losses: 0 };
  if (pnl > 0) stundenStats[name][h].wins++;
  else stundenStats[name][h].losses++;
  saveJSON(STUNDEN_PATH, stundenStats);
  db.updateStunden(name, h, pnl).catch(() => {});
}

function istSchlechteStunde(name) {
  const h = new Date().getHours();
  const st = stundenStats[name]?.[h];
  if (!st) return false;
  const total = st.wins + st.losses;
  if (total < TUNING.HOUR_MIN_TRADES) return false;
  return (st.wins / total) < TUNING.HOUR_BAD_WR;
}

// ── AutoTune ──────────────────────────────────────────
async function autoTune(name) {
  const trades = tradeHistory[name] || [];
  const s = SETTINGS[name];
  const orig = SETTINGS_ORIGINAL[name];
  if (!s || !orig || trades.length < TUNING.MIN_TRADES) return;

  // Konsekutive Verluste zählen
  let konsek = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].pnl < 0) konsek++;
    else break;
  }

  // Rolling Win-Rate (letzte 15 Trades)
  const fenster = trades.slice(-15);
  const wr = fenster.filter(t => t.pnl > 0).length / fenster.length;
  const wrPct = parseFloat((wr * 100).toFixed(1));

  const reduziert = parseFloat((orig.riskPct * TUNING.RISK_FACTOR).toFixed(2));
  let aktion = null;

  if ((konsek >= TUNING.KONSEK_REDUCE || wr < TUNING.WR_REDUCE) && s.riskPct > reduziert) {
    const grund = konsek >= TUNING.KONSEK_REDUCE
      ? `${konsek}x konsek. Verlust`
      : `WR ${wrPct}% < ${TUNING.WR_REDUCE * 100}%`;
    aktion = `🔽 AutoTune [${name}]: ${grund} → Risk ${orig.riskPct}% → ${reduziert}%`;
    SETTINGS[name].riskPct = reduziert;
  } else if (wr >= TUNING.WR_RESTORE && s.riskPct < orig.riskPct) {
    aktion = `🔼 AutoTune [${name}]: WR ${wrPct}% → Risk zurück auf ${orig.riskPct}%`;
    SETTINGS[name].riskPct = orig.riskPct;
  }

  if (aktion) {
    saveSettings();
    addLog('tuning', aktion);
    await tg(aktion);
    broadcast('settings', { name, settings: SETTINGS[name] });
    broadcast('tuning', { name, aktion, wr: wrPct, konsek, ts: new Date().toISOString() });
    if (!tuningHistory[name]) tuningHistory[name] = [];
    const _te = { ts: new Date().toISOString(), aktion, wr: wrPct, konsek, riskPct: SETTINGS[name].riskPct };
    tuningHistory[name].push(_te);
    db.addTuning(name, _te).catch(() => {});
    if (tuningHistory[name].length > 100) tuningHistory[name].shift();
    saveJSON(TUNING_PATH, tuningHistory);
  }

  // Nach jedem Trade auch Strategie-Score prüfen (pausiert schlechte Strategien)
  await pruefeStrategieScore(name);
}

// ── Strategie Scoring & Auto-Pause (V2 Item 7) ───────────────────────────
const SCORE_PATH = path.join(DATA_DIR, 'score_pauses.json');

const SCORE_CFG = {
  MIN_TRADES:   15,   // mindestens X Trades bevor Score berechnet wird
  PAUSE_UNTER:  25,   // Score < 25 → Strategie pausieren
  RESUME_UEBER: 40,   // Score ≥ 40 → Strategie wieder aktivieren
};

// scorePauses[name] = { paused: bool, score: number|null, grund: string, geaendertAm: string }
let scorePauses = loadJSON(SCORE_PATH, {});

// ── Risk Engine (module-scope so it's ready before any webhook fires) ─────────
const riskEngine = new RiskEngine(() => ({
  settings:    SETTINGS,
  performance,
  marketMode,
  marketModes: MARKET_MODES,
  scorePauses,
  tagesStart,
}));

function scoreBadge(score) {
  if (score === null || score === undefined) return '⚪';
  if (score >= 60) return '🟢';
  if (score >= 40) return '🟡';
  if (score >= 25) return '🟠';
  return '🔴';
}

// Score-basiertes Sizing: graduell statt hart pausieren
function getScoreWeightFaktor(name) {
  const sp = scorePauses[name];
  if (!sp || sp.score == null) return 1.0;
  const s = sp.score;
  if (s >= 70) return 1.2;
  if (s >= 50) return 1.0;
  if (s >= 35) return 0.6;
  if (s >= 25) return 0.3;
  return 0.0;
}

async function pruefeStrategieScore(name) {
  const trades = tradeHistory[name] || [];
  if (trades.length < SCORE_CFG.MIN_TRADES) return;

  const metriken = BT.berechneMetriken(trades);
  const score    = BT.berechneStrategieScore(metriken);
  if (score === null) return;

  const prev  = scorePauses[name] || { paused: false };
  const badge = scoreBadge(score);

  if (!prev.paused && score < SCORE_CFG.PAUSE_UNTER) {
    // Score zu schlecht → Strategie pausieren
    scorePauses[name] = {
      paused:      true,
      score,
      grund:       `Score ${score}/100 < ${SCORE_CFG.PAUSE_UNTER} | WR: ${metriken.winRate}% | PF: ${metriken.profitFactor}`,
      geaendertAm: new Date().toISOString(),
    };
    saveJSON(SCORE_PATH, scorePauses);
    broadcast('score_pause', { name, ...scorePauses[name] });
    const msg = `${badge} [${name}] Score-Pause: ${score}/100 — WR ${metriken.winRate}%, PF ${metriken.profitFactor}`;
    addLog('tuning', msg);
    await tg(`🔴 <b>[${name}] Score-Pause aktiviert</b>\nScore: ${score}/100\nWin Rate: ${metriken.winRate}%\nProfit Factor: ${metriken.profitFactor}\n\n<i>Strategie pausiert bis Score ≥ ${SCORE_CFG.RESUME_UEBER}</i>`);
  } else if (prev.paused && score >= SCORE_CFG.RESUME_UEBER) {
    // Score erholt → Strategie wieder aktivieren
    scorePauses[name] = {
      paused:      false,
      score,
      grund:       `Score ${score}/100 ≥ ${SCORE_CFG.RESUME_UEBER} — wieder aktiv`,
      geaendertAm: new Date().toISOString(),
    };
    saveJSON(SCORE_PATH, scorePauses);
    broadcast('score_resume', { name, ...scorePauses[name] });
    const msg = `🟢 [${name}] Score-Resume: ${score}/100 — wieder aktiv`;
    addLog('tuning', msg);
    await tg(`🟢 <b>[${name}] Score-Pause aufgehoben</b>\nScore: ${score}/100\nWin Rate: ${metriken.winRate}%\nProfit Factor: ${metriken.profitFactor}`);
  } else {
    // Kein Statuswechsel — Score aktualisieren
    scorePauses[name] = { ...prev, score, geaendertAm: new Date().toISOString() };
    saveJSON(SCORE_PATH, scorePauses);
  }
  broadcast('score_status', scorePauses);
}

async function pruefeAlleScores() {
  addLog('info', '📊 Strategie-Score Check...');
  for (const name of STRATEGY_IDS) {
    try { await pruefeStrategieScore(name); } catch {}
  }
  broadcast('score_status', scorePauses);
}

// ── V3: Memory System ────────────────────────────────────────────────────────
// Merkt sich welche Marktbedingungen (Modus, Stunde, Wochentag, Side) zu Gewinnen führen.
// Wird beim PnL-Feedback-Loop aktualisiert und beeinflusst den Konfidenz-Schwellwert.

const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');

// memory[key] = { wins: N, losses: N }
// key = "MODUS_hour_weekday_side" z.B. "BULL_9_1_BUY"
let memory = loadJSON(MEMORY_PATH, {});

const MEMORY_CFG = {
  MIN_OBS:        8,    // mindestens X Beobachtungen bevor Memory aktiv
  BOOST_THRESH:   0.65, // WR >= 65% in dieser Bedingung → Konfidenz um 0.04 senken (Trade eher erlauben)
  REDUCE_THRESH:  0.35, // WR <= 35% in dieser Bedingung → Konfidenz um 0.04 erhöhen (Trade eher blocken)
  ADJ:            0.04, // Konfidenz-Anpassung (in ±)
};

function memoryKey(modus, hour, weekday, side) {
  return `${modus}_${hour}_${weekday}_${side}`;
}

function updateMemory(modus, hour, weekday, side, pnl) {
  if (!modus || pnl === 0) return;
  const key = memoryKey(modus, hour, weekday, side);
  if (!memory[key]) memory[key] = { wins: 0, losses: 0 };
  if (pnl > 0) memory[key].wins++;
  else memory[key].losses++;
  saveJSON(MEMORY_PATH, memory);
}

function getMemoryAdjust(modus, hour, weekday, side) {
  // Gibt Konfidenz-Anpassung zurück: positiv = strenger, negativ = lockerer
  const key = memoryKey(modus, hour, weekday, side);
  const m = memory[key];
  if (!m) return 0;
  const total = m.wins + m.losses;
  if (total < MEMORY_CFG.MIN_OBS) return 0;
  const wr = m.wins / total;
  if (wr >= MEMORY_CFG.BOOST_THRESH)  return -MEMORY_CFG.ADJ;  // gut → lockerer
  if (wr <= MEMORY_CFG.REDUCE_THRESH) return +MEMORY_CFG.ADJ;  // schlecht → strenger
  return 0;
}

function getMemoryInsight(name, side) {
  // Gibt eine kurze Zusammenfassung der besten/schlechtesten Bedingungen zurück
  const entries = Object.entries(memory)
    .filter(([k]) => k.endsWith('_' + side))
    .map(([key, m]) => {
      const total = m.wins + m.losses;
      const wr = total >= MEMORY_CFG.MIN_OBS ? (m.wins / total) : null;
      return { key, ...m, total, wr };
    })
    .filter(e => e.wr !== null)
    .sort((a, b) => b.wr - a.wr);
  return {
    best:  entries.slice(0, 3),
    worst: entries.slice(-3).reverse(),
    total: entries.length,
  };
}

// -- V3 Meta-Learning: Modell-Drift Detection ----------------------------
const META_CFG = {
  BUFFER_SIZE:     30,
  MIN_OUTCOMES:    15,
  DRIFT_THRESHOLD: 15,
  CONF_MIN:        0.54,
  MAX_DAYS:        14,
  CHECK_INTERVAL:  60,
};

const mlPredBuffer = {};

function trackMlPrediction(name, ml) {
  if (!ml || !ml.trainiert || ml.konfidenz == null) return;
  if (!mlPredBuffer[name]) mlPredBuffer[name] = [];
  mlPredBuffer[name].push({ ts: Date.now(), konfidenz: ml.konfidenz, win: null });
  if (mlPredBuffer[name].length > META_CFG.BUFFER_SIZE) mlPredBuffer[name].shift();
}

function trackMlOutcome(name, win) {
  const buf = mlPredBuffer[name];
  if (!buf) return;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].win === null) { buf[i].win = win; break; }
  }
}

async function triggerRetrain(strategie) {
  if (!ML_URL) return;
  try {
    await axios.post(`${ML_URL}/train`, { strategie }, { timeout: 30000 });
    addLog('tuning', `[Meta] Retrain ausgeloest: ${strategie}`);
    bus.emit_event(EVENT_TYPES.AUTOTUNE_TRIGGERED, 'meta_learning', { strategie, grund: 'model_drift' });
    broadcast('meta_retrain', { strategie, ts: Date.now() });
    await tg(`<b>Meta-Learning: Retrain</b> -- ${strategie}
Modell-Drift erkannt, Retraining ausgeloest.`);
  } catch (err) {
    addLog('warn', `[Meta] Retrain fehlgeschlagen: ${err.message}`);
  }
}

async function pruefeModelDrift() {
  if (!ML_URL) return;
  for (const name of Object.keys(SETTINGS)) {
    const buf = mlPredBuffer[name] || [];
    const withOutcome = buf.filter(e => e.win !== null);
    const status = (mlStatus || {})[name];
    const meta   = status?.meta;
    const needsRetrain = [];

    if (meta?.trainiert_am) {
      const days = (Date.now() - new Date(meta.trainiert_am).getTime()) / (1000 * 60 * 60 * 24);
      if (days > META_CFG.MAX_DAYS) needsRetrain.push(`${days.toFixed(0)}d ohne Retrain`);
    }

    if (withOutcome.length >= META_CFG.MIN_OUTCOMES && meta?.accuracy_cv) {
      const recentAcc = withOutcome.filter(e => e.win).length / withOutcome.length * 100;
      const modelAcc  = meta.accuracy_cv * 100;
      const drift     = modelAcc - recentAcc;
      if (drift > META_CFG.DRIFT_THRESHOLD) {
        needsRetrain.push(`Accuracy-Drift ${drift.toFixed(1)}% (Modell: ${modelAcc.toFixed(0)}%, Aktuell: ${recentAcc.toFixed(0)}%)`);
      }
    }

    if (buf.length >= 10) {
      const avgConf = buf.slice(-10).reduce((s, e) => s + e.konfidenz, 0) / 10;
      if (avgConf < META_CFG.CONF_MIN) needsRetrain.push(`Avg-Konfidenz ${(avgConf*100).toFixed(0)}% < ${META_CFG.CONF_MIN*100}%`);
    }

    if (needsRetrain.length > 0) {
      addLog('tuning', `[Meta] Drift [${name}]: ${needsRetrain.join(' | ')}`);
      broadcast('meta_drift', { name, gruende: needsRetrain, ts: Date.now() });
      await triggerRetrain(name);
    }
  }
}

// ── ML-Service Integration ────────────────────────────
let mlStatus = {};  // { strategie: { trainiert, n_trades, accuracy } }

async function mlPredict(name, side, equity, rrr) {
  if (!ML_URL) return { empfehlung: 'trade', grund: 'ML nicht konfiguriert', trainiert: false };
  try {
    const trades = tradeHistory[name] || [];
    const f5  = trades.slice(-5).filter(t => t.pnl !== 0);
    const f15 = trades.slice(-15).filter(t => t.pnl !== 0);
    const res = await axios.post(`${ML_URL}/predict`, {
      strategie:  name,
      side,
      equity,
      rrr:        rrr || 2.0,
      recentWR5:  f5.length  ? parseFloat(((f5.filter(t=>t.pnl>0).length/f5.length)*100).toFixed(1))  : null,
      recentWR15: f15.length ? parseFloat(((f15.filter(t=>t.pnl>0).length/f15.length)*100).toFixed(1)) : null,
      konsek:     berechneKonsek(name),
      threshold:  getKonfidenzSchwelle(side, new Date().getHours(), new Date().getDay()),  // Market Mode + Memory
    }, { timeout: 3000 });
    return res.data;
  } catch (err) {
    addLog('warn', `⚠️ ML-Service nicht erreichbar: ${err.message} — Trade wird trotzdem ausgeführt`);
    return { empfehlung: 'trade', grund: 'ML-Fehler (fail-safe)', trainiert: false };
  }
}

async function aktualisiereMlStatus() {
  if (!ML_URL) return;
  try {
    const res = await axios.get(`${ML_URL}/status`, { timeout: 5000 });
    mlStatus = res.data;
    broadcast('ml_status', mlStatus);
  } catch {}
}

// ── Feature Logger + Signal Logger ───────────────────
const FEATURES_PATH = path.join(DATA_DIR, 'features.jsonl');
const SIGNALS_PATH  = path.join(DATA_DIR, 'signals.jsonl');  // Für Backtesting-Replay

function berechneWR(name, n) {
  const t = (tradeHistory[name] || []).slice(-n);
  if (!t.length) return null;
  return parseFloat(((t.filter(x => x.pnl > 0).length / t.length) * 100).toFixed(1));
}

function berechneKonsek(name) {
  const trades = tradeHistory[name] || [];
  let k = 0;
  for (let i = trades.length - 1; i >= 0; i--) { if (trades[i].pnl < 0) k++; else break; }
  return k;
}

// FIX 1 + FIX 3: logFeature mit PnL-Feedback Loop und erweiterten Features
// extras = { offer, bid, entry, slF, tpF } — alle optional, aus dem Markt-Snapshot
function logFeature(name, side, equity, rrr, ausgefuehrt, grund = null, extras = {}, correlationId = null) {
  try {
    const s    = SETTINGS[name] || {};
    const hour = new Date().getHours();
    const { offer = null, bid = null, entry = null, slF = null, tpF = null } = extras;

    const feature = {
      ts: Date.now(), correlationId: correlationId || null, strategie: name, side, equity,
      hour, weekday: new Date().getDay(),
      recentWR5:  berechneWR(name, 5),
      recentWR15: berechneWR(name, 15),
      konsek:     berechneKonsek(name),
      rrr:        rrr || null,
      ausgefuehrt,
      grund,
      marketModus: marketMode.modus,
      // FIX 3: Neue Features für besseres ML-Training
      slDistPct:      (entry != null && slF != null && entry > 0)
                        ? parseFloat((Math.abs(entry - slF) / entry * 100).toFixed(3))
                        : null,
      rewardPct:      (entry != null && tpF != null && entry > 0)
                        ? parseFloat((Math.abs(tpF - entry) / entry * 100).toFixed(3))
                        : null,
      spread:         (offer != null && bid != null)
                        ? parseFloat((offer - bid).toFixed(5))
                        : null,
      sessionLondon:  (hour >= 8  && hour < 12) ? 1 : 0,
      sessionOverlap: (hour >= 13 && hour < 17) ? 1 : 0,
      drawdownPct:    s.startEquity > 0
                        ? parseFloat(((s.startEquity - equity) / s.startEquity * 100).toFixed(2))
                        : 0,
    };

    if (ausgefuehrt) {
      // FIX 1: Trade ausgeführt → in pendingFeatures merken, PnL kommt beim nächsten Webhook
      pendingFeatures[name] = feature;
    } else {
      // FIX 1: Skip/Filter → sofort mit pnl: null in Datei schreiben
      feature.pnl = null;
      fs.appendFileSync(FEATURES_PATH, JSON.stringify(feature) + '\n');
      db.logFeature(feature).catch(() => {});
    }
  } catch {}
}

// ── Market Mode Detection (V2) ───────────────────────────────────────

function berechneEMA(werte, periode) {
  if (!werte || werte.length < periode) return null;
  const k = 2 / (periode + 1);
  let ema = werte.slice(0, periode).reduce((a, b) => a + b, 0) / periode;
  for (let i = periode; i < werte.length; i++) ema = werte[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(4));
}

function berechneATR(candles, periode = 14) {
  if (!candles || candles.length < periode + 1) return null;
  const mid = c => ((c?.bid || 0) + (c?.ask || 0)) / 2 || c?.bid || 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = mid(candles[i].highPrice), l = mid(candles[i].lowPrice), c = mid(candles[i-1].closePrice);
    if (!h || !l || !c) continue;
    trs.push(Math.max(h - l, Math.abs(h - c), Math.abs(l - c)));
  }
  if (trs.length < periode) return null;
  let atr = trs.slice(0, periode).reduce((a, b) => a + b, 0) / periode;
  const alle = [atr];
  for (let i = periode; i < trs.length; i++) { atr = (atr * (periode - 1) + trs[i]) / periode; alle.push(atr); }
  return { current: alle[alle.length - 1], avg: alle.reduce((a, b) => a + b, 0) / alle.length };
}

async function analysiereMarktmodus() {
  // Market data source is broker-agnostic.
  // Set MARKET_DATA_URL to any OHLC REST endpoint (e.g. Alpha Vantage, Polygon.io).
  // If not configured, market mode detection is skipped.
  const marketDataUrl = process.env.MARKET_DATA_URL;
  if (!marketDataUrl) {
    addLog('info', '📊 Market Mode: MARKET_DATA_URL not set — keeping last known mode');
    return;
  }
  const symbol = process.env.MARKET_DATA_SYMBOL || 'XAUUSD';

  try {
    const res = await axios.get(marketDataUrl, {
      params:  { symbol, resolution: 'HOUR', max: 100 },
      timeout: 10000,
    });
    const candles = res.data.prices || res.data.candles || (Array.isArray(res.data) ? res.data : null);
    if (!candles || candles.length < 55) {
      addLog('warn', `⚠️ Market Mode: Zu wenig Kerzen (${candles?.length || 0})`);
      return;
    }

    const mid    = c => ((c?.bid || 0) + (c?.ask || 0)) / 2 || c?.bid || 0;
    const closes = candles.map(c => mid(c.closePrice));
    const preis  = closes[closes.length - 1];

    const ema20     = berechneEMA(closes, 20);
    const ema50     = berechneEMA(closes, 50);
    const atrResult = berechneATR(candles, 14);
    const atr       = atrResult?.current;
    const atrAvg    = atrResult?.avg;

    // 5-Stunden-Momentum in %
    const momentum = closes.length >= 5
      ? parseFloat(((preis - closes[closes.length - 5]) / closes[closes.length - 5] * 100).toFixed(2))
      : 0;

    // Modus bestimmen
    let neuerModus;
    if (atr && atrAvg && atr > atrAvg * 1.8 && momentum < -2.5) neuerModus = 'PANIC';
    else if (atr && atrAvg && atr > atrAvg * 1.5)               neuerModus = 'HIGH_VOL';
    else if (ema20 && ema50 && preis > ema20 && ema20 > ema50 && momentum > 0) neuerModus = 'BULL';
    else if (ema20 && ema50 && preis < ema20 && ema20 < ema50 && momentum < 0) neuerModus = 'BEAR';
    else                                                                         neuerModus = 'SIDEWAYS';

    const alter = marketMode.modus;
    marketMode = {
      modus: neuerModus, preis: parseFloat(preis.toFixed(2)),
      ema20, ema50,
      atr:    atr    ? parseFloat(atr.toFixed(4))    : null,
      atrAvg: atrAvg ? parseFloat(atrAvg.toFixed(4)) : null,
      momentum, aktualisiertAm: new Date().toISOString(),
    };
    saveJSON(MARKET_MODE_PATH, marketMode);
    db.setMarketMode(marketMode).catch(() => {});
    broadcast('market_mode', marketMode);
    bus.emit_event(EVENT_TYPES.MARKET_MODE_UPDATED, 'market_analyser', { modus: neuerModus, alter, preis: marketMode.preis });

    const cfg = MARKET_MODES[neuerModus];
    if (neuerModus !== alter) {
      addLog('info', `${cfg.emoji} Market Mode: ${alter} → ${neuerModus} (EMA20=${ema20}, EMA50=${ema50}, ATR=${atr?.toFixed(2)}, Momentum=${momentum}%)`);
      await tg(`${cfg.emoji} <b>Market Mode: ${alter} → ${neuerModus}</b>\nEMA20: ${ema20} | EMA50: ${ema50} | Momentum: ${momentum}%`);
    } else {
      addLog('info', `📊 Market Mode: ${neuerModus} — EMA20=${ema20}, Momentum=${momentum}%`);
    }
  } catch (err) {
    addLog('warn', `⚠️ Market Mode Analyse: ${err.message}`);
  }
}

function getMarktSizingFaktor() {
  return MARKET_MODES[marketMode.modus]?.sizingFaktor ?? 1.0;
}

function getKonfidenzSchwelle(side, hour, weekday) {
  const adj = MARKET_MODES[marketMode.modus]?.konfidenzAdjust ?? 0;
  // V3 Memory: zusätzliche Anpassung basierend auf historischen Bedingungen
  const memAdj = (side && hour != null && weekday != null)
    ? getMemoryAdjust(marketMode.modus, hour, weekday, side)
    : 0;
  return parseFloat(Math.min(0.95, Math.max(0.50, BASIS_KONFIDENZ + adj + memAdj)).toFixed(2));
}

// ── Webhook Handler ───────────────────────────────────
async function handleWebhook(req, res, name) {
  // ── Security: Kill Switch (first gate) ───────────────────────────────────
  if (killSwitch.isActive()) {
    const ks = killSwitch.status();
    addLog('warn', `🔴 [KillSwitch] Webhook blocked for ${name}: ${ks.reason}`);
    return res.status(503).json({ status: 'blocked', reason: `KillSwitch active: ${ks.reason}`, activatedAt: ks.activatedAt });
  }

  // ── Security: Webhook Payload Validation ──────────────────────────────────
  if (!req.body._bypassFilters) {
    const payloadCheck = validateWebhookPayload(req.body);
    if (!payloadCheck.valid) {
      addLog('warn', `[OrderValidator] ${name}: payload rejected — ${payloadCheck.reason}`);
      eventStore.append(SEC_EVENT_TYPES.ORDER_VALIDATION_FAILED, { strategie: name, reason: payloadCheck.reason, body: sanitizeForLog(req.body) });
      return res.status(400).json({ status: 'rejected', reason: payloadCheck.reason });
    }
  }

  const s = SETTINGS[name];
  if (!s) return res.status(400).json({ error: 'Unbekannte Strategie' });
  if (!s.enabled) return res.json({ status: 'deaktiviert', strategie: name });

  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET)
    return res.status(401).json({ error: 'Ungültiger Secret' });

  // ── Security: correlationId-based Deduplication ───────────────────────────
  // Extract or generate a correlationId from the incoming payload.
  const incomingCorrelationId = req.body.correlationId || null;
  if (incomingCorrelationId && secDeduplicator.isDuplicate(incomingCorrelationId)) {
    metrics.inc('signal_dedup');
    addLog('warn', `[Security/Dedup] ${name}: duplicate correlationId ${incomingCorrelationId} — rejected`);
    eventStore.append(SEC_EVENT_TYPES.WEBHOOK_DUPLICATE, { strategie: name, correlationId: incomingCorrelationId });
    return res.json({ status: 'duplicate', correlationId: incomingCorrelationId });
  }

  if (!req.body._bypassFilters && aktiveTrades[name]) return res.status(429).json({ error: 'Trade läuft bereits' });
  if (!req.body._bypassFilters && letzterTrade[name] && Date.now() - letzterTrade[name] < 30000)
    return res.status(429).json({ error: 'Cooldown aktiv (30s)' });

  // -- HARDENING: Signal Deduplication (existing 15s window) ----------------
  if (!req.body._bypassFilters && dedup.isDuplicate(name, req.body.side, req.body.sl, req.body.tp)) {
    metrics.inc('signal_dedup');
    addLog('warn', `[Dedup] ${name}: identisches Signal innerhalb 15s ignoriert`);
    return res.status(429).json({ error: 'Duplikat-Signal ignoriert (15s Fenster)' });
  }

  aktiveTrades[name] = true;
  try {
    addLog('info', `📨 Signal [${name}]: ${JSON.stringify(sanitizeForLog(req.body))}`);
    const sigReceivedEvent = bus.emit_event(EVENT_TYPES.SIGNAL_RECEIVED, 'webhook', { strategie: name, epic: req.body.epic || 'GOLD', side: req.body.side, sl: req.body.sl, tp: req.body.tp });
    const correlationId = incomingCorrelationId || sigReceivedEvent.id;  // Root-Event-ID — folgt dem Signal durch alle Stages

    // ── Security: Record SIGNAL_IN in event store ─────────────────────────
    eventStore.append(SEC_EVENT_TYPES.SIGNAL_IN, { strategie: name, epic: req.body.epic || 'GOLD', side: req.body.side, sl: req.body.sl, tp: req.body.tp }, correlationId);

    metrics.inc('signals_received');
    const { side, sl, tp, epic = 'GOLD' } = req.body;
    if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder (side/sl/tp)' });

    // Parsed signal values — Capital.com used to fetch live price for entry;
    // with IBKR we estimate entry from sl/tp/rrr (broker executes at market price)
    const slF  = parseFloat(sl);
    const tpF  = parseFloat(tp);
    const rrr  = s?.rrr || 2.0;
    // entry = sl + (tp-sl)/(1+rrr) for BUY, reverse for SELL
    const entry = side === 'BUY'
      ? parseFloat((slF + (tpF - slF) / (1 + rrr)).toFixed(5))
      : parseFloat((slF - (slF - tpF) / (1 + rrr)).toFixed(5));
    const slDist = Math.abs(entry - slF);
    const extras = { entry, slF, tpF };

    // Signal für späteren Backtest-Replay loggen
    const _sig = { ts: Date.now(), strategie: name, epic, side, sl, tp };
    try { fs.appendFileSync(SIGNALS_PATH, JSON.stringify(_sig) + '\n'); } catch {}
    db.addSignal(_sig).catch(() => {});

    await ensureAuth(name);
    const equity = await getEquity(name);
    performance[name].equity = equity;

    // -- HARDENING: State Validation --------------------------------
    const _stateCheck = validator.validate(name, { settings: s, performance: performance[name], equity });
    if (!_stateCheck.valid) {
      addLog('warn', `[StateValidator] ${name}: ${_stateCheck.issues.join(', ')}`);
      metrics.error('state_validation', `${name}: ${_stateCheck.issues.join(', ')}`);
      // Nicht blockieren, aber warnen und messen
    }

    if (tagesStart[name] == null) tagesStart[name] = equity;
    const tagesPct = ((equity - tagesStart[name]) / tagesStart[name]) * 100;

    if (!req.body._bypassFilters && tagesPct >= s.tagsStopPct) {
      return res.json({ status: 'pausiert', grund: 'Tagesziel' });
    }
    if (!req.body._bypassFilters && s.tagsVerlustPct && tagesPct <= -s.tagsVerlustPct) {
      await tg(`\u{1F6D1} ${name} Tagesverlust-Stop -${s.tagsVerlustPct}%`);
      return res.json({ status: 'pausiert', grund: 'Tagesverlust-Stop' });
    }
    const drawdown = ((s.startEquity - equity) / s.startEquity) * 100;
    if (!req.body._bypassFilters && performance[name].trades > 0 && drawdown >= s.maxDrawdownPct) {
      await tg(`\u{1F6D1} <b>${name}</b> gestoppt — Max. Drawdown erreicht`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown' });
    }

    // Schlechte Handelsstunde erkennen
    if (!req.body._bypassFilters && istSchlechteStunde(name)) {
      addLog('tuning', `⏰ [${name}] Schlechte Stunde (${new Date().getHours()}:xx) — übersprungen`);
      logFeature(name, req.body.side, equity, null, false, 'schlechte Handelsstunde');
      return res.json({ status: 'übersprungen', grund: 'schlechte Handelsstunde' });
    }

    let regimeModus = 'AKTIV';
    if (!req.body._bypassFilters && s.regimeFilter) {
      const regime = await pruefeRegime();
      if (regime.geblockt) return res.json({ status: 'übersprungen', grund: regime.grund });
      regimeModus = regime.modus;
      if (regimeModus === 'VORSICHTIG' && side === 'SELL')
        return res.json({ status: 'übersprungen', grund: 'VORSICHTIG – nur LONG' });
    }

        // -- HARDENING: Risk Engine als echter Gatekeeper -----------------
    // SIGNAL_ENRICHED emittieren — Risk Engine subscribt auf diesen Event
    // und emittiert daraufhin RISK_SIZED oder RISK_REJECTED.
    const sigEnrichedEvent = bus.emit_event(EVENT_TYPES.SIGNAL_ENRICHED, 'webhook', {
      correlationId, strategie: name, epic, side, sl: slF, tp: tpF, entry,
      equity, rrr, drawdownPct: ((s.startEquity - equity) / s.startEquity) * 100,
    }, correlationId);
    metrics.inc('signals_enriched');

    // waitForRiskDecision() haelt den HTTP-Request an bis Risk Engine
    // entschieden hat. Timeout = 5s -> fail-SAFE = REJECT (kein Trade).
    let riskDecision;
    if (req.body._bypassFilters) {
      // Bypass mode: skip Risk Engine, use default size
      riskDecision = { type: 'RISK_SIZED', payload: { size: 1 } };
      addLog('info', `[Risk] ${name}: Bypass-Modus — Risk Engine übersprungen`);
    } else {
      try {
        riskDecision = await waitForRiskDecision(sigEnrichedEvent.id, 5000);
      } catch (riskErr) {
        metrics.error('risk_timeout', `${name}: ${riskErr.message}`);
        addLog('warn', `[Risk] ${name}: Timeout — Trade wird sicherheitshalber abgebrochen`);
        return res.json({ status: 'uebersprungen', grund: 'Risk Engine Timeout (fail-safe: reject)' });
      }
      if (riskDecision.type === 'RISK_REJECTED') {
        metrics.inc('risk_rejected');
        const { grund, code: rCode } = riskDecision.payload;
        addLog('warn', `[Risk] ${name}: REJECTED (${rCode}) — ${grund}`);
        logFeature(name, side, equity, rrr, false, `Risk: ${grund}`, extras);
        return res.json({ status: 'uebersprungen', grund, riskCode: rCode });
      }
    }
    // RISK_SIZED -> Risk Engine hat Groesse berechnet (wird unten als Fallback genutzt)
    const riskEngineSize = riskDecision.payload?.size ?? null;
    metrics.inc('risk_approved');

    // -- ML-Filter -------------------------------------------------------
    // ── ML-Filter ─────────────────────────────────────────────────
    let ml;
    if (breakers.ml.isOpen) {
      ml = { empfehlung: 'trade', grund: 'ML-Circuit offen (fail-safe)', trainiert: false };
      metrics.inc('ml_circuit_open');
    } else {
      const _t0 = Date.now();
      ml = await mlPredict(name, side, equity, rrr);
      metrics.timing('ml_latency', Date.now() - _t0);
    }
    trackMlPrediction(name, ml);
    addLog('info', `\u{1F916} [${name}] ML: ${ml.empfehlung} (${ml.konfidenz ? (ml.konfidenz*100).toFixed(0)+'%' : 'kein Modell'}) — ${ml.grund}`);
    if (!req.body._bypassFilters && ml.empfehlung === 'skip') {
      logFeature(name, side, equity, rrr, false, `ML: ${ml.grund}`, extras);
      broadcast('ml_skip', { name, side, konfidenz: ml.konfidenz, grund: ml.grund });
      return res.json({ status: 'übersprungen', grund: ml.grund, ml });
    }

    // ── Dynamischer Konfidenz-Schwellwert (Market Mode Override) ──────────
    // Falls ml-service die Schwelle nicht angewendet hat (kein trainiertes Modell),
    // prüfen wir hier nochmal lokal anhand der rohen Konfidenz
    if (ml.trainiert && ml.konfidenz != null) {
      const schwelle = getKonfidenzSchwelle(side, new Date().getHours(), new Date().getDay());
      if (ml.konfidenz < schwelle) {
        const msg = `Konfidenz ${(ml.konfidenz*100).toFixed(0)}% < ${marketMode.modus}-Schwelle ${(schwelle*100).toFixed(0)}%`;
        addLog('info', `📊 [${name}] Market Override: ${msg}`);
        logFeature(name, side, equity, rrr, false, `MarketOverride: ${msg}`, extras);
        broadcast('ml_skip', { name, side, konfidenz: ml.konfidenz, grund: msg, marketModus: marketMode.modus });
        return res.json({ status: 'übersprungen', grund: msg, schwelle, marketModus: marketMode.modus, ml });
      }
    }

    await closePositions(name, epic);
    // -- V4 Multi-Agent: Signal-Aggregation ----------------------------
    const agentCtx = {
      name, side, entry, equity, rrr,
      marketMode: marketMode.modus,
      hour:       new Date().getHours(),
      minute:     new Date().getMinutes(),
      weekday:    new Date().getDay(),
      recentWR5:  berechneWR(name, 5),
      recentWR15: berechneWR(name, 15),
      konsek:     berechneKonsek(name),
      slDistPct:  entry ? Math.abs(entry - slF) / entry * 100 : null,
    };
    const agentVote = aggregateAgents(agentCtx);
    broadcast('agent_vote', { name, avgVote: agentVote.avgVote, approved: agentVote.approved, grund: agentVote.grund });
    addLog('info', `[Agents] ${name}: ${(agentVote.avgVote*100).toFixed(0)}% | ${agentVote.grund}`);
    if (!req.body._bypassFilters && !agentVote.approved) {
      logFeature(name, side, equity, rrr, false, `Agents: ${agentVote.grund}`, extras);
      return res.json({ status: 'uebersprungen', grund: agentVote.grund, agents: agentVote.agentResults });
    }


    // Kombinations-Sizing: ML-Konfidenz × Market Mode
    // Beispiel: ML=1.5× (hohe Konfidenz) × BEAR=0.8 → 1.2× Endgröße
        const mlSizing     = ml.sizing_faktor != null ? ml.sizing_faktor : 1.0;
    const scoreWeight  = getScoreWeightFaktor(name);
    const agentBonus   = agentVote.sizingBonus || 1.0;
    const sizingFaktor = parseFloat((mlSizing * getMarktSizingFaktor() * scoreWeight * agentBonus).toFixed(2));
    const _scoreHint   = scorePauses[name]?.score != null ? ` | Score=${scorePauses[name].score}/100 (${scoreWeight}×)` : '';
    const _agentHint   = agentBonus > 1.0 ? ` | Agents-Boost ${agentBonus}×` : '';
    addLog('info', `📐 [${name}] Sizing: ML=${mlSizing}× × Markt=${getMarktSizingFaktor()}× × Score=${scoreWeight}× × Agents=${agentBonus}× → ${sizingFaktor}×${_scoreHint}${_agentHint}`);
    const riskCapital  = equity * (s.riskPct / 100) * sizingFaktor;
    const size = slDist > 0 ? Math.max(1, parseFloat((riskCapital / slDist).toFixed(1))) : 1;

    const order = {
      symbol:        epic,                         // instrument from signal payload
      assetClass:    req.body.assetClass || 'commodity', // from signal or default
      side,
      size,
      orderType:     'MKT',
      stopLevel:     slF,
      profitLevel:   tpF,
      strategyId:    name,
      correlationId,
    };
    // ── Security: Order Validation (before broker) ────────────────────────
    const orderCheck = validateOrder({
      symbol:    order.symbol,
      side:      order.side,
      size:      order.size,
      entry:     entry || null,
      sl:        slF,
      tp:        tpF,
      orderType: order.orderType,
    }, s);
    if (!req.body._bypassFilters && !orderCheck.valid) {
      addLog('warn', `[OrderValidator] ${name}: order rejected — ${orderCheck.reason}`);
      eventStore.append(SEC_EVENT_TYPES.ORDER_REJECTED, { strategie: name, reason: orderCheck.reason, order: sanitizeForLog(order) }, correlationId);
      return res.status(400).json({ status: 'rejected', reason: orderCheck.reason });
    }

    addLog('info', `\u{1F4E4} [${name}] Order: ${JSON.stringify(order)}`);
    const _t1 = Date.now();
    // ── Portfolio Risk Gate (HELIX Governance) ──────────────────────────────
    const orderValueUSD = riskCapital;  // estimated notional
    const riskCheck = portfolioManager.checkRisk(name, orderValueUSD, rrr);
    if (!riskCheck.approved) {
      addLog('warn', `🛡️ [${name}] Portfolio Risk blocked: ${riskCheck.reason}`);
      logFeature(name, side, equity, rrr, false, `PortfolioRisk: ${riskCheck.reason}`, extras);
      bus.emit_event(EVENT_TYPES.RISK_BLOCKED, 'portfolio_manager', { strategie: name, reason: riskCheck.reason, correlationId });
      eventStore.append(SEC_EVENT_TYPES.ORDER_REJECTED, { strategie: name, reason: riskCheck.reason }, correlationId);
      return res.json({ status: 'blocked', reason: riskCheck.reason });
    }

    const result = await breakers.broker.call(() => placeOrder(name, order));
    portfolioManager.openPosition(name, orderValueUSD);
    metrics.timing('broker_latency', Date.now() - _t1);
    metrics.inc('orders_placed');

    // ── Security: Record placed order + mark correlationId as seen ────────
    eventStore.append(SEC_EVENT_TYPES.ORDER_PLACED, { strategie: name, epic, side, size, sl: slF, tp: tpF, equity, dealId: result?.dealId }, correlationId);
    if (incomingCorrelationId) secDeduplicator.markSeen(incomingCorrelationId);

    logFeature(name, side, equity, rrr, true, null, extras, correlationId);
    await tg(`${side === 'BUY' ? '\u{1F7E2}' : '\u{1F534}'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'}</b> — <b>${name}</b>\nSize: ${size} | SL: ${slF} | TP: ${tpF}${ml.trainiert ? ` | ML: ${(ml.konfidenz*100).toFixed(0)}%` : ''}`);
    bus.emit_event(EVENT_TYPES.ORDER_PLACED, 'execution', { correlationId, strategie: name, epic, side, size, sl: slF, tp: tpF, equity }, correlationId);
    broadcast('trade', { name, epic, side, size, sl: slF, tp: tpF, equity });
    res.json({ status: 'ok', name, epic, size, sl: slF, tp: tpF });

  } catch (err) {
    const detail = err.response?.data || err.message;
    addLog('error', `❌ [${name}] ${JSON.stringify(detail)}`);
    res.status(500).json({ error: err.message, detail });
  } finally {
    aktiveTrades[name] = false;
    letzterTrade[name] = Date.now();
  }
}

// ── Webhook Routen ─────────────────────────────────────────────────
['mittel','aggressiv','smart','konservativ','optimiert','test','adaptive','steady'].forEach(n => {
  app.post(`/webhook/${n}`, (req, res) => handleWebhook(req, res, n));
});
app.post('/webhook/goldglobe', (req, res) => handleWebhook(req, res, 'smart'));
// ── PnL-Webhook ───────────────────────────────────────────────────────────────
// TradingView sendet diesen Webhook wenn ein Trade geschlossen wird.
// Payload: { strategie, pnl, side, datum? }
// Schliesst den ML-Feedback-Loop: Feature-Vektor + echtes Label (Gewinn/Verlust)
app.post('/pnl', async (req, res) => {
  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET)
    return res.status(401).json({ error: 'Ungültiger Secret' });

  const { strategie, pnl, side } = req.body;
  const pnlNum = parseFloat(pnl);
  if (!strategie || isNaN(pnlNum)) {
    return res.status(400).json({ error: 'Fehlende Felder: strategie und pnl erforderlich' });
  }
  if (!SETTINGS[strategie]) {
    return res.status(400).json({ error: 'Unbekannte Strategie: ' + strategie });
  }

  try {
    // ── ML Feedback Loop: pendingFeature mit echtem PnL beschriften ──────────
    const pending = pendingFeatures[strategie];
    if (pending) {
      pending.pnl   = pnlNum;
      pending.label = pnlNum > 0 ? 1 : 0;
      try {
        fs.appendFileSync(FEATURES_PATH, JSON.stringify(pending) + '\n');
        await db.logFeature(pending).catch(() => {});
      } catch {}
      delete pendingFeatures[strategie];
      addLog('info', `[PnL] ${strategie}: Feature beschriftet — PnL=${pnlNum > 0 ? '+' : ''}${pnlNum.toFixed(2)} | Label=${pending.label}`);
    } else {
      addLog('info', `[PnL] ${strategie}: PnL erhalten (kein pending Feature) — ${pnlNum > 0 ? '+' : ''}${pnlNum.toFixed(2)}`);
    }

    // ── Performance & Trade History aktualisieren ────────────────────────────
    const equity = await getEquity(strategie).catch(() => null);
    const trade = {
      datum:    new Date().toISOString(),
      ts:       Date.now(),
      strategie,
      side:     side || (pending && pending.side) || '?',
      pnl:      pnlNum,
      equity:   equity || (performance[strategie]?.equity),
      grund:    'PnL-Webhook',
    };

    updatePerf(strategie, pnlNum);
    addTrade(strategie, trade);
    if (equity) addEquity(strategie, equity);

    // ── Memory System: Marktbedingungen bei Gewinn/Verlust ───────────────────
    if (pending) {
      updateMemory(pending.marketModus || marketMode.modus, pending.hour, pending.weekday, pending.side, pnlNum);
    }

    // ── AutoTune: Verlustserie prüfen ────────────────────────────────────────
    autoTune(strategie);

    // ── Event Bus: PNL_RECORDED emittieren ────────────────────────────────────
    const correlationId = pending && pending.correlationId ? pending.correlationId : null;
    bus.emit_event(EVENT_TYPES.PNL_RECORDED, 'pnl_webhook', {
      strategie, pnl: pnlNum, label: pnlNum > 0 ? 1 : 0,
      equity: equity || null, side: trade.side,
    }, correlationId);
    metrics.inc('pnl_recorded');
    metrics.inc(pnlNum > 0 ? 'pnl_wins' : 'pnl_losses');

    broadcast('trade', { name: strategie, ...trade });
    const emoji = pnlNum > 0 ? '✅' : '❌';
    await tg(`${emoji} <b>${strategie}</b> Trade geschlossen\nPnL: ${pnlNum > 0 ? '+' : ''}${pnlNum.toFixed(2)} | Equity: ${equity ? equity.toFixed(2) : '?'}`);

    res.json({ ok: true, strategie, pnl: pnlNum, equity });
  } catch (err) {
    addLog('error', `[PnL] ${strategie}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Kurzform: POST /pnl/:strategie setzt strategie im Body und handled identisch
app.post('/pnl/:name', async (req, res) => {
  req.body.strategie = req.body.strategie || req.params.name;
  // Weiterleitung: einfach denselben Body mit strategie an /pnl-Logik
  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET)
    return res.status(401).json({ error: 'Ungültiger Secret' });
  const { strategie, pnl, side } = req.body;
  const pnlNum = parseFloat(pnl);
  if (!strategie || isNaN(pnlNum)) return res.status(400).json({ error: 'Fehlende Felder' });
  if (!SETTINGS[strategie]) return res.status(400).json({ error: 'Unbekannte Strategie: ' + strategie });
  // Intern an /pnl weiterleiten via axios (loopback)
  try {
    const r = await require('axios').post(`http://localhost:${PORT}/pnl`, req.body, { headers: { 'x-webhook-secret': secret || '' }, timeout: 10000 });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ── SL Update ─────────────────────────────────────────────────────
app.post('/webhook/update_sl/:name', async (req, res) => {
  const { name } = req.params;
  const { sl, epic = 'GOLD' } = req.body;
  if (!sl || !STRATEGY_IDS.includes(name)) return res.status(400).json({ error: 'Ungültig' });
  try {
    await ensureAuth(name);
    const positions = await getPositions(name);
    const pos = positions.find(p => p.market?.epic === epic);
    if (!pos) return res.json({ status: 'keine Position' });
    await broker.modifyOrder(name, pos?.dealId || pos?.position?.dealId, { stopLevel: parseFloat(sl) });
    res.json({ status: 'ok', sl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings API ──────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(SETTINGS));

app.post('/api/settings/:name', (req, res) => {
  const { name } = req.params;
  if (!SETTINGS[name]) return res.status(404).json({ error: 'Strategie nicht gefunden' });
  const allowed = ['enabled','riskPct','leverage','maxDrawdownPct','tagsStopPct','minRRR','startEquity','tagsVerlustPct'];
  allowed.forEach(k => { if (req.body[k] !== undefined) SETTINGS[name][k] = req.body[k]; });
  saveSettings();
  broadcast('settings', { name, settings: SETTINGS[name] });
  addLog('info', `⚙️ [${name}] Settings aktualisiert: ${JSON.stringify(req.body)}`);
  res.json({ status: 'ok', settings: SETTINGS[name] });
});

// ── Performance API ───────────────────────────────────────────────
app.get('/api/performance', async (req, res) => {
  const result = {};
  for (const name of STRATEGY_IDS) {
    try {
      await ensureAuth(name);
      performance[name].equity = await getEquity(name);
    } catch {}
    result[name] = performance[name];
  }
  res.json(result);
});

app.get('/api/equity', (req, res) => res.json(equityHistory));
app.get('/api/trades', (req, res) => res.json(tradeHistory));
app.get('/api/trades/:name', (req, res) => res.json(tradeHistory[req.params.name] || []));

// ── Positionen API ──────────────────────────────────────────────────
app.get('/api/positions', async (req, res) => {
  const result = {};
  for (const name of STRATEGY_IDS) {
    try {
      await ensureAuth(name);
      result[name] = await getPositions(name);
    } catch { result[name] = []; }
  }
  res.json(result);
});

// ── Smart Status & Reset ────────────────────────────────────────────────
app.get('/api/smart-status', (req, res) => res.json({ ...SMART, schwellen: { pause: WR_PAUSE * 100, vorsichtig: WR_VORSICHTIG * 100, konsekMax: KONSE_MAX } }));

app.post('/api/smart/reset', async (req, res) => {
  const alt = SMART.modus;
  SMART.modus = 'AKTIV'; SMART.pauseBis = null; SMART.konsekVerluste = 0; SMART.geaendertAm = new Date().toISOString();
  await tg(`\u{1F504} [Smart] Regime manuell zurückgesetzt: ${alt} → AKTIV`);
  broadcast('regime', SMART);
  res.json({ status: 'ok', alt, neu: 'AKTIV' });
});

// ── ML API ─────────────────────────────────────────────────────────────────
// ── Portfolio Manager API ──────────────────────────────────────────────────────
app.get('/api/portfolio', (_req, res) => res.json(portfolioManager.snapshot()));

app.post('/api/portfolio/:id/resume', (req, res) => {
  const id = req.params.id;
  if (!STRATEGY_IDS.includes(id)) return res.status(404).json({ error: 'Not found' });
  portfolioManager.resume(id);
  res.json({ ok: true });
});

app.post('/api/portfolio/:id/allocate', (req, res) => {
  const id = req.params.id;
  if (!STRATEGY_IDS.includes(id)) return res.status(404).json({ error: 'Not found' });
  portfolioManager.setAllocation(id, req.body);
  res.json({ ok: true, snapshot: portfolioManager.get(id)?.snapshot() });
});

// ── Broker API ─────────────────────────────────────────────────────────────────
app.get('/api/broker/health', async (_req, res) => {
  try { res.json(await broker.healthCheck()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/broker/reconnect', async (_req, res) => {
  try { await broker.reconnect(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ml-status', async (req, res) => {
  await aktualisiereMlStatus();
  res.json({ url: ML_URL, status: mlStatus });
});

app.post('/api/ml-train', async (req, res) => {
  if (!ML_URL) return res.status(503).json({ error: 'ML_SERVICE_URL nicht konfiguriert' });
  try {
    const { strategie } = req.body;
    const r = await axios.post(`${ML_URL}/train`, { strategie: strategie || null }, { timeout: 60000 });
    await aktualisiereMlStatus();
    res.json(r.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AutoTune & Stunden API ───────────────────────────────────────────────
app.get('/api/tuning', (req, res) => res.json(tuningHistory));
app.get('/api/stunden', (req, res) => res.json(stundenStats));
app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/tuning/reset/:name', (req, res) => {
  const { name } = req.params;
  if (!SETTINGS[name]) return res.status(404).json({ error: 'Nicht gefunden' });
  SETTINGS[name].riskPct = SETTINGS_ORIGINAL[name].riskPct;
  saveSettings();
  broadcast('settings', { name, settings: SETTINGS[name] });
  addLog('tuning', `\u{1F504} [${name}] AutoTune manuell zurückgesetzt`);
  res.json({ status: 'ok', riskPct: SETTINGS[name].riskPct });
});

// ── Backtesting API ───────────────────────────────────────────────────────────

// Analyse aller Strategien aus vorhandener Trade-History
app.get('/api/backtest/analyze', (req, res) => {
  const result = {};
  for (const name of STRATEGY_IDS) {
    const trades = tradeHistory[name] || [];
    const metriken = BT.berechneMetriken(trades);
    result[name] = {
      metriken,
      score:       BT.berechneStrategieScore(metriken),
      walkForward: BT.walkForwardTest(trades, Math.min(4, Math.floor(trades.length / 5))),
      stunden:     BT.analyseNachStunde(trades),
      wochentage:  BT.analyseNachWochentag(trades),
      sides:       BT.analyseNachSide(trades),
    };
  }
  res.json({ ts: new Date().toISOString(), strategien: result });
});

// Strategie-Scores (kompakt, fuer Dashboard)
app.get('/api/strategy-scores', (req, res) => {
  const scores = {};
  for (const name of STRATEGY_IDS) {
    const trades   = tradeHistory[name] || [];
    const metriken = BT.berechneMetriken(trades);
    scores[name] = {
      score:        BT.berechneStrategieScore(metriken),
      winRate:      metriken?.winRate      ?? null,
      profitFactor: metriken?.profitFactor ?? null,
      sharpe:       metriken?.sharpe       ?? null,
      trades:       trades.length,
      pnl:          metriken?.gesamtPnL    ?? 0,
    };
  }
  res.json(scores);
});

// Preis-basierter Backtest (EMA-Crossover auf historischen Kerzen)
app.post('/api/backtest/run', async (req, res) => {
  const { epic = 'GOLD', resolution = 'HOUR', count = 500, ema_schnell = 9, ema_langsam = 21, slPct = 0.5, rrr = 2.0 } = req.body;
  let name = null;
  for (const n of STRATEGY_IDS) { if (false  /* IBKR: no per-account sessions */) { name = n; break; } }
  if (!name) return res.status(503).json({ error: 'Kein aktives Konto' });
  try {
    addLog('info', `Backtest: ${epic} ${resolution} (${count} Kerzen, EMA${ema_schnell}/${ema_langsam})`);
    const candles = await BT.fetchCandles(process.env.MARKET_DATA_URL || BASE_URL, {}, epic, resolution, count);
    if (candles.length < 50) return res.status(400).json({ error: `Zu wenig Kerzen: ${candles.length}` });
    const result = BT.preisBacktest(candles, { ema_schnell, ema_langsam, slPct, rrr });
    addLog('info', `Backtest fertig: ${result.signale} Trades, WR ${result.metriken?.winRate ?? '?'}%, PF ${result.metriken?.profitFactor ?? '?'}`);
    broadcast('backtest_result', { epic, ...result });
    res.json({ epic, resolution, kerzen: candles.length, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Signal-Log (gesammelte TradingView-Signale fuer Backtest-Replay)
app.get('/api/backtest/signals', (req, res) => {
  try {
    if (!fs.existsSync(SIGNALS_PATH)) return res.json({ signale: 0, daten: [] });
    const lines   = fs.readFileSync(SIGNALS_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const signale = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ signale: signale.length, erste: signale[0]?.ts, letzte: signale[signale.length-1]?.ts, daten: signale.slice(-50) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Score API (V2 Item 7) ──────────────────────────────────────────────────────
app.get('/api/score-status', (req, res) => {
  const result = {};
  for (const name of STRATEGY_IDS) {
    const trades   = tradeHistory[name] || [];
    const metriken = BT.berechneMetriken(trades);
    const score    = BT.berechneStrategieScore(metriken);
    result[name] = {
      score,
      badge:        scoreBadge(score),
      paused:       scorePauses[name]?.paused ?? false,
      grund:        scorePauses[name]?.grund ?? null,
      geaendertAm:  scorePauses[name]?.geaendertAm ?? null,
      trades:       trades.length,
      winRate:      metriken?.winRate      ?? null,
      profitFactor: metriken?.profitFactor ?? null,
      sharpe:       metriken?.sharpe       ?? null,
      maxDrawdown:  metriken?.maxDrawdown  ?? null,
    };
  }
  res.json({ cfg: SCORE_CFG, strategien: result });
});

app.post('/api/score/check', async (req, res) => {
  await pruefeAlleScores();
  res.json({ status: 'ok', scores: scorePauses });
});

app.post('/api/score/resume/:name', async (req, res) => {
  const { name } = req.params;
  if (!STRATEGY_IDS.includes(name)) return res.status(404).json({ error: 'Strategie nicht gefunden' });
  const prev = scorePauses[name] || {};
  scorePauses[name] = { ...prev, paused: false, grund: 'Manuell entsperrt', geaendertAm: new Date().toISOString() };
  saveJSON(SCORE_PATH, scorePauses);
  broadcast('score_resume', { name, ...scorePauses[name] });
  addLog('tuning', `[${name}] Score-Pause manuell aufgehoben`);
  res.json({ status: 'ok', name, score: scorePauses[name] });
});

// ── Memory API (V3) ───────────────────────────────────────────────────────────
app.get('/api/memory', (req, res) => {
  const { side = 'BUY' } = req.query;
  const entries = Object.entries(memory).map(([key, m]) => {
    const [modus, hour, weekday, s] = key.split('_');
    const total = m.wins + m.losses;
    const wr = total > 0 ? parseFloat((m.wins / total * 100).toFixed(1)) : null;
    const adj = getMemoryAdjust(modus, parseInt(hour), parseInt(weekday), s);
    return { key, modus, hour: parseInt(hour), weekday: parseInt(weekday), side: s, wins: m.wins, losses: m.losses, total, wr, adj };
  }).filter(e => e.total >= MEMORY_CFG.MIN_OBS).sort((a, b) => (b.wr || 0) - (a.wr || 0));
  res.json({ cfg: MEMORY_CFG, total_obs: Object.keys(memory).length, entries });
});

app.get('/api/memory/insight', (req, res) => {
  const { side = 'BUY' } = req.query;
  const insight = getMemoryInsight(null, side);
  const currentAdj = getMemoryAdjust(marketMode.modus, new Date().getHours(), new Date().getDay(), side);
  res.json({ currentModus: marketMode.modus, currentHour: new Date().getHours(), currentAdj, ...insight });
});

// ── Konfidenz-Schwellwert API ──────────────────────────────────────────────
app.get('/api/confidence-threshold', (req, res) => res.json({
  basis:        BASIS_KONFIDENZ,
  aktuell:      getKonfidenzSchwelle(),
  marketModus:  marketMode.modus,
  adjust:       MARKET_MODES[marketMode.modus]?.konfidenzAdjust ?? 0,
  alle: Object.fromEntries(
    Object.entries(MARKET_MODES).map(([m, cfg]) => [m, parseFloat((BASIS_KONFIDENZ + cfg.konfidenzAdjust).toFixed(2))])
  ),
}));

// ── Market Mode API ──────────────────────────────────────────────────────────────
app.get('/api/market-mode', (req, res) => res.json({ ...marketMode, config: MARKET_MODES }));

app.post('/api/market-mode/refresh', async (req, res) => {
  await analysiereMarktmodus();
  res.json(marketMode);
});


// ── Features API (fuer ml-service) ─────────────────────────────────────────────────
app.get('/api/features/:name', async (req, res) => {
  const { name } = req.params;
  const limit = parseInt(req.query.limit) || 2000;
  if (!db.available) return res.status(503).json({ error: 'Kein DB-Zugang (DATABASE_URL fehlt)' });
  try {
    const features = await db.getFeatures(name, limit);
    res.json({ strategie: name, count: features.length, features });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agent API ───────────────────────────────────────────────────────────
app.get('/api/agents', (req, res) => {
  const result = {};
  for (const name of Object.keys(SETTINGS)) {
    const ctx = {
      name, side: 'BUY', entry: null, equity: performance[name]?.equity || 0, rrr: 2.5,
      marketMode: marketMode.modus,
      hour: new Date().getHours(), minute: new Date().getMinutes(), weekday: new Date().getDay(),
      recentWR5: berechneWR(name, 5), recentWR15: berechneWR(name, 15), konsek: berechneKonsek(name),
      slDistPct: null,
    };
    result[name] = aggregateAgents(ctx);
  }
  res.json(result);
});

// ── Meta-Learning API ──────────────────────────────────────────────────
app.get('/api/meta', (req, res) => {
  const result = {};
  for (const name of Object.keys(SETTINGS)) {
    const buf = mlPredBuffer[name] || [];
    const withOutcome = buf.filter(e => e.win !== null);
    const recentAcc = withOutcome.length
      ? parseFloat((withOutcome.filter(e => e.win).length / withOutcome.length * 100).toFixed(1))
      : null;
    const avgConf = buf.length
      ? parseFloat((buf.slice(-10).reduce((s,e) => s + e.konfidenz, 0) / Math.min(buf.length,10) * 100).toFixed(1))
      : null;
    const meta = (mlStatus || {})[name]?.meta;
    const daysSince = meta?.trainiert_am
      ? parseFloat(((Date.now() - new Date(meta.trainiert_am).getTime()) / (1000*60*60*24)).toFixed(1))
      : null;
    result[name] = {
      bufferSize:       buf.length,
      withOutcome:      withOutcome.length,
      recentAcc,
      avgConf,
      daysSinceRetrain: daysSince,
      modelAcc:         meta?.accuracy_cv ? parseFloat((meta.accuracy_cv*100).toFixed(1)) : null,
    };
  }
  res.json(result);
});

// ── Event Bus API ─────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  const n = parseInt(req.query.n) || 50;
  res.json({ events: bus.replay(n), stats: bus.stats() });
});

// -- Deep Health + Metrics ------------------------------------------------------
app.get('/api/health/deep', (req, res) => {
  res.json({
    status:       'ok',
    ts:           new Date().toISOString(),
    circuits:     Object.fromEntries(Object.entries(breakers).map(([k,v]) => [k, v.status()])),
    dedup:        dedup.status(),
    metrics:      metrics.snapshot(),
    eventBus:     bus.stats(),
    strategies: {
      total:    Object.keys(SETTINGS).length,
      paused:   Object.values(scorePauses).filter(s => s.paused).length,
      active:   Object.values(aktiveTrades).filter(Boolean).length,
    },
    marketMode:   marketMode.modus,
    mlPredBuffer: Object.fromEntries(Object.entries(mlPredBuffer).map(([k,v]) => [k, v.length])),
    pendingPnL:   Object.keys(pendingFeatures),
  });
});

// ── Signal Generator Status + Control ────────────────────────────────────────────────────────────────────
app.get('/api/signal-generator', (req, res) => {
  if (!sigGen) return res.json({ enabled: false, grund: 'SIGNAL_GEN_ENABLED nicht gesetzt' });
  res.json({ enabled: true, ...sigGen.status() });
});

app.post('/api/signal-generator/start', (req, res) => {
  if (!sigGen) return res.status(400).json({ error: 'Signal Generator nicht konfiguriert' });
  sigGen.start();
  res.json({ ok: true, msg: 'Signal Generator gestartet' });
});

app.post('/api/signal-generator/stop', (req, res) => {
  if (!sigGen) return res.status(400).json({ error: 'Signal Generator nicht konfiguriert' });
  sigGen.stop();
  res.json({ ok: true, msg: 'Signal Generator gestoppt' });
});

// Hot-add instrument to running scanner: POST /api/scanner/instruments { epic, strategie, rrr?, resolution? }
app.post('/api/scanner/instruments', (req, res) => {
  if (!sigGen) return res.status(400).json({ error: 'Scanner nicht aktiv' });
  const { epic, strategie, rrr, resolution, candleCount } = req.body;
  if (!epic || !strategie) return res.status(400).json({ error: 'epic und strategie erforderlich' });
  if (!SETTINGS[strategie]) return res.status(400).json({ error: 'Unbekannte Strategie: ' + strategie });
  sigGen.addInstrument({ epic, strategie, rrr: rrr || 2.0, resolution: resolution || 'MINUTE', candleCount: candleCount || 100 });
  res.json({ ok: true, msg: `${epic} → ${strategie} hinzugefügt`, status: sigGen.status() });
});

// Remove instrument: DELETE /api/scanner/instruments/:epic
app.delete('/api/scanner/instruments/:epic', (req, res) => {
  if (!sigGen) return res.status(400).json({ error: 'Scanner nicht aktiv' });
  const removed = sigGen.removeInstrument(req.params.epic);
  if (!removed) return res.status(404).json({ error: `Instrument nicht gefunden: ${req.params.epic}` });
  res.json({ ok: true, msg: `${req.params.epic} entfernt`, status: sigGen.status() });
});

// ── Test Trade ──────────────────────────────────────────────────────────────
// POST /api/test-trade { strategie, epic, side?, slPct?, rrr? }
// Fetches real candles, tries detectSignal, falls back to forced signal, fires webhook.
app.post('/api/test-trade', async (req, res) => {
  const { strategie, epic = 'GOLD', side, slPct = 1.0, rrr: testRrr = 2.0, bypass = false } = req.body;
  if (!strategie || !STRATEGY_IDS.includes(strategie))
    return res.status(400).json({ error: 'Ungültige Strategie: ' + strategie });
  try {
    await ensureAuth(strategie);
    const hdrs = await getCapitalHeaders();

    // Fetch candles for signal detection
    let candles = [];
    try {
      const priceResp = await axios.get(BASE_URL + '/prices/' + epic, {
        headers: hdrs,
        params: { resolution: 'MINUTE_5', max: 100 },
        timeout: 15000,
      });
      candles = priceResp.data?.prices || [];
    } catch (e) {
      addLog('warn', `[TestTrade] Kerzen-Fehler für ${epic}: ${e.message}`);
    }

    let sl, tp, entry, sigSide, grund;

    // Try real signal detection if no side forced and enough candles
    if (candles.length >= 55 && !side) {
      const sig = detectSignal(candles, parseFloat(testRrr), 1.5);
      if (sig.side) {
        sl = sig.sl; tp = sig.tp; entry = sig.entry;
        sigSide = sig.side; grund = sig.grund;
      }
    }

    // Fallback: forced signal with % SL/TP
    if (!sigSide) {
      const last = candles[candles.length - 1];
      entry = parseFloat((last?.closePrice?.bid || last?.close || 1000).toFixed(4));
      sigSide = side || 'BUY';
      const dist = entry * (parseFloat(slPct) / 100);
      sl = sigSide === 'BUY'
        ? parseFloat((entry - dist).toFixed(4))
        : parseFloat((entry + dist).toFixed(4));
      tp = sigSide === 'BUY'
        ? parseFloat((entry + dist * parseFloat(testRrr)).toFixed(4))
        : parseFloat((entry - dist * parseFloat(testRrr)).toFixed(4));
      grund = `Erzwungenes Test-Signal (${slPct}% SL, RRR ${testRrr})`;
    }

    addLog('info', `🧪 Test-Trade: ${strategie} | ${epic} ${sigSide} | Entry ~${entry} | SL: ${sl} | TP: ${tp}`);

    // Fire through handleWebhook directly (avoids internal HTTP loopback issues)
    const mockResult = await new Promise((resolve) => {
      const mockReq = {
        body: { epic, side: sigSide, sl, tp, _bypassFilters: bypass },
        headers: { 'x-webhook-secret': process.env.WEBHOOK_SECRET || '' },
        ip: '127.0.0.1',
        query: {},
      };
      let settled = false;
      const respond = (status, data) => {
        if (settled) return;
        settled = true;
        resolve({ status, data });
      };
      const mockRes = {
        status: (code) => ({ json: (data) => respond(code, data) }),
        json:   (data) => respond(200, data),
      };
      handleWebhook(mockReq, mockRes, strategie).catch(err => respond(500, { error: err.message }));
    });

    res.json({ ok: true, epic, side: sigSide, entry, sl, tp, grund, result: mockResult.data, httpStatus: mockResult.status });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    addLog('warn', `[TestTrade] Fehler: ${msg}`);
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ── Audit Trail ─────────────────────────────────────────────────────────────────────────────────────────
// Gibt die letzten N Events aus dem Bus-Ring-Buffer zurück (für Replay/Debug)
app.get('/api/audit', (req, res) => {
  const n    = Math.min(parseInt(req.query.n || '100', 10), 500);
  const type = req.query.type;   // optional filter: ?type=SIGNAL_RECEIVED
  let events = bus.replay(500);
  if (type) events = events.filter(e => e.type === type);
  res.json({ total: events.length, events: events.slice(-n) });
});

// Trace ein einzelnes Signal durch alle Stages via correlationId
app.get('/api/audit/:correlationId', (req, res) => {
  const { correlationId } = req.params;
  const trace = bus.trace(correlationId);
  if (!trace.length) return res.status(404).json({ error: 'correlationId nicht im Buffer gefunden' });
  res.json({
    correlationId,
    stages: trace.length,
    flow:   trace.map(e => ({
      stage:     e.type,
      stream:    e.stream,
      source:    e.source,
      ts:        new Date(e.timestamp).toISOString(),
      ms:        e.timestamp,
      approved:  e.payload?.approved,
      grund:     e.payload?.grund || e.payload?.reason,
      size:      e.payload?.size,
      pnl:       e.payload?.pnl,
    })),
    first:  new Date(trace[0].timestamp).toISOString(),
    last:   new Date(trace[trace.length-1].timestamp).toISOString(),
    totalMs: trace[trace.length-1].timestamp - trace[0].timestamp,
  });
});

// ── Replay Engine (HELIX Phase 9) ───────────────────────────────────────────
// GET  /api/replay            → list replayable correlationIds
// GET  /api/replay/:id        → full timeline for one trade
// POST /api/replay/simulate   → dry-run signal through current logic
const replayEngine = new ReplayEngine({
  auditPath: path.join(DATA_DIR, 'audit.jsonl'),
  db,
  addLog,
});
app.use('/api/replay', createReplayRouter(replayEngine, handleWebhook));

// ── State Snapshot ──────────────────────────────────────────────────────────────────────────────────────
// Authoritative full state für Dashboard-Resync nach WS-Reconnect
app.get('/api/state', (req, res) => {
  try {
    const stateByStrategy = {};
    for (const name of STRATEGY_IDS) {
      const perf   = performance[name] || {};
      const equity = perf.equity ?? perf.startEquity ?? 0;
      const sp     = scorePauses[name] || {};
      const ml     = mlStatus[name]    || {};
      stateByStrategy[name] = {
        equity,
        startEquity:   perf.startEquity   ?? 0,
        totalPnl:      perf.totalPnl      ?? 0,
        winRate:       perf.winRate       ?? 0,
        totalTrades:   perf.totalTrades   ?? 0,
        score:         sp.score           ?? 50,
        paused:        sp.paused          ?? false,
        pauseGrund:    sp.grund           ?? null,
        aktiv:         !!aktiveTrades[name],
        mlTrainiert:   ml.trainiert       ?? false,
        mlAccuracy:    ml.accuracy        ?? null,
        mlNTrades:     ml.n_trades        ?? 0,
        recentTrades:  (tradeHistory[name] || []).slice(-10).map(t => ({
          ts:    t.ts,
          side:  t.side,
          pnl:   t.pnl,
          grund: t.grund,
        })),
        equityHistory: (equityHistory[name] || []).slice(-50),
      };
    }

    res.json({
      ts:          new Date().toISOString(),
      marketMode:  marketMode.modus,
      strategies:  stateByStrategy,
      circuits:    Object.fromEntries(Object.entries(breakers).map(([k, v]) => [k, v.status()])),
      dedup:       dedup.status(),
      metricsSnap: metrics.snapshot(),
      settings:    SETTINGS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Security: Kill Switch API ────────────────────────────────────────────────
app.get('/api/kill-switch', (req, res) => {
  res.json(killSwitch.status());
});

app.post('/api/kill-switch/activate', (req, res) => {
  const { reason, secret } = req.body || {};
  const apiSecret = process.env.API_SECRET;
  if (!secret || secret !== apiSecret)
    return res.status(401).json({ error: 'Invalid secret' });
  killSwitch.activate(reason || 'Manual activation via API', 'api');
  eventStore.append(SEC_EVENT_TYPES.KILL_SWITCH_ACTIVATED, { reason, by: 'api' });
  addLog('warn', `🔴 [KillSwitch] Activated via API: ${reason}`);
  broadcast('kill_switch', killSwitch.status());
  res.json({ ok: true, status: killSwitch.status() });
});

app.post('/api/kill-switch/deactivate', (req, res) => {
  const { secret } = req.body || {};
  const apiSecret = process.env.API_SECRET;
  if (!secret || secret !== apiSecret)
    return res.status(401).json({ error: 'Invalid secret' });
  killSwitch.deactivate('api');
  eventStore.append(SEC_EVENT_TYPES.KILL_SWITCH_DEACTIVATED, { by: 'api' });
  addLog('info', '🟢 [KillSwitch] Deactivated via API');
  broadcast('kill_switch', killSwitch.status());
  res.json({ ok: true, status: killSwitch.status() });
});

// ── Security: Event Store Replay API ─────────────────────────────────────────
app.get('/api/events/replay', async (req, res) => {
  const from = req.query.from ? parseInt(req.query.from) : 0;
  const to   = req.query.to   ? parseInt(req.query.to)   : Date.now();
  const type = req.query.type || null;
  try {
    const events = await eventStore.replay(from, to, type);
    res.json({ count: events.length, from, to, type, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/replay/:correlationId', async (req, res) => {
  try {
    const events = await eventStore.getByCorrelationId(req.params.correlationId);
    if (!events.length) return res.status(404).json({ error: 'No events found for correlationId' });
    res.json({ correlationId: req.params.correlationId, count: events.length, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Security: Broker Sandbox Orders ─────────────────────────────────────────
app.get('/api/broker/sandbox-orders', (req, res) => {
  if (typeof broker.getInterceptedOrders !== 'function') {
    return res.json({ sandboxMode: false, orders: [] });
  }
  res.json({
    sandboxMode:  broker.sandboxMode,
    count:        broker.getInterceptedOrders().length,
    orders:       broker.getInterceptedOrders(),
  });
});

app.delete('/api/broker/sandbox-orders', (req, res) => {
  if (typeof broker.clearIntercepted === 'function') broker.clearIntercepted();
  res.json({ ok: true });
});

// ── Security: Recovery Tests API ─────────────────────────────────────────────
app.get('/api/recovery/tests', async (req, res) => {
  try {
    const result = await runRecoveryTests({
      killSwitch,
      deduplicator: secDeduplicator,
      validateOrder,
      validateWebhookPayload,
      portfolioManager,
      broker,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recovery Status API ─────────────────────────────────────────────────────
app.get('/api/recovery/snapshot', (req, res) => {
  const { loadSnapshot } = require('./recovery');
  const snap = loadSnapshot(path.join(DATA_DIR, 'snapshot.json'));
  if (!snap) return res.json({ snapshot: null, msg: 'Kein Snapshot vorhanden' });
  res.json({ snapshot: snap });
});

app.post('/api/recovery/reconcile', async (req, res) => {
  try {
    const result = await reconcileOnStartup({
      broker,
      strategies:      STRATEGY_IDS,
      snapshotPath:    path.join(DATA_DIR, 'snapshot.json'),
      addLog,
      autoCloseOrphans: req.body?.autoClose === true,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────────────────────────
// ── Explicit root fallback (belt-and-suspenders for express.static) ─────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.json({
  status:      'ok',
  strategies:  STRATEGY_IDS.length,
  marketMode:  marketMode.modus,
  db:          db.available ? 'postgresql' : 'json-fallback',
  scorePaused: Object.values(scorePauses).filter(s => s.paused).length,
}));

// ── Server starten ──────────────────────────────────────────────────────────────────────────────
async function startServer() {
  if (db.available) {
    try {
      await db.init();
      addLog('info', '🐘 PostgreSQL verbunden — lade Daten aus DB...');
      for (const name of STRATEGY_IDS) {
        try {          const dbTrades = await db.getTrades(name, 500);
          if (dbTrades.length > 0) {
            tradeHistory[name] = dbTrades;
            addLog('info', `[${name}] ${dbTrades.length} Trades aus DB geladen`);
          }
        } catch {}
        try {
          const dbEquity = await db.getEquityHistory(name, 500);
          if (dbEquity.length > 0) equityHistory[name] = dbEquity;
        } catch {}
        try {
          const dbPerf = await db.getPerformance(name);
          if (dbPerf) performance[name] = { ...performance[name], ...dbPerf };
        } catch {}
        try {
          const dbStunden = await db.getStunden(name);
          if (Object.keys(dbStunden).length > 0) stundenStats[name] = dbStunden;
        } catch {}
        try {
          const dbTuning = await db.getTuning(name);
          if (dbTuning.length > 0) tuningHistory[name] = dbTuning;
        } catch {}
      }
      try {
        const dbMM = await db.getMarketMode();
        if (dbMM) marketMode = dbMM;
      } catch {}
      addLog('info', '🐘 DB-Sync abgeschlossen');
    } catch (err) {
      addLog('warn', `⚠️ DB-Init fehlgeschlagen (JSON-Fallback): ${err.message}`);
    }
  } else {
    addLog('info', '📁 Kein DATABASE_URL — JSON-Fallback aktiv');
  }

  // riskEngine already instantiated at module scope (before routes)
  addLog('info', '⚙️ Risk Engine aktiv (bereits bei Modulstart initialisiert)');

  // ── Phase 10: Snapshot + Recovery ────────────────────────────────────────
  const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json');
  const DEDUP_PATH    = path.join(DATA_DIR, 'dedup.json');

  // Start periodic state snapshots (every 60s)
  startSnapshotLoop({
    snapshotPath: SNAPSHOT_PATH,
    intervalMs:   60_000,
    addLog,
    getState: () => ({
      performance:   JSON.parse(JSON.stringify(performance)),
      tradeHistory:  JSON.parse(JSON.stringify(tradeHistory)),
      equityHistory: JSON.parse(JSON.stringify(equityHistory)),
      marketMode:    JSON.parse(JSON.stringify(marketMode)),
      tagesStart:    JSON.parse(JSON.stringify(tagesStart)),
    }),
  });

  // Initialise event deduplicator (used for idempotent webhook handling)
  const _dedup = deduplicator({ dedupPath: DEDUP_PATH, addLog });

  // Reconcile open positions at broker vs. local state
  // Run non-blocking — don't delay server start
  reconcileOnStartup({
    broker,
    strategies:      STRATEGY_IDS,
    snapshotPath:    SNAPSHOT_PATH,
    addLog,
    autoCloseOrphans: process.env.AUTO_CLOSE_ORPHANS === 'true',
  }).catch(err => addLog('warn', `[Recovery] Startup-Reconciliation Fehler: ${err.message}`));

  server.listen(PORT, () => {
    addLog('info', `🚀 Master Bot laeuft auf Port ${PORT} (DB: ${db.available ? 'PostgreSQL' : 'JSON'})`);
    console.log(`Master Bot auf Port ${PORT}`);

    // ── Security: Recovery Tests at startup ───────────────────────────────
    runRecoveryTests({
      killSwitch,
      deduplicator: secDeduplicator,
      validateOrder,
      validateWebhookPayload,
      portfolioManager,
      broker,
    }).then(r => {
      addLog('RECOVERY_TESTS', `${r.summary} — allPassed: ${r.allPassed}`);
      if (!r.allPassed) {
        const failed = r.results.filter(t => !t.passed).map(t => `${t.name}: ${t.error}`).join(' | ');
        addLog('warn', `⚠️ [Security] Recovery Tests FAILED: ${failed}`);
      } else {
        addLog('info', `✅ [Security] All recovery tests passed`);
      }
    }).catch(err => addLog('warn', `[Security] Recovery tests error: ${err.message}`));
  });

  // ── Phase 7: Auto-Retraining Loop ─────────────────────────────────────────
  const autoRetrainer = new AutoRetrain({
    featuresPath: FEATURES_PATH,
    retrainPath:  path.join(DATA_DIR, 'retrains.jsonl'),
    mlUrl:        ML_URL,
    addLog,
    bus,
    EVENT_TYPES,
  });
  _autoRetrainer = autoRetrainer;
  if (ML_URL) {
    autoRetrainer.start();
    addLog('info', '[AutoRetrain] Retraining-Loop aktiv');
  } else {
    addLog('info', '[AutoRetrain] Inaktiv (kein ML_SERVICE_URL gesetzt)');
  }

  // ── Market Mode alle 30 Min aktualisieren (+ sofort nach 5s)
  setTimeout(analysiereMarktmodus, 5 * 1000);
  setInterval(analysiereMarktmodus, 30 * 60 * 1000);
  setInterval(syncPortfolioCapital, 5 * 60 * 1000);
  setTimeout(syncPortfolioCapital, 5000);

  // ML-Status alle 5 Min aktualisieren
  setInterval(aktualisiereMlStatus, 5 * 60 * 1000);

  // Meta-Learning: Modell-Drift alle 60 Min pruefen (+ sofort nach 30s)
  setTimeout(pruefeModelDrift, 30 * 1000);
  setInterval(pruefeModelDrift, META_CFG.CHECK_INTERVAL * 60 * 1000);

  // Strategie-Score alle 4h pruefen (+ sofort nach 10s)
  setTimeout(pruefeAlleScores, 10 * 1000);
  setInterval(pruefeAlleScores, 4 * 60 * 60 * 1000);

  // Multi-Asset Scanner (HELIX Phase 3) — scans multiple instruments simultaneously
  // Set SIGNAL_SCAN_EPICS=GOLD,EURUSD,US500 to override instrument list
  // Falls back to SIGNAL_GEN_EPIC (single instrument) for backwards compat
  if (process.env.SIGNAL_GEN_ENABLED === 'true') {
    sigGen = new MultiAssetScanner({
      baseUrl:      BASE_URL,
      getHeaders:   (_name) => getCapitalHeaders(),
      ensureAuth:   ensureAuth,
      addLog:       addLog,
      port:         PORT,
      rrr:          process.env.SIGNAL_GEN_RRR    || '2.0',
      atrSlFactor:  process.env.SIGNAL_GEN_ATR_SL || '1.5',
      intervalMs:   (parseInt(process.env.SIGNAL_GEN_INTERVAL || '60', 10)) * 1000,
      secret:       process.env.WEBHOOK_SECRET    || '',
      // Explicit instrument list (optional — falls back to env SIGNAL_SCAN_EPICS)
      instruments:  null,
    });
    sigGen.start();
    addLog('info', '[Scanner] Multi-Asset Scanner aktiv');
  } else {
    addLog('info', '[Scanner] Signal Scanner inaktiv (ENV: SIGNAL_GEN_ENABLED=false oder nicht gesetzt)');
  }
}

startServer().catch(err => {
  console.error('Startup-Fehler:', err);
  process.exit(1);
});
