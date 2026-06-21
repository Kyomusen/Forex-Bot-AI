import fs from 'fs'
import path from 'path'

const CACHE_FILE = path.resolve('./logs/candle_cache.json')
const MAX_CANDLES = 120
const INITIAL_FETCH = 100
const REFRESH_FETCH = 5

function loadCache() {
	if (!fs.existsSync(CACHE_FILE)) return {}
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
	} catch {
		return {}
	}
}

function saveCache(cache) {
	const dir = path.dirname(CACHE_FILE)
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
}

function makeKey(symbol, tf) {
	return `${symbol}:${tf}`
}

function mergeCandles(existing, incoming) {
	const seen = new Map()
	for (const c of existing) {
		seen.set(c.snapshotTimeUTC || c.snapshotTime, c)
	}
	for (const c of incoming) {
		seen.set(c.snapshotTimeUTC || c.snapshotTime, c)
	}
	return Array.from(seen.values())
		.sort((a, b) => new Date(a.snapshotTimeUTC) - new Date(b.snapshotTimeUTC))
		.slice(-MAX_CANDLES)
}

function getCached({ symbol, tf, candles }) {
	const cache = loadCache()
	const key = makeKey(symbol, tf)
	const cached = cache[key]

	if (!cached || cached.length < 60) {
		if (candles.length > 0) {
			cache[key] = candles
			saveCache(cache)
		}
		return candles
	}

	if (candles.length === 0) return cached

	const merged = mergeCandles(cached, candles)
	cache[key] = merged
	saveCache(cache)
	return merged
}

export { getCached, INITIAL_FETCH, REFRESH_FETCH }
