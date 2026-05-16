'use strict';
/**
 * strategies/index.js — Strategy Loader
 *
 * Instantiates all strategy modules, connects them to the broker's price feed,
 * and starts autonomous signal generation.
 *
 * Each strategy can trade ANY instrument — symbols come from STRATEGY_SYMBOLS
 * env var or per-strategy config, not hardcoded.
 */

const { MarketDataService }      = require('./market-data');
const EMACrossoverStrategy       = require('./ema-crossover');
const BreakoutStrategy           = require('./breakout');
const MLConfidenceStrategy       = require('./ml-confidence');
const TrendFollowStrategy        = require('./trend-follow');
const RSIReversionStrategy       = require('./rsi-reversion');
const SessionTraderStrategy      = require('./session-trader');
const AdaptiveRegimeStrategy     = require('./adaptive-regime');
const SteadyScalperStrategy      = require('./steady-scalper');

// Default symbols each strategy watches — override via STRATEGY_SYMBOLS env var (JSON)
// Format: { "mittel": ["XAUUSD","EURUSD","SPX500"], "steady": ["XAUUSD"] }
const DEFAULT_SYMBOLS = {
  mittel:      ['XAUUSD', 'EURUSD', 'SPX500', 'US100', 'BTCUSD'],
  aggressiv:   ['XAUUSD', 'EURUSD', 'SPX500', 'US100', 'BTCUSD', 'ETHUSD'],
  smart:       ['XAUUSD', 'EURUSD', 'SPX500'],
  konservativ: ['XAUUSD', 'SPX500', 'US100'],
  optimiert:   ['XAUUSD', 'EURUSD', 'GBPUSD', 'SPX500'],
  test:        ['XAUUSD', 'EURUSD', 'SPX500', 'US100'],
  adaptive:    ['XAUUSD', 'EURUSD', 'SPX500', 'US100', 'BTCUSD'],
  steady:      ['XAUUSD', 'EURUSD'],
};

// Asset class mapping (symbol → assetClass for broker contract resolution)
const ASSET_CLASS = {
  XAUUSD:  'commodity',
  XAGUSD:  'commodity',
  EURUSD:  'forex',
  GBPUSD:  'forex',
  USDJPY:  'forex',
  AUDUSD:  'forex',
  USDCAD:  'forex',
  EURGBP:  'forex',
  SPX500:  'cfd',
  US100:   'cfd',
  GER40:   'cfd',
  UK100:   'cfd',
  BTCUSD:  'cfd',
  ETHUSD:  'cfd',
  AAPL:    'stock',
  TSLA:    'stock',
  NVDA:    'stock',
};

function getAssetClass(symbol) {
  return ASSET_CLASS[symbol.toUpperCase()] || 'cfd';
}

let _marketData = null;
let _strategies = [];

/**
 * Start all strategies.
 * @param {object} broker      — BrokerAdapter instance
 * @param {object} settings    — SETTINGS object from server.js
 * @param {object} options     — { port, log }
 */
function startStrategies(broker, settings, options = {}) {
  _marketData = new MarketDataService(broker);

  let symbolConfig = DEFAULT_SYMBOLS;
  try {
    if (process.env.STRATEGY_SYMBOLS) {
      symbolConfig = { ...DEFAULT_SYMBOLS, ...JSON.parse(process.env.STRATEGY_SYMBOLS) };
    }
  } catch (e) {
    console.warn('[Strategies] STRATEGY_SYMBOLS parse error:', e.message);
  }

  const opts = { port: options.port, log: options.log || console.log };

  // Instantiate all strategies
  const instances = [
    new EMACrossoverStrategy(settings.mittel,      _marketData, opts),
    new BreakoutStrategy(settings.aggressiv,        _marketData, opts),
    new MLConfidenceStrategy(settings.smart,        _marketData, opts),
    new TrendFollowStrategy(settings.konservativ,   _marketData, opts),
    new RSIReversionStrategy(settings.optimiert,    _marketData, opts),
    new SessionTraderStrategy(settings.test,        _marketData, opts),
    new AdaptiveRegimeStrategy(settings.adaptive,   _marketData, opts),
    new SteadyScalperStrategy(settings.steady,      _marketData, opts),
  ];

  // Patch each strategy to trade ALL its configured symbols, not just one hardcoded one
  for (const strat of instances) {
    const symbols = symbolConfig[strat.id] || ['XAUUSD'];
    strat._symbols = symbols;

    // Override onStart to subscribe to multiple symbols
    const origOnStart = strat.onStart.bind(strat);
    strat.onStart = async function() {
      // Subscribe to each symbol with the same candle handler
      for (const sym of this._symbols) {
        const ac = getAssetClass(sym);
        // Patch signal() to use the correct symbol per subscription
        const origOnCandle = this._onCandle?.bind(this);
        if (origOnCandle) {
          this._subscribe(sym, ac, this._defaultTimeframe || 'H1', (agg) => {
            // Temporarily override signal to inject correct symbol
            const origSignal = this.signal.bind(this);
            this.signal = (side, params) =>
              origSignal(side, { ...params, symbol: sym, assetClass: ac });
            origOnCandle(agg).finally(() => { this.signal = origSignal; });
          });
        }
      }
    };

    if (settings[strat.id]?.enabled !== false) {
      strat.start();
      options.log?.(`[Strategies] ${strat.id} started — watching: ${symbols.join(', ')}`);
    } else {
      options.log?.(`[Strategies] ${strat.id} disabled in settings`);
    }

    _strategies.push(strat);
  }

  return _strategies;
}

function stopStrategies() {
  for (const s of _strategies) s.stop();
  _strategies = [];
}

function getStatus() {
  return _strategies.map(s => ({
    ...s.status(),
    symbols: s._symbols || [],
  }));
}

module.exports = { startStrategies, stopStrategies, getStatus, ASSET_CLASS, DEFAULT_SYMBOLS };
