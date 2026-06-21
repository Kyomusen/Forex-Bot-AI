import cron from 'node-cron'
import dotenv from 'dotenv'
import { createSession, getCandles } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { getAIDecision } from './aiDecision.js'
import { buildOrderParams } from './riskManager.js'
import { placeOrder, hasOpenPosition, logOpenPositions } from './orderManager.js'
import { renderChart } from './chartRenderer.js'
import { addTrade, getHistorySummary } from './tradeHistory.js'
import { sendOrderNotification, sendErrorNotification, sendCycleNotification } from './discordNotifier.js'

dotenv.config()

const SYMBOLS = (process.env.SYMBOLS ?? 'EURUSD').split(',')
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE ?? '1000')

// Configuration for synchronized multi-timeframe analysis
const PRIMARY_TIMEFRAME = process.env.TIMEFRAME ?? 'MINUTE_15'

// Dynamic mapping of primary TF to secondary/tertiary TFs
const TF_MAP = {
	'MINUTE_1':  ['MINUTE_1', 'MINUTE_5', 'MINUTE_15'],
	'MINUTE_5':  ['MINUTE_5', 'MINUTE_15', 'HOUR'],
	'MINUTE_15': ['MINUTE_15', 'HOUR', 'HOUR_4'],
	'MINUTE_30': ['MINUTE_30', 'HOUR', 'HOUR_4'],
	'HOUR':      ['HOUR', 'HOUR_4', 'DAY'],
}

const CRON_MAP = {
	'MINUTE_1': '*/1 * * * *',
	'MINUTE_5': '*/5 * * * *',
	'MINUTE_15': '*/15 * * * *',
	'MINUTE_30': '*/30 * * * *',
	'HOUR': '0 * * * *',
}

const CRON_SCHEDULE = CRON_MAP[PRIMARY_TIMEFRAME] ?? '*/15 * * * *'

const SELECTED_TFS = TF_MAP[PRIMARY_TIMEFRAME] ?? ['MINUTE_15', 'HOUR', 'HOUR_4']

const TIMEFRAMES = SELECTED_TFS.map(tf => ({
	tf: tf,
	label: tf.replace('MINUTE_', '').replace('HOUR', '1H').replace('DAY', '1D').replace('4H', '4H') // Simplify labels
}))

async function runAssetCycle(symbol) {
	console.log(`\n[Bot] ===== ${symbol} | รอบใหม่ ${new Date().toISOString()} =====`)

	let cycleReport = { action: 'HOLD', reason: 'เริ่มทำงาน', status: 'OK', symbol }

	try {
		const alreadyOpen = await hasOpenPosition(symbol)
		if (alreadyOpen) {
			console.log(`[Bot] ${symbol} มี position เปิดอยู่แล้ว — ข้ามรอบนี้`)
			await logOpenPositions()
			return
		}

		console.log(`[Bot] ${symbol} ดึง candle data...`)
		const candleMap = {}
		for (const { tf, label } of TIMEFRAMES) {
			const candles = await getCandles(symbol, tf, 100)
			if (!candles || candles.length < 60) {
				console.log(`[Bot] ${symbol} candle ${label} ไม่เพียงพอ — ข้ามรอบนี้`)
				return
			}
			candleMap[label] = candles
		}

		console.log(`[Bot] ${symbol} คำนวณ indicators...`)
		const multiTFIndicators = getMultiTFIndicators(candleMap)

		console.log(`[Bot] ${symbol} วาด chart ผ่าน QuickChart...`)
		const chartBuffers = {}
		for (const [label, candles] of Object.entries(candleMap)) {
			chartBuffers[label] = await renderChart(candles, label)
		}

		console.log(`[Bot] ${symbol} โหลด trade history...`)
		const historySummary = getHistorySummary()

		console.log(`[Bot] ${symbol} ถาม AI...`)
		const decision = await getAIDecision(symbol, multiTFIndicators, chartBuffers, historySummary)
		console.log(`[Bot] ${symbol} decision:`, JSON.stringify(decision, null, 2))
		cycleReport = { ...decision, status: decision.status ?? 'OK', symbol }

		if (decision.action === 'HOLD') {
			console.log(`[Bot] ${symbol} AI บอก HOLD — ${decision.reason}`)
		} else if (decision.trend_alignment === 'conflicted') {
			console.log(`[Bot] ${symbol} trend ขัดแย้งกัน — ไม่เปิด order`)
			cycleReport.reason = 'trend ขัดแย้งกัน'
		} else {
			console.log(`[Bot] ${symbol} คำนวณ risk...`)
			const primaryIndicators = multiTFIndicators[TIMEFRAMES[0].label]
			const orderParams = buildOrderParams({
				decision,
				indicators: primaryIndicators,
				accountBalance: ACCOUNT_BALANCE,
				symbol: symbol,
			})

			if (!orderParams) {
				console.log(`[Bot] ${symbol} riskManager ไม่ผ่าน — ไม่เปิด order`)
				cycleReport.reason = 'riskManager ไม่ผ่าน'
			} else {
				console.log(`[Bot] ${symbol} ส่ง order...`)
				const result = await placeOrder(orderParams)
				if (result) {
					console.log(`[Bot] ${symbol} ✅ เปิด ${decision.action} สำเร็จ`)
					addTrade({
						dealId: result.dealReference ?? null,
						action: decision.action,
						confidence: decision.confidence,
						trend_alignment: decision.trend_alignment,
						reason: decision.reason,
						entry: symbolData.indicators[TIMEFRAMES[0].label].currentPrice,
						sl_pips: decision.sl_pips,
						tp_pips: decision.tp_pips,
					})
					await sendOrderNotification({ 
						action: decision.action,
						symbol: symbol,
						size: orderParams.size,
						entry: symbolData.indicators[TIMEFRAMES[0].label].currentPrice,
						sl: orderParams.stopLevel,
						tp: orderParams.profitLevel,
						confidence: decision.confidence,
						reason: decision.reason,
						trend_alignment: decision.trend_alignment,
						chartBuffers: symbolData.charts
					})
				} else {
					console.log(`[Bot] ${symbol} ❌ เปิด order ไม่สำเร็จ`)
					cycleReport.status = 'ERROR'
					cycleReport.reason = 'เปิด order ไม่สำเร็จ'
				}
			}
		}

	} catch (err) {
		console.error(`[Bot] ${symbol} error ใน cycle:`, err.message)
		cycleReport = { action: 'HOLD', reason: err.message, status: 'ERROR', symbol }
		await sendErrorNotification(`${symbol} cycle error: ${err.message}`)
		
		// Stop the bot on error as requested
		console.error(`[Bot] Stopping bot due to fatal error in ${symbol}.`)
		await sendCycleNotification(cycleReport)
		process.exit(1)
	}

	// Always send cycle notification
	await sendCycleNotification(cycleReport)
}

async function runAllCycles() {
	console.log(`\n[Bot] ===== รอบใหม่ ${new Date().toISOString()} =====`)
	
	const allData = []
	for (const symbol of SYMBOLS) {
		console.log(`[Bot] ${symbol} ดึง candle data...`)
		const candleMap = {}
		let valid = true
		for (const { tf, label } of TIMEFRAMES) {
			const candles = await getCandles(symbol, tf, 100)
			if (!candles || candles.length < 60) {
				console.log(`[Bot] ${symbol} candle ${label} ไม่เพียงพอ`)
				valid = false
				break
			}
			candleMap[label] = candles
		}
		if (!valid) continue

		const multiTFIndicators = getMultiTFIndicators(candleMap)
		const chartBuffers = {}
		for (const [label, candles] of Object.entries(candleMap)) {
			chartBuffers[label] = await renderChart(candles, label)
		}
		
		allData.push({ symbol, indicators: multiTFIndicators, charts: chartBuffers })
	}

	if (allData.length === 0) return

	console.log('[Bot] ถาม AI สำหรับทุกสินทรัพย์ในรอบเดียว...')
	// Note: You will need to update getAIDecision to handle an array of symbols
	const decisions = await getAIDecision(allData, getHistorySummary()) 
	console.log('[Bot] AI decisions received')

	for (const decision of decisions) {
		const symbol = decision.symbol
		const symbolData = allData.find(d => d.symbol === symbol)
		
		let cycleReport = { ...decision, status: decision.status ?? 'OK', symbol }
		
		try {
			const alreadyOpen = await hasOpenPosition(symbol)
			if (alreadyOpen) continue

			if (decision.action === 'HOLD') {
				console.log(`[Bot] ${symbol} AI บอก HOLD — ${decision.reason}`)
			} else if (decision.trend_alignment === 'conflicted') {
				console.log(`[Bot] ${symbol} trend ขัดแย้งกัน — ไม่เปิด order`)
			} else {
				const orderParams = buildOrderParams({
					decision,
					indicators: symbolData.indicators[TIMEFRAMES[0].label],
					accountBalance: ACCOUNT_BALANCE,
					symbol: symbol,
				})

				if (orderParams) {
					const result = await placeOrder(orderParams)
					if (result) {
						console.log(`[Bot] ${symbol} ✅ เปิด ${decision.action} สำเร็จ`)
					addTrade({
						dealId: result.dealReference ?? null,
						action: decision.action,
						confidence: decision.confidence,
						trend_alignment: decision.trend_alignment,
						reason: decision.reason,
						entry: symbolData.indicators[TIMEFRAMES[0].label].currentPrice,
						sl_pips: decision.sl_pips,
						tp_pips: decision.tp_pips,
					})
					await sendOrderNotification({ 
						action: decision.action,
						symbol: symbol,
						size: orderParams.size,
						entry: symbolData.indicators[TIMEFRAMES[0].label].currentPrice,
						sl: orderParams.stopLevel,
						tp: orderParams.profitLevel,
						confidence: decision.confidence,
						reason: decision.reason,
						trend_alignment: decision.trend_alignment,
						chartBuffers: symbolData.charts
					})
					}
				}
			}
		} catch (err) {
			console.error(`[Bot] ${symbol} error:`, err.message)
		}
		await sendCycleNotification(cycleReport)
	}
}

async function start() {
	console.log('[Bot] 🚀 Forex Bot เริ่มทำงาน')
	console.log(`[Bot] Symbols: ${SYMBOLS.join(', ')} | Balance: $${ACCOUNT_BALANCE}`)
	console.log(`[Bot] Timeframes: ${TIMEFRAMES.map(t => t.label).join(', ')}`)
	console.log(`[Bot] Cron: ${CRON_SCHEDULE}`)

	console.log('[Bot] กำลัง login Capital.com...')
	await createSession()

	await runAllCycles()

	cron.schedule(CRON_SCHEDULE, async () => {
		await runAllCycles()
	})
}

start().catch(async err => {
	console.error('[Bot] fatal error:', err.message)
	await sendErrorNotification(`fatal error: ${err.message}`)
	process.exit(1)
})


