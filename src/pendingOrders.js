import fs from 'fs'
import { placeWorkingOrder, cancelWorkingOrder, listWorkingOrders } from './orderManager.js'
import { buildWorkingOrderParams } from './riskManager.js'

const FILE = './logs/pending_orders.json'
const MAX_AGE_MS = 6 * 60 * 60 * 1000

export function loadPending() {
	if (!fs.existsSync(FILE)) return []
	try {
		return JSON.parse(fs.readFileSync(FILE, 'utf-8'))
	} catch {
		return []
	}
}

export function savePending(orders) {
	const dir = FILE.substring(0, FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(FILE, JSON.stringify(orders, null, 2))
}

export function checkCondition(order, currentPrice) {
	const cond = order.entry_condition || ''
	const match = cond.match(/^price\s*([<>=!]+)\s*([\d.]+)$/)
	if (!match) return false
	const op = match[1]
	const val = parseFloat(match[2])
	switch (op) {
		case '<=': return currentPrice <= val
		case '>=': return currentPrice >= val
		case '<':  return currentPrice < val
		case '>':  return currentPrice > val
		default:   return false
	}
}

export function cleanExpired(orders) {
	const now = Date.now()
	const remaining = []
	for (const order of orders) {
		const createdAt = order.created_at ? new Date(order.created_at).getTime() : 0
		if ((now - createdAt) < MAX_AGE_MS) {
			remaining.push(order)
		} else if (order.dealId) {
			cancelWorkingOrder(order.dealId).catch(() => {})
		}
	}
	return remaining
}

/**
 * Place a pending order: save locally + create working order on Capital.com
 * @returns {object|null} the saved order with dealId, or null on failure
 */
export async function placePendingOrder({ decision, indicators, accountBalance, symbol, entryPrice, condition, reason }) {
	const params = await buildWorkingOrderParams({ decision, indicators, accountBalance, symbol, entryPrice, condition })
	if (!params) return null

	const result = await placeWorkingOrder(params)
	if (!result) return null

	const dealId = result.dealReference
	const order = {
		dealId,
		symbol,
		action: decision.action,
		entry_condition: condition,
		entry_price: entryPrice,
		orderType: params.type,
		level: params.level,
		sl_pips: decision.sl_pips,
		tp_pips: decision.tp_pips,
		confidence: decision.confidence || 0.7,
		reason: reason || condition,
		created_at: new Date().toISOString(),
	}

	const orders = loadPending()
	orders.push(order)
	savePending(orders)

	console.log(`[Pending] วาง order แล้ว: ${symbol} ${params.type} ${decision.action} @ ${params.level} (dealId=${dealId})`)
	return order
}

/**
 * Sync local pending orders with Capital.com working orders.
 * Returns orders that were triggered (exist locally but gone from Capital.com).
 */
export async function syncWithCapital() {
	const localOrders = loadPending()
	if (localOrders.length === 0) return { triggered: [], remaining: localOrders }

	let remoteOrders
	try {
		remoteOrders = await listWorkingOrders()
	} catch {
		return { triggered: [], remaining: localOrders }
	}

	const remoteDealIds = new Set(
		(remoteOrders || [])
			.map(o => o.workingOrderData?.dealId)
			.filter(Boolean)
	)

	const triggered = []
	const remaining = []

	for (const order of localOrders) {
		if (order.dealId && !remoteDealIds.has(order.dealId)) {
			triggered.push(order)
		} else {
			remaining.push(order)
		}
	}

	if (triggered.length > 0) {
		console.log(`[Pending] ตรวจพบ ${triggered.length} orders ถูก trigger แล้ว`)
		savePending(remaining)
	}

	return { triggered, remaining }
}

export function executePendingOrders(orders) {
	const executed = []
	const remaining = []
	const cache = loadCandleCache()

	for (const order of orders) {
		const key = `${order.symbol}:HOUR`
		const candles = cache[key]
		if (!candles || candles.length === 0) {
			remaining.push(order)
			continue
		}
		const last = candles[candles.length - 1]
		const currentPrice = last.closePrice?.bid ?? last.closePrice ?? last.close ?? null
		if (currentPrice === null) {
			remaining.push(order)
			continue
		}

		if (checkCondition(order, currentPrice)) {
			executed.push({ ...order, triggeredPrice: currentPrice })
		} else {
			remaining.push(order)
		}
	}

	return { executed, remaining }
}

function loadCandleCache() {
	const f = './logs/candle_cache.json'
	if (!fs.existsSync(f)) return {}
	try { return JSON.parse(fs.readFileSync(f, 'utf-8')) } catch { return {} }
}
