import dotenv from 'dotenv'
import fs from 'fs'
import { createSession, getCandles } from './capitalClient.js'
import { getIndicators, getMultiTFIndicators } from './indicators.js'
import { getAIDecision } from './aiDecision.js'
import { sendBacktestReport } from './discordNotifier.js'
import { recordTrades, shouldSkipSetup, printSummary } from './backtestLearning.js'

dotenv.config()

const SYMBOLS = (process.env.BACKTEST_SYMBOLS ?? 'EURUSD,XAUUSD,GBPUSD,USDJPY,US30').split(',')
const TF = process.env.BACKTEST_TF ?? 'HOUR'
const CANDLE_COUNT = parseInt(process.env.BACKTEST_CANDLES ?? '720')
const BALANCE_PER_SYMBOL = parseFloat(process.env.BACKTEST_BALANCE ?? '500')
const USE_AI = process.env.BACKTEST_USE_AI === 'true'
const RISK_PERCENT = parseFloat(process.env.BACKTEST_RISK ?? '0.3')
const SL_PIPS_DEFAULT = parseInt(process.env.BACKTEST_SL_PIPS ?? '15')
const TP_PIPS_DEFAULT = parseInt(process.env.BACKTEST_TP_PIPS ?? '30')
const TREND_TF = TF === 'HOUR' ? 'HOUR_4' : 'DAY'
const CANDLE_OFFSET = parseInt(process.env.BACKTEST_OFFSET ?? '0')

const CACHE_FILE = './logs/candle_cache.json'

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
	if (s.includes('US30') || s.includes('WS30')) return 1
	if (s.includes('SPX') || s.includes('NAS')) return 1
	return 10
}

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

function getPrice(c) { return c.closePrice?.bid ?? c.closePrice }
function getHigh(c) { return c.highPrice?.bid ?? c.highPrice }
function getLow(c) { return c.lowPrice?.bid ?? c.lowPrice }

const MAX_DD_PERCENT = parseFloat(process.env.BACKTEST_MAX_DD ?? '50')
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

const aiCallTimestamps = []
function canCallAI() {
	const now = Date.now()
	aiCallTimestamps.push(now)
	const recent = aiCallTimestamps.filter(t => now - t < 60000)
	aiCallTimestamps.length = 0
	aiCallTimestamps.push(...recent)
	return recent.length <= 15
}

const SYMBOL_STRATEGY = {
	EURUSD: {
		allowedSetups: ['pullback_sell'],
		rsi: {
			pullback_sell: { min: 60, max: 80 },
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
		allowedSetups: ['momentum_sell'],
		rsi: {
			momentum_sell: { min: 28, max: 48 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 0.8,
		atrTpM: 2.5,
		minSl: 15,
		minTp: 35,
	},
	GBPUSD: {
		allowedSetups: ['momentum_sell'],
		rsi: {
			momentum_sell: { min: 28, max: 44 },
		},
		trendRequired: false,
		requireH1Trend: true,
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

function atrParams(atr, symbol) {
	const cfg = SYMBOL_STRATEGY[symbol]
	if (!atr || atr <= 0) return { slPips: cfg?.minSl ?? SL_PIPS_DEFAULT, tpPips: cfg?.minTp ?? TP_PIPS_DEFAULT }
	const pips = Math.round(atr / pipToPrice(1, symbol))
	return {
		slPips: Math.max(cfg?.minSl ?? 18, Math.round(pips * (cfg?.atrSlM ?? 2))),
		tpPips: Math.max(cfg?.minTp ?? 45, Math.round(pips * (cfg?.atrTpM ?? 6))),
	}
}

function evaluate(params) {
	const { symbol, h4Trend, ind, knowledge } = params
	const { rsi, ema20, ema50, emaTrend: h1Trend, macd, atr, currentPrice } = ind
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
		: (h4Trend === 'bearish' || belowEma50)

	const uptrend = cfg.trendRequired
		? h4Trend === 'bullish' && aboveEma50 && h1Trend === 'bullish'
		: (h4Trend === 'bullish' || aboveEma50)

	const candidates = []

	for (const setup of cfg.allowedSetups) {
		const rsiRange = cfg.rsi[setup]
		if (!rsiRange) continue

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
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (symbol === 'US30') buyOk = buyOk && macdCrossoverBull && h1Trend === 'bullish'
			if (buyOk) {
				candidates.push({ action: 'BUY', setup, confidence: 0.7, slPips, tpPips })
			}
		}
		if (setup === 'pullback_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) {
				candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
			}
		}
	}

	if (candidates.length === 0) return null

	candidates.sort((a, b) => b.confidence - a.confidence)
	if (knowledge) {
		for (const c of candidates) {
			if (!shouldSkipSetup(symbol, c.setup)) return c
		}
		return null
	}
	return candidates[0]
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

async function runBacktest() {
	const totalBalance = BALANCE_PER_SYMBOL * SYMBOLS.length
	console.log(`\n[Backtest] ===== เริ่ม Backtest =====`)
	console.log(`[Backtest] Symbols: ${SYMBOLS.join(', ')} | ${TF} + ${TREND_TF} | ${CANDLE_COUNT} candles | AI: ${USE_AI}`)
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

	const balances = {}
	const positions = {}
	const trades = {}
	let aiCallsUsed = 0
	let peakTotal = totalBalance
	let maxDD = 0

	for (const sym of activeSymbols) {
		balances[sym] = BALANCE_PER_SYMBOL
		positions[sym] = null
		trades[sym] = []
	}

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
			const et = new Date(entry.time).getTime()
			if (et <= t) best = entry
		}
		return best.emaTrend || 'neutral'
	}

	const startIdx = 60
	for (let i = startIdx; i < minLen; i++) {
		for (const sym of activeSymbols) {
			const { h1 } = allData[sym]
			const current = h1[i]
			const price = getPrice(current)
			const pos = positions[sym]

			if (pos) {
				const result = checkPosition(pos, h1, pos.entryIdx + 1, i + 1)
				if (result) {
					const multiplier = pos.type === 'BUY' ? 1 : -1
					const pnlPips = (result.price - pos.entry) / pipToPrice(1, sym)
					const pnl = pnlPips * pos.size * pipValuePerLot(sym) * multiplier
					balances[sym] += pnl
					trades[sym].push({
						symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
						exit: result.price, pnl: parseFloat(pnl.toFixed(2)), result: pnl >= 0 ? 'WIN' : 'LOSS',
						exitTime: result.at, entryTime: pos.entryTime, bars: i - pos.entryIdx,
						reason: pos.reason, confidence: pos.confidence,
					})
					positions[sym] = null
					const currentTotal = Object.values(balances).reduce((a, b) => a + b, 0)
					if (currentTotal > peakTotal) peakTotal = currentTotal
					const dd = ((peakTotal - currentTotal) / peakTotal) * 100
					if (dd > maxDD) maxDD = dd
					continue
				}
				if (i >= minLen - 1) {
					trades[sym].push({ symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry, exit: price, pnl: 0, result: 'UNKNOWN', entryTime: pos.entryTime, exitTime: current.snapshotTime ?? i, bars: i - pos.entryIdx, reason: pos.reason, confidence: pos.confidence })
					positions[sym] = null
				}
				continue
			}

			const window = h1.slice(0, i + 1)
			const sw = h1.slice(Math.max(0, i - 95), i + 1)
			const candleMap = { [TF]: window }
			if (sw.length >= 20) candleMap[`${TF}_secondary`] = sw
			const indicators = getMultiTFIndicators(candleMap)
			const h4Trend = getH4Trend(sym, current.snapshotTime ?? current.snapshotTimeUTC ?? i)

			let decision = null
			if (USE_AI && canCallAI()) {
				try {
					const data = [{ symbol: sym, indicators, charts: {}, h4_trend: h4Trend }]
					const aiDecisions = await getAIDecision(data, null, null)
					decision = aiDecisions?.[0]
					aiCallsUsed++
				} catch (err) {
					console.warn(`[Backtest] ${sym} AI error: ${err.message}`)
				}
			}

			if (!decision || decision.action === 'HOLD') {
				const mainInd = Object.values(indicators)[0]
				if (mainInd) mainInd.currentPrice = price
				decision = evaluate({
					symbol: sym, h4Trend, ind: mainInd, knowledge: true,
				})
			}

			if (!decision) continue

			const currentTotal = Object.values(balances).reduce((a, b) => a + b, 0)
			if (isDDDisabled(sym, currentTotal, peakTotal)) continue

			const size = calcSize(balances[sym], decision.slPips, sym)
			if (size <= 0) continue

			const slOffset = pipToPrice(decision.slPips, sym)
			const tpOffset = pipToPrice(decision.tpPips, sym)
			const sl = decision.action === 'BUY' ? price - slOffset : price + slOffset
			const tp = decision.action === 'BUY' ? price + tpOffset : price - tpOffset

			positions[sym] = {
				symbol: sym, type: decision.action, entry: price, sl, tp, size,
				setup: decision.setup || 'unknown', confidence: decision.confidence || 0.5,
				reason: decision.reason || '',
				entryTime: current.snapshotTime ?? current.snapshotTimeUTC ?? i,
				entryIdx: i,
			}

			if (trades[sym].length === 0 || trades[sym].length % 3 === 0) {
				console.log(`[Backtest] ${sym} candle#${i} ${decision.action} (${decision.setup}) @ ${price} | conf: ${((decision.confidence ?? 0) * 100).toFixed(0)}%`)
			}
		}
	}

	const allTrades = Object.values(trades).flat()
	const closedTrades = allTrades.filter(t => t.result !== 'UNKNOWN')
	recordTrades(allTrades)

	const finalBalance = Object.values(balances).reduce((a, b) => a + b, 0)
	await printReport(trades, balances, totalBalance, finalBalance, closedTrades, aiCallsUsed, maxDD)
	printSummary()
}

async function printReport(tradesMap, balances, totalBalance, finalBalance, allClosedTrades, aiCalls, maxDD) {
	console.log(`\n${'='.repeat(60)}`)
	console.log(`📊 สรุป Backtest ทุกค่าเงิน`)
	console.log(`${'='.repeat(60)}`)
	const h = (s, w) => s.padEnd(w)
	const hr = (s, w) => s.padStart(w)
	console.log(`${h('สินทรัพย์',12)} ${hr('Balance',10)} ${hr('PnL',10)} ${hr('เทรด',6)} ${hr('WIN',5)} ${hr('LOSS',5)} ${hr('WinRate',8)} ${hr('PF',6)}`)
	console.log('-'.repeat(60))

	let totalTrades = 0, totalWins = 0, totalLosses = 0
	let grossProfit = 0, grossLoss = 0
	let allProfit = true

	for (const sym of Object.keys(tradesMap)) {
		const trades = tradesMap[sym]
		const pnl = (balances[sym] || 0) - BALANCE_PER_SYMBOL
		const closed = trades.filter(t => t.result !== 'UNKNOWN')
		const wins = closed.filter(t => t.result === 'WIN')
		const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 'N/A'
		const gp = wins.reduce((s, t) => s + t.pnl, 0)
		const gl = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (closed.length > 0 ? '∞' : '-')
		totalTrades += trades.length
		totalWins += wins.length
		totalLosses += losses.length
		grossProfit += gp
		grossLoss += Math.abs(gl)
		if (pnl < 0) allProfit = false
		console.log(`${sym.padEnd(12)} $${(balances[sym] || 0).toFixed(2).padStart(7)} ${(pnl >= 0 ? '+' : '') + pnl.toFixed(2).padStart(7)} ${String(trades.length).padStart(6)} ${wins.length.toString().padStart(5)} ${losses.length.toString().padStart(5)} ${String(wr).padStart(7)}% ${pf.toString().padStart(5)}`)
	}

	const netPnl = finalBalance - totalBalance
	const overallWR = (totalWins + totalLosses) > 0 ? (totalWins / (totalWins + totalLosses) * 100).toFixed(1) : 'N/A'
	const overallPF = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (totalTrades > 0 ? '∞' : '-')

	console.log('-'.repeat(60))
	console.log(`${'รวม'.padEnd(12)} $${finalBalance.toFixed(2).padStart(7)} ${(netPnl >= 0 ? '+' : '') + netPnl.toFixed(2).padStart(7)} ${String(totalTrades).padStart(6)} ${totalWins.toString().padStart(5)} ${totalLosses.toString().padStart(5)} ${String(overallWR).padStart(7)}% ${overallPF.toString().padStart(5)}`)
	console.log(`${'='.repeat(60)}`)
	console.log(`เรียก AI: ${aiCalls} ครั้ง`)
	console.log(`ยอดรวม: $${totalBalance.toFixed(2)} → $${finalBalance.toFixed(2)}`)
	console.log(`PnL: $${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} (${(netPnl / totalBalance * 100).toFixed(2)}%)`)
	console.log(`Max DD: ${maxDD.toFixed(2)}% | PF: ${overallPF} | WR: ${overallWR}%`)

	const profitable = netPnl > 0 && allProfit
	console.log(`\n🎯 สรุป: ${profitable ? '✅ กำไรทุกสินทรัพย์!' : '❌ ยังไม่ผ่าน'} (ต้องการกำไรทุกตัว + WR ≥ 50%)`)
	console.log(`${'='.repeat(60)}\n`)

	const symbolSummaries = Object.entries(tradesMap).map(([sym, trades]) => {
		const closed = trades.filter(t => t.result !== 'UNKNOWN')
		const wins = closed.filter(t => t.result === 'WIN')
		const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : '0.0'
		const gp = wins.reduce((s, t) => s + t.pnl, 0)
		const gl = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (closed.length > 0 ? '∞' : '-')
		return `${sym}: $${((balances[sym] || 0) - BALANCE_PER_SYMBOL) >= 0 ? '+' : ''}${((balances[sym] || 0) - BALANCE_PER_SYMBOL).toFixed(2)} | ${closed.length}เทรด | WR ${wr}% | PF ${pf}`
	}).join('\n')

	const allWins = allClosedTrades.filter(t => t.result === 'WIN')
	const allLosses = allClosedTrades.filter(t => t.result === 'LOSS')

	await sendBacktestReport({
		symbol: `${SYMBOLS.length} สินทรัพย์`,
		tf: TF,
		candles: CANDLE_COUNT,
		aiCalls,
		totalTrades,
		closed: allClosedTrades.length,
		wins: totalWins,
		losses: totalLosses,
		winRate: overallWR,
		profitFactor: overallPF,
		initialBalance: totalBalance,
		finalBalance,
		netProfit: netPnl,
		returnPct: ((netPnl / totalBalance) * 100).toFixed(2),
		maxDrawdown: maxDD.toFixed(2),
		bestTrade: allWins.length > 0 ? Math.max(...allWins.map(t => t.pnl)) : 0,
		worstTrade: allLosses.length > 0 ? Math.min(...allLosses.map(t => t.pnl)) : 0,
		symbolSummaries,
	})
}

runBacktest().catch(async err => {
	console.error('[Backtest] fatal:', err.message)
	process.exit(1)
})
