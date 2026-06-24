import fs from 'fs'
import { getGeminiModel } from './geminiClient.js'

const model = getGeminiModel()

const RATE_LIMIT_MAX = 13
const RATE_LIMIT_WINDOW = 60000
const RATE_LIMIT_MAX_WAIT_MS = parseInt(process.env.AI_RATE_LIMIT_TIMEOUT ?? '120000')
const _aiCallTimestamps = []

export function canCallAI() {
	const now = Date.now()
	const cutoff = now - RATE_LIMIT_WINDOW
	while (_aiCallTimestamps.length > 0 && _aiCallTimestamps[0] < cutoff) {
		_aiCallTimestamps.shift()
	}
	return _aiCallTimestamps.length < RATE_LIMIT_MAX
}

export function recordAICall() {
	_aiCallTimestamps.push(Date.now())
}

async function waitForAISlot() {
	const started = Date.now()
	while (!canCallAI()) {
		const elapsed = Date.now() - started
		if (elapsed > RATE_LIMIT_MAX_WAIT_MS) {
			console.warn(`[RateLimit] timeout ${Math.round(RATE_LIMIT_MAX_WAIT_MS / 1000)}s — skip AI, default PROCEED`)
			return false
		}
		const oldest = _aiCallTimestamps[0]
		const waitMs = Math.min(RATE_LIMIT_WINDOW - (Date.now() - oldest) + 500, RATE_LIMIT_MAX_WAIT_MS - elapsed)
		if (waitMs <= 0) continue
		await new Promise(r => setTimeout(r, Math.min(waitMs, 5000)))
	}
	return true
}

const AI_CACHE_FILE = './logs/ai_cache.json'
const AI_CACHE_TTL_MS = 15 * 60 * 1000

function loadAICache() {
	if (!fs.existsSync(AI_CACHE_FILE)) return {}
	try { return JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf-8')) } catch { return {} }
}

function saveAICache(cache) {
	const dir = AI_CACHE_FILE.substring(0, AI_CACHE_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(cache, null, 2))
}

function getCachedAI(key) {
	const cache = loadAICache()
	const entry = cache[key]
	if (!entry) return null
	const age = Date.now() - new Date(entry.timestamp).getTime()
	if (age > AI_CACHE_TTL_MS) return null
	return entry.data
}

function setCachedAI(key, data) {
	const cache = loadAICache()
	cache[key] = { timestamp: new Date().toISOString(), data }
	saveAICache(cache)
}

const ADJUSTMENT_MAP = { tight: 0.7, normal: 1.0, wide: 1.3 }

function parseAdjustment(val) {
	if (val == null) return 1.0
	if (typeof val === 'number') return Math.max(0.5, Math.min(2.0, val))
	const s = String(val).toLowerCase().trim()
	return ADJUSTMENT_MAP[s] ?? 1.0
}

function buildFilterPrompt({ symbol, action, setup, confidence, marketData, slPips, tpPips }) {
	const { rsi, ema20, ema50, emaTrend, macd, atr, currentPrice } = marketData || {}
	const macdHist = macd?.histogram ?? 0
	const macdHistTrend = macd?.histogramTrend ?? 'neutral'
	const pricePos = currentPrice && ema20 ? (currentPrice > ema20 ? 'above EMA20' : 'below EMA20') : 'unknown'

	const now = new Date()
	const utcHour = now.getUTCHours()
	const closeTimeNote = utcHour >= 13 ? `\nMarket close in ${16 - utcHour}h — consider overnight hold carefully` : ''

	return `You are a FOREX signal filter. The indicator detected a signal below.
Default to PROCEED. SKIP only when indicators clearly contradict the signal.${closeTimeNote}

Signal: ${action} on ${symbol}
Setup: ${setup} | Confidence: ${(confidence * 100).toFixed(0)}%
Price: ${currentPrice} | RSI(14): ${rsi?.toFixed(2)}
Price vs EMA20: ${pricePos} | EMA Trend: ${emaTrend}
MACD Histogram: ${macdHist.toFixed(5)} (${macdHistTrend})
ATR: ${atr?.toFixed(5)}

Current SL: ${slPips}pips | TP: ${tpPips}pips

Also suggest:
1. SL/TP adjustments: "tight" (0.7x), "normal" (1.0x), "wide" (1.3x)
2. Overnight hold: should this trade be held past market close (16:00 UTC)?
   - true: only if strong trend, high conviction
   - false: close before close to avoid overnight fees + gap risk

Respond ONLY valid JSON (no markdown):
{"action":"PROCEED"|"SKIP","confidence":0-1,"slAdjustment":"normal","tpAdjustment":"normal","holdOvernight":true|false,"reason":"brief reason"}`
}

export async function getAIFilter(params) {
	const hasSlot = await waitForAISlot()
	if (!hasSlot) {
		return { action: 'PROCEED', confidence: 0.5, slMultiplier: 1.0, tpMultiplier: 1.0, holdOvernight: true, reason: 'Rate limit timeout — auto PROCEED' }
	}

	const prompt = buildFilterPrompt(params)

	let lastError = null
	for (let retry = 0; retry < 3; retry++) {
		try {
			const result = await model.generateContent(prompt)
			recordAICall()
			const text = result.response.text()
			const cleaned = text.replace(/```json|```/g, '').trim()
			const parsed = JSON.parse(cleaned)
			return {
				action: parsed.action ?? 'PROCEED',
				confidence: parsed.confidence ?? 0.5,
				slMultiplier: parseAdjustment(parsed.slAdjustment),
				tpMultiplier: parseAdjustment(parsed.tpAdjustment),
				holdOvernight: parsed.holdOvernight !== false,
				reason: parsed.reason ?? '',
			}
		} catch (err) {
			lastError = err
			const status = String(err.status || err.code || err.message || '')
			if (status === '429' || status.includes('429') || status.includes('RATE_LIMIT') || status.includes('Too Many Requests')) {
				const baseWait = parseInt(err.message?.match(/retryDelay.*?(\d+)/i)?.[1] ?? '10') || 10
				const waitSec = baseWait * (retry + 1)
				console.warn(`[AI] 429 rate limit (retry ${retry + 1}/3)! wait ${waitSec}s`)
				for (let i = 0; i < Math.ceil(waitSec / (60000 / 13)); i++) recordAICall()
				await new Promise(r => setTimeout(r, Math.min(waitSec * 1000, 60000)))
				continue
			}
			break
		}
	}

	return { action: 'PROCEED', confidence: 0.5, slMultiplier: 1.0, tpMultiplier: 1.0, holdOvernight: true, reason: `AI error — default PROCEED (${(lastError?.message || '').slice(0, 80)})` }
}

export { waitForAISlot }
