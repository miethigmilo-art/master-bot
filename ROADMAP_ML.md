# Master Bot — ML Roadmap (aktueller Stand Mai 2026)

## Was bereits implementiert ist

### Self-Learning System (server.js)
- **PnL Feedback Loop** — jeder ausgeführte Trade bekommt sein Ergebnis (Gewinn/Verlust) zurückgeschrieben in features.jsonl
- **Feature-Logging (13 Features):** hour, weekday, sessionLondon, sessionOverlap, side, wr5, wr15, konsek, rrr, slDistPct, rewardPct, spread, drawdownPct
- **Konfidenz-basiertes Sizing:** skip / 0.5× / 1.0× / 1.5× je nach ML-Wahrscheinlichkeit
- **AutoTune:** Risk-Reduktion bei schlechter Win-Rate oder Verlustserien
- **Stunden-Persistenz:** stundenStats überleben Server-Neustarts

### ML-Service (ml-service/main.py)
- **XGBoost Classifier** (kein Random Forest, kein PyTorch — XGBoost ist optimal für tabellarische Handelsdaten)
- **MIN_TRADES = 60** pro Strategie bevor Modell aktiv wird
- **Konfidenz-Schwelle = 0.62** (erhöht von 0.58)
- **3-stufiges Sizing:** < 0.54 → skip | 0.54–0.62 → 0.5× | 0.62–0.72 → 1.0× | > 0.72 → 1.5×
- **Klassen-Balance** automatisch per scale_pos_weight
- **Wöchentliches Auto-Retrain** montags 03:00

---

## Was noch fehlt (priorisiert)

### Nächste Schritte (V1 abschließen) ✅ FERTIG
1. ✅ **Trades sammeln** — 60+ pro Strategie bevor ML-Training sinnvoll ist
2. ✅ **ML_SERVICE_URL** in Railway master-bot eintragen (URL des ml-service)
3. ✅ **PostgreSQL** — db.js Adapter + dual-write in server.js + ml-service liest aus shared DB

### V2 — Market Intelligence ✅ FERTIG
4. ✅ **Market Mode Detection** — Bull / Bear / Sideways / High Volatility / Panic automatisch erkennen
5. ✅ **Backtesting Engine** — historische OHLCV-Daten von Capital.com, Walk-Forward Testing
6. ✅ **Dynamischer Confidence Threshold** — je nach Marktmodus anpassen (nicht statisch 0.62)
7. ✅ **Strategie Scoring** — Score 0–100 (WR×35% + PF×30% + Sharpe×20% − DD×15%), Auto-Pause < 25, Auto-Resume ≥ 40, alle 4h + nach jedem Trade, manuelles Resume via API

### Event Backbone ✅ FERTIG
- ✅ **eventbus.js** — zentraler Event Bus (4 Streams: market/signal/risk/execution), Redis-kompatible API
- ✅ **risk_engine.js** — Risk Engine als eigenständige Komponente, abonniert signal-stream
- ✅ **server.js Integration** — SIGNAL_RECEIVED, SIGNAL_ENRICHED, ORDER_PLACED, PNL_RECORDED, MARKET_MODE_UPDATED Emissions
- ✅ **waitForRiskDecision()** — HTTP/Event-Bridge für async Risk Engine Antworten
- ✅ **/api/events** — Event Log Endpoint (letzte N Events + Stats)
- ✅ **WS Bus Bridge** — alle Bus Events werden ans Dashboard gestreamt (bus_event)

### V3 — Memory & Learning
8. ✅ **Memory System** — welche Marktbedingungen führen zu Gewinnen? (nicht nur einzelne Trades)
9. ✅ **Strategy Weight Adjustment** — Score-basiertes Sizing: ≥70→1.2×, ≥50→1.0×, ≥35→0.6×, ≥25→0.3×, <25→hard pause
10. ✅ **Meta-Learning** — 3 Drift-Signale: Accuracy-Abfall >15%, Avg-Konfidenz <54%, Modell >14 Tage alt → automatisches Retrain via /train

### V4 — Multi-Agent
11. ✅ **Spezialisierte Agenten** — TrendAgent, SessionAgent, MomentumAgent, SetupAgent, NewsAgent (agents.js)
12. ✅ **Signal Aggregation** — Weighted voting: avgVote < 0.35 → Skip | avgVote > 0.80 → Sizing-Boost 1.1×
13. ✅ **News/Sentiment Integration** — NewsAgent: NFP/CPI/FOMC Blackout-Fenster, manuell erweiterbar
14. ✅ **Eigene Signalgenerierung** — Capital.com REST (1-Min OHLCV) → EMA(20/50) Crossover + ATR/RSI Filter → signal_generator.js

---

## Feature-Vektor (aktuell)

| Feature | Beschreibung |
|---|---|
| hour | Stunde des Signals (0–23) |
| weekday | Wochentag (0=Mo, 6=So) |
| sessionLondon | 1 wenn 08:00–12:00 |
| sessionOverlap | 1 wenn 13:00–17:00 (London/NY Overlap) |
| side_buy | BUY=1, SELL=0 |
| wr5 | Win Rate letzte 5 Trades |
| wr15 | Win Rate letzte 15 Trades |
| konsek | Aktuelle Verlustserie (max 10) |
| rrr | Risk-Reward-Ratio (korrekt: entry→sl / entry→tp) |
| slDistPct | SL-Abstand vom Entry in % |
| rewardPct | TP-Abstand vom Entry in % |
| spread | Bid-Ask Spread zum Zeitpunkt |
| drawdownPct | Aktueller Drawdown vom Start-Equity |

**Label:** 1 = Gewinn, 0 = Verlust

---

## Tech Stack (final)

| Komponente | Technologie |
|---|---|
| Backend | Node.js + Express + WebSocket |
| ML-Service | Python + FastAPI |
| Modell | XGBoost (fest — kein Upgrade auf PyTorch geplant) |
| Daten | features.jsonl → PostgreSQL (ab V2) |
| Scheduling | APScheduler (wöchentliches Retrain) |
| Deployment | Railway (GitHub Auto-Deploy) |

---

## Hardening (V5) — Status

### System Hardening ✅ FERTIG
- ✅ **Circuit Breaker** — ML-Service (threshold=3, reset=30s) + Capital.com (threshold=5, reset=60s)
- ✅ **Signal Deduplication** — 15s TTL-Fenster, verhindert Doppel-Trades
- ✅ **State Validator** — prüft equity/riskPct/startEquity vor jedem Trade
- ✅ **Metrics Collector** — Counters, rolling Latenz, Error-Log (letzten 10)
- ✅ **Risk Engine als echter Gatekeeper** — waitForRiskDecision(), Timeout → fail-safe REJECT
- ✅ **/api/health/deep** — vollständiger System-Gesundheits-Snapshot
- ✅ **/api/state** — autoritativer State-Snapshot für Dashboard-Resync
- ✅ **WS Reconnect** — Exponential Backoff (1s→30s) + vollständiger State-Reload nach Reconnect
- ✅ **System Health Panel** — neuer Tab im Dashboard (Circuit Breakers, Metriken, Latenz, Fehler)

### Offen
- ✅ **Eigene Signalgenerierung** — signal_generator.js fertig (siehe V4 #14 oben)
- 🔲 **Railway Deploy** — git_push.bat ausführen + DATABASE_URL