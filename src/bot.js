import cron from 'node-cron'
import dotenv from 'dotenv'
import { createSession, getCandles, getOpenPositions } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { getAIConditionalOrders } from './aiDecision.js'
import { buildOrderParams } from './riskManager.js'
import { placeOrder, hasOpenPosition } from './orderManager.js'
import { renderChart } from './chartRenderer.js'
import { addTrade, getLearningHistory, loadHistory, saveHistory } from './tradeHistory.js'
import { sendOrderNotification, sendErrorNotification, sendCycleSummary } from './discordNotifier.js'
import { getCached, INITIAL_FETCH, REFRESH_FETCH } from './candleCache.js'
import { loadKnowledge, updateKnowledge, syncTradeResults } from './selfLearning.js'
import { evaluate as strategyEval, SYMBOL_STRATEGY } from './strategy.js'
import { loadPending, savePending, executePendingOrders, cleanExpired } from './pendingOrders.js'

dotenv.config()

const SYMBOLS = (process.env.SYMBOLS ?? 'EURUSD').split(',')
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE ?? '1000')
const PRIMARY_TIMEFRAME = process.env.TIMEFRAME ?? 'MINUTE_15'
const RUN_NUMBER = process.env.GITHUB_RUN_NUMBER ?? '1'
const PAPER_TRADING = process.env.PAPER_TRADING === 'true'

const TF_MAP = {
	'MINUTE_1':  ['MINUTE_1',  'MINUTE_5',  'MINUTE_15'],
	'MINUTE_5':  ['MINUTE_5',  'MINUTE_15', 'HOUR'],
	'MINUTE_15': ['MINUTE_15', 'HOUR',      'HOUR_4'],
	'MINUTE_30': ['MINUTE_30', 'HOUR',      'HOUR_4'],
	'HOUR':      ['HOUR',      'HOUR_4',    'DAY'],
}

const CRON_MAP = {
	'MINUTE_1':  '*/1 * * * *',
	'MINUTE_5':  '*/5 * * * *',
	'MINUTE_15': '*/15 * * * *',
	'MINUTE_30': '*/30 * * * *',
	'HOUR':      '0 * * * *',
}

const TF_LABEL_MAP = {
	'MINUTE_1':  '1m',
	'MINUTE_5':  '5m',
	'MINUTE_15': '15m',
	'MINUTE_30': '30m',
	'HOUR':      '1H',
	'HOUR_4':    '4H',
	'DAY':       '1D',
}

const CRON_SCHEDULE = CRON_MAP[PRIMARY_TIMEFRAME] ?? '*/15 * * * *'
const SELECTED_TFS = TF_MAP[PRIMARY_TIMEFRAME] ?? ['MINUTE_15', 'HOUR', 'HOUR_4']

const TIMEFRAMES = SELECTED_TFS.map(tf => ({
	tf,
	label: TF_LABEL_MAP[tf] ?? tf,
}))

async function runAllCycles() {
	console.log(`\n[Bot] ===== รอบใหม่ ${new Date().toISOString()} =====`)

	// Phase 1: Execute pending orders (fast, no AI)
	console.log('[Bot] Phase 1: ตรวจสอบ Pending Orders...')
	const allPending = cleanExpired(loadPending())
	if (allPending.length > 0) {
		const { executed, remaining } = executePendingOrders(allPending)
		for (const order of executed) {
			console.log(`[Bot] 🎯 ${order.symbol} เงื่อนไขตรง! ${order.entry_condition} (price=${order.triggeredPrice})`)
			try {
				const alreadyOpen = await hasOpenPosition(order.symbol)
				if (alreadyOpen) {
					console.log(`[Bot] ${order.symbol} มี position แล้ว — ข้าม`)
					continue
				}
				const currentPrice = order.triggeredPrice
				const orderParams = buildOrderParams({
					decision: {
						action: order.action,
						sl_pips: order.sl_pips,
						tp_pips: order.tp_pips,
						confidence: order.confidence || 0.7,
					},
					indicators: { currentPrice },
					accountBalance: ACCOUNT_BALANCE,
					symbol: order.symbol,
				})
				if (orderParams) {
					let result
					if (PAPER_TRADING) {
						result = { dealReference: `paper-${Date.now()}-${order.symbol}` }
						console.log(`[Bot] ${order.symbol} 📝 PAPER — ${order.action}`)
					} else {
						result = await placeOrder(orderParams)
					}
					if (result) {
						addTrade({
							dealId: result.dealReference ?? null,
							symbol: order.symbol,
							action: order.action,
							confidence: order.confidence || 0.7,
							reason: `Pending: ${order.reason || order.entry_condition}`,
							entry: currentPrice,
							sl_pips: order.sl_pips,
							tp_pips: order.tp_pips,
							paper: PAPER_TRADING || undefined,
						})
						await sendOrderNotification({
							action: order.action,
							symbol: order.symbol,
							size: orderParams.size,
							entry: currentPrice,
							sl: orderParams.stopLevel,
							tp: orderParams.profitLevel,
							confidence: order.confidence || 0.7,
							reason: `Pending trigger: ${order.reason || order.entry_condition}`,
							trend_alignment: 'aligned',
							paper: PAPER_TRADING,
						})
					}
				}
			} catch (err) {
				console.error(`[Bot] ${order.symbol} execute error:`, err.message)
			}
		}
		savePending(remaining)
		console.log(`[Bot] Pending: ${executed.length} executed, ${remaining.length} remaining`)
	}

	// Phase 2: AI วิเคราะห์ — สร้าง pending orders ใหม่
	console.log('[Bot] Phase 2: ดึงข้อมูลตลาดให้ AI วิเคราะห์...')
	const allData = []

	for (const symbol of SYMBOLS) {
		console.log(`[Bot] ${symbol} ดึง candle data...`)
		const candleMap = {}
		let valid = true

		for (const { tf, label } of TIMEFRAMES) {
			const cached = getCached({ symbol, tf, candles: [] })
			const hasCache = cached && cached.length >= 60
			const fetchCount = hasCache ? REFRESH_FETCH : INITIAL_FETCH
			const raw = await getCandles(symbol, tf, fetchCount)

			if (!raw || raw.length < fetchCount) {
				console.log(`[Bot] ${symbol} candle ${label} ไม่เพียงพอ`)
				valid = false
				break
			}

			const candles = getCached({ symbol, tf, candles: raw })

			if (!candles || candles.length < 60) {
				console.log(`[Bot] ${symbol} candle ${label} ยังไม่เพียงพอ (${candles?.length ?? 0}) — รอรอบหน้า`)
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

	if (allData.length === 0) {
		await sendCycleSummary([], RUN_NUMBER)
		return
	}

	console.log('[Bot] ถาม AI เพื่อวาง Pending Orders...')
	const aiOrders = await getAIConditionalOrders(allData, getLearningHistory(), loadKnowledge())
	console.log(`[Bot] AI สร้าง ${aiOrders.length} pending orders`)

	const remaining = loadPending()
	const merged = [...remaining]
	for (const order of aiOrders) {
		const existing = merged.find(o => o.symbol === order.symbol && o.action === order.action)
		if (existing) {
			Object.assign(existing, {
				entry_condition: order.entry_condition,
				entry_price: order.entry_price,
				sl_pips: order.sl_pips,
				tp_pips: order.tp_pips,
				confidence: order.confidence,
				reason: order.reason,
				created_at: new Date().toISOString(),
			})
		} else {
			merged.push({
				symbol: order.symbol,
				action: order.action,
				entry_condition: order.entry_condition,
				entry_price: order.entry_price,
				sl_pips: order.sl_pips,
				tp_pips: order.tp_pips,
				confidence: order.confidence,
				reason: order.reason,
				created_at: new Date().toISOString(),
			})
		}
	}
	savePending(merged)
	console.log(`[Bot] บันทึก ${merged.length} pending orders เรียบร้อย`)

	await sendCycleSummary(aiOrders.map(o => ({
		action: o.action,
		symbol: o.symbol,
		status: 'PENDING',
		reason: `${o.entry_condition} — ${o.reason || ''}`,
		confidence: o.confidence,
	})), RUN_NUMBER)

	// Sync trade results
	try {
		const positions = await getOpenPositions()
		const openDealIds = new Set((positions ?? []).map(p => p.position?.dealId).filter(Boolean))
		const hist = loadHistory()
		if (syncTradeResults(hist, openDealIds)) {
			saveHistory(hist)
			console.log('[Learn] อัปเดตผลเทรดที่ปิดแล้ว')
		}
		updateKnowledge(hist)
	} catch (err) {
		console.error('[Learn] error:', err.message)
	}
}

async function start() {
	console.log('[Bot] 🚀 Forex Bot เริ่มทำงาน')
	console.log(`[Bot] Symbols: ${SYMBOLS.join(', ')} | Balance: $${ACCOUNT_BALANCE}`)
	console.log(`[Bot] Primary TF: ${PRIMARY_TIMEFRAME} | Timeframes: ${TIMEFRAMES.map(t => t.label).join(', ')}`)
	console.log(`[Bot] Cron: ${CRON_SCHEDULE}`)

	await createSession()

	await runAllCycles()

	const singleRun = process.env.SINGLE_RUN === 'true'
	if (singleRun) {
		console.log('[Bot] SINGLE_RUN=true — จบรอบนี้แล้วหยุด')
		return
	}

	cron.schedule(CRON_SCHEDULE, async () => {
		await runAllCycles()
	})
}

start().catch(async err => {
	console.error('[Bot] fatal error:', err.message)
	await sendErrorNotification(`fatal error: ${err.message}`)
	process.exit(1)
})
