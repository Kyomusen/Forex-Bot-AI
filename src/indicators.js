import {
	RSI,
	EMA,
	MACD,
	ATR,
} from 'technicalindicators'

function extractOHLC(candles) {
	return {
		open: candles.map(c => c.openPrice.bid),
		high: candles.map(c => c.highPrice.bid),
		low: candles.map(c => c.lowPrice.bid),
		close: candles.map(c => c.closePrice.bid),
	}
}

function calcRSI(closes, period = 14) {
	const result = RSI.calculate({ values: closes, period })
	return result[result.length - 1] ?? null
}

function calcEMA(closes, period) {
	const result = EMA.calculate({ values: closes, period })
	return result[result.length - 1] ?? null
}

function calcMACD(closes) {
	const result = MACD.calculate({
		values: closes,
		fastPeriod: 12,
		slowPeriod: 26,
		signalPeriod: 9,
		SimpleMAOscillator: false,
		SimpleMASignal: false,
	})
	return result[result.length - 1] ?? null
}

function calcATR(highs, lows, closes, period = 14) {
	const result = ATR.calculate({ high: highs, low: lows, close: closes, period })
	return result[result.length - 1] ?? null
}

function calcSupportResistance(candles, lookback = 24) {
	const recent = candles.slice(-Math.min(lookback, candles.length - 1))
	if (recent.length < 10) return { swingHigh: null, swingLow: null, nearSupport: false, nearResistance: false }

	const { high, low, close } = extractOHLC(candles)
	const currentPrice = close[close.length - 1]
	const highs = recent.map(c => c.highPrice.bid)
	const lows = recent.map(c => c.lowPrice.bid)

	const swingHigh = Math.max(...highs)
	const swingLow = Math.min(...lows)
	const ema50 = calcEMA(close, 50)
	const atrVal = calcATR(high, low, close)

	if (!atrVal || atrVal <= 0) return { swingHigh, swingLow, nearSupport: false, nearResistance: false }

	const srAtr = parseFloat(process.env.BACKTEST_SR_ATR) || 0.3
	const threshold = atrVal * srAtr

	const nearSwingSupport = Math.abs(currentPrice - swingLow) <= threshold
	const nearSwingResistance = Math.abs(currentPrice - swingHigh) <= threshold

	const nearEma = ema50 ? Math.abs(currentPrice - ema50) <= threshold * 2 : false

	const aboveEma50 = currentPrice && ema50 ? currentPrice > ema50 : false
	const belowEma50 = currentPrice && ema50 ? currentPrice < ema50 : false

	const nearSupport = nearSwingSupport || (nearEma && aboveEma50)
	const nearResistance = nearSwingResistance || (nearEma && belowEma50)

	return { swingHigh, swingLow, nearSupport, nearResistance }
}

function getIndicators(candles) {
	const { high, low, close } = extractOHLC(candles)

	const rsi = calcRSI(close)
	const ema20 = calcEMA(close, 20)
	const ema50 = calcEMA(close, 50)
	const macd = calcMACD(close)
	const atr = calcATR(high, low, close)
	const sr = calcSupportResistance(candles, 24)

	const currentPrice = close[close.length - 1]

	return {
		currentPrice,
		rsi,
		ema20,
		ema50,
		emaTrend: ema20 > ema50 ? 'bullish' : 'bearish',
		macd: {
			macd: macd?.MACD ?? null,
			signal: macd?.signal ?? null,
			histogram: macd?.histogram ?? null,
			histogramTrend: macd?.histogram > 0 ? 'positive' : 'negative',
		},
		atr,
		...sr,
	}
}

function getMultiTFIndicators(candleMap) {
	const result = {}
	for (const [tf, candles] of Object.entries(candleMap)) {
		result[tf] = getIndicators(candles)
	}
	return result
}

export { getIndicators, getMultiTFIndicators }
