import { GoogleGenerativeAI } from '@google/generative-ai'
import dotenv from 'dotenv'

dotenv.config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })

function buildBatchPrompt(allData, learningHistory) {
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
สถิติ: ${learningHistory.total} เทรด | Winrate: ${learningHistory.winrate}% (Wins: ${learningHistory.wins} / Losses: ${learningHistory.losses})
แนวโน้ม: ${learningHistory.lesson.winRateTrend === 'positive' ? 'กำลังดีขึ้น' : 'ต้องระวัง'}

รายละเอียด ${learningHistory.recent.length} เทรดล่าสุด:
${recentDetail}

${learningHistory.lesson.winPatterns.length > 0 ? `\nรูปแบบที่เคยได้กำไร:\n${learningHistory.lesson.winPatterns.map(r => `- ${r}`).join('\n')}` : ''}
${learningHistory.lesson.lossPatterns.length > 0 ? `\nรูปแบบที่เคยขาดทุน:\n${learningHistory.lesson.lossPatterns.map(r => `- ${r}`).join('\n')}` : ''}

⚠️ วิเคราะห์ด้วยว่าครั้งที่แล้วคุณตัดสินใจอะไรผิดหรือถูก แล้วปรับการตัดสินใจรอบนี้ให้ดีขึ้น`
	} else {
		learningSection = '\n=== ยังไม่มีประวัติเทรด ==='
	}

	return `
คุณคือ AI เทรด Forex ผู้เชี่ยวชาญ วิเคราะห์ตลาดหลายสินทรัพย์พร้อมกัน
${assetsPrompt}
${learningSection}

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

async function getAIDecision(allData, learningHistory) {
	const textPrompt = buildBatchPrompt(allData, learningHistory)
	const parts = [{ text: textPrompt }]

	for (const { symbol, charts } of allData) {
		for (const [tf, buffer] of Object.entries(charts)) {
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
			reason: 'AI parse error'
		}))
	}
}

export { getAIDecision }
