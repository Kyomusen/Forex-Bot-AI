import dotenv from 'dotenv'
import { getMarketInfo } from './capitalClient.js'

dotenv.config()

const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT ?? '3')

const forexPairs = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']

function isForex(symbol) {
	return forexPairs.some(p => symbol.toUpperCase().includes(p))
}

function pipToPrice(pips, symbol) {
	const upper = symbol.toUpperCase()
	const isJpy = forexPairs.some(p => upper.includes(p.replace('/', ''))) && upper.includes('JPY')
	const isGold = upper.includes('XAU') || upper.includes('GOLD')
	if (isGold) return pips * 0.01
	return isJpy ? pips * 0.01 : pips * 0.0001
}

function pipValuePerLot(symbol) {
	const s = symbol.toUpperCase()
	const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']
	if (s.includes('XAU') || s.includes('GOLD')) return 10
	if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return 1
	if (jpyPairs.some(p => s.includes(p.replace('/', '')))) return 1
	return 10
}

function lotsToCapitalUnits(lots, symbol) {
	const upper = symbol.toUpperCase()
	if (forexPairs.some(p => upper.includes(p))) return Math.round(lots * 10000)
	if (upper.includes('US30') || upper.includes('WS30') || upper.includes('SPX') || upper.includes('NAS')) return parseFloat(lots.toFixed(3))
	return parseFloat(lots.toFixed(4))
}

const _dealingRulesCache = {}

async function getDealingRules(symbol) {
	if (_dealingRulesCache[symbol]) return _dealingRulesCache[symbol]
	try {
		const info = await getMarketInfo(symbol)
		const rules = info?.dealingRules
		if (rules) {
			_dealingRulesCache[symbol] = rules
			return rules
		}
	} catch {}
	return null
}

function calcPositionSize({ accountBalance, currentPrice, sl_pips, symbol }) {
	if (!sl_pips || sl_pips <= 0) return null

	const riskAmount = accountBalance * (RISK_PERCENT / 100)
	const pvpl = pipValuePerLot(symbol)

	const lots = riskAmount / (sl_pips * pvpl)
	const minLot = (symbol.toUpperCase().includes('XAU') || symbol.toUpperCase().includes('GOLD')) ? 0.0001 : 0.01
	const sizeLots = Math.max(minLot, parseFloat(lots.toFixed(4)))

	return sizeLots
}

function calcPriceLevels({ currentPrice, direction, sl_pips, tp_pips, symbol }) {
	const slOffset = pipToPrice(sl_pips, symbol)
	const tpOffset = pipToPrice(tp_pips, symbol)

	let stopLevel, profitLevel
	if (direction === 'BUY') {
		stopLevel = parseFloat((currentPrice - slOffset).toFixed(5))
		profitLevel = parseFloat((currentPrice + tpOffset).toFixed(5))
	} else {
		stopLevel = parseFloat((currentPrice + slOffset).toFixed(5))
		profitLevel = parseFloat((currentPrice - tpOffset).toFixed(5))
	}
	return { stopLevel, profitLevel }
}

async function buildOrderParams({ decision, indicators, accountBalance, symbol }) {
	const { action, sl_pips, tp_pips, confidence } = decision
	const { currentPrice } = indicators

	if (action === 'HOLD') return null
	if (confidence < 0.6) {
		console.log(`[Risk] confidence ต่ำเกินไป (${confidence}) — ข้าม`)
		return null
	}
	if (!sl_pips || !tp_pips) {
		console.log('[Risk] ไม่มี SL/TP — ข้าม')
		return null
	}

	const direction = action
	let sizeLots = calcPositionSize({ accountBalance, currentPrice, sl_pips, symbol })
	if (!sizeLots) {
		console.log('[Risk] คำนวณ size ไม่ได้ — ข้าม')
		return null
	}

	const { stopLevel, profitLevel } = calcPriceLevels({
		currentPrice, direction, sl_pips, tp_pips, symbol,
	})

	// Convert lots → Capital.com API units
	let size = lotsToCapitalUnits(sizeLots, symbol)

	// Enforce minimum size from Capital.com dealing rules
	const rules = await getDealingRules(symbol)
	const minSize = rules?.minDealSize?.value
	const increment = rules?.minSizeIncrement?.value
	const isFx = isForex(symbol)

	if (minSize != null && size < minSize) {
		const newLots = (minSize / (isFx ? 10000 : 1))
		console.log(`[Risk] ${symbol} size ${size} < min ${minSize} — ปรับขนาด (${sizeLots}→${newLots.toFixed(4)} lots)`)
		size = lotsToCapitalUnits(Math.max(sizeLots, newLots), symbol)
	}

	// Round to increment
	if (increment && increment > 0 && size >= increment) {
		size = Math.round(size / increment) * increment
	}

	// Validate actual risk doesn't exceed 2x budget
	const actualLots = isFx ? (size / 10000) : size
	const actualRisk = actualLots * sl_pips * pipValuePerLot(symbol)
	const budgetRisk = accountBalance * (RISK_PERCENT / 100)
	if (actualRisk > budgetRisk * 2) {
		console.log(`[Risk] ${symbol} risk $${actualRisk.toFixed(2)} > ${budgetRisk.toFixed(2)} × 2 — ข้าม (size ${actualLots.toFixed(4)} ใหญ่เกินไป)`)
		return null
	}

	const finalLots = actualLots
	console.log(`[Risk] ${symbol} ${direction} size=${size} (${finalLots.toFixed(4)} lots) SL=${stopLevel} TP=${profitLevel} risk=$${actualRisk.toFixed(2)} (${(actualRisk / accountBalance * 100).toFixed(2)}%)`)

	return { epic: symbol, direction, size, stopLevel, profitLevel }
}

/**
 * Convert entry_condition string to Capital.com order type and level
 * @param {string} action - 'BUY' or 'SELL'
 * @param {string} condition - e.g. "price <= 1.0850"
 * @param {number} entryPrice - trigger price from AI
 * @param {number} currentPrice - current market price
 * @returns {{ type: 'LIMIT'|'STOP', level: number } | null}
 */
function conditionToOrderType(action, condition, entryPrice, currentPrice) {
	// Try parsing condition string
	const match = condition?.match(/price\s*([<>=!]+)\s*([\d.]+)/)
	if (match) {
		const op = match[1]
		const condPrice = parseFloat(match[2])
		if (action === 'BUY' && (op === '<=' || op === '<')) return { type: 'LIMIT', level: condPrice }
		if (action === 'BUY' && (op === '>=' || op === '>')) return { type: 'STOP', level: condPrice }
		if (action === 'SELL' && (op === '<=' || op === '<')) return { type: 'STOP', level: condPrice }
		if (action === 'SELL' && (op === '>=' || op === '>')) return { type: 'LIMIT', level: condPrice }
	}

	// Fallback: derive from entryPrice vs currentPrice
	if (entryPrice != null && currentPrice != null) {
		if (action === 'BUY') {
			return entryPrice < currentPrice
				? { type: 'LIMIT', level: entryPrice }
				: { type: 'STOP', level: entryPrice }
		}
		if (action === 'SELL') {
			return entryPrice < currentPrice
				? { type: 'STOP', level: entryPrice }
				: { type: 'LIMIT', level: entryPrice }
		}
	}

	return null
}

/**
 * Build parameters for a working (conditional) order on Capital.com
 * Uses entryPrice (trigger price) for SL/TP calculation, not currentPrice
 */
async function buildWorkingOrderParams({ decision, indicators, accountBalance, symbol, entryPrice, condition }) {
	const { action, sl_pips, tp_pips, confidence } = decision
	const { currentPrice } = indicators

	if (action === 'HOLD') return null
	if (confidence < 0.6) {
		console.log(`[Risk] working order confidence ต่ำเกินไป (${confidence}) — ข้าม`)
		return null
	}
	if (!sl_pips || !tp_pips) {
		console.log('[Risk] working order ไม่มี SL/TP — ข้าม')
		return null
	}
	if (entryPrice == null) {
		console.log('[Risk] working order ไม่มี entryPrice — ข้าม')
		return null
	}

	const direction = action

	// Calculate size based on entryPrice (not currentPrice)
	let sizeLots = calcPositionSize({ accountBalance, currentPrice: entryPrice, sl_pips, symbol })
	if (!sizeLots) {
		console.log('[Risk] คำนวณ size ไม่ได้ — ข้าม')
		return null
	}

	const { stopLevel, profitLevel } = calcPriceLevels({
		currentPrice: entryPrice, direction, sl_pips, tp_pips, symbol,
	})

	// Convert lots → Capital.com API units
	let size = lotsToCapitalUnits(sizeLots, symbol)

	// Enforce minimum size from dealing rules
	const rules = await getDealingRules(symbol)
	const minSize = rules?.minDealSize?.value
	const increment = rules?.minSizeIncrement?.value
	const isFx = isForex(symbol)

	if (minSize != null && size < minSize) {
		const newLots = (minSize / (isFx ? 10000 : 1))
		console.log(`[Risk] ${symbol} size ${size} < min ${minSize} — ปรับ (${sizeLots}→${newLots.toFixed(4)} lots)`)
		size = lotsToCapitalUnits(Math.max(sizeLots, newLots), symbol)
	}

	if (increment && increment > 0 && size >= increment) {
		size = Math.round(size / increment) * increment
	}

	const actualLots = isFx ? (size / 10000) : size
	const actualRisk = actualLots * sl_pips * pipValuePerLot(symbol)
	const budgetRisk = accountBalance * (RISK_PERCENT / 100)
	if (actualRisk > budgetRisk * 2) {
		console.log(`[Risk] ${symbol} working order risk $${actualRisk.toFixed(2)} > ${budgetRisk.toFixed(2)} × 2 — ข้าม`)
		return null
	}

	// Determine order type (LIMIT/STOP) and trigger level
	const orderInfo = conditionToOrderType(action, condition, entryPrice, currentPrice)
	if (!orderInfo) {
		console.log('[Risk] ไม่สามารถกำหนด order type ได้ — ข้าม')
		return null
	}

	// Set expiry 6 hours from now (matches pendingOrders MAX_AGE_MS)
	const goodTillDate = new Date(Date.now() + 6 * 60 * 60 * 1000)
		.toISOString()
		.replace(/\.\d+Z$/, '')

	const finalLots = actualLots
	console.log(`[Risk] ${symbol} ${direction} WORKING ${orderInfo.type} @ ${orderInfo.level} size=${size} (${finalLots.toFixed(4)} lots) SL=${stopLevel} TP=${profitLevel} risk=$${actualRisk.toFixed(2)}`)

	return {
		epic: symbol,
		direction,
		size,
		level: orderInfo.level,
		type: orderInfo.type,
		stopLevel,
		profitLevel,
		goodTillDate,
	}
}

export { buildOrderParams, buildWorkingOrderParams }
