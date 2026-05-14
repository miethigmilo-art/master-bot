# Master Trading Bot – Dashboard Spec

## Ziel

Real-time AI Trading Control Dashboard:
- Live Markt + Agent + Risiko Visualisierung
- WebSocket-only Streaming (kein Polling)
- Hedgefund-style Control Room UI
- Vollständig reaktiv (kein manueller Refresh)

---

## 1. UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  TOP BAR: System Status + Market Mode                   │
├──────────────┬──────────────────────┬───────────────────┤
│ LEFT         │ CENTER               │ RIGHT             │
│ System Info  │ Live Chart           │ Risk Engine       │
│ Agent Panel  │ (Candlestick)        │ Confidence Score  │
│              │                      │ Alerts            │
├──────────────┴──────────────────────┴───────────────────┤
│  BOTTOM: Live Event Stream (full width)                 │
└─────────────────────────────────────────────────────────┘
```

**Style:**
- Dark Mode + Glassmorphism
- Neon-Farbcode: Grün = BUY/Profit | Rot = SELL/Risk | Gelb = Warnung | Blau = Info
- Pflicht-Animationen bei jedem Update

---

## 2. Live Data System

**WebSocket-only** — kein REST-Polling
Latenz-Ziel: < 200ms

**Event Schema:**
```json
{
  "timestamp": "ISO8601",
  "source": "TrendAgent | RiskAgent | Master | ...",
  "type": "SIGNAL | RISK | INFO | TRADE",
  "asset": "XAUUSD | AAPL | ...",
  "action": "BUY | SELL | HOLD",
  "confidence": 0,
  "price": 0,
  "message": ""
}
```

---

## 3. Master Status (Links oben)

| Feld | Werte |
|---|---|
| System | ACTIVE / LEARNING / PAUSED |
| Market Mode | Bull / Bear / Sideways / Panic / High Volatility |
| AI Mode | Conservative / Balanced / Aggressive |

---

## 4. Agent Panel (Links Mitte)

**Agenten:**
- Trend Agent
- Risk Agent
- News Agent
- Macro Agent
- Gold Bot
- Stock Bot
- Crypto Bot

**Pro Agent anzeigen:**
- Status (aktiv/inaktiv)
- Accuracy %
- Aktuelles Signal
- Contribution Score

---

## 5. Center: Live Chart

- Candlestick Chart (Haupt-Asset)
- Multi-Timeframe Toggle (1m / 5m / 15m / 1h / 4h / 1d)
- Indikatoren: EMA, RSI, Volumen
- AI Prediction Line (optional)
- Buy/Sell Marker auf Chart
- Echtzeit-Kerzen-Animation

---

## 6. Right Panel – Risk Engine

**Risiko-Metriken:**
- Portfolio Risk %
- Max Drawdown
- Daily Loss Limit
- Exposure %

**Confidence:**
- Trade Confidence Score (0–100)
- Aktueller Threshold
- Agent Agreement Score (wieviele Agenten stimmen überein)

**Alerts:**
- Volatility Spike
- News Impact
- Risk Breach
- Strategy Switch

---

## 7. Live Event Stream (Bottom, volle Breite)

**Format:**
```
[HH:MM:SS] Agent → ACTION ASSET (confidence%)
```

**Beispiel:**
```
[14:32:01] Trend     → BUY  XAUUSD (92%)   🟢
[14:32:01] Risk      → APPROVED             ✅
[14:32:02] Master    → EXECUTE              ⚡
[14:32:02] Execution → FILLED  @ 2341.50   💰
```

**Regeln:**
- Neueste Events oben
- Farbcodiert nach Typ
- Fade-in Animation
- Auto-Scroll (optional)

---

## 8. Network View (Optionaler Tab)

Graph-Visualisierung aller Agenten und Datenflüsse:

**Nodes:** Master, Agents, Data Sources, Execution
**Edges:** Signal- und Datenfluss

| Eigenschaft | Bedeutung |
|---|---|
| Linienstärke | Signalstärke |
| Knotengröße | Wichtigkeit |
| Farbe | Performance |
| Pulsieren | Aktiver Fluss |

---

## 9. Performance Tab

- P&L Live (kumulativ)
- Win Rate gesamt + pro Strategie
- Profit Factor
- Drawdown Kurve
- Strategie-Vergleich (Heatmap)
- Agent Ranking

---

## 10. UI Reaktions-Anforderungen

Das UI muss sofort reagieren auf:

| Event | UI Reaktion |
|---|---|
| Neues Signal | Pulse-Animation auf Agent |
| Trade ausgeführt | Flash grün/rot |
| Risk-Warnung | UI-Rand rot |
| Market Mode Wechsel | Top Bar Farbwechsel |
| Agent-Fehler | Agent-Card rot + Alert |
| Confidence Drop | Glow reduziert |

---

## 11. Animationen (Pflicht)

- Signale: Puls-Animation
- Trades: Flash grün (Gewinn) / rot (Verlust)
- Risk steigt: UI kippt ins Rote
- Confidence steigt: Glow-Effekt
- Agent-Update: Slide-in von links

---

## 12. System-Prinzip

Kein statisches UI.

Es ist ein **Real-Time AI Trading Control Room:**
- Alles streamt
- Alles reagiert
- Alles ist event-driven

---

## 13. User-Ziele

Der User muss können:
- KI-Entscheidungen verstehen
- Reasoning live verfolgen
- Risiko sofort erkennen
- Alle Agenten überwachen
- Strategien visuell debuggen

---

## 14. Verbindung zum aktuellen System

**Was bereits existiert (master-bot):**
- WebSocket Broadcasts: log, performance, equity, trade, settings, regime, tuning, ml_status
- 8 Strategie-Karten mit Toggle + Settings
- Chart.js Equity-Kurven
- AutoTune Tab
- ML Tab
- Live-Log Stream

**Was noch fehlt für vollständigen Spec:**
- Candlestick Chart (aktuell nur Equity-Linie)
- Multi-Asset / Multi-Timeframe Toggle
- Agent Panel (aktuell keine Agenten-Architektur)
- Network Graph View
- Confidence Score Live-Anzeige pro Trade
- Market Mode Anzeige (Smart Regime existiert, aber nicht prominent)
- Animationen für alle Events

**Reihenfolge:** Dashboard-Upgrade sinnvoll nach V2 (wenn Agenten-Architektur steht).

---

## End Goal

**Professional-grade:**
- Hedge Fund Terminal
- AI Command Center
- Real-Time Decision Engine UI
