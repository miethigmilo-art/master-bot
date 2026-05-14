# Master Bot — Kontext für neue Chats

## Was dieses Projekt ist

Ein adaptives KI-Trading-System das mehrere Assets handeln kann (Gold, Aktien, Indizes, Crypto), Strategien dynamisch auswählt und aus jedem Trade lernt. Kein einfacher Bot — ein Master-System.

## GitHub Repos

- master-bot: https://github.com/miethigmilo-art/master-bot
- ml-service: https://github.com/miethigmilo-art/ml-service
- trading-bot: https://github.com/miethigmilo-art/trading-bot (bereits live)
- GitHub Token: `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`

## Railway Deployments

- trading-bot: https://trading-bot-production-86d8.up.railway.app ✅
- master-bot: deployed auf Railway, Env-Variablen noch einzutragen
- ml-service: deployed auf Railway, Env-Variablen noch einzutragen

## Workspace-Ordner

`C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\`
- `master-bot/` — Node.js Backend + Dashboard
- `ml-service/` — Python ML-Service

## Capital.com API

- Demo API: `https://demo-api-capital.backend-capital.com/api/v1`
- Auth: CST + X-SECURITY-TOKEN Header
- Pro Konto: API_KEY, EMAIL, PASSWORD

## Was gebaut wurde

### master-bot (Node.js/Express + WebSocket)
- Webhook-Empfang von TradingView
- Risk Management: Drawdown-Stop, Daily Loss, AutoTune
- AutoTune: Risk wird automatisch angepasst bei schlechter Win-Rate
- Regime-Filter: AKTIV / VORSICHTIG / PAUSE
- ML-Integration: ruft ml-service vor jedem Trade an
- **PnL-Feedback Loop** (Fix Mai 2026): Features werden nach Trade mit Outcome geschrieben
- **RRR korrekt berechnet** (Fix Mai 2026): entry→sl / entry→tp
- **Stunden-Persistenz** (Fix Mai 2026): stundenStats überleben Neustarts
- **Konfidenz-Sizing**: ML gibt sizing_faktor zurück (0.5× / 1.0× / 1.5×)
- Feature-Logging: 13 Features pro Trade in features.jsonl
- Dashboard: WebSocket, Charts, AutoTune-Tab, ML-Tab, Live-Logs

### ml-service (Python/FastAPI)
- **XGBoost Classifier** (kein Random Forest, kein PyTorch)
- MIN_TRADES = 60 (erhöht von 30)
- PREDICT_CONF = 0.62 (erhöht von 0.58)
- 3-stufiges Sizing: skip / 0.5× / 1.0× / 1.5×
- Wöchentliches Auto-Retrain
- 13 Features im Training (inkl. slDistPct, spread, sessionLondon etc.)
- Import: TradingView CSV + Telegram JSON

## Feature-Vektor (13 Features)

hour, weekday, sessionLondon, sessionOverlap, side_buy, wr5, wr15, konsek, rrr, slDistPct, rewardPct, spread, drawdownPct

## Env-Variablen master-bot (Railway)

```
BASE_URL=https://demo-api-capital.backend-capital.com/api/v1
API_KEY=
EMAIL=
PASSWORD=
[weitere Konten je nach Anzahl Strategien]
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
WEBHOOK_SECRET=
ML_SERVICE_URL=  ← Railway URL des ml-service
PORT=8080
```

## Env-Variablen ml-service (Railway)

```
MIN_TRADES=60
PREDICT_CONF=0.62
```

## Offene Aufgaben (priorisiert)

1. Env-Variablen in Railway eintragen (Capital.com Credentials + ML_SERVICE_URL)
2. 60+ Trades sammeln → ML-Training starten
3. Market Mode Detection bauen (V2)
4. Backtesting Engine (V2)
5. PostgreSQL einführen (V2)

## Wichtige Hinweise

- Git push via Git Bash (PowerShell hat Execution Policy Problem)
- Railway deployed automatisch bei GitHub Push
- Ziel ist Multi-Asset Trading — nicht nur Gold
- XGBoost bleibt das Modell (kein Upgrade auf PyTorch geplant)
- Der Master Bot entscheidet final über alle Trades

## Detaillierte Docs

- SYSTEM_BLUEPRINT.md — vollständige Architektur + Phasen
- ROADMAP_ML.md — ML-Roadmap aktueller Stand
- DASHBOARD_SPEC.md — Dashboard Anforderungen
