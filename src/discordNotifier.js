import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL

const ACTION_COLOR = {
	BUY: 0x00c896,
	SELL: 0xff4466,
	ERROR: 0xff8800,
}

async function sendOrderNotification({ action, symbol, size, entry, sl, tp, confidence, reason, trend_alignment, chartBuffers }) {
	if (!WEBHOOK_URL) {
		console.warn('[Discord] ไม่มี DISCORD_WEBHOOK_URL — ข้ามการแจ้งเตือน')
		return
	}

	const color = ACTION_COLOR[action] ?? 0x888888
	const emoji = action === 'BUY' ? '🟢' : '🔴'
	const alignEmoji = trend_alignment === 'aligned' ? '✅' : '⚠️'

	const embed = {
		title: `${emoji} ${action} ${symbol}`,
		color,
		fields: [
			{ name: 'Entry', value: String(entry), inline: true },
			{ name: 'Size', value: String(size), inline: true },
			{ name: 'Confidence', value: `${(confidence * 100).toFixed(0)}%`, inline: true },
			{ name: 'Stop Loss', value: String(sl), inline: true },
			{ name: 'Take Profit', value: String(tp), inline: true },
			{ name: 'TF Alignment', value: `${alignEmoji} ${trend_alignment}`, inline: true },
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

async function sendCycleNotification(report) {
	if (!WEBHOOK_URL) return

	const color = report.status === 'ERROR' ? ACTION_COLOR.ERROR : 0x00aa00
	const embed = {
		title: `📊 รอบการทำงาน: ${report.action}`,
		color,
		fields: [
			{ name: 'Status', value: String(report.status), inline: true },
			{ name: 'เหตุผล', value: String(report.reason ?? '-'), inline: false },
		],
		timestamp: new Date().toISOString(),
	}

	try {
		await axios.post(WEBHOOK_URL, { embeds: [embed] })
		console.log('[Discord] ✅ ส่ง cycle notification สำเร็จ')
	} catch (err) {
		console.error('[Discord] ❌ ส่ง cycle notification ล้มเหลว:', err.response?.data ?? err.message)
	}
}

export { sendOrderNotification, sendErrorNotification, sendCycleNotification }

