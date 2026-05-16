// ══════════════════════════════════════════════════════════════
//  Master Bot — Agent Framework V4
//
//  Jeder Agent ist eine pure Funktion:
//    (ctx) => { vote: 0.0-1.0, reason: string, skip: bool }
//
//  vote: 0 = strong skip | 0.5 = neutral | 1.0 = strong agree
//  skip: true = Agent blockiert den Trade hart (nicht nur Gewicht)
//
//  Aggregation:
//    avgVote < SKIP_THRESHOLD   → Trade blockiert
//    avgVote >= BOOST_THRESHOLD → sizing +10% Bonus
// ══════════════════════════════════════════════════════════════
'use strict';

const AGGREGATOR_CFG = {
  SKIP_THRESHOLD:  0.35,  // Avg-Vote unter diesem Wert → Skip
  BOOST_THRESHOLD: 0.80,  // Avg-Vote über diesem Wert → Sizing-Boost +10%
  BOOST_FAKTOR:    1.10,
};

// ── Agent: Trend ──────────────────────────────────────────────
// Prüft ob die Trade-Richtung mit dem Marktmodus übereinstimmt
function TrendAgent(ctx) {
  const { side, marketMode } = ctx;
  switch (marketMode) {
    case 'BULL':
      return side === 'BUY'
        ? { vote: 0.90, reason: 'BULL + BUY = Trendfolge' }
        : { vote: 0.25, reason: 'BULL + SELL = Gegen den Trend' };
    case 'BEAR':
      return side === 'SELL'
        ? { vote: 0.90, reason: 'BEAR + SELL = Trendfolge' }
        : { vote: 0.25, reason: 'BEAR + BUY = Gegen den Trend' };
    case 'PANIC':
      return { vote: 0.0, reason: 'PANIC Modus', skip: true };
    case 'HIGH_VOL':
      return { vote: 0.55, reason: 'HIGH_VOL — vorsichtig' };
    case 'SIDEWAYS':
      return { vote: 0.60, reason: 'SIDEWAYS — kein klarer Trend' };
    default:
      return { vote: 0.50, reason: 'Unbekannter Modus' };
  }
}

// ── Agent: Session ────────────────────────────────────────────
// Prüft ob die Tageszeit günstig ist (London/NY Overlap = best)
function SessionAgent(ctx) {
  const { hour } = ctx;
  if (hour >= 13 && hour < 17) return { vote: 0.90, reason: `London/NY Overlap (${hour}h)` };
  if (hour >= 8  && hour < 13) return { vote: 0.80, reason: `London Session (${hour}h)` };
  if (hour >= 17 && hour < 20) return { vote: 0.65, reason: `NY Session (${hour}h)` };
  if (hour >= 20 && hour < 22) return { vote: 0.45, reason: `NY Close (${hour}h)` };
  // Asiatische Session + Nacht = schwache Liquidität
  return { vote: 0.20, reason: `Schwache Session (${hour}h)` };
}

// ── Agent: Momentum ───────────────────────────────────────────
// Prüft aktuellen Performance-Schwung (Win-Rate + Verlustserie)
function MomentumAgent(ctx) {
  const { recentWR5, recentWR15, konsek } = ctx;

  // Zu wenig Daten → neutral
  if (recentWR15 == null) return { vote: 0.55, reason: 'Zu wenig Trades für Momentum-Check' };

  // Starke Verlustserie → blockieren
  if (konsek >= 5) return { vote: 0.10, reason: `${konsek} Verluste in Folge`, skip: true };
  if (konsek >= 3) return { vote: 0.30, reason: `${konsek} Verluste in Folge` };

  // Win-Rate Bewertung
  if (recentWR15 >= 65 && (recentWR5 == null || recentWR5 >= 50))
    return { vote: 0.90, reason: `WR15=${recentWR15}% — starker Schwung` };
  if (recentWR15 >= 50)
    return { vote: 0.70, reason: `WR15=${recentWR15}% — positiv` };
  if (recentWR15 >= 35)
    return { vote: 0.45, reason: `WR15=${recentWR15}% — schwach` };
  return { vote: 0.20, reason: `WR15=${recentWR15}% — sehr schwach` };
}

// ── Agent: Setup Quality (RRR + SL-Abstand) ───────────────────
// Prüft die Qualität des Setups unabhängig von der Strategie
function SetupAgent(ctx) {
  const { rrr, slDistPct } = ctx;

  // SL-Abstand prüfen (zu eng = Stop-Hunt, zu weit = schlechtes RR)
  if (slDistPct != null) {
    if (slDistPct < 0.05) return { vote: 0.15, reason: `SL zu eng (${slDistPct.toFixed(2)}%) — Stop-Hunt Risiko` };
    if (slDistPct > 3.0)  return { vote: 0.30, reason: `SL zu weit (${slDistPct.toFixed(2)}%) — schlechtes Risk/Reward` };
  }

  // RRR bewerten
  if (rrr >= 4.0) return { vote: 0.95, reason: `RRR ${rrr} — exzellent` };
  if (rrr >= 3.0) return { vote: 0.85, reason: `RRR ${rrr} — sehr gut` };
  if (rrr >= 2.5) return { vote: 0.75, reason: `RRR ${rrr} — gut` };
  if (rrr >= 2.0) return { vote: 0.60, reason: `RRR ${rrr} — akzeptabel` };
  return { vote: 0.20, reason: `RRR ${rrr} — zu niedrig` };
}

// ── Agent: News / Makro Blackout ──────────────────────────────
// Blockiert Trading während wichtiger Wirtschaftsnachrichten.
// newsBlackouts = [{ startH, startM, endH, endM, label, weekday? }]
// weekday: 0=So, 1=Mo, ... 5=Fr, 6=Sa — undefined = jeden Tag
const NEWS_BLACKOUTS = [
  // NFP: Erster Freitag des Monats, 14:30 UTC
  { startH: 14, startM: 0, endH: 15, endM: 30, label: 'NFP-Fenster', weekday: 5 },
  // CPI USA: monatlich, meistens 14:30 UTC (Di oder Mi)
  { startH: 14, startM: 20, endH: 15, endM: 0, label: 'CPI-Fenster' },
  // FOMC: 20:00 UTC (Mi, alle 6 Wochen — als tägliche Vorsicht)
  { startH: 19, startM: 45, endH: 20, endM: 30, label: 'FOMC-Fenster', weekday: 3 },
];

function NewsAgent(ctx) {
  const { hour, minute, weekday, customBlackouts } = ctx;
  const m = minute || 0;
  const allBlackouts = [...NEWS_BLACKOUTS, ...(customBlackouts || [])];

  for (const b of allBlackouts) {
    if (b.weekday !== undefined && b.weekday !== weekday) continue;
    const nowMin   = hour * 60 + m;
    const startMin = b.startH * 60 + b.startM;
    const endMin   = b.endH   * 60 + b.endM;
    if (nowMin >= startMin && nowMin < endMin) {
      return { vote: 0.0, reason: `News Blackout: ${b.label}`, skip: true };
    }
  }
  return { vote: 0.75, reason: 'Kein News-Event aktiv' };
}

// ── Aggregator ────────────────────────────────────────────────
// Sammelt alle Agenten-Votes, gibt Gesamtentscheidung zurück
function aggregateAgents(ctx) {
  const agents = [
    { name: 'TrendAgent',   fn: TrendAgent   },
    { name: 'SessionAgent', fn: SessionAgent  },
    { name: 'MomentumAgent',fn: MomentumAgent },
    { name: 'SetupAgent',   fn: SetupAgent    },
    { name: 'NewsAgent',    fn: NewsAgent     },
  ];

  const results = agents.map(a => {
    try {
      const r = a.fn(ctx);
      return { agent: a.name, vote: r.vote ?? 0.5, reason: r.reason || '', skip: !!r.skip };
    } catch (err) {
      return { agent: a.name, vote: 0.5, reason: `Fehler: ${err.message}`, skip: false };
    }
  });

  // Hard skip wenn ein Agent skip=true
  const hardSkip = results.find(r => r.skip);
  if (hardSkip) {
    return {
      approved:     false,
      skip:         true,
      grund:        `${hardSkip.agent}: ${hardSkip.reason}`,
      avgVote:      hardSkip.vote,
      sizingBonus:  1.0,
      agentResults: results,
    };
  }

  const avgVote = results.reduce((s, r) => s + r.vote, 0) / results.length;

  if (avgVote < AGGREGATOR_CFG.SKIP_THRESHOLD) {
    const weak = results.filter(r => r.vote < 0.4).map(r => `${r.agent}(${(r.vote*100).toFixed(0)}%)`);
    return {
      approved:     false,
      skip:         false,
      grund:        `Schwache Agenten-Zustimmung (${(avgVote*100).toFixed(0)}%): ${weak.join(', ')}`,
      avgVote,
      sizingBonus:  1.0,
      agentResults: results,
    };
  }

  return {
    approved:     true,
    skip:         false,
    grund:        `Agenten-Konsens: ${(avgVote*100).toFixed(0)}%`,
    avgVote,
    sizingBonus:  avgVote >= AGGREGATOR_CFG.BOOST_THRESHOLD ? AGGREGATOR_CFG.BOOST_FAKTOR : 1.0,
    agentResults: results,
  };
}

module.exports = { aggregateAgents, AGGREGATOR_CFG, NEWS_BLACKOUTS };
