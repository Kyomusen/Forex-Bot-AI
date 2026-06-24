export const SYMBOL_STRATEGY = {
	EURUSD: {
		allowedSetups: ['pullback_sell'],
		rsi: {
			pullback_sell: { min: 58, max: 78 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.5,
		atrTpM: 3.5,
		minSl: 12,
		minTp: 25,
	},
	XAUUSD: {
		allowedSetups: ['trend_buy', 'trend_sell'],
		rsi: {
			trend_buy: { min: 30, max: 50 },
			trend_sell: { min: 50, max: 70 },
			momentum_sell: { min: 28, max: 48 },
			momentum_buy: { min: 48, max: 62 },
			pullback_sell: { min: 55, max: 75 },
			pullback_buy: { min: 30, max: 50 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.0,
		atrTpM: 2.0,
		minSl: 10,
		minTp: 25,
	},
	GBPUSD: {
		allowedSetups: ['momentum_sell'],
		rsi: {
			momentum_sell: { min: 28, max: 44 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.2,
		atrTpM: 3.0,
		minSl: 10,
		minTp: 22,
	},
	USDJPY: {
		allowedSetups: ['momentum_buy'],
		rsi: {
			momentum_buy: { min: 48, max: 60 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.2,
		atrTpM: 3.0,
		minSl: 10,
		minTp: 25,
	},
	US30: {
		allowedSetups: ['momentum_buy'],
		rsi: {
			momentum_buy: { min: 52, max: 62 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.2,
		atrTpM: 3.0,
		minSl: 20,
		minTp: 50,
	},
}

export function pipToPrice(pips, symbol) {
	const s = symbol.toUpperCase()
	const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']
	if (jpyPairs.some(p => s.includes(p.replace('/', '')))) return pips * 0.01
	if (s.includes('XAU') || s.includes('GOLD')) return pips * 0.01
	if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return pips * 1.0
	return pips * 0.0001
}

export function atrParams(atr, symbol) {
	const cfg = SYMBOL_STRATEGY[symbol]
	if (!cfg) return {}
	if (!atr || atr <= 0) return { slPips: cfg?.minSl ?? 15, tpPips: cfg?.minTp ?? 30 }
	const pips = Math.round(atr / pipToPrice(1, symbol))
	return {
		slPips: Math.max(cfg?.minSl ?? 15, Math.round(pips * (cfg?.atrSlM ?? 2))),
		tpPips: Math.max(cfg?.minTp ?? 30, Math.round(pips * (cfg?.atrTpM ?? 6))),
	}
}

export function evaluate(params) {
	const { symbol, h4Trend, ind, knowledge } = params
	const { rsi, ema20, ema50, emaTrend: h1Trend, macd, atr, currentPrice, nearSupport, nearResistance } = ind
	if (rsi == null || !atr) return null

	const cfg = SYMBOL_STRATEGY[symbol]
	if (!cfg) return null

	const { slPips, tpPips } = atrParams(atr, symbol)
	const aboveEma50 = currentPrice && ema50 ? currentPrice > ema50 : false
	const belowEma50 = currentPrice && ema50 ? currentPrice < ema50 : false
	const aboveEma20 = currentPrice && ema20 ? currentPrice > ema20 : false
	const belowEma20 = currentPrice && ema20 ? currentPrice < ema20 : false
	const macdNegative = macd?.histogramTrend === 'negative'
	const macdPositive = macd?.histogramTrend === 'positive'
	const macdCrossoverBear = macd?.histogram < 0 && macd?.macd < macd?.signal
	const macdCrossoverBull = macd?.histogram > 0 && macd?.macd > macd?.signal
	const noMacdFilter = process.env.BACKTEST_NO_MACD_FILTER === 'true'
	const noRsiFilter = process.env.BACKTEST_NO_RSI_FILTER === 'true'
	const noEmaFilter = process.env.BACKTEST_NO_EMA_FILTER === 'true'

	const downtrend = cfg.trendRequired
		? h4Trend === 'bearish' && belowEma50 && h1Trend === 'bearish'
		: (h4Trend === 'bearish' && belowEma50)

	const uptrend = cfg.trendRequired
		? h4Trend === 'bullish' && aboveEma50 && h1Trend === 'bullish'
		: (h4Trend === 'bullish' && aboveEma50)

	const candidates = []

	for (const setup of cfg.allowedSetups) {
		const rsiRange = cfg.rsi[setup]
		if (!rsiRange) continue

		if (setup === 'trend_sell' && downtrend && (noMacdFilter || macdNegative) && nearResistance && (noEmaFilter || aboveEma20) && (noRsiFilter || (rsi >= rsiRange.min && rsi <= rsiRange.max))) {
			candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'trend_buy' && uptrend && (noMacdFilter || macdPositive) && nearSupport && (noEmaFilter || belowEma20) && (noRsiFilter || (rsi >= rsiRange.min && rsi <= rsiRange.max))) {
			candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'momentum_sell' && downtrend && macdNegative) {
			let sellOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bearish') sellOk = false
			if (cfg.requireBelowEma50 && !belowEma50) sellOk = false
			if (sellOk) {
				candidates.push({ action: 'SELL', setup, confidence: 0.7, slPips, tpPips })
			}
		}
		if (setup === 'pullback_sell' && downtrend && macdNegative) {
			let sellOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bearish') sellOk = false
			if (cfg.requireBelowEma50 && !belowEma50) sellOk = false
			if (sellOk) {
				candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips, tpPips })
			}
		}
		if (setup === 'momentum_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) {
				candidates.push({ action: 'BUY', setup, confidence: 0.7, slPips, tpPips })
			}
		}
		if (setup === 'pullback_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) {
				candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
			}
		}
	}

	if (candidates.length === 0) return null

	candidates.sort((a, b) => b.confidence - a.confidence)
	return candidates[0]
}
