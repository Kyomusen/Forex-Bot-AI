import fs from 'fs'
import { getGeminiModel } from './geminiClient.js'
import { querySimilarTrades } from './filterLearning.js'
import { getWisdomForPrompt } from './filterWisdom.js'
import { getLearnedRulesForPrompt } from './aiLearn.js'

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
			console.warn(`[RateLimit] ⏰ รอเกิน ${Math.round(RATE_LIMIT_MAX_WAIT_MS / 1000)}s แล้ว — ข้าม AI รอบนี้ (fallback PROCEED)`)
			return false
		}
		const oldest = _aiCallTimestamps[0]
		const waitMs = Math.min(RATE_LIMIT_WINDOW - (Date.now() - oldest) + 500, RATE_LIMIT_MAX_WAIT_MS - elapsed)
		if (waitMs <= 0) continue
		console.log(`[RateLimit] ถึง limit — รอ ${Math.ceil(waitMs / 1000)}s (รอทั้งหมด ${Math.round(elapsed / 1000)}s / max ${Math.round(RATE_LIMIT_MAX_WAIT_MS / 1000)}s)`)
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
	console.log(`[AI] ใช้ cache (${Math.round(age / 1000)}s ago) — ข้าม API call`)
	return entry.data
}

function setCachedAI(key, data) {
	const cache = loadAICache()
	cache[key] = { timestamp: new Date().toISOString(), data }
	saveAICache(cache)
}

function buildBatchPrompt(allData, learningHistory, knowledgeMd) {
	const assetsPrompt = allData.map(({ symbol, indicators }) => {
		const tfSections = Object.entries(indicators).map(([tf, ind]) => {
			return `
[${symbol} - ${tf}]
ราคา: ${ind.currentPrice}
RSI: ${ind.rsi?.toFixed(2)}
EMA20: ${ind.ema20?.toFixed(5)} | EMA50: ${ind.ema50?.toFixed(5)} | Trend: ${ind.emaTrend}
MACD: ${ind.macd.macd?.toFixed(5)} | Signal: ${ind.macd.signal?.toFixed(5)} | Histogram: ${ind.macd.histogram?.toFixed(5)} (${ind.macd.histogramTrend})
ATR: ${ind.atr?.toFixed(5)}`
		}).join('\n')
		return tfSections
	}).join('\n\n')

	let learningSection = ''
	if (learningHistory && learningHistory.total > 0) {
		const recentDetail = learningHistory.recent.map(t =>
			`  ${t.action} → ${t.result} | confidence: ${t.confidence} | trend: ${t.trend_alignment} | reason: ${t.reason}${t.entry_indicator ? ` | RSI:${t.entry_indicator.rsi} EMA:${t.entry_indicator.ema_trend} MACD:${t.entry_indicator.macd_histogram_trend}` : ''}`
		).join('\n')

		const lesson = learningHistory.lesson
		const winRateTrend = typeof lesson === 'object' ? lesson.winRateTrend : 'unknown'
		const winPatterns = typeof lesson === 'object' ? lesson.winPatterns : []
		const lossPatterns = typeof lesson === 'object' ? lesson.lossPatterns : []

		learningSection = `
=== การเรียนรู้จากอดีต ===
สถิติ: ${learningHistory.total} เทรด | Winrate: ${learningHistory.winrate}% (Wins: ${learningHistory.wins} / Losses: ${learningHistory.losses})
แนวโน้ม: ${winRateTrend === 'positive' ? 'กำลังดีขึ้น' : 'ต้องระวัง'}

รายละเอียด ${learningHistory.recent.length} เทรดล่าสุด:
${recentDetail}

${winPatterns.length > 0 ? `\nรูปแบบที่เคยได้กำไร:\n${winPatterns.map(r => `- ${r}`).join('\n')}` : ''}
${lossPatterns.length > 0 ? `\nรูปแบบที่เคยขาดทุน:\n${lossPatterns.map(r => `- ${r}`).join('\n')}` : ''}

⚠️ วิเคราะห์ด้วยว่าครั้งที่แล้วคุณตัดสินใจอะไรผิดหรือถูก แล้วปรับการตัดสินใจรอบนี้ให้ดีขึ้น`
	} else {
		learningSection = '\n=== ยังไม่มีประวัติเทรด ==='
	}

	let knowledgeSection = ''
	if (knowledgeMd) {
		const short = knowledgeMd.split('\n').filter(l => l.startsWith('-') || l.startsWith('|')).slice(0, 15).join('\n')
		knowledgeSection = `
=== ความรู้สะสมจากการเทรดที่ผ่านมา ===
${short}`
	}

	return `
คุณคือ AI เทรด Forex ผู้เชี่ยวชาญ วิเคราะห์ตลาดหลายสินทรัพย์พร้อมกัน
${assetsPrompt}
${learningSection}
${knowledgeSection}

ตอบเป็น JSON ARRAY เท่านั้น (ไม่ต้องใส่ backticks):
[
  {
    "symbol": "...",
    "action": "BUY" | "SELL" | "HOLD",
    "sl_pips": number | null,
    "tp_pips": number | null,
    "confidence": number (0-1),
    "trend_alignment": "aligned" | "mixed" | "conflicted",
    "reason": "วิเคราะห์ + สิ่งที่เรียนรู้จากอดีต"
  },
  ...
]`.trim()
}

async function getAIDecision(allData, learningHistory, knowledgeMd) {
	const cached = getCachedAI('decision')
	if (cached) return cached

	const textPrompt = buildBatchPrompt(allData, learningHistory, knowledgeMd)
	const parts = [{ text: textPrompt }]

	for (const { symbol, charts } of allData) {
		for (const [tf, buffer] of Object.entries(charts)) {
			parts.push({ text: `\nChart ของ ${symbol} - ${tf}:` })
			parts.push({
				inlineData: {
					mimeType: 'image/png',
					data: buffer.toString('base64'),
				},
			})
		}
	}

	const result = await model.generateContent(parts)
	const text = result.response.text()

	try {
		const cleaned = text.replace(/```json|```/g, '').trim()
		const parsed = JSON.parse(cleaned)
		setCachedAI('decision', parsed)
		return parsed
	} catch (err) {
		console.error('[AI] parse error:', err.message)
		return allData.map(d => ({
			symbol: d.symbol,
			action: 'HOLD',
			sl_pips: null,
			tp_pips: null,
			confidence: 0,
			trend_alignment: 'conflicted',
			reason: 'AI parse error — fallback HOLD',
		}))
	}
}

function buildConditionalPrompt(allData, learningHistory, knowledgeMd) {
	const assetsPrompt = allData.map(({ symbol, indicators }) => {
		const tfSections = Object.entries(indicators).map(([tf, ind]) => {
			return `
[${symbol} - ${tf}]
ราคา: ${ind.currentPrice}
RSI: ${ind.rsi?.toFixed(2)}
EMA20: ${ind.ema20?.toFixed(5)} | EMA50: ${ind.ema50?.toFixed(5)} | Trend: ${ind.emaTrend}
MACD: ${ind.macd.macd?.toFixed(5)} | Signal: ${ind.macd.signal?.toFixed(5)} | Histogram: ${ind.macd.histogram?.toFixed(5)} (${ind.macd.histogramTrend})
ATR: ${ind.atr?.toFixed(5)}`
		}).join('\n')
		return tfSections
	}).join('\n\n')

	let learningSection = ''
	if (learningHistory && learningHistory.total > 0) {
		const recentDetail = learningHistory.recent.map(t =>
			`  ${t.action} → ${t.result} | confidence: ${t.confidence} | trend: ${t.trend_alignment} | reason: ${t.reason}${t.entry_indicator ? ` | RSI:${t.entry_indicator.rsi} EMA:${t.entry_indicator.ema_trend} MACD:${t.entry_indicator.macd_histogram_trend}` : ''}`
		).join('\n')
		learningSection = `
=== การเรียนรู้จากอดีต ===
สถิติ: ${learningHistory.total} เทรด | Winrate: ${learningHistory.winrate}%
รายละเอียด ${learningHistory.recent.length} เทรดล่าสุด:
${recentDetail}`
	}

	let knowledgeSection = ''
	if (knowledgeMd) {
		const short = knowledgeMd.split('\n').filter(l => l.startsWith('-') || l.startsWith('|')).slice(0, 15).join('\n')
		knowledgeSection = `
=== ความรู้สะสม ===
${short}`
	}

	return `
คุณคือ AI เทรด Forex วางแผนล่วงหน้า กำหนดคำสั่งรอ (pending orders)
${assetsPrompt}
${learningSection}
${knowledgeSection}

ตอบเป็น JSON ARRAY เท่านั้น (ไม่ต้องใส่ backticks):
[
  {
    "symbol": "...",
    "action": "BUY" | "SELL",
    "entry_condition": "price <= X.XXXX" | "price >= X.XXXX",
    "sl_pips": number,
    "tp_pips": number,
    "entry_price": X.XXXX,
    "confidence": number (0-1),
    "trend_alignment": "aligned" | "mixed" | "conflicted",
    "reason": "วิเคราะห์ + เหตุผล"
  }
]

คำอธิบาย:
- entry_condition: เงื่อนไขราคาที่จะเปิด order เช่น "price <= 1.0850" (ซื้อเมื่อลงถึง) หรือ "price >= 185.50" (ขายเมื่อขึ้นถึง)
- entry_price: ราคาที่คาดว่าจะเข้าเทรด (ใช้คำนวณ SL/TP)
- สร้างเฉพาะ BUY หรือ SELL ที่มั่นใจเท่านั้น
- ไม่ต้องตอบ HOLD`.trim()
}

async function getAIConditionalOrders(allData, learningHistory, knowledgeMd) {
	const cached = getCachedAI('conditional')
	if (cached) return cached

	const textPrompt = buildConditionalPrompt(allData, learningHistory, knowledgeMd)
	const parts = [{ text: textPrompt }]

	for (const { symbol, charts } of allData) {
		for (const [tf, buffer] of Object.entries(charts)) {
			parts.push({ text: `\nChart ของ ${symbol} - ${tf}:` })
			parts.push({
				inlineData: {
					mimeType: 'image/png',
					data: buffer.toString('base64'),
				},
			})
		}
	}

	const result = await model.generateContent(parts)
	const text = result.response.text()

	try {
		const cleaned = text.replace(/```json|```/g, '').trim()
		const parsed = JSON.parse(cleaned)
		setCachedAI('conditional', parsed)
		return parsed
	} catch (err) {
		console.error('[AI] conditional parse error:', err.message)
		return []
	}
}

function buildFilterPrompt({ symbol, action, setup, confidence, marketData, patterns, wisdom, slPips, tpPips }) {
	const { rsi, ema20, ema50, emaTrend, macd, atr, currentPrice } = marketData || {}
	const macdHist = macd?.histogram ?? 0
	const macdHistTrend = macd?.histogramTrend ?? 'neutral'
	const pricePos = currentPrice && ema20 ? (currentPrice > ema20 ? 'above EMA20' : 'below EMA20') : 'unknown'

	let learningSection = ''
	if (patterns) {
		const riskLabel = patterns.winRate < 0.3 ? '🔴 HIGH RISK' : patterns.winRate < 0.4 ? '🟡 CAUTION' : '🟢 NORMAL'
		learningSection = `\n📊 Past ${patterns.total} similar trades on ${symbol} (${setup}):
Wins: ${patterns.wins} | Losses: ${patterns.losses} | Win Rate: ${(patterns.winRate * 100).toFixed(0)}% | ${riskLabel}
${patterns.winRate < 0.3 ? '⚠️ Past similar trades had LOW win rate — STRONGLY consider SKIP' : ''}
${patterns.winRate < 0.4 ? '⚠️ Past similar trades were below average — use extra caution' : ''}`
	}

	let wisdomSection = ''
	if (wisdom) {
		wisdomSection = `\n Wisdom:\n${wisdom}`
	}

	const learnedRules = getLearnedRulesForPrompt(symbol)
	let learnedSection = ''
	if (learnedRules && learnedRules.skipRules?.length > 0) {
		learnedSection = `\n[Ai Learned Rules for ${symbol}]\n${learnedRules.skipRules.map(r => `  SKIP: ${r}`).join('\n')}`
		if (learnedRules.proceedRules?.length > 0) {
			learnedSection += '\n' + learnedRules.proceedRules.map(r => `  PROCEED: ${r}`).join('\n')
		}
	}

	return `You are a FOREX signal filter. The indicator detected a signal below.
Default to PROCEED. SKIP only when past data clearly shows <30% win rate with 5+ similar trades.
If unsure or data is limited → PROCEED.

Signal: ${action} on ${symbol}
Setup: ${setup} | Confidence: ${(confidence * 100).toFixed(0)}%
Price: ${currentPrice} | RSI(14): ${rsi?.toFixed(2)}
Price vs EMA20: ${pricePos} | EMA Trend: ${emaTrend}
MACD Histogram: ${macdHist.toFixed(5)} (${macdHistTrend})
ATR: ${atr?.toFixed(5)}${learningSection}${wisdomSection}${learnedSection}

Current SL: ${slPips}pips | TP: ${tpPips}pips (default values from indicator)

Also suggest SL/TP adjustments based on past trade outcomes:
- "tight" (0.7x): reduce SL/TP distance when market is choppy or SL gets hit too often
- "normal" (1.0x): keep default
- "wide" (1.3x): widen SL/TP when trend is strong or TP consistently missed

Past trade analysis should guide your choice: if similar trades often hit SL first, use "wide" SL; if they hit TP first, try "tight" TP.

Respond ONLY valid JSON (no markdown):
{"action":"PROCEED"|"SKIP","confidence":0-1,"slAdjustment":"normal","tpAdjustment":"normal","reason":"brief reason"}`
}

const ADJUSTMENT_MAP = { tight: 0.7, normal: 1.0, wide: 1.3 }

function parseAdjustment(val) {
	if (val == null) return 1.0
	if (typeof val === 'number') return Math.max(0.5, Math.min(2.0, val))
	const s = String(val).toLowerCase().trim()
	return ADJUSTMENT_MAP[s] ?? 1.0
}

async function getAIFilter(params) {
	const hasSlot = await waitForAISlot()
	if (!hasSlot) {
		console.warn(`[AI] ${params.symbol} rate limit timeout — default PROCEED`)
		return { action: 'PROCEED', confidence: 0.5, slMultiplier: 1.0, tpMultiplier: 1.0, reason: 'Rate limit timeout — auto PROCEED' }
	}

	const { symbol, indicatorDecision, marketData, slPips, tpPips } = params
	const { action, setup, confidence } = indicatorDecision
	const rsi = marketData?.rsi
	const macdHistTrend = marketData?.macd?.histogramTrend

	// Query past similar trades
	const patterns = querySimilarTrades({
		symbol, setup,
		rsi: rsi ?? 50,
		macdHistogramTrend: macdHistTrend ?? 'neutral',
	})

	// Auto-SKIP if past similar trades have low win rate
	if (patterns && patterns.total >= 3 && patterns.winRate < 0.35) {
		console.log(`[AI] ${symbol} auto-SKIP: past ${patterns.total} similar trades, WR ${(patterns.winRate * 100).toFixed(0)}%`)
		return { action: 'SKIP', confidence: 0.4, slMultiplier: 1.0, tpMultiplier: 1.0, reason: `Auto-skip: past ${patterns.total} similar trades had ${(patterns.winRate * 100).toFixed(0)}% win rate` }
	}

	const prompt = buildFilterPrompt({ symbol, ...indicatorDecision, marketData, patterns, wisdom: getWisdomForPrompt(symbol, setup), slPips, tpPips })

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
				reason: parsed.reason ?? '',
			}
		} catch (err) {
			lastError = err
			const status = String(err.status || err.code || err.message || '')
			if (status === '429' || status.includes('429') || status.includes('RATE_LIMIT') || status.includes('Too Many Requests')) {
				const baseWait = parseInt(err.message?.match(/retryDelay.*?(\d+)/i)?.[1] ?? '10') || 10
				const waitSec = baseWait * (retry + 1)
				console.warn(`[AI] 🐢 429 rate limit (ครั้งที่ ${retry + 1}/3)! รอ ${waitSec}s แล้วลองใหม่`)
				for (let i = 0; i < Math.ceil(waitSec / (60000 / 13)); i++) recordAICall()
				await new Promise(r => setTimeout(r, Math.min(waitSec * 1000, 60000)))
				continue
			}
			break
		}
	}

	console.error('[AI] filter error:', lastError?.message || 'unknown')
	return { action: 'PROCEED', confidence: 0.5, slMultiplier: 1.0, tpMultiplier: 1.0, reason: `AI error — default PROCEED (${(lastError?.message || '').slice(0, 80)})` }
}

export { getAIDecision, getAIConditionalOrders, getAIFilter, waitForAISlot }
