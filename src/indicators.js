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

function getIndicators(candles) {
	const { high, low, close } = extractOHLC(candles)

	const rsi = calcRSI(close)
	const ema20 = calcEMA(close, 20)
	const ema50 = calcEMA(close, 50)
	const macd = calcMACD(close)
	const atr = calcATR(high, low, close)

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
