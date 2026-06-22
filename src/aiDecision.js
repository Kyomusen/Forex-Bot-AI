import { GoogleGenerativeAI } from '@google/generative-ai'
import dotenv from 'dotenv'

dotenv.config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })

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
		return JSON.parse(cleaned)
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
		return JSON.parse(cleaned)
	} catch (err) {
		console.error('[AI] conditional parse error:', err.message)
		return []
	}
}

export { getAIDecision, getAIConditionalOrders }
