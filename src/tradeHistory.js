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

function addTrade(trade) {
	const history = loadHistory()
	history.push({
		...trade,
		timestamp: new Date().toISOString(),
	})
	const trimmed = history.slice(-MAX_HISTORY)
	saveHistory(trimmed)
}

function getHistorySummary() {
	const history = loadHistory()
	if (history.length === 0) return null

	const closed = history.filter(t => t.result !== undefined)
	const wins = closed.filter(t => t.result === 'WIN')
	const losses = closed.filter(t => t.result === 'LOSS')
	const winrate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : 'N/A'

	const recentTrades = history.slice(-10).map(t =>
		`${t.action} → ${t.result ?? 'OPEN'} (${t.reason ?? ''})`
	)

	return {
		total: closed.length,
		wins: wins.length,
		losses: losses.length,
		winrate,
		recentTrades,
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

export { addTrade, getHistorySummary, updateTradeResult }
