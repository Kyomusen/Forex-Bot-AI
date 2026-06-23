import dotenv from 'dotenv'
import fs from 'fs'
import { getGeminiModel } from './geminiClient.js'

dotenv.config()

const model = getGeminiModel()

const NEWS_CACHE_FILE = './logs/news_cache.json'
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000

function loadNewsCache() {
	if (!fs.existsSync(NEWS_CACHE_FILE)) return {}
	try { return JSON.parse(fs.readFileSync(NEWS_CACHE_FILE, 'utf-8')) } catch { return {} }
}

function saveNewsCache(cache) {
	const dir = NEWS_CACHE_FILE.substring(0, NEWS_CACHE_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(NEWS_CACHE_FILE, JSON.stringify(cache, null, 2))
}

async function checkNews(symbol) {
	const cache = loadNewsCache()
	const cached = cache[symbol]
	if (cached) {
		const age = Date.now() - new Date(cached.timestamp).getTime()
		if (age < NEWS_CACHE_TTL_MS) {
			console.log(`[News] ${symbol} ใช้ cache (${Math.round(age / 1000)}s ago)`)
			return cached.data
		}
	}

	const prompt = `Check economic events affecting ${symbol} in the next 2 hours.

Events to check: Fed/ECB/BOJ/BOE rate decisions, NFP, CPI, PPI, GDP, FOMC minutes, major central bank speeches.

${symbol} specifics:
- EURUSD: ECB, EU GDP, German data
- GBPUSD: BOE, UK GDP, UK CPI
- USDJPY: BOJ, Japanese data
- XAUUSD: Fed, gold inventory, safe-haven flows
- US30: US GDP, earnings, Fed

Respond JSON only:
{"hasMajorEvent":false,"events":[],"recommendation":"PROCEED"}`

	try {
		const result = await model.generateContent(prompt)
		const text = result.response.text()
		const cleaned = text.replace(/```json|```/g, '').trim()
		const parsed = JSON.parse(cleaned)

		cache[symbol] = { timestamp: new Date().toISOString(), data: parsed }
		saveNewsCache(cache)

		return parsed
	} catch (err) {
		console.error('[News] error:', err.message)
		return { hasMajorEvent: false, events: [], recommendation: 'PROCEED' }
	}
}

export { checkNews }
