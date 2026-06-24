import { RSI, EMA, MACD, ATR } from 'technicalindicators'
import dotenv from 'dotenv'
import fs from 'fs'
import { createSession, getCandles } from '../src/core/capitalClient.js'

dotenv.config()

// ── Config (env overrides with hardcoded wins defaults) ──
const SYMBOLS = (process.env.BT_SYMBOLS ?? 'XAUUSD').split(',')
const TF = process.env.BT_TF ?? 'HOUR'
const TREND_TF = TF === 'HOUR' ? 'HOUR_4' : 'DAY'
const CANDLE_COUNT = parseInt(process.env.BT_CANDLES ?? '20000')
const BALANCE_PER_SYMBOL = parseFloat(process.env.BT_BALANCE ?? '500')
const RISK_PERCENT = parseFloat(process.env.BT_RISK ?? '1.0')
const CANDLE_OFFSET = parseInt(process.env.BT_OFFSET ?? '0')
const TREND_MODE = process.env.BT_TREND_MODE || 'AND'
const SR_ATR = parseFloat(process.env.BT_SR_ATR ?? '0.3')
const TRAILING = process.env.BT_TRAILING !== 'false'
const TRAILING_ACTIVATE = parseFloat(process.env.BT_TRAILING_ACTIVATE ?? '0.5')
const TRAILING_DISTANCE = parseFloat(process.env.BT_TRAILING_DISTANCE ?? '0.3')
const ATR_SL = parseFloat(process.env.BT_ATR_SL ?? '1.0')
const ATR_TP = parseFloat(process.env.BT_ATR_TP ?? '5.0')
const NO_MACD_FILTER = process.env.BT_NO_MACD_FILTER !== 'false'
const NO_RSI_FILTER = process.env.BT_NO_RSI_FILTER !== 'false'
const NO_EMA_FILTER = process.env.BT_NO_EMA_FILTER !== 'false'
const SPREAD_PIPS = parseFloat(process.env.BT_SPREAD ?? '0.4')
const MAX_DD = parseFloat(process.env.BT_MAX_DD ?? '50')
const ACTIVE_SETUPS = process.env.BT_SETUPS ? process.env.BT_SETUPS.split(',') : ['trend_buy', 'trend_sell']
const NUM_SEGMENTS = Math.max(1, parseInt(process.env.BT_SEGMENTS ?? '1'))

const CACHE_FILE = process.env.BT_CACHE_FILE || './logs/candle_cache.json'

// ── Helpers ──
function getPrice(c) { return c.closePrice?.bid ?? c.closePrice }
function getHigh(c) { return c.highPrice?.bid ?? c.highPrice }
function getLow(c) { return c.lowPrice?.bid ?? c.lowPrice }

function pipToPrice(pips, symbol) {
	const s = symbol.toUpperCase()
	const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']
	if (jpyPairs.some(p => s.includes(p.replace('/', '')))) return pips * 0.01
	if (s.includes('XAU') || s.includes('GOLD')) return pips * 0.01
	if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return pips * 1.0
	return pips * 0.0001
}

function pipValuePerLot(symbol) {
	const s = symbol.toUpperCase()
	if (s.includes('XAU') || s.includes('GOLD')) return 10
	if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return 1
	return 10
}

function extractOHLC(candles) {
	return {
		open: candles.map(c => c.openPrice.bid),
		high: candles.map(c => c.highPrice.bid),
		low: candles.map(c => c.lowPrice.bid),
		close: candles.map(c => c.closePrice.bid),
	}
}

// ── Indicator Calculations ──
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
		values: closes, fastPeriod: 12, slowPeriod: 26,
		signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false,
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
	const highs = recent.map(c => getHigh(c))
	const lows = recent.map(c => getLow(c))
	const swingHigh = Math.max(...highs)
	const swingLow = Math.min(...lows)
	const ema50 = calcEMA(close, 50)
	const atrVal = calcATR(high, low, close)
	if (!atrVal || atrVal <= 0) return { swingHigh, swingLow, nearSupport: false, nearResistance: false }
	const threshold = atrVal * SR_ATR
	const nearSwingSupport = currentPrice !== null && Math.abs(currentPrice - swingLow) <= threshold
	const nearSwingResistance = currentPrice !== null && Math.abs(currentPrice - swingHigh) <= threshold
	const nearEma = ema50 && currentPrice !== null ? Math.abs(currentPrice - ema50) <= threshold * 2 : false
	const aboveEma50 = currentPrice !== null && ema50 ? currentPrice > ema50 : false
	const belowEma50 = currentPrice !== null && ema50 ? currentPrice < ema50 : false
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
		currentPrice, rsi, ema20, ema50,
		emaTrend: ema20 > ema50 ? 'bullish' : 'bearish',
		macd: {
			macd: macd?.MACD ?? null,
			signal: macd?.signal ?? null,
			histogram: macd?.histogram ?? null,
			histogramTrend: macd?.histogram > 0 ? 'positive' : 'negative',
		},
		atr, ...sr,
	}
}

function getMultiTFIndicators(candleMap) {
	const result = {}
	for (const [tf, candles] of Object.entries(candleMap)) {
		result[tf] = getIndicators(candles)
	}
	return result
}

// ── Strategy Constants ──
const SYMBOL_STRATEGY = {
	EURUSD: {
		allowedSetups: ['pullback_sell'],
		rsi: { pullback_sell: { min: 58, max: 78 } },
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.5, atrTpM: 3.5, minSl: 12, minTp: 25,
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
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.0, atrTpM: 5.0, minSl: 10, minTp: 25,
	},
	GBPUSD: {
		allowedSetups: ['momentum_sell'],
		rsi: { momentum_sell: { min: 28, max: 44 } },
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.2, atrTpM: 3.0, minSl: 10, minTp: 22,
	},
	USDJPY: {
		allowedSetups: ['momentum_buy'],
		rsi: { momentum_buy: { min: 48, max: 60 } },
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.2, atrTpM: 3.0, minSl: 10, minTp: 25,
	},
	US30: {
		allowedSetups: ['momentum_buy'],
		rsi: { momentum_buy: { min: 52, max: 62 } },
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.2, atrTpM: 3.0, minSl: 20, minTp: 50,
	},
}

// ── Strategy Evaluation ──
function atrParams(atr, symbol) {
	const cfg = SYMBOL_STRATEGY[symbol]
	const slM = ATR_SL || (cfg?.atrSlM ?? 2)
	const tpM = ATR_TP || (cfg?.atrTpM ?? 6)
	if (!atr || atr <= 0) return { slPips: cfg?.minSl ?? 15, tpPips: cfg?.minTp ?? 30 }
	const pips = Math.round(atr / pipToPrice(1, symbol))
	return {
		slPips: Math.max(cfg?.minSl ?? 18, Math.round(pips * slM)),
		tpPips: Math.max(cfg?.minTp ?? 45, Math.round(pips * tpM)),
	}
}

function evaluate(params) {
	const { symbol, h4Trend, ind } = params
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
	const downtrend = cfg.trendRequired
		? h4Trend === 'bearish' && belowEma50 && h1Trend === 'bearish'
		: TREND_MODE === 'AND'
			? (h4Trend === 'bearish' && belowEma50)
			: (h4Trend === 'bearish' || belowEma50)
	const uptrend = cfg.trendRequired
		? h4Trend === 'bullish' && aboveEma50 && h1Trend === 'bullish'
		: TREND_MODE === 'AND'
			? (h4Trend === 'bullish' && aboveEma50)
			: (h4Trend === 'bullish' || aboveEma50)
	const candidates = []
	for (const setup of ACTIVE_SETUPS) {
		const rsiRange = cfg.rsi[setup]
		if (!rsiRange) continue
		if (setup === 'trend_sell' && downtrend && (NO_MACD_FILTER || macdNegative) && nearResistance && (NO_EMA_FILTER || aboveEma20) && (NO_RSI_FILTER || (rsi >= rsiRange.min && rsi <= rsiRange.max))) {
			candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'trend_buy' && uptrend && (NO_MACD_FILTER || macdPositive) && nearSupport && (NO_EMA_FILTER || belowEma20) && (NO_RSI_FILTER || (rsi >= rsiRange.min && rsi <= rsiRange.max))) {
			candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'momentum_sell' && downtrend && macdNegative) {
			let sellOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bearish') sellOk = false
			if (cfg.requireBelowEma50 && !belowEma50) sellOk = false
			if (sellOk) candidates.push({ action: 'SELL', setup, confidence: 0.7, slPips, tpPips })
		}
		if (setup === 'momentum_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) candidates.push({ action: 'BUY', setup, confidence: 0.7, slPips, tpPips })
		}
		if (setup === 'pullback_sell' && downtrend && macdNegative) {
			let sellOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bearish') sellOk = false
			if (cfg.requireBelowEma50 && !belowEma50) sellOk = false
			if (sellOk) candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'pullback_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
		}
	}
	if (candidates.length === 0) return null
	candidates.sort((a, b) => b.confidence - a.confidence)
	return candidates[0]
}

// ── Position Management ──
function calcSize(balance, slPips, symbol) {
	const riskBase = Math.min(balance, BALANCE_PER_SYMBOL * 3)
	const riskAmount = riskBase * (RISK_PERCENT / 100)
	const pvpl = pipValuePerLot(symbol)
	const lots = riskAmount / (slPips * pvpl)
	const minLot = symbol.includes('XAU') || symbol.includes('GOLD') ? 0.0001 : 0.01
	const size = Math.max(minLot, parseFloat(lots.toFixed(4)))
	const riskPct = (size * slPips * pvpl) / riskBase * 100
	if (riskPct > RISK_PERCENT * 3) return 0
	return size
}

function checkPosition(pos, candles, startIdx, endIdx) {
	endIdx = Math.min(endIdx ?? candles.length, candles.length)
	for (let i = startIdx; i < endIdx; i++) {
		const c = candles[i]
		const high = getHigh(c)
		const low = getLow(c)
		const time = c.snapshotTime ?? c.snapshotTimeUTC ?? i
		if (pos.type === 'BUY') {
			if (low <= pos.sl) return { price: pos.sl, type: 'SL', at: time }
			if (high >= pos.tp) return { price: pos.tp, type: 'TP', at: time }
		} else {
			if (high >= pos.sl) return { price: pos.sl, type: 'SL', at: time }
			if (low <= pos.tp) return { price: pos.tp, type: 'TP', at: time }
		}
	}
	return null
}

// ── Candle Cache ──
function loadCandleCache() {
	if (!fs.existsSync(CACHE_FILE)) return {}
	try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) }
	catch { return {} }
}

function saveCandleCache(cache) {
	const dir = CACHE_FILE.substring(0, CACHE_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
}

async function loadCandles(symbol, tf, count, cache, label) {
	const key = `${symbol}:${tf}`
	if (cache[key] && cache[key].length >= count + CANDLE_OFFSET) {
		console.log(`[Cache] ${symbol} ${tf} (${label}): ${cache[key].length} candles offset=${CANDLE_OFFSET}`)
		const off = CANDLE_OFFSET
		return cache[key].slice(-(count + off), off === 0 ? undefined : -off)
	}
	console.log(`[Fetch] ${symbol} ${tf} (${label}): loading ${count} candles...`)
	const raw = await getCandles(symbol, tf, count)
	if (raw && raw.length > 0) {
		cache[key] = raw
		saveCandleCache(cache)
	}
	return raw || []
}

// ── Drawdown ──
const ddDisabled = {}
function isDDDisabled(sym, currentTotal, peakTotal) {
	if (ddDisabled[sym]) return true
	const dd = peakTotal > 0 ? ((peakTotal - currentTotal) / peakTotal) * 100 : 0
	if (dd > MAX_DD) {
		console.log(`[DD] ${sym} DD=${dd.toFixed(1)}% > ${MAX_DD}% — halt`)
		ddDisabled[sym] = true
		return true
	}
	return false
}

// ── Main Backtest ──
async function runBacktest() {
	const totalBalance = BALANCE_PER_SYMBOL * SYMBOLS.length
	console.log(`\n[Backtest] ===== Pure Strategy =====`)
	console.log(`[Backtest] ${SYMBOLS.join(', ')} | ${TF}+${TREND_TF} | ${CANDLE_COUNT}c | ${TREND_MODE} | SR=${SR_ATR} | trail=${TRAILING} a=${TRAILING_ACTIVATE} d=${TRAILING_DISTANCE} | SL=${ATR_SL} TP=${ATR_TP} | risk=${RISK_PERCENT}%`)

	await createSession()
	const cache = loadCandleCache()
	const allData = {}
	let minLen = Infinity
	for (const sym of SYMBOLS) {
		const h1 = await loadCandles(sym, TF, CANDLE_COUNT, cache, 'entry')
		const h4Count = Math.ceil(CANDLE_COUNT / 4) + 50
		const h4 = await loadCandles(sym, TREND_TF, h4Count, cache, 'trend')
		if (h1.length < 60) { console.error(`[Backtest] ${sym}: insufficient data`); continue }
		allData[sym] = { h1, h4 }
		if (h1.length < minLen) minLen = h1.length
	}
	const activeSymbols = Object.keys(allData)
	if (activeSymbols.length === 0) { console.error('[Backtest] no symbols'); return }

	// Pre-compute H4 indicators
	const h4IndCache = {}
	for (const sym of activeSymbols) {
		const { h4 } = allData[sym]
		h4IndCache[sym] = []
		for (let i = 50; i < h4.length; i++) {
			const ind = getIndicators(h4.slice(0, i + 1))
			h4IndCache[sym].push({ time: h4[i].snapshotTime ?? h4[i].snapshotTimeUTC ?? i, emaTrend: ind.emaTrend })
		}
	}

	function getH4Trend(sym, h1Time) {
		const cache = h4IndCache[sym]
		if (!cache || cache.length === 0) return 'neutral'
		const t = new Date(h1Time).getTime()
		let best = cache[0]
		for (const entry of cache) {
			if (new Date(entry.time).getTime() <= t) best = entry
		}
		return best.emaTrend || 'neutral'
	}

	const startIdx = 60
	const segSize = NUM_SEGMENTS > 1 ? Math.floor((minLen - startIdx) / NUM_SEGMENTS) : (minLen - startIdx)
	const allSegmentTrades = {}
	for (const sym of activeSymbols) allSegmentTrades[sym] = []
	let cumProfit = 0
	let globalMaxDD = 0

	for (let seg = 0; seg < NUM_SEGMENTS; seg++) {
		const segStart = startIdx + seg * segSize
		const segEnd = seg < NUM_SEGMENTS - 1 ? segStart + segSize : minLen
		if (NUM_SEGMENTS > 1) console.log(`\n───── Segment ${seg + 1}/${NUM_SEGMENTS} (${segStart}-${segEnd}) ─────`)
		const balances = {}; const positions = {}; const trades = {}
		let peakTotal = BALANCE_PER_SYMBOL * activeSymbols.length
		let maxDD = 0
		for (const sym of activeSymbols) { balances[sym] = BALANCE_PER_SYMBOL; positions[sym] = null; trades[sym] = [] }

		for (let i = segStart; i < segEnd; i++) {
			for (const sym of activeSymbols) {
				const { h1 } = allData[sym]
				const current = h1[i]; const price = getPrice(current)
				const pos = positions[sym]
				if (pos) {
					// Trailing
					if (TRAILING && pos.atrValue > 0) {
						const candleHigh = getHigh(h1[i]); const candleLow = getLow(h1[i])
						if (pos.type === 'BUY') {
							if (candleHigh > pos.bestPrice) pos.bestPrice = candleHigh
							const profit = pos.bestPrice - pos.entry
							if (profit >= TRAILING_ACTIVATE * pos.atrValue) {
								const newSl = Math.max(pos.sl, pos.bestPrice - TRAILING_DISTANCE * pos.atrValue)
								if (newSl > pos.sl) { pos.sl = newSl; if (!pos.trailingActivated) { pos.trailingActivated = true; console.log(`  [Trail] ${sym} active SL=${newSl.toFixed(5)}`) } }
							}
						} else {
							if (candleLow < pos.bestPrice) pos.bestPrice = candleLow
							const profit = pos.entry - pos.bestPrice
							if (profit >= TRAILING_ACTIVATE * pos.atrValue) {
								const newSl = Math.min(pos.sl, pos.bestPrice + TRAILING_DISTANCE * pos.atrValue)
								if (newSl < pos.sl) { pos.sl = newSl; if (!pos.trailingActivated) { pos.trailingActivated = true; console.log(`  [Trail] ${sym} active SL=${newSl.toFixed(5)}`) } }
							}
						}
					}

					// Overnight close
					if (pos.holdOvernight === false && (i - pos.entryIdx) >= 6) {
						const multiplier = pos.type === 'BUY' ? 1 : -1
						const pnlPips = (price - pos.entry) / pipToPrice(1, sym)
						const pnl = pnlPips * pos.size * pipValuePerLot(sym) * multiplier
						balances[sym] += pnl
						const slPips = Math.round(Math.abs(pos.sl - pos.entry) / pipToPrice(1, sym))
						const tpPips = Math.round(Math.abs(pos.tp - pos.entry) / pipToPrice(1, sym))
						trades[sym].push({ symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry, exit: price, pnl: parseFloat(pnl.toFixed(2)), result: pnl >= 0 ? 'WIN' : 'LOSS', exitTime: current.snapshotTime ?? current.snapshotTimeUTC ?? i, entryTime: pos.entryTime, bars: i - pos.entryIdx, reason: pos.reason, confidence: pos.confidence, slPips, tpPips, exitReason: 'CLOSE' })
						positions[sym] = null
						const ct = Object.values(balances).reduce((a, b) => a + b, 0)
						if (ct > peakTotal) peakTotal = ct
						if (((peakTotal - ct) / peakTotal) * 100 > maxDD) maxDD = ((peakTotal - ct) / peakTotal) * 100
						continue
					}

					const result = checkPosition(pos, h1, pos.entryIdx + 1, i + 1)
					if (result) {
						const multiplier = pos.type === 'BUY' ? 1 : -1
						const pnlPips = (result.price - pos.entry) / pipToPrice(1, sym)
						const spreadCost = SPREAD_PIPS * pos.size * pipValuePerLot(sym)
						const pnl = pnlPips * pos.size * pipValuePerLot(sym) * multiplier - spreadCost
						const slPips = Math.round(Math.abs(pos.sl - pos.entry) / pipToPrice(1, sym))
						const tpPips = Math.round(Math.abs(pos.tp - pos.entry) / pipToPrice(1, sym))
						balances[sym] += pnl
						trades[sym].push({ symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry, exit: result.price, pnl: parseFloat(pnl.toFixed(2)), result: pnl >= 0 ? 'WIN' : 'LOSS', exitTime: result.at, entryTime: pos.entryTime, bars: i - pos.entryIdx, reason: pos.reason, confidence: pos.confidence, slPips, tpPips, exitReason: result.type })
						positions[sym] = null
						const currentTotal = Object.values(balances).reduce((a, b) => a + b, 0)
						if (currentTotal > peakTotal) peakTotal = currentTotal
						if (((peakTotal - currentTotal) / peakTotal) * 100 > maxDD) maxDD = ((peakTotal - currentTotal) / peakTotal) * 100
					} else if (i >= minLen - 1) {
						trades[sym].push({ symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry, exit: price, pnl: 0, result: 'UNKNOWN', entryTime: pos.entryTime, exitTime: current.snapshotTime ?? i, bars: i - pos.entryIdx, reason: pos.reason, confidence: pos.confidence })
						positions[sym] = null
					}
					continue
				}

				if (isDDDisabled(sym, balances)) continue

				const window = h1.slice(0, i + 1)
				const sw = h1.slice(Math.max(0, i - 95), i + 1)
				const candleMap = { [TF]: window }
				if (sw.length >= 20) candleMap[`${TF}_secondary`] = sw
				const indicators = getMultiTFIndicators(candleMap)
				const h4Trend = getH4Trend(sym, current.snapshotTime ?? current.snapshotTimeUTC ?? i)
				const mainInd = Object.values(indicators)[0]
				if (mainInd) mainInd.currentPrice = price

				const ruleDecision = evaluate({ symbol: sym, h4Trend, ind: mainInd })
				if (!ruleDecision) continue

				const finalAction = ruleDecision.action
				const setupName = ruleDecision.reason?.slice(0, 30) ?? 'rules'
				const entryReason = ruleDecision.reason

				const atrVal = mainInd?.atr ?? 0
				let { slPips, tpPips } = atrParams(atrVal, sym)

				const entryPrice = price
				const slPrice = finalAction === 'BUY' ? entryPrice - slPips * pipToPrice(1, sym) : entryPrice + slPips * pipToPrice(1, sym)
				const tpPrice = finalAction === 'BUY' ? entryPrice + tpPips * pipToPrice(1, sym) : entryPrice - tpPips * pipToPrice(1, sym)
				const size = calcSize(balances[sym], slPips, sym)
				if (!size) continue

				positions[sym] = {
					type: finalAction, entry: entryPrice, sl: slPrice, tp: tpPrice,
					size, entryIdx: i, entryTime: current.snapshotTime ?? current.snapshotTimeUTC ?? i,
					setup: setupName, reason: entryReason, confidence: ruleDecision.confidence,
					atrValue: atrVal, bestPrice: entryPrice, trailingActivated: false, holdOvernight: true,
				}
				console.log(`[${sym}] ${finalAction} @ ${entryPrice} SL=${slPrice.toFixed(5)} TP=${tpPrice.toFixed(5)} size=${size.toFixed(4)} ${setupName}`)
			}
		}

		for (const sym of activeSymbols) allSegmentTrades[sym].push(...trades[sym])
		const segFinal = Object.values(balances).reduce((a, b) => a + b, 0)
		const segPnl = segFinal - BALANCE_PER_SYMBOL * activeSymbols.length
		cumProfit += segPnl
		if (maxDD > globalMaxDD) globalMaxDD = maxDD
		const segAll = Object.values(trades).flat().filter(t => t.result !== 'UNKNOWN')
		console.log(`➡️  Seg ${seg + 1}: $${segPnl >= 0 ? '+' : ''}${segPnl.toFixed(2)} | ${segAll.length} trades | WR: ${segAll.length > 0 ? (segAll.filter(t => t.result === 'WIN').length / segAll.length * 100).toFixed(1) : 'N/A'}%`)
	}

	const finalBalance = BALANCE_PER_SYMBOL * activeSymbols.length + cumProfit
	const allTrades = Object.values(allSegmentTrades).flat()
	const closedTrades = allTrades.filter(t => t.result !== 'UNKNOWN')
	console.log(`\n${'='.repeat(60)}`)
	console.log(`📊 Result`)
	console.log(`${'='.repeat(60)}`)
	const h = (s, w) => s.padEnd(w)
	const hr = (s, w) => s.padStart(w)
	console.log(`${h('Asset',12)} ${hr('Balance',10)} ${hr('PnL',10)} ${hr('Trades',6)} ${hr('WIN',5)} ${hr('LOSS',5)} ${hr('WR',7)} ${hr('PF',6)}`)
	console.log('-'.repeat(60))
	let totalT = 0, totalW = 0, totalL = 0, gp = 0, gl = 0
	for (const sym of Object.keys(allSegmentTrades)) {
		const trades = allSegmentTrades[sym]; const pnl = (BALANCE_PER_SYMBOL * activeSymbols.length) > 0 ? (() => { const b = BALANCE_PER_SYMBOL + trades.reduce((s, t) => s + (t.pnl ?? 0), 0); return b - BALANCE_PER_SYMBOL })() : 0
		const closed = trades.filter(t => t.result !== 'UNKNOWN'); const wins = closed.filter(t => t.result === 'WIN'); const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 'N/A'
		const bal = BALANCE_PER_SYMBOL + trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
		const pnlVal = bal - BALANCE_PER_SYMBOL
		const gpi = wins.reduce((s, t) => s + t.pnl, 0); const gli = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gli !== 0 ? (gpi / Math.abs(gli)).toFixed(2) : (closed.length > 0 ? '∞' : '-')
		totalT += trades.length; totalW += wins.length; totalL += losses.length; gp += gpi; gl += Math.abs(gli)
		console.log(`${sym.padEnd(12)} $${bal.toFixed(2).padStart(7)} ${(pnlVal >= 0 ? '+' : '') + pnlVal.toFixed(2).padStart(7)} ${String(trades.length).padStart(6)} ${wins.length.toString().padStart(5)} ${losses.length.toString().padStart(5)} ${String(wr).padStart(7)}% ${pf.toString().padStart(5)}`)
	}
	const netPnl = finalBalance - BALANCE_PER_SYMBOL * activeSymbols.length
	const owr = (totalW + totalL) > 0 ? (totalW / (totalW + totalL) * 100).toFixed(1) : 'N/A'
	const opf = gl > 0 ? (gp / gl).toFixed(2) : (totalT > 0 ? '∞' : '-')
	console.log('-'.repeat(60))
	console.log(`${'Total'.padEnd(12)} $${finalBalance.toFixed(2).padStart(7)} ${(netPnl >= 0 ? '+' : '') + netPnl.toFixed(2).padStart(7)} ${String(totalT).padStart(6)} ${totalW.toString().padStart(5)} ${totalL.toString().padStart(5)} ${String(owr).padStart(7)}% ${opf.toString().padStart(5)}`)
	console.log(`${'='.repeat(60)}`)
	console.log(`Balance: $${(BALANCE_PER_SYMBOL * activeSymbols.length).toFixed(2)} → $${finalBalance.toFixed(2)}`)
	console.log(`PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${(netPnl / (BALANCE_PER_SYMBOL * activeSymbols.length) * 100).toFixed(2)}%)`)
	console.log(`Max DD: ${globalMaxDD.toFixed(2)}% | PF: ${opf} | WR: ${owr}%`)
	console.log(`${'='.repeat(60)}\n`)
}

runBacktest().catch(err => { console.error('[Backtest] fatal:', err.message); process.exit(1) })
