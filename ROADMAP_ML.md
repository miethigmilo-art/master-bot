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

### Nächste Schritte (V1 abschließen)
1. **Trades sammeln** — 60+ pro Strategie bevor ML-Training sinnvoll ist
2. **ML_SERVICE_URL** in Railway master-bot eintragen (URL des ml-service)
3. **PostgreSQL** einführen statt JSON-Dateien (skaliert nicht über ~500 Trades)

### V2 — Market Intelligence
4. **Market Mode Detection** — Bull / Bear / Sideways / High Volatility / Panic automatisch erkennen
5. **Backtesting Engine** — historische OHLCV-Daten von Capital.com, Walk-Forward Testing
6. **Dynamischer Confidence Threshold** — je nach Marktmodus anpassen (nicht statisch 0.62)
7. **Strategie Scoring** — Win Rate, Profit Factor, Drawdown pro Strategie automatisch bewerten

### V3 — Memory & Learning
8. **Memory System** — welche Marktbedingungen führen zu Gewinnen? (nicht nur einzelne Trades)
9. **Strategy Weight Adjustment** — schlechte Strategien automatisch depriorisieren
10. **Meta-Learning** — erkennt wann Retraining nötig ist (Markt hat sich verändert)

### V4 — Multi-Agent
11. **Spezialisierte Agenten** — Trend, Risk, News, Macro, Gold, Stock, Crypto
12. **Signal Aggregation** — Master aggregiert alle Agenten-Signale
13. **News/Sentiment Integration** — Makro-Events, Earnings, CPI in Entscheidung einbeziehen
14. **Eigene Signalgenerierung** — kein TradingView mehr nötig (Capital.com WebSocket → eigene Indikatoren)

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
