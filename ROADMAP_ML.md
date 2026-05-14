# Master-Bot — ML Roadmap (Stufe 3 & 4)

## Was bereits läuft (Stufe 1 & 2)

- **Regime-Filter** (Smart): AKTIV / VORSICHTIG / PAUSE basierend auf Rolling Win-Rate
- **AutoTune**: Risk-% wird automatisch halbiert bei schlechter WR oder Verlustserien
- **Stunden-Tracking**: schlechte Handelsstunden werden erkannt und blockiert
- **Tages-Limits**: Tagesziel-Stop, Tagesverlust-Stop, Max. Drawdown

---

## Stufe 3 — Machine Learning (Python-Microservice)

### Architektur
```
TradingView Signal
      ↓
master-bot (Node.js) ──→ ML-Service (Python/FastAPI) ──→ Entscheidung
      ↓                         ↑
  Trade ausführen          Modell + Features
```

### Was das Modell lernt
Aus jedem abgeschlossenen Trade wird ein Feature-Vektor gebaut:

| Feature | Beschreibung |
|---------|-------------|
| `hour` | Stunde des Signals (0–23) |
| `weekday` | Wochentag (0=Mo, 4=Fr) |
| `side` | BUY=1, SELL=0 |
| `spread` | Bid-Ask Spread zum Zeitpunkt |
| `recent_wr_5` | Win Rate letzte 5 Trades |
| `recent_wr_15` | Win Rate letzte 15 Trades |
| `konsek_verluste` | Aktuelle Verlustserie |
| `equity_change_24h` | Equity-Veränderung letzten 24h |
| `drawdown_pct` | Aktueller Drawdown vom Start |
| `rrr` | Risk-Reward-Ratio des Signals |

**Target**: `gewinn` (1) oder `verlust` (0)

### Modell
- **Phase 1**: Random Forest (scikit-learn) — schnell, erklärbar
- **Phase 2**: XGBoost — bessere Performance bei wenig Daten
- **Phase 3**: LSTM (PyTorch) — lernt zeitliche Muster

### Training
- Mindestens 50 Trades pro Strategie bevor Modell greift
- Wöchentliches Retrain mit allen historischen Trades
- Modell speichert sich als `.pkl` Datei

### Integration in master-bot
```js
// Vor jedem Trade: ML-Service anfragen
const mlRes = await axios.post('http://ml-service:5000/predict', { features });
if (mlRes.data.wahrscheinlichkeit < 0.55) {
  return res.json({ status: 'übersprungen', grund: 'ML: zu geringes Signal' });
}
```

### Dateien die vorbereitet werden (jetzt schon sammeln)
- `data/trades.json` — wird bereits gespeichert ✅
- `data/equity.json` — wird bereits gespeichert ✅
- `data/tuning.json` — wird bereits gespeichert ✅
- `data/features.jsonl` — NEU: Feature-Log für jedes Signal (auch abgelehnte!)

---

## Stufe 4 — Vollautonomes System

### Eigene Signalgenerierung (kein TradingView mehr nötig)

```
Capital.com Marktdaten (WebSocket)
      ↓
Feature Engineering (OHLCV + Indikatoren)
      ↓
ML-Modell entscheidet: Einsteigen? In welche Richtung?
      ↓
master-bot führt aus
```

**Indikatoren die berechnet werden:**
- RSI (14), EMA (9, 21, 50), MACD, Bollinger Bands
- ATR für dynamisches SL/TP
- Volumen-Anomalien
- Tageszeit-gewichtete Signalstärke

### Backtesting-Engine
- Historische OHLCV-Daten laden (Capital.com `/prices` Endpoint)
- Strategie simulieren ohne echtes Kapital
- Sharpe Ratio, Max. Drawdown, Win Rate auswerten
- Nur wenn Backtest > Schwellenwert → Live schalten

### A/B-Testing
- Neue Strategievariante läuft mit 10% des Kapitals parallel
- Nach 30 Trades: automatischer Vergleich
- Bessere Variante gewinnt, schlechtere wird gestoppt

---

## Datenpunkte die wir JETZT schon sammeln sollten

```js
// In server.js ergänzen: Feature-Log bei jedem Signal
function logFeature(name, signal, equity, context) {
  const feature = {
    ts: Date.now(),
    strategie: name,
    side: signal.side,
    hour: new Date().getHours(),
    weekday: new Date().getDay(),
    equity,
    recentWR5:  berechneWR(name, 5),
    recentWR15: berechneWR(name, 15),
    konsek:     berechneKonsek(name),
    rrr:        context.rrr,
    ausgefuehrt: true  // false wenn blockiert
  };
  fs.appendFileSync(path.join(DATA_DIR, 'features.jsonl'), JSON.stringify(feature) + '\n');
}
```

Je mehr Trades gesammelt werden, desto besser wird das Modell.
**Ziel: 200+ Trades pro Strategie** bevor ML sinnvoll ist.

---

## Tech Stack für Stufe 3+4

| Komponente | Technologie |
|-----------|-------------|
| ML-Service | Python 3.11 + FastAPI |
| Modell | scikit-learn → XGBoost → PyTorch |
| Daten-Pipeline | pandas + numpy |
| Scheduling | APScheduler (wöchentliches Retrain) |
| Deployment | Eigener Railway Service |
| Kommunikation | REST API zwischen Node.js und Python |

---

## Nächste konkrete Schritte

1. **Jetzt**: Feature-Logging in server.js einbauen (sammelt Daten für später)
2. **Nach 50+ Trades**: Python ML-Service bauen (FastAPI + Random Forest)
3. **Nach 200+ Trades**: XGBoost mit vollständigem Feature-Set
4. **Optional**: Capital.com WebSocket für eigene Marktdaten anbinden
