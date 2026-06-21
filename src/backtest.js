import dotenv from 'dotenv'
import { createSession, getCandles } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { getAIDecision } from './aiDecision.js'

dotenv.config()

const SYMBOL = process.env.BACKTEST_SYMBOL ?? 'EURUSD'
const TF = process.env.BACKTEST_TF ?? 'HOUR'
const CANDLE_COUNT = parseInt(process.env.BACKTEST_CANDLES ?? '720')
const INITIAL_BALANCE = parseFloat(process.env.BACKTEST_BALANCE ?? '1000')
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

function getPrice(candle) {
	return candle.closePrice?.bid ?? candle.closePrice
}

function getHigh(candle) {
	return candle.highPrice?.bid ?? candle.highPrice
}

function getLow(candle) {
	return candle.lowPrice?.bid ?? candle.lowPrice
}

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

	const { rsi, emaTrend, macd } = ind
	if (rsi == null) return { action: 'HOLD', confidence: 0, sl_pips: null, tp_pips: null, reason: 'no RSI' }

	if (rsi < 30 && emaTrend === 'bullish') {
		return { action: 'BUY', confidence: 0.6, sl_pips: SL_PIPS_DEFAULT, tp_pips: TP_PIPS_DEFAULT, reason: `RSI ${rsi.toFixed(1)} oversold + ${emaTrend}` }
	}
	if (rsi > 70 && emaTrend === 'bearish') {
		return { action: 'SELL', confidence: 0.6, sl_pips: SL_PIPS_DEFAULT, tp_pips: TP_PIPS_DEFAULT, reason: `RSI ${rsi.toFixed(1)} overbought + ${emaTrend}` }
	}
	return { action: 'HOLD', confidence: 0.3, sl_pips: null, tp_pips: null, reason: `RSI ${rsi.toFixed(1)} ${emaTrend}` }
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

function calcWinRate(trades) {
	if (trades.length === 0) return 0
	return (trades.filter(t => t.result === 'WIN').length / trades.length * 100).toFixed(1)
}

async function runBacktest() {
	console.log(`\n[Backtest] ===== เริ่ม Backtest =====`)
	console.log(`[Backtest] ${SYMBOL} | ${TF} | ${CANDLE_COUNT} candles | Balance: $${INITIAL_BALANCE} | AI: ${USE_AI}`)

	await createSession()
	const raw = await getCandles(SYMBOL, TF, CANDLE_COUNT)
	if (!raw || raw.length < 60) {
		console.error(`[Backtest] ข้อมูล candle ไม่เพียงพอ (${raw?.length ?? 0})`)
		return
	}
	console.log(`[Backtest] โหลดมา ${raw.length} candles`)

	const candles = raw
	let balance = INITIAL_BALANCE
	let position = null
	const trades = []
	let peakBalance = INITIAL_BALANCE
	let maxDrawdown = 0
	let aiCallsUsed = 0

	const startIdx = 60

	for (let i = startIdx; i < candles.length; i++) {
		const window = candles.slice(0, i + 1)
		const current = candles[i]
		const price = getPrice(current)

		if (position) {
			const result = checkSLTP(position, candles, position.entryIdx + 1, i + 1)
			if (result) {
				const multiplier = position.type === 'BUY' ? 1 : -1
				const pnl = (result.price - position.entry) * position.size * multiplier
				balance += pnl

				const resultType = result.type === 'TP' ? 'WIN' : 'LOSS'
				trades.push({
					type: position.type,
					entry: position.entry,
					exit: result.price,
					pnl: parseFloat(pnl.toFixed(2)),
					result: resultType,
					reason: position.reason,
					confidence: position.confidence,
					entryTime: position.entryTime,
					exitTime: result.at,
					bars: i - position.entryIdx,
				})

				position = null

				if (balance > peakBalance) peakBalance = balance
				const dd = ((peakBalance - balance) / peakBalance) * 100
				if (dd > maxDrawdown) maxDrawdown = dd

				if (trades.length % 10 === 0) {
					console.log(`[Backtest] ${trades.length} เทรดแล้ว | Balance: $${balance.toFixed(2)} | WinRate: ${calcWinRate(trades)}%`)
				}

				continue
			}
			if (i >= candles.length - 1) {
				trades.push({
					type: position.type,
					entry: position.entry,
					exit: price,
					pnl: 0,
					result: 'UNKNOWN',
					reason: position.reason,
					confidence: position.confidence,
					entryTime: position.entryTime,
					exitTime: current.snapshotTime ?? i,
					bars: i - position.entryIdx,
				})
				position = null
			}
			continue
		}

		const candleMap = {}
		const secondTf = TF === 'HOUR' ? 'HOUR_4' : 'MINUTE_15'
		candleMap[TF] = window

		try {
			const secondWindow = candles.slice(Math.max(0, i - 95), i + 1)
			if (secondWindow.length >= 20) candleMap[secondTf] = secondWindow
		} catch (_) {}

		const indicators = getMultiTFIndicators(candleMap)

		let decision
		if (USE_AI && canCallAI()) {
			const allData = [{
				symbol: SYMBOL,
				indicators,
				charts: {},
			}]
			try {
				const aiDecisions = await getAIDecision(allData, null, null)
				decision = aiDecisions?.[0]
				aiCallsUsed++
				if (aiCallsUsed % 5 === 0) console.log(`[Backtest] เรียก AI ไป ${aiCallsUsed} ครั้ง`)
			} catch (err) {
				console.warn(`[Backtest] AI error (ใช้กฎแทน): ${err.message}`)
				decision = ruleDecision(indicators)
			}
		} else {
			decision = ruleDecision(indicators)
		}

		if (!decision || decision.action === 'HOLD') continue

		const slPips = decision.sl_pips ?? SL_PIPS_DEFAULT
		const tpPips = decision.tp_pips ?? TP_PIPS_DEFAULT
		const size = calcSize(balance, price, slPips, SYMBOL)

		if (size <= 0) continue

		const slOffset = pipToPrice(slPips, SYMBOL)
		const tpOffset = pipToPrice(tpPips, SYMBOL)
		const sl = decision.action === 'BUY' ? price - slOffset : price + slOffset
		const tp = decision.action === 'BUY' ? price + tpOffset : price - tpOffset

		position = {
			type: decision.action,
			entry: price,
			sl,
			tp,
			size,
			confidence: decision.confidence,
			reason: decision.reason,
			entryTime: current.snapshotTime ?? i,
			entryIdx: i,
		}

		console.log(`[Backtest] candle#${i} ${decision.action} @ ${price} | SL: ${sl.toFixed(5)} TP: ${tp.toFixed(5)} | confidence: ${((decision.confidence ?? 0) * 100).toFixed(0)}%`)
	}

	printReport(trades, INITIAL_BALANCE, balance, maxDrawdown, aiCallsUsed, candles.length)
}

function printReport(trades, initBalance, finalBalance, maxDrawdown, aiCalls, totalCandles) {
	const totalTrades = trades.length
	const closed = trades.filter(t => t.result !== 'UNKNOWN')
	const wins = closed.filter(t => t.result === 'WIN')
	const losses = closed.filter(t => t.result === 'LOSS')
	const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : 'N/A'
	const grossProfit = wins.reduce((s, t) => s + t.pnl, 0)
	const grossLoss = losses.reduce((s, t) => s + t.pnl, 0)
	const netProfit = finalBalance - initBalance
	const profitFactor = grossLoss !== 0 ? (grossProfit / Math.abs(grossLoss)).toFixed(2) : '∞'

	const avgWin = wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : 'N/A'
	const avgLoss = losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : 'N/A'

	console.log(`\n${'='.repeat(50)}`)
	console.log(`📊 ผล Backtest: ${SYMBOL} ${TF}`)
	console.log(`${'='.repeat(50)}`)
	console.log(`ระยะเวลา:         ${totalCandles} candles`)
	console.log(`เรียก AI:         ${aiCalls} ครั้ง`)
	console.log(`เทรดทั้งหมด:      ${totalTrades} ครั้ง`)
	console.log(`ปิดแล้ว:          ${closed.length} (WIN: ${wins.length} / LOSS: ${losses.length})`)
	console.log(`Win Rate:         ${winRate}%`)
	console.log(`ยอดเริ่มต้น:      $${initBalance.toFixed(2)}`)
	console.log(`ยอดสุดท้าย:       $${finalBalance.toFixed(2)}`)
	console.log(`กำไร/ขาดทุน:      $${netProfit >= 0 ? '+' : ''}${netProfit.toFixed(2)} (${(netProfit / initBalance * 100).toFixed(2)}%)`)
	console.log(`Max Drawdown:     ${maxDrawdown.toFixed(2)}%`)
	console.log(`Profit Factor:    ${profitFactor}`)
	console.log(`Avg Win:          $${avgWin}`)
	console.log(`Avg Loss:         $${avgLoss}`)
	console.log(`Best Trade:       $${Math.max(...wins.map(t => t.pnl), 0).toFixed(2)}`)
	console.log(`Worst Trade:      $${Math.min(...losses.map(t => t.pnl), 0).toFixed(2)}`)
	console.log(`${'='.repeat(50)}\n`)
}

runBacktest().catch(err => {
	console.error('[Backtest] fatal:', err.message)
	process.exit(1)
})
