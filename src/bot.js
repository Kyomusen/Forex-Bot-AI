import cron from 'node-cron'
import dotenv from 'dotenv'
import { createSession, getCandles, getOpenPositions } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { getAIFilter } from './aiDecision.js'
import { checkNews } from './newsFilter.js'
import { buildOrderParams } from './riskManager.js'
import { placeOrder, hasOpenPosition } from './orderManager.js'
import { renderChart } from './chartRenderer.js'
import { addTrade, getLearningHistory, loadHistory, saveHistory } from './tradeHistory.js'
import { sendOrderNotification, sendErrorNotification, sendCycleSummary } from './discordNotifier.js'
import { getCached, INITIAL_FETCH, REFRESH_FETCH } from './candleCache.js'
import { loadKnowledge, updateKnowledge, syncTradeResults } from './selfLearning.js'
import { evaluate as strategyEval, SYMBOL_STRATEGY } from './strategy.js'
import { loadPending, savePending, executePendingOrders, cleanExpired } from './pendingOrders.js'
import { recordTradeResult } from './filterLearning.js'

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

const TF_MINUTES = {
	'MINUTE_1':  1,
	'MINUTE_5':  5,
	'MINUTE_15': 15,
	'MINUTE_30': 30,
	'HOUR':      60,
	'HOUR_4':    240,
	'DAY':       1440,
}

function getNextCandleTime(tf) {
	const interval = TF_MINUTES[tf] || 60
	const now = Date.now()
	const msSinceMidnight = (now % 86400000)
	const intervalMs = interval * 60000
	const nextInterval = Math.ceil(msSinceMidnight / intervalMs) * intervalMs
	return Math.floor(now / 86400000) * 86400000 + nextInterval
}

const CRON_SCHEDULE = CRON_MAP[PRIMARY_TIMEFRAME] ?? '0 * * * *'
const SELECTED_TFS = TF_MAP[PRIMARY_TIMEFRAME] ?? ['HOUR', 'HOUR_4', 'DAY']

const TIMEFRAMES = SELECTED_TFS.map(tf => ({
	tf,
	label: TF_LABEL_MAP[tf] ?? tf,
}))

async function runAllCycles() {
	console.log(`\n[Bot] ===== รอบใหม่ ${new Date().toISOString()} =====`)
	console.log(`[Bot] Timeframe: ${PRIMARY_TIMEFRAME}`)

	// Sync to next candle boundary so we always analyze fresh candles
	const nextCandle = getNextCandleTime(PRIMARY_TIMEFRAME)
	const waitMs = nextCandle - Date.now()
	if (waitMs > 100 && waitMs < 3600000) {
		console.log(`[Bot] รอ ${Math.round(waitMs / 1000)}s จนถึง candle ${PRIMARY_TIMEFRAME} ถัดไป...`)
		await new Promise(r => setTimeout(r, waitMs + 1000))
	}
	console.log(`[Bot] Candle ใหม่เริ่มแล้ว — ${new Date().toISOString()}`)

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
				const orderParams = await buildOrderParams({
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

	// Phase 2: Indicator → AI filter → News → Place order
	console.log('[Bot] Phase 2: วิเคราะห์ Indicator...')
	const results = []

	for (const symbol of SYMBOLS) {
		console.log(`[Bot] ${symbol} กำลังตรวจสอบ...`)
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

		if (!valid) {
			results.push({ symbol, action: null, status: 'ERROR', reason: 'ข้อมูล candle ไม่พอ' })
			continue
		}

		const multiTFIndicators = getMultiTFIndicators(candleMap)
		const mainInd = Object.values(multiTFIndicators)[0]
		if (!mainInd || !mainInd.rsi || !mainInd.atr) {
			results.push({ symbol, action: null, status: 'ERROR', reason: 'Indicator ไม่ครบ' })
			continue
		}

		// Determine H4 trend for strategy evaluation
		const h4Label = TIMEFRAMES.find(t => t.tf === 'HOUR_4')?.label || '4H'
		const h4Ind = multiTFIndicators[h4Label]
		const h4Trend = h4Ind?.emaTrend || mainInd.emaTrend || 'neutral'

		// Step 1: Indicator decides
		const indicatorDecision = strategyEval({
			symbol,
			h4Trend,
			ind: mainInd,
			knowledge: false,
		})

		if (!indicatorDecision) {
			console.log(`[Bot] ${symbol} indicator: HOLD`)
			results.push({ symbol, action: 'HOLD', status: 'OK', reason: 'HOLD' })
			continue
		}

		const { action, setup, confidence, slPips, tpPips } = indicatorDecision
		console.log(`[Bot] ${symbol} indicator: ${action} (${setup}, ${(confidence * 100).toFixed(0)}%)`)

		// Check for open position
		if (await hasOpenPosition(symbol)) {
			console.log(`[Bot] ${symbol} มี position แล้ว — ข้าม`)
			results.push({ symbol, action, status: 'SKIP', reason: 'มี Position เปิดอยู่แล้ว' })
			continue
		}

		// Step 2: AI filter (PROCEED/SKIP)
		const aiResult = await getAIFilter({ symbol, indicatorDecision, marketData: mainInd })
		if (aiResult.action === 'SKIP') {
			console.log(`[Bot] ${symbol} AI filter: SKIP — ${aiResult.reason}`)
			results.push({ symbol, action, status: 'SKIP', reason: `AI skip: ${(aiResult.reason || '').slice(0, 200)}` })
			continue
		}
		console.log(`[Bot] ${symbol} AI filter: PROCEED (conf ${(aiResult.confidence * 100).toFixed(0)}%)`)

		// Step 3: News filter
		const newsResult = await checkNews(symbol)
		if (newsResult.hasMajorEvent) {
			console.log(`[Bot] ${symbol} news: BLOCK — ${(newsResult.events || []).join(', ')}`)
			results.push({ symbol, action, status: 'SKIP', reason: `News: ${(newsResult.events || []).join(', ')}` })
			continue
		}

		// Step 4: Place order
		const currentPrice = mainInd.currentPrice
		const orderParams = await buildOrderParams({
			decision: { action, sl_pips: slPips, tp_pips: tpPips, confidence },
			indicators: { currentPrice },
			accountBalance: ACCOUNT_BALANCE,
			symbol,
		})

		if (!orderParams) {
			results.push({ symbol, action, status: 'SKIP', reason: 'Risk params ไม่ผ่าน' })
			continue
		}

		let result
		if (PAPER_TRADING) {
			result = { dealReference: `paper-${Date.now()}-${symbol}` }
			console.log(`[Bot] ${symbol} 📝 PAPER — ${action}`)
		} else {
			result = await placeOrder(orderParams)
		}

		if (result) {
			addTrade({
				dealId: result.dealReference ?? null,
				symbol,
				action,
				confidence,
				reason: `Indicator: ${setup} | AI: ${(aiResult.reason || '').slice(0, 100)}`,
				entry: currentPrice,
				sl_pips: slPips,
				tp_pips: tpPips,
				indicators: mainInd,
				paper: PAPER_TRADING || undefined,
			})
			await sendOrderNotification({
				action,
				symbol,
				size: orderParams.size,
				entry: currentPrice,
				sl: orderParams.stopLevel,
				tp: orderParams.profitLevel,
				confidence,
				reason: `Indicator: ${setup} | AI: ${(aiResult.reason || '').slice(0, 100)}`,
				trend_alignment: 'aligned',
				paper: PAPER_TRADING,
			})
			results.push({ symbol, action, status: 'OK', reason: `เทรด ${action} @ ${currentPrice}` })
		}
	}

	await sendCycleSummary(results, RUN_NUMBER)

	// Sync trade results
	try {
		const positions = await getOpenPositions()
		const openDealIds = new Set((positions ?? []).map(p => p.position?.dealId).filter(Boolean))
		const hist = loadHistory()
		if (syncTradeResults(hist, openDealIds)) {
			saveHistory(hist)
			console.log('[Learn] อัปเดตผลเทรดที่ปิดแล้ว')
			// Record closed trades for filter learning
			for (const t of hist) {
				if (t.result === 'CLOSED' && t.indicators) {
					recordTradeResult({
						symbol: t.symbol, action: t.action,
						setup: t.reason?.includes('momentum') ? 'momentum_sell' : t.reason?.includes('pullback') ? 'pullback_sell' : 'rules',
						entryIndicators: t.indicators,
						result: 'UNKNOWN', pnl: 0,
					})
				}
			}
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
