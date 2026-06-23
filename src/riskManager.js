import dotenv from 'dotenv'
import { getMarketInfo } from './capitalClient.js'

dotenv.config()

const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT ?? '1')

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
	const pipValue = pipToPrice(1, symbol)
	const pipValuePerLot = pipValue * 100000

	const lots = riskAmount / (sl_pips * pipValuePerLot)
	const sizeLots = Math.max(0.01, parseFloat(lots.toFixed(4)))

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

	const finalLots = isFx ? (size / 10000) : size
	console.log(`[Risk] ${symbol} ${direction} size=${size} (${finalLots.toFixed(4)} lots) SL=${stopLevel} TP=${profitLevel}`)

	return { epic: symbol, direction, size, stopLevel, profitLevel }
}

export { buildOrderParams }
