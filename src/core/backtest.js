import dotenv from 'dotenv'
import fs from 'fs'
import { createSession, getCandles } from './capitalClient.js'
import { getIndicators, getMultiTFIndicators } from './indicators.js'
import { sendBacktestReport, sendBatchNotification } from '../utils/discordNotifier.js'
import { evaluate, atrParams, SYMBOL_STRATEGY, pipToPrice, pipValuePerLot } from './strategy.js'
import { printReport } from '../utils/summary.js'

dotenv.config()

// ── Defaults (405% winning config) ──
const SYMBOLS = (process.env.BACKTEST_SYMBOLS ?? 'EURUSD,XAUUSD,GBPUSD,USDJPY,US30').split(',')
const TF = process.env.BACKTEST_TF ?? 'HOUR'
const CANDLE_COUNT = parseInt(process.env.BACKTEST_CANDLES ?? '20000')
const BALANCE_PER_SYMBOL = parseFloat(process.env.BACKTEST_BALANCE ?? '500')
const RISK_PERCENT = parseFloat(process.env.BACKTEST_RISK ?? '1.0')
const CANDLE_OFFSET = parseInt(process.env.BACKTEST_OFFSET ?? '0')
const TREND_TF = TF === 'HOUR' ? 'HOUR_4' : 'DAY'
const BACKTEST_TRAILING = process.env.BACKTEST_TRAILING === 'true'
const TRAILING_ACTIVATE = parseFloat(process.env.BACKTEST_TRAILING_ACTIVATE ?? '0.5')
const TRAILING_DISTANCE = parseFloat(process.env.BACKTEST_TRAILING_DISTANCE ?? '0.3')
const MAX_DD_PERCENT = parseFloat(process.env.BACKTEST_MAX_DD ?? '50')

const CACHE_FILE = './logs/candle_cache.json'
const NUM_SEGMENTS = Math.max(1, parseInt(process.env.BACKTEST_SEGMENTS ?? '1'))

// ── Helpers ──
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

function getPrice(c) { return c.closePrice?.bid ?? c.closePrice }
function getHigh(c) { return c.highPrice?.bid ?? c.highPrice }
function getLow(c) { return c.lowPrice?.bid ?? c.lowPrice }

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

const ddDisabled = {}
function isDDDisabled(sym, currentTotal, peakTotal) {
	if (ddDisabled[sym]) return true
	const dd = peakTotal > 0 ? ((peakTotal - currentTotal) / peakTotal) * 100 : 0
	if (dd > MAX_DD_PERCENT) {
		console.log(`[DD] ${sym} DD=${dd.toFixed(1)}% > ${MAX_DD_PERCENT}% — หยุดเทรด`)
		ddDisabled[sym] = true
		return true
	}
	return false
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

async function loadCandles(symbol, tf, count, cache, label) {
	const key = `${symbol}:${tf}`
	if (cache[key] && cache[key].length >= count + CANDLE_OFFSET) {
		console.log(`[Cache] ${symbol} ${tf} (${label}): ใช้ cache ${cache[key].length} candles offset=${CANDLE_OFFSET}`)
		const off = CANDLE_OFFSET
		return cache[key].slice(-(count + off), off === 0 ? undefined : -off)
	}
	console.log(`[Fetch] ${symbol} ${tf} (${label}): กำลังโหลด ${count} candles...`)
	const raw = await getCandles(symbol, tf, count)
	if (raw && raw.length > 0) {
		cache[key] = raw
		saveCandleCache(cache)
	}
	return raw || []
}

// ── Main backtest ──
async function runBacktest() {
	const totalBalance = BALANCE_PER_SYMBOL * SYMBOLS.length
	console.log(`\n[Backtest] ===== เริ่ม Backtest =====`)
	console.log(`[Backtest] Symbols: ${SYMBOLS.join(', ')} | ${TF} + ${TREND_TF} | ${CANDLE_COUNT} candles`)
	console.log(`[Backtest] Balance: $${BALANCE_PER_SYMBOL}/symbol (รวม $${totalBalance})`)

	await createSession()
	const cache = loadCandleCache()

	const allData = {}
	let minLen = Infinity
	for (const sym of SYMBOLS) {
		const h1 = await loadCandles(sym, TF, CANDLE_COUNT, cache, 'entry')
		const h4Count = Math.ceil(CANDLE_COUNT / 4) + 50
		const h4 = await loadCandles(sym, TREND_TF, h4Count, cache, 'trend')
		if (h1.length < 60) { console.error(`[Backtest] ${sym}: ข้อมูลไม่พอ`); continue }
		allData[sym] = { h1, h4 }
		if (h1.length < minLen) minLen = h1.length
	}

	const activeSymbols = Object.keys(allData)
	if (activeSymbols.length === 0) { console.error('[Backtest] ไม่มี symbol'); return }

	// Pre-compute H4 indicator cache
	const h4IndCache = {}
	for (const sym of activeSymbols) {
		const { h4 } = allData[sym]
		h4IndCache[sym] = []
		for (let i = 50; i < h4.length; i++) {
			const ind = getIndicators(h4.slice(0, i + 1))
			h4IndCache[sym].push({ time: h4[i].snapshotTime ?? h4[i].snapshotTimeUTC ?? i, emaTrend: ind.emaTrend, ema50: ind.ema50 })
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

		if (NUM_SEGMENTS > 1) {
			console.log(`\n───── Segment ${seg + 1}/${NUM_SEGMENTS} (candle ${segStart}-${segEnd}) ─────`)
		}

		const balances = {}
		const positions = {}
		const trades = {}
		let peakTotal = BALANCE_PER_SYMBOL * activeSymbols.length
		let maxDD = 0

		for (const sym of activeSymbols) {
			balances[sym] = BALANCE_PER_SYMBOL
			positions[sym] = null
			trades[sym] = []
		}

		for (let i = segStart; i < segEnd; i++) {
			for (const sym of activeSymbols) {
				const { h1 } = allData[sym]
				const current = h1[i]
				const price = getPrice(current)
				const pos = positions[sym]

				if (pos) {
					// Trailing stop logic — use candle HIGH/LOW
					if (BACKTEST_TRAILING && pos.atrValue > 0) {
						const candleHigh = getHigh(h1[i])
						const candleLow = getLow(h1[i])
						if (pos.type === 'BUY') {
							if (candleHigh > pos.bestPrice) pos.bestPrice = candleHigh
							const profit = pos.bestPrice - pos.entry
							if (profit >= TRAILING_ACTIVATE * pos.atrValue) {
								const newSl = Math.max(pos.sl, pos.bestPrice - TRAILING_DISTANCE * pos.atrValue)
								if (newSl > pos.sl) {
									pos.sl = newSl
									if (!pos.trailingActivated) {
										pos.trailingActivated = true
										console.log(`  [Trailing] ${sym} activated, SL=${newSl.toFixed(5)}`)
									}
								}
							}
						} else {
							if (candleLow < pos.bestPrice) pos.bestPrice = candleLow
							const profit = pos.entry - pos.bestPrice
							if (profit >= TRAILING_ACTIVATE * pos.atrValue) {
								const newSl = Math.min(pos.sl, pos.bestPrice + TRAILING_DISTANCE * pos.atrValue)
								if (newSl < pos.sl) {
									pos.sl = newSl
									if (!pos.trailingActivated) {
										pos.trailingActivated = true
										console.log(`  [Trailing] ${sym} activated, SL=${newSl.toFixed(5)}`)
									}
								}
							}
						}
					}

					// Overnight hold close
					if (pos.holdOvernight === false && (i - pos.entryIdx) >= 6) {
						const closePrice = price
						const multiplier = pos.type === 'BUY' ? 1 : -1
						const pnlPips2 = (closePrice - pos.entry) / pipToPrice(1, sym)
						const pnl2 = pnlPips2 * pos.size * pipValuePerLot(sym) * multiplier
						const slPips = Math.round(Math.abs(pos.sl - pos.entry) / pipToPrice(1, sym))
						const tpPips = Math.round(Math.abs(pos.tp - pos.entry) / pipToPrice(1, sym))
						balances[sym] += pnl2
						trades[sym].push({
							symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
							exit: closePrice, pnl: parseFloat(pnl2.toFixed(2)), result: pnl2 >= 0 ? 'WIN' : 'LOSS',
							exitTime: current.snapshotTime ?? current.snapshotTimeUTC ?? i,
							entryTime: pos.entryTime, bars: i - pos.entryIdx,
							reason: pos.reason, confidence: pos.confidence,
							slPips, tpPips, exitReason: 'CLOSE',
						})
						positions[sym] = null
						const ct = Object.values(balances).reduce((a, b) => a + b, 0)
						if (ct > peakTotal) peakTotal = ct
						const dd2 = ((peakTotal - ct) / peakTotal) * 100
						if (dd2 > maxDD) maxDD = dd2
						continue
					}

					const result = checkPosition(pos, h1, pos.entryIdx + 1, i + 1)
					if (result) {
						const multiplier = pos.type === 'BUY' ? 1 : -1
						const pnlPips = (result.price - pos.entry) / pipToPrice(1, sym)
						const spreadPips = parseFloat(process.env.BACKTEST_SPREAD_PIPS ?? '0')
						const spreadCost = spreadPips * pos.size * pipValuePerLot(sym)
						const pnl = pnlPips * pos.size * pipValuePerLot(sym) * multiplier - spreadCost
						const slPips = Math.round(Math.abs(pos.sl - pos.entry) / pipToPrice(1, sym))
						const tpPips = Math.round(Math.abs(pos.tp - pos.entry) / pipToPrice(1, sym))
						balances[sym] += pnl
						trades[sym].push({
							symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
							exit: result.price, pnl: parseFloat(pnl.toFixed(2)), result: pnl >= 0 ? 'WIN' : 'LOSS',
							exitTime: result.at, entryTime: pos.entryTime, bars: i - pos.entryIdx,
							reason: pos.reason, confidence: pos.confidence,
							slPips, tpPips, exitReason: result.type,
						})
						positions[sym] = null
						const currentTotal = Object.values(balances).reduce((a, b) => a + b, 0)
						if (currentTotal > peakTotal) peakTotal = currentTotal
						const dd = ((peakTotal - currentTotal) / peakTotal) * 100
						if (dd > maxDD) maxDD = dd
					} else if (i >= minLen - 1) {
						trades[sym].push({
							symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
							exit: price, pnl: 0, result: 'UNKNOWN',
							entryTime: pos.entryTime, exitTime: current.snapshotTime ?? i,
							bars: i - pos.entryIdx, reason: pos.reason, confidence: pos.confidence,
						})
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
					atrValue: atrVal,
					bestPrice: entryPrice, trailingActivated: false,
					signalIndex: null, holdOvernight: true,
				}
				console.log(`[${sym}] ${finalAction} @ ${entryPrice} SL=${slPrice.toFixed(5)} TP=${tpPrice.toFixed(5)} size=${size.toFixed(4)} ${setupName}`)
			}
		}

		// Copy segment trades to cumulative
		for (const sym of activeSymbols) {
			allSegmentTrades[sym].push(...trades[sym])
		}

		const segFinal = Object.values(balances).reduce((a, b) => a + b, 0)
		const segPnl = segFinal - BALANCE_PER_SYMBOL * activeSymbols.length
		cumProfit += segPnl
		if (maxDD > globalMaxDD) globalMaxDD = maxDD
		const segAllTrades = Object.values(trades).flat()
		const segClosed = segAllTrades.filter(t => t.result !== 'UNKNOWN')
		console.log(`➡️  Segment ${seg + 1}: $${segPnl >= 0 ? '+' : ''}${segPnl.toFixed(2)} | ${segClosed.length} trades | WR: ${segClosed.length > 0 ? (segClosed.filter(t => t.result === 'WIN').length / segClosed.length * 100).toFixed(1) : 'N/A'}%`)
	} // end segment loop

	// ── Report ──
	const finalBalance = BALANCE_PER_SYMBOL * activeSymbols.length + cumProfit
	const allTrades = Object.values(allSegmentTrades).flat()
	const closedTrades = allTrades.filter(t => t.result !== 'UNKNOWN')
	const finalBalances = {}
	for (const sym of activeSymbols) {
		const symTrades = allSegmentTrades[sym] || []
		const symPnl = symTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
		finalBalances[sym] = BALANCE_PER_SYMBOL + symPnl
	}
	await printReport(allSegmentTrades, finalBalances, BALANCE_PER_SYMBOL, BALANCE_PER_SYMBOL * activeSymbols.length, finalBalance, closedTrades, 0, globalMaxDD, SYMBOLS, TF, CANDLE_COUNT)
	if (NUM_SEGMENTS > 1) {
		console.log(`\n📈 Cumulative PnL across ${NUM_SEGMENTS} segments: ${cumProfit >= 0 ? '+' : ''}${cumProfit.toFixed(2)}`)
	}
}

runBacktest().catch(async err => {
	console.error('[Backtest] fatal:', err.message)
	process.exit(1)
})
