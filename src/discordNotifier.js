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

function confidenceBar(confidence) {
	const bars = Math.round(confidence * 10)
	const filled = '█'.repeat(bars)
	const empty = '░'.repeat(10 - bars)
	return filled + empty
}

function trendText(trend) {
	if (trend === 'aligned') return '✅ aligned'
	if (trend === 'mixed') return '⚠️ mixed'
	return '❌ conflicted'
}

function formatReason(reason) {
	if (!reason) return '-'
	if (reason.length <= 1000) return reason
	return reason.slice(0, 997) + '...'
}

async function sendOrderNotification({ action, symbol, size, entry, sl, tp, confidence, reason, trend_alignment, chartBuffers }) {
	if (!WEBHOOK_URL) {
		console.warn('[Discord] ไม่มี DISCORD_WEBHOOK_URL — ข้ามการแจ้งเตือน')
		return
	}

	const { name: symbolName, emoji: symbolEmoji } = getSymbolDisplay(symbol)
	const color = ACTION_COLOR[action] ?? 0x888888
	const actionEmoji = action === 'BUY' ? '🟢 BUY' : '🔴 SELL'
	const pct = (confidence * 100).toFixed(0)

	const embed = {
		title: `${symbolEmoji} ${symbolName} — ${actionEmoji}`,
		color,
		fields: [
			{
				name: '🤔 การวิเคราะห์ของ AI',
				value: formatReason(reason),
				inline: false,
			},
			{
				name: '📊 ความมั่นใจ',
				value: `${confidenceBar(confidence)} **${pct}%**`,
				inline: true,
			},
			{
				name: '🎯 แนวโน้ม',
				value: trendText(trend_alignment),
				inline: true,
			},
			{
				name: '📋 รายละเอียดออเดอร์',
				value: [
					`Entry: **${entry}**`,
					`Size: **${size}**`,
					`SL: **${sl}**`,
					`TP: **${tp}**`,
				].join('\n'),
				inline: false,
			},
		],
		timestamp: new Date().toISOString(),
		footer: { text: 'Forex Bot • คำตัดสินของ AI' },
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

async function sendCycleSummary(results, runCount) {
	if (!WEBHOOK_URL || results.length === 0) return

	const embeds = results.map(r => {
		const { name: symbolName, emoji: symbolEmoji } = getSymbolDisplay(r.symbol)
		const actionText = r.action ?? 'HOLD'
		const pct = r.confidence != null ? `${(r.confidence * 100).toFixed(0)}%` : '-'

		let color, statusIcon
		if (r.status === 'ERROR') {
			color = 0xff4466
			statusIcon = '❌'
		} else if (r.action === 'HOLD' || r.action === null) {
			color = 0xff8800
			statusIcon = '⏭️'
		} else if (r.reason === 'มี Position เปิดอยู่แล้ว' || r.reason === 'trend ขัดแย้งกัน' || r.reason === 'Risk parameters ไม่ผ่าน') {
			color = 0xff8800
			statusIcon = '⏭️'
		} else if (r.status === 'OK') {
			color = 0x00c896
			statusIcon = '✅'
		} else {
			color = 0xff8800
			statusIcon = '⏭️'
		}

		const outcome = r.reason ?? '-'
		const analysis = r.aiAnalysis && r.aiAnalysis !== r.reason ? r.aiAnalysis : null

		const lines = [`${statusIcon} confident ${pct}`]
		if (outcome) lines.push(outcome)
		if (analysis) lines.push('', `🤔 ${formatReason(analysis)}`)

		return {
			title: `#${runCount} ${symbolEmoji} ${symbolName} — ${actionText}`,
			color,
			description: lines.join('\n'),
			timestamp: new Date().toISOString(),
			footer: { text: 'Forex Bot' },
		}
	})

	try {
		await axios.post(WEBHOOK_URL, { embeds })
		console.log('[Discord] ✅ ส่ง cycle summary สำเร็จ')
	} catch (err) {
		console.error('[Discord] ❌ ส่ง cycle summary ล้มเหลว:', err.response?.data ?? err.message)
	}
}

export { sendOrderNotification, sendErrorNotification, sendCycleSummary }
