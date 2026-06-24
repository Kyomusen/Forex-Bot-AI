import cron from 'node-cron'
import dotenv from 'dotenv'
import { createSession, getCandles, getOpenPositions, updatePosition, toEpic } from './capitalClient.js'
import { getMultiTFIndicators } from './indicators.js'
import { checkNews } from './newsFilter.js'
import { buildOrderParams } from './riskManager.js'
import { placeOrder, hasOpenPosition } from './orderManager.js'
import { addTrade, loadHistory } from './tradeHistory.js'
import { sendOrderNotification, sendErrorNotification, sendCycleSummary } from './discordNotifier.js'
import { getCached, INITIAL_FETCH, REFRESH_FETCH } from './candleCache.js'
import { evaluate as strategyEval, SYMBOL_STRATEGY } from './strategy.js'
import { loadPending, savePending, placePendingOrder, syncWithCapital, cleanExpired, executePendingOrders } from './pendingOrders.js'

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

async function checkTrailingStops() {
	if (process.env.BACKTEST_TRAILING !== 'true') return
	const trailingActivate = parseFloat(process.env.BACKTEST_TRAILING_ACTIVATE || '1.0')
	const trailingDist = parseFloat(process.env.BACKTEST_TRAILING_DISTANCE || '0.5')
	try {
		const positions = await getOpenPositions()
		if (!positions || positions.length === 0) return
		// Build entryMap from trade history by matching on dealId
		const hist = (await import('./tradeHistory.js')).loadHistory()
		const entryMap = {}
		for (const t of hist) {
			if (t.dealId && t.indicators?.atr) entryMap[t.dealId] = t
		}
		for (const p of positions) {
			const dealId = p.position?.dealId
			if (!dealId) continue
			const entry = entryMap[dealId]
			if (!entry?.indicators?.atr) continue
			const entryPrice = entry.entry
			const atrVal = entry.indicators.atr
			const isBuy = entry.action === 'BUY'
			const currentPrice = p.market?.bid ?? (isBuy ? p.market?.offer : p.market?.bid)
			if (!currentPrice) continue
			const profit = isBuy ? currentPrice - entryPrice : entryPrice - currentPrice
			if (profit >= trailingActivate * atrVal) {
				const bestPrice = isBuy ? Math.max(entryPrice, currentPrice, (p.position?.level || entryPrice)) : Math.min(entryPrice, currentPrice, (p.position?.level || entryPrice))
				const newSl = isBuy
					? parseFloat((bestPrice - trailingDist * atrVal).toFixed(5))
					: parseFloat((bestPrice + trailingDist * atrVal).toFixed(5))
				const currentSl = p.position?.stopLevel
				if (!currentSl) continue
				if ((isBuy && newSl > currentSl) || (!isBuy && newSl < currentSl)) {
					console.log(`[Trailing] ${entry.symbol} ${dealId} update SL ${currentSl}→${newSl}`)
					await updatePosition(dealId, { stopLevel: newSl })
				}
			}
		}
	} catch (err) {
		console.error('[Trailing] error:', err.message)
	}
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

	// Phase 1: Sync triggered working orders from Capital.com
	console.log('[Bot] Phase 1: ตรวจสอบ Working Orders ที่ถูก trigger...')
	cleanExpired(loadPending()) // clean expired + cancel on Capital.com

	if (PAPER_TRADING) {
		// Paper mode: use local polling fallback
		const allPending = loadPending()
		if (allPending.length > 0) {
			const { executed, remaining } = executePendingOrders(allPending)
			for (const order of executed) {
				console.log(`[Bot] 📝 ${order.symbol} PAPER pending trigger: ${order.entry_condition}`)
				addTrade({
					dealId: `paper-${Date.now()}-${order.symbol}`,
					symbol: order.symbol,
					action: order.action,
					confidence: order.confidence || 0.7,
					reason: `Paper Pending: ${order.reason || order.entry_condition}`,
					entry: order.triggeredPrice,
					sl_pips: order.sl_pips,
					tp_pips: order.tp_pips,
					paper: true,
				})
				await sendOrderNotification({
					action: order.action,
					symbol: order.symbol,
					size: '?',
					entry: order.triggeredPrice,
					sl: null,
					tp: null,
					confidence: order.confidence || 0.7,
					reason: `Paper Pending Trigger: ${order.reason || order.entry_condition}`,
					trend_alignment: 'aligned',
					paper: true,
				})
			}
			savePending(remaining)
			console.log(`[Bot] Pending: ${executed.length} executed, ${remaining.length} remaining`)
		}
	} else {
		const { triggered, remaining } = await syncWithCapital()
		for (const order of triggered) {
			console.log(`[Bot] 🎯 ${order.symbol} Working Order ถูก trigger แล้ว! (${order.orderType} ${order.action} @ ${order.level})`)
			try {
				// Check position is actually open
				const positions = await getOpenPositions()
				const pos = (positions || []).find(p =>
					(p.market?.epic ?? '').toUpperCase() === toEpic(order.symbol).toUpperCase()
				)
				const entryPrice = pos?.position?.level || order.level
				const posSize = pos?.position?.size
				addTrade({
					dealId: order.dealId,
					symbol: order.symbol,
					action: order.action,
					confidence: order.confidence || 0.7,
					reason: `Working Order Triggered: ${order.orderType} @ ${order.level} | ${order.reason || order.entry_condition}`,
					entry: entryPrice,
					sl_pips: order.sl_pips,
					tp_pips: order.tp_pips,
					paper: PAPER_TRADING || undefined,
				})
				await sendOrderNotification({
					action: order.action,
					symbol: order.symbol,
					size: posSize ?? '?',
					entry: entryPrice,
					sl: null,
					tp: null,
					confidence: order.confidence || 0.7,
					reason: `Working Order Triggered: ${order.orderType} @ ${order.level}`,
					trend_alignment: 'aligned',
					paper: PAPER_TRADING,
				})
			} catch (err) {
				console.error(`[Bot] ${order.symbol} sync trigger error:`, err.message)
				remaining.push(order)
			}
		}
		savePending(remaining)
		if (triggered.length > 0) {
			console.log(`[Bot] Pending: ${triggered.length} triggered, ${remaining.length} remaining`)
		}
	}

	// Phase 2: Trailing stop check for open positions
	await checkTrailingStops()

	// Phase 3: Indicator → AI filter → News → Place order
	console.log('[Bot] Phase 3: วิเคราะห์ Indicator...')
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

		const { action, setup, confidence, slPips: baseSlPips, tpPips: baseTpPips } = indicatorDecision
		console.log(`[Bot] ${symbol} indicator: ${action} (${setup}, ${(confidence * 100).toFixed(0)}%)`)

		// Check for open position
		if (await hasOpenPosition(symbol)) {
			console.log(`[Bot] ${symbol} มี position แล้ว — ข้าม`)
			results.push({ symbol, action, status: 'SKIP', reason: 'มี Position เปิดอยู่แล้ว' })
			continue
		}

		// Step 2: News filter
		const newsResult = await checkNews(symbol)
		if (newsResult.hasMajorEvent) {
			console.log(`[Bot] ${symbol} news: BLOCK — ${(newsResult.events || []).join(', ')}`)
			results.push({ symbol, action, status: 'SKIP', reason: `News: ${(newsResult.events || []).join(', ')}` })
			continue
		}

		const slPips = baseSlPips
		const tpPips = baseTpPips

		// Step 3: Place order
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
				reason: `Indicator: ${setup}`,
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
				reason: `Indicator: ${setup}`,
				trend_alignment: 'aligned',
				paper: PAPER_TRADING,
			})
			results.push({ symbol, action, status: 'OK', reason: `เทรด ${action} @ ${currentPrice}` })
		}
	}

	await sendCycleSummary(results, RUN_NUMBER)
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
