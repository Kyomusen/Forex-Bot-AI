import dotenv from 'dotenv'

dotenv.config()

const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT ?? '1')

function pipToPrice(pips, symbol) {
	const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']
	const isJpy = jpyPairs.some(p => symbol.toUpperCase().includes(p.replace('/', '')))
	return isJpy ? pips * 0.01 : pips * 0.0001
}

function calcPositionSize({ accountBalance, currentPrice, sl_pips, symbol }) {
	if (!sl_pips || sl_pips <= 0) return null

	const riskAmount = accountBalance * (RISK_PERCENT / 100)
	const slPrice = pipToPrice(sl_pips, symbol)

	if (slPrice <= 0) return null

	const pipValue = pipToPrice(1, symbol)
	const unitsPerLot = 100000
	const pipValuePerLot = pipValue * unitsPerLot

	const lots = riskAmount / (sl_pips * pipValuePerLot)
	const size = Math.max(0.01, parseFloat(lots.toFixed(2)))

	return size
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

function buildOrderParams({ decision, indicators, accountBalance, symbol }) {
	const { action, sl_pips, tp_pips, confidence } = decision
	const { currentPrice } = indicators

	if (action === 'HOLD') {
		return null
	}

	if (confidence < 0.6) {
		console.log(`[Risk] confidence ต่ำเกินไป (${confidence}) — ข้ามการเทรด`)
		return null
	}

	if (!sl_pips || !tp_pips) {
		console.log('[Risk] ไม่มี SL/TP — ข้ามการเทรด')
		return null
	}

	const direction = action
	const size = calcPositionSize({ accountBalance, currentPrice, sl_pips, symbol })

	if (!size) {
		console.log('[Risk] คำนวณ size ไม่ได้ — ข้ามการเทรด')
		return null
	}

	const { stopLevel, profitLevel } = calcPriceLevels({
		currentPrice,
		direction,
		sl_pips,
		tp_pips,
		symbol,
	})

	console.log(`[Risk] direction=${direction} size=${size} SL=${stopLevel} TP=${profitLevel}`)

	return {
		epic: symbol,
		direction,
		size,
		stopLevel,
		profitLevel,
	}
}

export { buildOrderParams }
