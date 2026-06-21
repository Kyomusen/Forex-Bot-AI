import {
	openPosition,
	closePosition,
	getOpenPositions,
	toEpic,
} from './capitalClient.js'

async function placeOrder(orderParams) {
	try {
		console.log('[Order] กำลังเปิด position:', orderParams)
		const result = await openPosition(orderParams)
		console.log('[Order] เปิด position สำเร็จ:', result)
		return result
	} catch (err) {
		console.error('[Order] เปิด position ล้มเหลว:', err.response?.data ?? err.message)
		return null
	}
}

async function closeAllPositions() {
	try {
		const positions = await getOpenPositions()

		if (!positions || positions.length === 0) {
			console.log('[Order] ไม่มี position เปิดอยู่')
			return
		}

		for (const pos of positions) {
			const dealId = pos.position.dealId
			console.log(`[Order] กำลังปิด position dealId=${dealId}`)
			await closePosition(dealId)
			console.log(`[Order] ปิด position สำเร็จ dealId=${dealId}`)
		}
	} catch (err) {
		console.error('[Order] ปิด position ล้มเหลว:', err.response?.data ?? err.message)
	}
}

async function hasOpenPosition(symbol) {
	try {
		const positions = await getOpenPositions()

		if (!positions || positions.length === 0) return false

		return positions.some(pos => {
			const epic = pos.market?.epic ?? ''
			return epic.toUpperCase() === toEpic(symbol).toUpperCase()
		})
	} catch (err) {
		console.error('[Order] ดึง positions ล้มเหลว:', err.response?.data ?? err.message)
		return false
	}
}

async function logOpenPositions() {
	try {
		const positions = await getOpenPositions()

		if (!positions || positions.length === 0) {
			console.log('[Order] ไม่มี position เปิดอยู่')
			return
		}

		console.log(`[Order] Open positions (${positions.length}):`)
		for (const pos of positions) {
			const { dealId, direction, size, level, stopLevel, limitLevel } = pos.position
			const epic = pos.market?.epic ?? 'unknown'
			const pnl = pos.position.upl ?? 'N/A'
			console.log(`  ${epic} | ${direction} | size=${size} | entry=${level} | SL=${stopLevel} | TP=${limitLevel} | PnL=${pnl}`)
		}
	} catch (err) {
		console.error('[Order] ดึง positions ล้มเหลว:', err.response?.data ?? err.message)
	}
}

export {
	placeOrder,
	closeAllPositions,
	hasOpenPosition,
	logOpenPositions,
}
