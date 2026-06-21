import fs from 'fs'
import path from 'path'

const HISTORY_FILE = path.resolve('./logs/trade_history.json')
const MAX_HISTORY = 50

function ensureDir() {
	const dir = path.dirname(HISTORY_FILE)
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadHistory() {
	ensureDir()
	if (!fs.existsSync(HISTORY_FILE)) return []
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'))
	} catch {
		return []
	}
}

function saveHistory(history) {
	ensureDir()
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

function addTrade({ dealId, symbol, action, confidence, trend_alignment, reason, entry, sl_pips, tp_pips, indicators }) {
	const history = loadHistory()
	history.push({
		dealId,
		symbol,
		action,
		confidence,
		trend_alignment,
		reason,
		entry,
		sl_pips,
		tp_pips,
		indicators,
		timestamp: new Date().toISOString(),
	})
	const trimmed = history.slice(-MAX_HISTORY)
	saveHistory(trimmed)
}

function getLearningHistory() {
	const history = loadHistory()
	if (history.length === 0) return null

	const closed = history.filter(t => t.result !== undefined)
	const wins = closed.filter(t => t.result === 'WIN')
	const losses = closed.filter(t => t.result === 'LOSS')
	const total = closed.length
	const winrate = total > 0 ? ((wins.length / total) * 100).toFixed(1) : 'N/A'

	const learningData = history.slice(-20).map(t => ({
		action: t.action,
		entry: t.entry,
		sl_pips: t.sl_pips,
		tp_pips: t.tp_pips,
		confidence: t.confidence,
		trend_alignment: t.trend_alignment,
		reason: t.reason,
		result: t.result ?? 'ยังไม่จบ',
		pipsPnL: t.pipsPnL ?? null,
		entry_indicator: t.indicators ? {
			rsi: t.indicators.rsi,
			ema_trend: t.indicators.emaTrend,
			macd_histogram_trend: t.indicators.macd?.histogramTrend,
			atr: t.indicators.atr,
		} : null,
	}))

	return {
		total,
		wins: wins.length,
		losses: losses.length,
		winrate,
		recent: learningData,
		lesson: buildLesson(closed),
	}
}

function buildLesson(closed) {
	if (closed.length < 3) return 'ข้อมูลยังน้อยเกินไปสำหรับการวิเคราะห์'

	const wins = closed.filter(t => t.result === 'WIN')
	const losses = closed.filter(t => t.result === 'LOSS')

	const winReasons = wins.map(t => t.reason).filter(Boolean)
	const lossReasons = losses.map(t => t.reason).filter(Boolean)

	return {
		winPatterns: winReasons,
		lossPatterns: lossReasons,
		winRateTrend: wins.length >= losses.length ? 'positive' : 'negative',
	}
}

function updateTradeResult(dealId, result, pipsPnL) {
	const history = loadHistory()
	const trade = history.find(t => t.dealId === dealId)
	if (trade) {
		trade.result = result
		trade.pipsPnL = pipsPnL
		saveHistory(history)
	}
}

export { addTrade, getLearningHistory, updateTradeResult, loadHistory, saveHistory }
