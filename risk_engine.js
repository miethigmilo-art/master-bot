// ══════════════════════════════════════════════════════════════
//  Master Bot — Risk Engine V1
//
//  Abonniert signal-stream, prüft alle Risiko-Regeln zentral,
//  und emittiert RISK_APPROVED / RISK_REJECTED / RISK_SIZED.
//
//  Alle Risiko-Logik kommt hierher — nicht mehr verteilt in server.js.
// ══════════════════════════════════════════════════════════════
'use strict';

const { bus, STREAMS, EVENT_TYPES } = require('./eventbus');

class RiskEngine {
  constructor(getState) {
    // getState() gibt aktuellen System-State zurück (settings, performance, marketMode, etc.)
    this.getState = getState;
    this._aktiv   = true;

    // Risk Engine abonniert signal-stream
    // BUGFIX: setImmediate() verhindert eine Race Condition.
    // _evaluate() ist async aber hat kein await — läuft also synchron durch und
    // emittiert RISK_SIZED/REJECTED BEVOR waitForRiskDecision() seinen Listener
    // auf dem RISK-Stream registrieren kann. Das führt dazu, dass alle Signale
    // in den 5s-Timeout laufen und kein einziger Trade ausgeführt wird.
    // setImmediate() stellt sicher, dass die Evaluation NACH dem aktuellen
    // Synchron-Call-Stack startet — also nachdem waitForRiskDecision() seinen
    // Listener bereits registriert hat.
    bus.subscribe(STREAMS.SIGNAL, (event) => {
      if (event.type === EVENT_TYPES.SIGNAL_ENRICHED) {
        setImmediate(() => {
          this._evaluate(event).catch(err => {
            bus.emit_event(EVENT_TYPES.ERROR, 'risk_engine', { error: err.message, event });
          });
        });
      }
    });
  }

  async _evaluate(signalEvent) {
    const { strategie, side, sl, tp, equity, rrr, entry } = signalEvent.payload;
    const state    = this.getState();
    const settings = state.settings[strategie] || {};
    const perf     = state.performance[strategie] || {};
    const mm       = state.marketMode;
    const scores   = state.scorePauses || {};

    const checks = [];
    let approved  = true;

    // ── Regel 1: Strategie aktiv? ─────────────────────
    if (!settings.enabled) {
      return this._reject(signalEvent, 'Strategie deaktiviert', 'DISABLED');
    }

    // ── Regel 2: PANIC Modus ──────────────────────────
    if (mm.modus === 'PANIC') {
      return this._reject(signalEvent, 'PANIC Modus — kein Trading', 'PANIC');
    }

    // ── Regel 3: Score-Pause ──────────────────────────
    if (scores[strategie]?.paused) {
      return this._reject(signalEvent, `Score-Pause (${scores[strategie].score}/100)`, 'SCORE_PAUSE');
    }

    // ── Regel 4: Max Drawdown ─────────────────────────
    const drawdown = settings.startEquity > 0
      ? ((settings.startEquity - equity) / settings.startEquity) * 100
      : 0;
    if (perf.trades > 0 && drawdown >= settings.maxDrawdownPct) {
      return this._reject(signalEvent, `Max Drawdown erreicht (${drawdown.toFixed(1)}%)`, 'MAX_DRAWDOWN');
    }

    // ── Regel 5: Tagesverlust-Stop ────────────────────
    const tagesStart = state.tagesStart[strategie];
    if (tagesStart != null) {
      const tagesPct = ((equity - tagesStart) / tagesStart) * 100;
      if (settings.tagsVerlustPct && tagesPct <= -settings.tagsVerlustPct) {
        return this._reject(signalEvent, `Tagesverlust-Stop -${settings.tagsVerlustPct}%`, 'DAY_LOSS_STOP');
      }
      if (tagesPct >= settings.tagsStopPct) {
        return this._reject(signalEvent, 'Tagesziel erreicht', 'DAY_TARGET');
      }
    }

    // ── Regel 6: RRR Minimum ──────────────────────────
    const mmConfig = state.marketModes[mm.modus] || {};
    const minRRR   = settings.minRRR || 2.0;
    if (rrr < minRRR) {
      return this._reject(signalEvent, `RRR ${rrr} < Minimum ${minRRR}`, 'RRR_TOO_LOW');
    }

    // ── Alle Checks bestanden → APPROVED ─────────────
    // Positions-Größe berechnen
    const slDist      = entry && sl ? Math.abs(entry - parseFloat(sl)) : 0;
    const mmSizing    = mmConfig.sizingFaktor ?? 1.0;
    const mlSizing    = signalEvent.payload.mlSizingFaktor ?? 1.0;
    const sizingFaktor = parseFloat((mlSizing * mmSizing).toFixed(2));
    const riskCapital  = equity * (settings.riskPct / 100) * sizingFaktor;
    // Raw size from risk formula, then cap at maxSizeUSD (default 5000 USD notional)
    const rawSize      = slDist > 0 ? riskCapital / slDist : 1;
    const maxSizeUSD   = settings.maxSizeUSD ?? 5000;
    const maxUnits     = entry > 0 ? maxSizeUSD / entry : rawSize;
    const size         = parseFloat(Math.max(1, Math.min(rawSize, maxUnits)).toFixed(1));

    bus.emit_event(EVENT_TYPES.RISK_SIZED, 'risk_engine', {
      ...signalEvent.payload,
      size,
      sizingFaktor,
      mmSizing,
      mlSizing,
      drawdown: parseFloat(drawdown.toFixed(2)),
      riskCapital: parseFloat(riskCapital.toFixed(2)),
      marketModus: mm.modus,
      signalEventId: signalEvent.id,
    });
  }

  _reject(signalEvent, grund, code) {
    bus.emit_event(EVENT_TYPES.RISK_REJECTED, 'risk_engine', {
      ...signalEvent.payload,
      grund,
      code,
      signalEventId: signalEvent.id,
    });
  }

  // Manuell einen Check auslösen (für Tests/Debug)
  async check(payload) {
    const syntheticEvent = {
      id:        'manual',
      type:      EVENT_TYPES.SIGNAL_ENRICHED,
      source:    'manual',
      timestamp: Date.now(),
      payload,
    };
    await this._evaluate(syntheticEvent);
  }
}

module.exports = { RiskEngine };
