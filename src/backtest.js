import dotenv from 'dotenv'
import { createSession, getCandles } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { getAIDecision } from './aiDecision.js'
import { sendBacktestReport } from './discordNotifier.js'

dotenv.config()

const SYMBOLS = (process.env.BACKTEST_SYMBOLS ?? 'EURUSD,XAUUSD,GBPUSD,USDJPY,US30').split(',')
const TF = process.env.BACKTEST_TF ?? 'HOUR'
const CANDLE_COUNT = parseInt(process.env.BACKTEST_CANDLES ?? '720')
const BALANCE_PER_SYMBOL = parseFloat(process.env.BACKTEST_BALANCE ?? '200')
const USE_AI = process.env.BACKTEST_USE_AI === 'true'
const RISK_PERCENT = parseFloat(process.env.BACKTEST_RISK ?? '1')
const SL_PIPS_DEFAULT = parseInt(process.env.BACKTEST_SL_PIPS ?? '15')
const TP_PIPS_DEFAULT = parseInt(process.env.BACKTEST_TP_PIPS ?? '30')

function pipToPrice(pips, symbol) {
	const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']
	const isJpy = jpyPairs.some(p => symbol.toUpperCase().includes(p.replace('/', '')))
	const isGold = symbol.toUpperCase().includes('XAU') || symbol.toUpperCase().includes('GOLD')
	if (isGold) return pips * 0.01
	return isJpy ? pips * 0.01 : pips * 0.0001
}

function calcSize(balance, entry, slPips, symbol) {
	const riskAmount = balance * (RISK_PERCENT / 100)
	const slPrice = pipToPrice(slPips, symbol)
	if (slPrice <= 0) return 0.01
	const pipValue = pipToPrice(1, symbol)
	const unitsPerLot = 100000
	const pipValuePerLot = pipValue * unitsPerLot
	const lots = riskAmount / (slPips * pipValuePerLot)
	return Math.max(0.01, parseFloat(lots.toFixed(2)))
}

function getPrice(candle) { return candle.closePrice?.bid ?? candle.closePrice }
function getHigh(candle) { return candle.highPrice?.bid ?? candle.highPrice }
function getLow(candle) { return candle.lowPrice?.bid ?? candle.lowPrice }

const aiCallTimestamps = []
function canCallAI() {
	const now = Date.now()
	const window = 60000
	aiCallTimestamps.push(now)
	const recent = aiCallTimestamps.filter(t => now - t < window)
	aiCallTimestamps.length = 0
	aiCallTimestamps.push(...recent)
	return recent.length <= 15
}

function ruleDecision(indicators) {
	const ind = Object.values(indicators)[0]
	if (!ind) return { action: 'HOLD', confidence: 0, sl_pips: null, tp_pips: null, reason: 'no data' }
	const { rsi, emaTrend } = ind
	if (rsi == null) return { action: 'HOLD', confidence: 0, sl_pips: null, tp_pips: null, reason: 'no RSI' }

	if (rsi < 30 && emaTrend === 'bullish')
		return { action: 'BUY', confidence: 0.6, sl_pips: SL_PIPS_DEFAULT, tp_pips: TP_PIPS_DEFAULT, reason: `RSI ${rsi.toFixed(1)} oversold + ${emaTrend}` }
	if (rsi > 70 && emaTrend === 'bearish')
		return { action: 'SELL', confidence: 0.6, sl_pips: SL_PIPS_DEFAULT, tp_pips: TP_PIPS_DEFAULT, reason: `RSI ${rsi.toFixed(1)} overbought + ${emaTrend}` }
	return { action: 'HOLD', confidence: 0.3, sl_pips: null, tp_pips: null, reason: `RSI ${rsi.toFixed(1)} ${emaTrend}` }
}

async function runBacktest() {
	const totalBalance = BALANCE_PER_SYMBOL * SYMBOLS.length
	console.log(`\n[Backtest] ===== เริ่ม Backtest =====`)
	console.log(`[Backtest] Symbols: ${SYMBOLS.join(', ')} | ${TF} | ${CANDLE_COUNT} candles`)
	console.log(`[Backtest] Balance: $${BALANCE_PER_SYMBOL}/symbol (รวม $${totalBalance}) | AI: ${USE_AI}`)

	await createSession()

	const allCandles = {}
	let minLen = Infinity
	for (const sym of SYMBOLS) {
		const raw = await getCandles(sym, TF, CANDLE_COUNT)
		if (!raw || raw.length < 60) {
			console.error(`[Backtest] ${sym}: candle ไม่เพียงพอ (${raw?.length ?? 0}) — ข้าม`)
			continue
		}
		allCandles[sym] = raw
		if (raw.length < minLen) minLen = raw.length
		console.log(`[Backtest] ${sym}: โหลดมา ${raw.length} candles`)
	}

	const activeSymbols = Object.keys(allCandles)
	if (activeSymbols.length === 0) { console.error('[Backtest] ไม่มี symbol ที่มีข้อมูลพอ'); return }

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

	const startIdx = 60
	for (let i = startIdx; i < minLen; i++) {
		for (const sym of activeSymbols) {
			const candles = allCandles[sym]
			const current = candles[i]
			const price = getPrice(current)
			const pos = positions[sym]

			if (pos) {
				const result = checkSLTP(pos, candles, pos.entryIdx + 1, i + 1)
				if (result) {
					const multiplier = pos.type === 'BUY' ? 1 : -1
					const pnlPips = (result.price - pos.entry) / pipToPrice(1, sym)
					const pnl = pnlPips * pos.size * (pipToPrice(1, sym) * 100000) * multiplier
					balances[sym] += pnl
					trades[sym].push({ ...pos, exit: result.price, pnl: parseFloat(pnl.toFixed(2)), result: result.type === 'TP' ? 'WIN' : 'LOSS', exitTime: result.at, bars: i - pos.entryIdx })
					positions[sym] = null
					const currentTotal = Object.values(balances).reduce((a, b) => a + b, 0)
					if (currentTotal > peakTotal) peakTotal = currentTotal
					const dd = ((peakTotal - currentTotal) / peakTotal) * 100
					if (dd > maxDD) maxDD = dd
					continue
				}
				if (i >= minLen - 1) {
					trades[sym].push({ ...pos, exit: price, pnl: 0, result: 'UNKNOWN', exitTime: current.snapshotTime ?? i, bars: i - pos.entryIdx })
					positions[sym] = null
				}
				continue
			}

			const window = candles.slice(0, i + 1)
			const secondTf = TF === 'HOUR' ? 'HOUR_4' : 'MINUTE_15'
			const candleMap = { [TF]: window }
			const sw = candles.slice(Math.max(0, i - 95), i + 1)
			if (sw.length >= 20) candleMap[secondTf] = sw
			const indicators = getMultiTFIndicators(candleMap)

			let decision
			if (USE_AI && canCallAI()) {
				try {
					const aiDecisions = await getAIDecision([{ symbol: sym, indicators, charts: {} }], null, null)
					decision = aiDecisions?.[0]
					aiCallsUsed++
				} catch (err) {
					console.warn(`[Backtest] ${sym} AI error: ${err.message}`)
					decision = ruleDecision(indicators)
				}
			} else {
				decision = ruleDecision(indicators)
			}

			if (!decision || decision.action === 'HOLD') continue

			const slPips = decision.sl_pips ?? SL_PIPS_DEFAULT
			const tpPips = decision.tp_pips ?? TP_PIPS_DEFAULT
			const size = calcSize(balances[sym], price, slPips, sym)
			if (size <= 0) continue

			const sl = decision.action === 'BUY' ? price - pipToPrice(slPips, sym) : price + pipToPrice(slPips, sym)
			const tp = decision.action === 'BUY' ? price + pipToPrice(tpPips, sym) : price - pipToPrice(tpPips, sym)

			positions[sym] = { symbol: sym, type: decision.action, entry: price, sl, tp, size, confidence: decision.confidence, reason: decision.reason, entryTime: current.snapshotTime ?? i, entryIdx: i }

			if (trades[sym].length === 0 || trades[sym].length % 5 === 0) {
				console.log(`[Backtest] ${sym} candle#${i} ${decision.action} @ ${price} | confidence: ${((decision.confidence ?? 0) * 100).toFixed(0)}%`)
			}
		}
	}

	const allTrades = Object.values(trades).flat()
	const totalUsedBalance = Object.values(balances).reduce((a, b) => a + b, 0)
	const totalPnl = totalUsedBalance - totalBalance
	await printReport(trades, balances, totalBalance, totalUsedBalance, allTrades, aiCallsUsed, maxDD)
}

function checkSLTP(position, candles, startIdx, endIdx) {
	endIdx = Math.min(endIdx ?? candles.length, candles.length)
	for (let i = startIdx; i < endIdx; i++) {
		const c = candles[i]
		const high = getHigh(c)
		const low = getLow(c)
		const time = c.snapshotTime ?? c.snapshotTimeUTC ?? i
		if (position.type === 'BUY') {
			if (low <= position.sl) return { hit: true, price: position.sl, type: 'SL', at: time }
			if (high >= position.tp) return { hit: true, price: position.tp, type: 'TP', at: time }
		} else {
			if (high >= position.sl) return { hit: true, price: position.sl, type: 'SL', at: time }
			if (low <= position.tp) return { hit: true, price: position.tp, type: 'TP', at: time }
		}
	}
	return null
}

async function printReport(tradesMap, balances, totalBalance, finalBalance, allTrades, aiCalls, maxDD) {
	console.log(`\n${'='.repeat(60)}`)
	console.log('📊 สรุป Backtest ทุกค่าเงิน')
	console.log(`${'='.repeat(60)}`)
	const h = (s, w) => s.padEnd(w)
	const hr = (s, w) => s.padStart(w)
	console.log(`${h('สินทรัพย์',12)} ${hr('Balance',10)} ${hr('PnL',10)} ${hr('เทรด',6)} ${hr('WIN',5)} ${hr('LOSS',5)} ${hr('WinRate',8)} ${hr('PF',6)}`)
	console.log('-'.repeat(60))

	let totalTrades = 0, totalClosed = 0, totalWins = 0, totalLosses = 0
	let grossProfit = 0, grossLoss = 0
	let allClosedTrades = []

	for (const sym of Object.keys(tradesMap)) {
		const trades = tradesMap[sym]
		const initBal = BALANCE_PER_SYMBOL
		const finalBal = balances[sym]
		const pnl = finalBal - initBal
		const closed = trades.filter(t => t.result !== 'UNKNOWN')
		const wins = closed.filter(t => t.result === 'WIN')
		const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 'N/A'
		const gp = wins.reduce((s, t) => s + t.pnl, 0)
		const gl = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (closed.length > 0 ? '∞' : '-')

		totalTrades += trades.length
		totalClosed += closed.length
		totalWins += wins.length
		totalLosses += losses.length
		grossProfit += gp
		grossLoss += Math.abs(gl)
		allClosedTrades.push(...closed)

		console.log(`${sym.padEnd(12)} $${finalBal.toFixed(2).padStart(7)} ${(pnl >= 0 ? '+' : '') + pnl.toFixed(2).padStart(7)} ${String(trades.length).padStart(6)} ${wins.length.toString().padStart(5)} ${losses.length.toString().padStart(5)} ${String(wr).padStart(7)}% ${pf.toString().padStart(5)}`)
	}

	const netPnl = finalBalance - totalBalance
	const overallWR = totalClosed > 0 ? (totalWins / totalClosed * 100).toFixed(1) : 'N/A'
	const overallPF = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (totalClosed > 0 ? '∞' : '-')

	console.log('-'.repeat(60))
	console.log(`${'รวม'.padEnd(12)} $${finalBalance.toFixed(2).padStart(7)} ${(netPnl >= 0 ? '+' : '') + netPnl.toFixed(2).padStart(7)} ${String(totalTrades).padStart(6)} ${totalWins.toString().padStart(5)} ${totalLosses.toString().padStart(5)} ${String(overallWR).padStart(7)}% ${overallPF.toString().padStart(5)}`)
	console.log(`${'='.repeat(60)}`)
	console.log(`เรียก AI: ${aiCalls} ครั้ง`)
	console.log(`ยอดรวมเริ่มต้น: $${totalBalance.toFixed(2)} → $${finalBalance.toFixed(2)}`)
	console.log(`กำไร/ขาดทุน: $${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} (${(netPnl / totalBalance * 100).toFixed(2)}%)`)
	console.log(`Max Drawdown: ${maxDD.toFixed(2)}%`)
	console.log(`Profit Factor: ${overallPF}`)
	console.log(`${'='.repeat(60)}\n`)

	const allWins = allClosedTrades.filter(t => t.result === 'WIN')
	const allLosses = allClosedTrades.filter(t => t.result === 'LOSS')

	const symbolSummaries = Object.entries(tradesMap).map(([sym, trades]) => {
		const closed = trades.filter(t => t.result !== 'UNKNOWN')
		const wins = closed.filter(t => t.result === 'WIN')
		const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : '0.0'
		const gp = wins.reduce((s, t) => s + t.pnl, 0)
		const gl = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (closed.length > 0 ? '∞' : '-')
		return `${sym}: $${(balances[sym] - BALANCE_PER_SYMBOL) >= 0 ? '+' : ''}${(balances[sym] - BALANCE_PER_SYMBOL).toFixed(2)} | ${closed.length}เทรด | WR ${wr}% | PF ${pf}`
	}).join('\n')

	await sendBacktestReport({
		symbol: `${SYMBOLS.length} สินทรัพย์`,
		tf: TF,
		candles: CANDLE_COUNT,
		aiCalls,
		totalTrades,
		closed: totalClosed,
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
