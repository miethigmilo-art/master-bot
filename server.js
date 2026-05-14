require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const { WebSocketServer } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT     = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL;
const ML_URL   = process.env.ML_SERVICE_URL || null;  // z.B. https://ml-service.up.railway.app
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Settings ──────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
let SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
// Original-Werte merken (für AutoTune-Wiederherstellung)
const SETTINGS_ORIGINAL = JSON.parse(JSON.stringify(SETTINGS));

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(SETTINGS, null, 2));
}

// ── Konten ────────────────────────────────────────────
const KONTEN = {
  mittel:      { apiKey: process.env.API_KEY,            email: process.env.EMAIL,            password: process.env.PASSWORD,            cst: null, token: null },
  aggressiv:   { apiKey: process.env.API_KEY_AGGRESSIV,  email: process.env.EMAIL_AGGRESSIV,  password: process.env.PASSWORD_AGGRESSIV,  cst: null, token: null },
  smart:       { apiKey: process.env.API_KEY_GOLDGLOBE,  email: process.env.EMAIL_GOLDGLOBE,  password: process.env.PASSWORD_GOLDGLOBE,  cst: null, token: null },
  konservativ: { apiKey: process.env.API_KEY_KONSERVATIV,email: process.env.EMAIL_KONSERVATIV,password: process.env.PASSWORD_KONSERVATIV, cst: null, token: null },
  optimiert:   { apiKey: process.env.API_KEY_OPTIMIERT,  email: process.env.EMAIL_OPTIMIERT,  password: process.env.PASSWORD_OPTIMIERT,  cst: null, token: null },
  test:        { apiKey: process.env.API_KEY_TEST,       email: process.env.EMAIL_TEST,       password: process.env.PASSWORD_TEST,       cst: null, token: null },
  adaptive:    { apiKey: process.env.API_KEY_TEST2,      email: process.env.EMAIL_TEST2,      password: process.env.PASSWORD_TEST2,      cst: null, token: null },
  steady:      { apiKey: process.env.API_KEY_STEADY,     email: process.env.EMAIL_STEADY,     password: process.env.PASSWORD_STEADY,     cst: null, token: null },
};

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

function buildDefaultPerf() {
  const p = {};
  Object.keys(KONTEN).forEach(n => { p[n] = { trades: 0, gewinn: 0, verlust: 0, gesamtPnL: 0, bester: 0, schlechtester: 0, equity: SETTINGS[n]?.startEquity || 1000, winRate: 0 }; });
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

// ── Capital.com Auth ──────────────────────────────────
async function login(name) {
  const k = KONTEN[name];
  if (!k.apiKey || !k.email || !k.password) throw new Error(`Fehlende Credentials für ${name}`);
  const res = await axios.post(`${BASE_URL}/session`,
    { identifier: k.email, password: k.password },
    { headers: { 'X-CAP-API-KEY': k.apiKey } });
  k.cst   = res.headers['cst'];
  k.token = res.headers['x-security-token'];
  addLog('info', `✅ Login: ${name} (${k.email})`);
}

async function ensureAuth(name) {
  if (!KONTEN[name].cst) await login(name);
}

function headers(name) {
  const k = KONTEN[name];
  return { 'X-CAP-API-KEY': k.apiKey, 'CST': k.cst, 'X-SECURITY-TOKEN': k.token };
}

async function getEquity(name) {
  try {
    const res = await axios.get(`${BASE_URL}/accounts`, { headers: headers(name) });
    const bal = res.data.accounts[0]?.balance;
    return bal?.balance ?? bal?.available ?? bal;
  } catch (err) {
    if (err.response?.status === 401) { await login(name); return getEquity(name); }
    throw err;
  }
}

async function getPositions(name) {
  const res = await axios.get(`${BASE_URL}/positions`, { headers: headers(name) });
  return res.data.positions || [];
}

async function closePositions(name, epic) {
  try {
    const positions = await getPositions(name);
    for (const p of positions.filter(x => x.market?.epic === epic)) {
      await axios.delete(`${BASE_URL}/positions/${p.position.dealId}`, { headers: headers(name) });
      addLog('info', `🔒 [${name}] Position geschlossen: ${p.position.dealId}`);
    }
  } catch (err) { addLog('warn', `⚠️ [${name}] closePositions: ${err.message}`); }
}

async function placeOrder(name, order) {
  try {
    return await axios.post(`${BASE_URL}/positions`, order, { headers: headers(name) });
  } catch (err) {
    if (err.response?.status === 401) {
      addLog('info', `🔄 [${name}] Session erneuert, wiederhole Order...`);
      await login(name);
      return await axios.post(`${BASE_URL}/positions`, order, { headers: headers(name) });
    }
    throw err;
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
  broadcast('performance', { name, perf: p });
}

function addEquity(name, equity) {
  if (!equityHistory[name]) equityHistory[name] = [];
  equityHistory[name].push({ ts: Date.now(), equity });
  if (equityHistory[name].length > 500) equityHistory[name].shift();
  saveJSON(EQUITY_PATH, equityHistory);
  broadcast('equity', { name, equity, ts: Date.now() });
}

function addTrade(name, trade) {
  if (!tradeHistory[name]) tradeHistory[name] = [];
  tradeHistory[name].push(trade);
  if (tradeHistory[name].length > 200) tradeHistory[name].shift();
  saveJSON(TRADES_PATH, tradeHistory);
  trackStunde(name, trade.pnl);
}

// ── Stunden-Tracking ──────────────────────────────────
function trackStunde(name, pnl) {
  const h = new Date().getHours();
  if (!stundenStats[name]) stundenStats[name] = {};
  if (!stundenStats[name][h]) stundenStats[name][h] = { wins: 0, losses: 0 };
  if (pnl > 0) stundenStats[name][h].wins++;
  else stundenStats[name][h].losses++;
  saveJSON(STUNDEN_PATH, stundenStats);  // FIX 4: Nach jeder Aktualisierung persistieren
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
    tuningHistory[name].push({ ts: new Date().toISOString(), aktion, wr: wrPct, konsek, riskPct: SETTINGS[name].riskPct });
    if (tuningHistory[name].length > 100) tuningHistory[name].shift();
    saveJSON(TUNING_PATH, tuningHistory);
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

// ── Feature Logger (für späteres ML-Training) ────────
const FEATURES_PATH = path.join(DATA_DIR, 'features.jsonl');

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
function logFeature(name, side, equity, rrr, ausgefuehrt, grund = null, extras = {}) {
  try {
    const s    = SETTINGS[name] || {};
    const hour = new Date().getHours();
    const { offer = null, bid = null, entry = null, slF = null, tpF = null } = extras;

    const feature = {
      ts: Date.now(), strategie: name, side, equity,
      hour, weekday: new Date().getDay(),
      recentWR5:  berechneWR(name, 5),
      recentWR15: berechneWR(name, 15),
      konsek:     berechneKonsek(name),
      rrr:        rrr || null,
      ausgefuehrt,
      grund,
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
    }
  } catch {}
}

// ── Webhook Handler ───────────────────────────────────
async function handleWebhook(req, res, name) {
  const s = SETTINGS[name];
  if (!s) return res.status(400).json({ error: 'Unbekannte Strategie' });
  if (!s.enabled) return res.json({ status: 'deaktiviert', strategie: name });

  const secret = req.body.secret || req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET)
    return res.status(401).json({ error: 'Ungültiger Secret' });

  if (aktiveTrades[name]) return res.status(429).json({ error: 'Trade läuft bereits' });
  if (letzterTrade[name] && Date.now() - letzterTrade[name] < 30000)
    return res.status(429).json({ error: 'Cooldown aktiv (30s)' });

  aktiveTrades[name] = true;
  try {
    addLog('info', `📨 Signal [${name}]: ${JSON.stringify(req.body)}`);
    const { side, sl, tp } = req.body;
    if (!side || !sl || !tp) return res.status(400).json({ error: 'Fehlende Felder (side/sl/tp)' });

    await ensureAuth(name);
    const equity = await getEquity(name);
    performance[name].equity = equity;

    if (tagesStart[name] == null) tagesStart[name] = equity;
    const tagesPct = ((equity - tagesStart[name]) / tagesStart[name]) * 100;

    if (tagesPct >= s.tagsStopPct) {
      return res.json({ status: 'pausiert', grund: 'Tagesziel' });
    }
    if (s.tagsVerlustPct && tagesPct <= -s.tagsVerlustPct) {
      await tg(`\u{1F6D1} ${name} Tagesverlust-Stop -${s.tagsVerlustPct}%`);
      return res.json({ status: 'pausiert', grund: 'Tagesverlust-Stop' });
    }
    const drawdown = ((s.startEquity - equity) / s.startEquity) * 100;
    if (performance[name].trades > 0 && drawdown >= s.maxDrawdownPct) {
      await tg(`\u{1F6D1} <b>${name}</b> gestoppt — Max. Drawdown erreicht`);
      return res.json({ status: 'gestoppt', grund: 'Max. Drawdown' });
    }

    // Schlechte Handelsstunde erkennen
    if (istSchlechteStunde(name)) {
      addLog('tuning', `⏰ [${name}] Schlechte Stunde (${new Date().getHours()}:xx) — übersprungen`);
      logFeature(name, req.body.side, equity, null, false, 'schlechte Handelsstunde');
      return res.json({ status: 'übersprungen', grund: 'schlechte Handelsstunde' });
    }

    let regimeModus = 'AKTIV';
    if (s.regimeFilter) {
      const regime = await pruefeRegime();
      if (regime.geblockt) return res.json({ status: 'übersprungen', grund: regime.grund });
      regimeModus = regime.modus;
      if (regimeModus === 'VORSICHTIG' && side === 'SELL')
        return res.json({ status: 'übersprungen', grund: 'VORSICHTIG – nur LONG' });
    }

    // PnL aufzeichnen
    if (letzteEquity[name] != null) {
      const pnl = parseFloat((equity - letzteEquity[name]).toFixed(2));
      if (pnl !== 0) {
        updatePerf(name, pnl);
        addTrade(name, { datum: new Date().toISOString(), pnl, equity, side });
        addLog('info', `\u{1F4DD} [${name}] PnL ${pnl >= 0 ? '+' : ''}${pnl}€`);
        // FIX 1: PnL-Feedback Loop — pending Feature mit Outcome abschließen und in features.jsonl schreiben
        if (pendingFeatures[name]) {
          const completed = { ...pendingFeatures[name], pnl };
          fs.appendFileSync(FEATURES_PATH, JSON.stringify(completed) + '\n');
          delete pendingFeatures[name];
        }
        await autoTune(name);  // Nach jedem Trade: Selbst-Anpassung prüfen
      }
    }
    letzteEquity[name] = equity;
    addEquity(name, equity);

    // RRR prüfen
    let slF = parseFloat(sl), tpF = parseFloat(tp);
    const minRRR = (s.regimeFilter && regimeModus === 'VORSICHTIG') ? 3.5 : s.minRRR;
    // FIX 2: entry, offer, bid außerhalb des try-Blocks deklarieren
    let entry = null, offer = null, bid = null;
    try {
      const mkt = await axios.get(`${BASE_URL}/markets/GOLD`, { headers: headers(name) });
      offer = mkt.data.snapshot.offer;
      bid   = mkt.data.snapshot.bid;
      entry = side === 'BUY' ? offer : bid;
      const riskD = Math.abs(entry - slF), rewardD = Math.abs(tpF - entry);
      if (riskD > 0 && rewardD / riskD < minRRR) {
        tpF = side === 'BUY' ? entry + riskD * minRRR : entry - riskD * minRRR;
        tpF = parseFloat(tpF.toFixed(2));
        addLog('info', `\u{1F4D0} [${name}] RRR angepasst: TP → ${tpF}`);
      }
    } catch {}

    // FIX 2: RRR korrekt berechnen (entry→sl = Risiko, entry→tp = Reward)
    const slDist     = entry != null ? Math.abs(entry - slF) : Math.abs(tpF - slF);
    const rewardDist = entry != null ? Math.abs(tpF - entry) : Math.abs(tpF - slF);
    const rrr = slDist > 0 ? parseFloat((rewardDist / slDist).toFixed(2)) : 2.0;
    const extras = { offer, bid, entry, slF, tpF };

    // ── ML-Filter ─────────────────────────────────────────────────
    const ml  = await mlPredict(name, side, equity, rrr);
    addLog('info', `\u{1F916} [${name}] ML: ${ml.empfehlung} (${ml.konfidenz ? (ml.konfidenz*100).toFixed(0)+'%' : 'kein Modell'}) — ${ml.grund}`);
    if (ml.empfehlung === 'skip') {
      logFeature(name, side, equity, rrr, false, `ML: ${ml.grund}`, extras);
      broadcast('ml_skip', { name, side, konfidenz: ml.konfidenz, grund: ml.grund });
      return res.json({ status: 'übersprungen', grund: ml.grund, ml });
    }

    await closePositions(name, 'GOLD');

    // Konfidenz-basiertes Sizing: ML gibt sizing_faktor zurück (0.5 / 1.0 / 1.5)
    const sizingFaktor = ml.sizing_faktor != null ? ml.sizing_faktor : 1.0;
    const riskCapital = equity * (s.riskPct / 100) * sizingFaktor;
    const size = slDist > 0 ? Math.max(1, parseFloat((riskCapital / slDist).toFixed(1))) : 1;

    const order = { epic: 'GOLD', direction: side, size, guaranteedStop: false, stopLevel: slF, profitLevel: tpF };
    addLog('info', `\u{1F4E4} [${name}] Order: ${JSON.stringify(order)}`);
    await placeOrder(name, order);

    logFeature(name, side, equity, rrr, true, null, extras);
    await tg(`${side === 'BUY' ? '\u{1F7E2}' : '\u{1F534}'} <b>${side === 'BUY' ? 'LONG' : 'SHORT'}</b> — <b>${name}</b>\nSize: ${size} | SL: ${slF} | TP: ${tpF}${ml.trainiert ? ` | ML: ${(ml.konfidenz*100).toFixed(0)}%` : ''}`);
    broadcast('trade', { name, side, size, sl: slF, tp: tpF, equity });
    res.json({ status: 'ok', name, size, sl: slF, tp: tpF });

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

// ── SL Update ─────────────────────────────────────────────────────
app.post('/webhook/update_sl/:name', async (req, res) => {
  const { name } = req.params;
  const { sl } = req.body;
  if (!sl || !KONTEN[name]) return res.status(400).json({ error: 'Ungültig' });
  try {
    await ensureAuth(name);
    const positions = await getPositions(name);
    const pos = positions.find(p => p.market?.epic === 'GOLD');
    if (!pos) return res.json({ status: 'keine Position' });
    await axios.put(`${BASE_URL}/positions/${pos.position.dealId}`, { stopLevel: parseFloat(sl) }, { headers: headers(name) });
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
  for (const name of Object.keys(KONTEN)) {
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
  for (const name of Object.keys(KONTEN)) {
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

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', strategies: Object.keys(KONTEN).length }));

// ── Server starten ────────────────────────────────────────────────────────
server.liste