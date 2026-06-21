import { GoogleGenerativeAI } from '@google/generative-ai'
import dotenv from 'dotenv'

dotenv.config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' })

function buildBatchPrompt(allData, historySummary) {
	const assetsPrompt = allData.map(({ symbol, indicators, charts }) => {
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

	const historySection = historySummary ? `
=== ประวัติการเทรด ===
${historySummary.total} trades, Winrate: ${historySummary.winrate}%` : '=== ไม่มีประวัติเทรด ==='

	return `
คุณคือ AI เทรด Forex ผู้เชี่ยวชาญ วิเคราะห์ตลาดหลายสินทรัพย์พร้อมกัน
${assetsPrompt}

${historySection}

วิเคราะห์แต่ละสินทรัพย์และตอบเป็น JSON ARRAY เท่านั้น (ไม่ต้องใส่ backticks)
[
  {
    "symbol": "...",
    "action": "BUY" | "SELL" | "HOLD",
    "sl_pips": number | null,
    "tp_pips": number | null,
    "confidence": number,
    "trend_alignment": "aligned" | "mixed" | "conflicted",
    "reason": "..."
  },
  ...
]`.trim()
}

async function getAIDecision(allData, historySummary) {
	const textPrompt = buildBatchPrompt(allData, historySummary)
	const parts = [{ text: textPrompt }]

	// Add all charts
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

