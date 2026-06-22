import fs from 'fs'

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

function getCurrentPrice(symbol) {
	const cache = loadCandleCache()
	const key = `${symbol}:HOUR`
	const candles = cache[key]
	if (!candles || candles.length === 0) return null
	const last = candles[candles.length - 1]
	return last.closePrice?.bid ?? last.closePrice ?? last.close ?? null
}

function loadCandleCache() {
	const f = './logs/candle_cache.json'
	if (!fs.existsSync(f)) return {}
	try { return JSON.parse(fs.readFileSync(f, 'utf-8')) } catch { return {} }
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
	return orders.filter(o => {
		const createdAt = o.created_at ? new Date(o.created_at).getTime() : 0
		return (now - createdAt) < MAX_AGE_MS
	})
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
