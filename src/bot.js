import cron from 'node-cron'
import dotenv from 'dotenv'
import { createSession, getCandles, getOpenPositions } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { getAIDecision } from './aiDecision.js'
import { buildOrderParams } from './riskManager.js'
import { placeOrder, hasOpenPosition } from './orderManager.js'
import { renderChart } from './chartRenderer.js'
import { addTrade, getLearningHistory, loadHistory, saveHistory } from './tradeHistory.js'
import { sendOrderNotification, sendErrorNotification, sendCycleSummary } from './discordNotifier.js'
import { getCached, INITIAL_FETCH, REFRESH_FETCH } from './candleCache.js'
import { loadKnowledge, updateKnowledge, syncTradeResults } from './selfLearning.js'
import { evaluate as strategyEval, SYMBOL_STRATEGY } from './strategy.js'

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

	console.log('[Bot] ถาม AI สำหรับทุกสินทรัพย์...')
	const decisions = await getAIDecision(allData, getLearningHistory(), loadKnowledge())
	console.log('[Bot] AI decisions received')

	for (const d of decisions) {
		if (d.action === 'HOLD' || d.trend_alignment === 'conflicted' || !d.action) {
			const symbolData = allData.find(x => x.symbol === d.symbol)
			if (symbolData) {
				const primaryIndicators = symbolData.indicators[TIMEFRAMES[0].label]
				const h4Indicators = symbolData.indicators[TIMEFRAMES[2]?.label]
				const h4Trend = h4Indicators?.emaTrend || 'neutral'
				const ruleDecision = strategyEval({
					symbol: d.symbol,
					h4Trend,
					ind: primaryIndicators,
					knowledge: false,
				})
				if (ruleDecision) {
					d.action = ruleDecision.action
					d.sl_pips = ruleDecision.slPips
					d.tp_pips = ruleDecision.tpPips
					d.confidence = ruleDecision.confidence
					d.reason = `Rule-based ${ruleDecision.setup} (RSI-based)`
					d.trend_alignment = 'aligned'
				}
			}
		}
	}

	const results = []

	for (const decision of decisions) {
		const symbol = decision.symbol
		const symbolData = allData.find(d => d.symbol === symbol)
		const cycleReport = { ...decision, status: 'OK', symbol, aiAnalysis: decision.reason, paper: PAPER_TRADING || undefined }

		try {
			const alreadyOpen = await hasOpenPosition(symbol)
			if (alreadyOpen) {
				cycleReport.action = 'HOLD'
				cycleReport.reason = 'มี Position เปิดอยู่แล้ว'
				results.push(cycleReport)
				continue
			}

			if (decision.action === 'HOLD') {
				console.log(`[Bot] ${symbol} AI บอก HOLD — ${decision.reason}`)
			} else if (decision.trend_alignment === 'conflicted') {
				console.log(`[Bot] ${symbol} trend ขัดแย้งกัน — ไม่เปิด order`)
				cycleReport.reason = 'trend ขัดแย้งกัน'
			} else {
				const primaryIndicators = symbolData.indicators[TIMEFRAMES[0].label]
				const orderParams = buildOrderParams({
					decision,
					indicators: primaryIndicators,
					accountBalance: ACCOUNT_BALANCE,
					symbol,
				})

				if (orderParams) {
					let result
					if (PAPER_TRADING) {
						result = { dealReference: `paper-${Date.now()}-${symbol}` }
						console.log(`[Bot] ${symbol} 📝 PAPER — จำลอง ${decision.action}`)
					} else {
						result = await placeOrder(orderParams)
					}
					if (result) {
						console.log(`[Bot] ${symbol} ✅ เปิด ${decision.action} สำเร็จ${PAPER_TRADING ? ' (PAPER)' : ''}`)
						addTrade({
							dealId: result.dealReference ?? null,
							symbol,
							action: decision.action,
							confidence: decision.confidence,
							trend_alignment: decision.trend_alignment,
							reason: decision.reason,
							entry: primaryIndicators.currentPrice,
							sl_pips: decision.sl_pips,
							tp_pips: decision.tp_pips,
							indicators: primaryIndicators,
							paper: PAPER_TRADING || undefined,
						})
						await sendOrderNotification({
							action: decision.action,
							symbol,
							size: orderParams.size,
							entry: primaryIndicators.currentPrice,
							sl: orderParams.stopLevel,
							tp: orderParams.profitLevel,
							confidence: decision.confidence,
							reason: decision.reason,
							trend_alignment: decision.trend_alignment,
							chartBuffers: symbolData.charts,
							paper: PAPER_TRADING,
						})
					} else {
						cycleReport.status = 'ERROR'
						cycleReport.reason = 'เปิด order ไม่สำเร็จ'
					}
				} else {
					cycleReport.reason = 'Risk parameters ไม่ผ่าน'
				}
			}
		} catch (err) {
			console.error(`[Bot] ${symbol} error:`, err.message)
			cycleReport.status = 'ERROR'
			cycleReport.reason = err.message
		}

		results.push(cycleReport)
	}

	await sendCycleSummary(results, RUN_NUMBER)

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
