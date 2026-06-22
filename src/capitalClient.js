import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const BASE_URL = 'https://api-capital.backend-capital.com/api/v1'

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
	let oldestTime = prices[prices.length - 1].snapshotTimeUTC || prices[prices.length - 1].snapshotTime
	const totalNeeded = max
	while (prices.length < totalNeeded) {
		const remaining = totalNeeded - prices.length
		const chunkSize = Math.min(CHUNK, remaining)
		const to = new Date(oldestTime).getTime() - 60000
		const toStr = new Date(to).toISOString().replace(/\.\d+Z$/, '')
		const res2 = await axios.get(`${BASE_URL}/prices/${epic}`, {
			headers: getAuthHeaders(),
			params: { resolution, max: chunkSize, to: toStr },
		})
		const chunk = res2.data.prices || []
		if (!chunk.length) break
		prices.push(...chunk)
		if (chunk.length < chunkSize) break
		oldestTime = chunk[chunk.length - 1].snapshotTimeUTC || chunk[chunk.length - 1].snapshotTime
	}
	return prices
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
	SYMBOL_TO_EPIC,
	toEpic,
}
