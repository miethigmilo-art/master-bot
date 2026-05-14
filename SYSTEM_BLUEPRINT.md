# Master Trading Bot — System Blueprint

## Vision

Kein einfacher Trading-Bot. Ein adaptives KI-System das:
- Automatisch die beste Strategie für den aktuellen Markt erkennt
- Mehrere Assets handeln kann (Gold, Aktien, Indizes, Crypto)
- Aus jedem Trade lernt und sich selbst verbessert
- Risiken automatisch kontrolliert

Start: Paper Trading (Capital.com Demo) → später Live Trading

---

## Aktueller Stand (Mai 2026)

### Gebaut
- **master-bot** (Node.js/Express + WebSocket): Webhook-Empfang, Risk Management, AutoTune, Regime-Filter, ML-Integration, Dashboard
- **ml-service** (Python/FastAPI): XGBoost Classifier, 13-Feature-Logging, PnL-Feedback Loop, Konfidenz-Sizing
- **trading-bot**: live auf Railway deployiert (separates Projekt)

### Deployed auf Railway
- trading-bot: https://trading-bot-production-86d8.up.railway.app ✅
- master-bot: deployed, Env-Variablen noch nicht eingetragen
- ml-service: deployed, Env-Variablen noch nicht eingetragen

### Offene Punkte V1
- Env-Variablen in Railway eintragen (Capital.com Credentials, ML_SERVICE_URL)
- 60+ Trades sammeln → erstes ML-Training
- PostgreSQL einführen (aktuell JSON-Dateien)

---

## Was der Master Bot können soll

### Kern-Funktionen
1. **Multi-Asset Trading** — Gold, Aktien, Indizes, Crypto
2. **Market Mode Detection** — Bull / Bear / Sideways / High Volatility / Panic
3. **Signal Aggregation** — mehrere Quellen zusammenführen und gewichten
4. **Confidence Score (0–100)** — Trade nur wenn Score über Threshold
5. **Self-Learning** — lernt aus jedem Trade, verbessert sich automatisch
6. **Risk Management** — Drawdown, Daily Loss, Positionsgröße, Volatilitätsanpassung
7. **Multi-Agent System** — spezialisierte Agenten pro Asset/Analyse-Bereich

### Was er NICHT ist
- Kein Bot der blind Signale ausführt
- Kein System mit fixen Regeln die nie lernen
- Kein Einzel-Asset-Bot

---

## Entwicklungsphasen

### V1 — Foundation (aktuell ~70% fertig)
- TradingView Webhooks → Trade-Ausführung
- Risk Management (Drawdown, Daily Loss, AutoTune)
- Self-Learning Loop (XGBoost, PnL-Feedback, 13 Features)
- Dashboard (WebSocket, Charts, ML-Tab)

### V2 — Intelligence
- Market Mode Detection
- Backtesting Engine + Walk-Forward Testing
- Dynamischer Confidence Threshold je Marktmodus
- Strategie Scoring (Win Rate, Profit Factor, Drawdown)
- PostgreSQL statt JSON

### V3 — Learning
- Memory System (Marktbedingungen → Strategie-Performance)
- Adaptive Strategien (schlechte automatisch deaktivieren)
- Meta-Learning (wann ist Retraining nötig?)
- Strategy Evolution

### V4 — Multi-Agent System
- Spezialisierte Agenten: Trend, Risk, News, Macro, Gold, Stock, Crypto
- Master Agent aggregiert alle Signale
- Konfliktlösung: Risk Agent hat Override-Recht
- News & Sentiment Integration
- Portfolio Management (Diversifikation, Korrelation)
- Eigene Signalgenerierung (kein TradingView mehr nötig)

---

## Architektur

```
Data Layer
  ├── Marktdaten (Capital.com API / WebSocket)
  ├── Fundamentaldaten (FRED, Alpha Vantage)
  └── News / Sentiment (NewsAPI)
        ↓
Specialist Agents
  ├── Gold Bot (XAU/USD)
  ├── Stock Bot
  ├── Crypto Bot
  ├── News Agent
  └── Macro Agent
        ↓
Strategy Engine
  ├── Momentum
  ├── Trend Following
  ├── Breakout
  ├── Mean Reversion
  └── Volatility
        ↓
Risk Agent (Drawdown, Daily Loss, Positionsgröße)
        ↓
Master Bot
  ├── Signal Aggregation
  ├── Confidence Score (0–100)
  ├── Market Mode Check
  └── Final Decision
        ↓
Execution Layer (Capital.com Paper/Live)
```

**Signal-Format (jeder Agent sendet):**
```json
{
  "asset": "XAUUSD",
  "direction": "BUY | SELL | HOLD",
  "confidence": 85,
  "reasoning": ["trend_up", "low_spread", "london_session"],
  "risk_level": "medium"
}
```

---

## Self-Learning System

### Aktuell implementiert
- Feature-Logging: 13 Features pro Trade (Zeit, Session, RRR, Spread, Drawdown etc.)
- PnL-Feedback Loop: Outcome nach Trade-Abschluss zurückgeschrieben
- XGBoost Classifier: trainiert ab 60 Trades
- Konfidenz-Sizing: 0.5× / 1.0× / 1.5× je nach ML-Score
- AutoTune: Risk-Reduktion bei schlechter Performance

### Geplant
- Memory System
- Meta-Learning
- Walk-Forward Validation

---

## Design-Prinzipien

1. **Risk First** — Verlustlimits vor Gewinnoptimierung
2. **Modular** — jede Komponente unabhängig austauschbar
3. **Datengetrieben** — alles messbar, keine Bauchentscheidungen
4. **Iterativ** — V1 muss laufen bevor V2 startet
5. **Spezialisierung** — Gold Bot kennt Gold besser als ein Generalist
6. **Kein Over-Engineering** — einfachste Lösung die funktioniert

---

## Tech Stack

| Komponente | Technologie |
|---|---|
| Backend | Node.js + Express + WebSocket |
| ML | XGBoost (kein PyTorch — optimal für tabellarische Daten) |
| Datenbank | JSON → PostgreSQL (ab V2) |
| Frontend | Vanilla JS → React (ab V3) |
| Broker | Capital.com API |
| Signale | TradingView Webhooks → später eigene Generierung |
| Deployment | Railway |

---

## GitHub Repos

- master-bot: https://github.com/miethigmilo-art/master-bot
- ml-service: https://github.com/miethigmilo-art/ml-service
- trading-bot: https://github.com/miethigmilo-art/trading-bot
