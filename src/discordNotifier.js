import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL

const ACTION_COLOR = {
	BUY: 0x00c896,
	SELL: 0xff4466,
	HOLD: 0x888888,
	ERROR: 0xff8800,
}

const SYMBOL_DISPLAY = {
	EURUSD: { name: 'EUR/USD', emoji: '💶' },
	XAUUSD: { name: 'Gold', emoji: '🥇' },
	GBPUSD: { name: 'GBP/USD', emoji: '💷' },
	USDJPY: { name: 'USD/JPY', emoji: '💴' },
	US30:   { name: 'US Wall Street 30', emoji: '📈' },
}

function getSymbolDisplay(symbol) {
	return SYMBOL_DISPLAY[symbol] ?? { name: symbol, emoji: '🔹' }
}

async function sendOrderNotification({ action, symbol, size, entry, sl, tp, confidence, reason, trend_alignment, chartBuffers }) {
	if (!WEBHOOK_URL) {
		console.warn('[Discord] ไม่มี DISCORD_WEBHOOK_URL — ข้ามการแจ้งเตือน')
		return
	}

	const { name: symbolName, emoji: symbolEmoji } = getSymbolDisplay(symbol)
	const color = ACTION_COLOR[action] ?? 0x888888
	const actionEmoji = action === 'BUY' ? '🟢 BUY' : '🔴 SELL'
	const alignEmoji = trend_alignment === 'aligned' ? '✅ aligned' : '⚠️ conflicted'

	const embed = {
		title: `${symbolEmoji} ${symbolName} — ${actionEmoji}`,
		color,
		fields: [
			{ name: 'Entry', value: String(entry), inline: true },
			{ name: 'Size', value: String(size), inline: true },
			{ name: 'Confidence', value: `${(confidence * 100).toFixed(0)}%`, inline: true },
			{ name: 'Stop Loss', value: String(sl), inline: true },
			{ name: 'Take Profit', value: String(tp), inline: true },
			{ name: 'Trend Alignment', value: alignEmoji, inline: true },
			{ name: 'เหตุผล', value: reason ?? '-', inline: false },
		],
		timestamp: new Date().toISOString(),
		footer: { text: 'Forex Bot' },
	}

	if (chartBuffers && Object.keys(chartBuffers).length > 0) {
		const firstTF = Object.keys(chartBuffers)[0]
		embed.image = { url: `attachment://chart_${firstTF}.png` }
	}

	const formData = new FormData()
	formData.append('payload_json', JSON.stringify({ embeds: [embed] }))

	if (chartBuffers) {
		for (const [tf, buffer] of Object.entries(chartBuffers)) {
			const blob = new Blob([buffer], { type: 'image/png' })
			formData.append(`files[${Object.keys(chartBuffers).indexOf(tf)}]`, blob, `chart_${tf}.png`)
		}
	}

	try {
		await axios.post(WEBHOOK_URL, formData, {
			headers: { 'Content-Type': 'multipart/form-data' },
		})
		console.log('[Discord] ✅ ส่งแจ้งเตือนสำเร็จ')
	} catch (err) {
		console.error('[Discord] ❌ ส่งแจ้งเตือนล้มเหลว:', err.response?.data ?? err.message)
	}
}

async function sendErrorNotification(message) {
	if (!WEBHOOK_URL) return

	const embed = {
		title: '⚠️ Bot Error',
		description: message,
		color: ACTION_COLOR.ERROR,
		timestamp: new Date().toISOString(),
		footer: { text: 'Forex Bot' },
	}

	try {
		await axios.post(WEBHOOK_URL, { embeds: [embed] })
	} catch (err) {
		console.error('[Discord] ส่ง error notification ล้มเหลว:', err.message)
	}
}

async function sendCycleSummary(results) {
	if (!WEBHOOK_URL || results.length === 0) return

	const fields = results.map(r => {
		const { name: symbolName, emoji: symbolEmoji } = getSymbolDisplay(r.symbol)
		const actionEmoji = r.action === 'BUY' ? '🟢 BUY' : r.action === 'SELL' ? '🔴 SELL' : '⚫ HOLD'
		const statusEmoji = r.status === 'ERROR' ? '❌' : '✅'
		return {
			name: `${symbolEmoji} ${symbolName}`,
			value: `${statusEmoji} ${actionEmoji}\n${r.reason ?? '-'}`,
			inline: false,
		}
	})

	const anyError = results.some(r => r.status === 'ERROR')
	const anyTrade = results.some(r => r.action === 'BUY' || r.action === 'SELL')

	let title = '📊 รอบการทำงาน'
	if (anyTrade) title += ' — มีการเปิด Position'
	else if (anyError) title += ' — มี Error'
	else title += ' — ทั้งหมด HOLD'

	const embed = {
		title,
		color: anyError ? ACTION_COLOR.ERROR : anyTrade ? 0x00c896 : 0x888888,
		fields,
		timestamp: new Date().toISOString(),
		footer: { text: `Forex Bot • ${results.length} สินทรัพย์` },
	}

	try {
		await axios.post(WEBHOOK_URL, { embeds: [embed] })
		console.log('[Discord] ✅ ส่ง cycle summary สำเร็จ')
	} catch (err) {
		console.error('[Discord] ❌ ส่ง cycle summary ล้มเหลว:', err.response?.data ?? err.message)
	}
}

export { sendOrderNotification, sendErrorNotification, sendCycleSummary }
