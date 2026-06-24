import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const DEMO = process.env.CAPITAL_DEMO === 'true'
const BASE_URL = DEMO
	? 'https://demo-api-capital.backend-capital.com/api/v1'
	: 'https://api-capital.backend-capital.com/api/v1'

const SYMBOL_TO_EPIC = {
	XAUUSD: 'GOLD',
}

function toEpic(symbol) {
	return SYMBOL_TO_EPIC[symbol] ?? symbol
}

const SESSION_TTL_MS = 9 * 60 * 1000

let sessionTokens = {
	CST: null,
	X_SECURITY_TOKEN: null,
	lastRefresh: null,
}

async function createSession() {
	const res = await axios.post(`${BASE_URL}/session`, {
		identifier: process.env.CAPITAL_EMAIL,
		password: process.env.CAPITAL_PASSWORD,
	}, {
		headers: {
			'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
			'Content-Type': 'application/json',
		},
	})

	sessionTokens.CST = res.headers['cst']
	sessionTokens.X_SECURITY_TOKEN = res.headers['x-security-token']
	sessionTokens.lastRefresh = Date.now()

	console.log('[Capital] Session created')
	return sessionTokens
}

async function ensureSession() {
	const expired = !sessionTokens.lastRefresh || Date.now() - sessionTokens.lastRefresh > SESSION_TTL_MS
	if (expired) {
		console.log('[Capital] Session หมดอายุ — กำลัง re-login...')
		await createSession()
	}
}

function getAuthHeaders() {
	return {
		'CST': sessionTokens.CST,
		'X-SECURITY-TOKEN': sessionTokens.X_SECURITY_TOKEN,
		'Content-Type': 'application/json',
	}
}

async function getCandles(symbol, resolution = 'MINUTE_15', max = 100) {
	await ensureSession()
	const epic = toEpic(symbol)
	const CHUNK = 1000
	if (max <= CHUNK) {
		const res = await axios.get(`${BASE_URL}/prices/${epic}`, {
			headers: getAuthHeaders(),
			params: { resolution, max },
		})
		return res.data.prices || []
	}
	const res = await axios.get(`${BASE_URL}/prices/${epic}`, {
		headers: getAuthHeaders(),
		params: { resolution, max: CHUNK },
	})
	const prices = res.data.prices || []
	if (!prices.length) return prices

	// Use a map to deduplicate candles by snapshotTimeUTC
	const seen = new Map()
	for (const c of prices) {
		const key = c.snapshotTimeUTC || c.snapshotTime
		if (!seen.has(key)) seen.set(key, c)
	}

	const totalNeeded = max
	while (seen.size < totalNeeded) {
		const oldestTime = [...seen.keys()].sort()[0] // earliest timestamp for paginating backwards
		if (!oldestTime) break
		// Parse as UTC by appending Z
		const to = new Date(oldestTime.endsWith('Z') ? oldestTime : oldestTime + 'Z').getTime() - 1
		const toStr = new Date(to).toISOString().replace(/\.\d+Z$/, '')
		const remaining = totalNeeded - seen.size
		const chunkSize = Math.min(CHUNK, remaining)
		const res2 = await axios.get(`${BASE_URL}/prices/${epic}`, {
			headers: getAuthHeaders(),
			params: { resolution, max: chunkSize, to: toStr },
		})
		const chunk = res2.data.prices || []
		if (!chunk.length) break
		let newCandles = 0
		for (const c of chunk) {
			const key = c.snapshotTimeUTC || c.snapshotTime
			if (!seen.has(key)) {
				seen.set(key, c)
				newCandles++
			}
		}
		if (newCandles === 0) break
	}

	return [...seen.values()].sort((a, b) => {
		const ta = a.snapshotTimeUTC || a.snapshotTime
		const tb = b.snapshotTimeUTC || b.snapshotTime
		return ta.localeCompare(tb)
	})
}

async function getOpenPositions() {
	await ensureSession()
	const res = await axios.get(`${BASE_URL}/positions`, {
		headers: getAuthHeaders(),
	})
	return res.data.positions
}

async function openPosition({ epic, direction, size, stopLevel, profitLevel }) {
	await ensureSession()
	const res = await axios.post(`${BASE_URL}/positions`, {
		epic: toEpic(epic),
		direction,
		size,
		guaranteedStop: false,
		stopLevel,
		profitLevel,
	}, {
		headers: getAuthHeaders(),
	})
	return res.data
}

async function closePosition(dealId) {
	await ensureSession()
	const res = await axios.delete(`${BASE_URL}/positions/${dealId}`, {
		headers: getAuthHeaders(),
	})
	return res.data
}

async function createWorkingOrder({ epic, direction, size, level, type, stopLevel, profitLevel, goodTillDate }) {
	await ensureSession()
	const body = {
		epic: toEpic(epic),
		direction,
		size,
		level,
		type, // 'LIMIT' or 'STOP'
		guaranteedStop: false,
	}
	if (stopLevel != null) body.stopLevel = stopLevel
	if (profitLevel != null) body.profitLevel = profitLevel
	if (goodTillDate) body.goodTillDate = goodTillDate
	const res = await axios.post(`${BASE_URL}/workingorders`, body, {
		headers: getAuthHeaders(),
	})
	return res.data
}

async function getWorkingOrders() {
	await ensureSession()
	const res = await axios.get(`${BASE_URL}/workingorders`, {
		headers: getAuthHeaders(),
	})
	return res.data.workingOrders || []
}

async function cancelWorkingOrder(dealId) {
	await ensureSession()
	const res = await axios.delete(`${BASE_URL}/workingorders/${dealId}`, {
		headers: getAuthHeaders(),
	})
	return res.data
}

async function getMarketInfo(symbol) {
	await ensureSession()
	const epic = toEpic(symbol)
	const res = await axios.get(`${BASE_URL}/markets/${epic}`, {
		headers: getAuthHeaders(),
	})
	return res.data
}

export {
	createSession,
	getCandles,
	getOpenPositions,
	openPosition,
	closePosition,
	getMarketInfo,
	createWorkingOrder,
	getWorkingOrders,
	cancelWorkingOrder,
	SYMBOL_TO_EPIC,
	toEpic,
}
