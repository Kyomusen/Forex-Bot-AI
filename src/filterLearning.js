import fs from 'fs'

const KNOWLEDGE_FILE = './logs/filter_knowledge.json'

function load() {
	if (!fs.existsSync(KNOWLEDGE_FILE)) return { trades: [] }
	try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')) }
	catch { return { trades: [] } }
}

function save(data) {
	const dir = KNOWLEDGE_FILE.substring(0, KNOWLEDGE_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(data, null, 2))
}

export function recordTradeResult({ symbol, action, setup, entryIndicators, result, pnl, aiDecision, slPips, tpPips, exitReason }) {
	const data = load()
	const ind = entryIndicators || {}
	data.trades.push({
		symbol, action, setup,
		rsi: ind.rsi,
		macdHistogram: ind.macd?.histogram,
		macdHistogramTrend: ind.macd?.histogramTrend,
		emaTrend: ind.emaTrend,
		priceVsEma20: ind.currentPrice != null && ind.ema20 != null
			? (ind.currentPrice > ind.ema20 ? 'above' : 'below') : 'unknown',
		atr: ind.atr,
		slPips: slPips ?? null,
		tpPips: tpPips ?? null,
		exitReason: exitReason ?? (result === 'WIN' ? 'TP' : result === 'LOSS' ? 'SL' : null),
		result, pnl,
		aiDecision: aiDecision || 'NONE',
		closedAt: new Date().toISOString(),
	})
	if (data.trades.length > 500) data.trades.splice(0, data.trades.length - 500)
	save(data)
}

export function querySimilarTrades({ symbol, setup, rsi, macdHistogramTrend }) {
	const data = load()
	if (data.trades.length < 3) return null

	const sameSetup = data.trades.filter(t =>
		t.symbol === symbol && t.setup === setup && t.result && t.result !== 'UNKNOWN'
	)
	if (sameSetup.length < 3) return null

	// Try tighter RSI match first (±2), fallback to ±5, then all same setup
	const tightRsi = sameSetup.filter(t =>
		t.rsi != null && Math.abs(t.rsi - rsi) <= 2
	)
	if (tightRsi.length >= 3) {
		const wins = tightRsi.filter(t => t.result === 'WIN').length
		return { total: tightRsi.length, wins, losses: tightRsi.length - wins, winRate: parseFloat((wins / tightRsi.length).toFixed(2)), matchType: 'tight' }
	}

	const byRsi = sameSetup.filter(t =>
		t.rsi != null && Math.abs(t.rsi - rsi) <= 5
	)

	const pool = byRsi.length >= 3 ? byRsi : sameSetup

	const total = pool.length
	const wins = pool.filter(t => t.result === 'WIN').length
	const losses = pool.filter(t => t.result === 'LOSS').length
	const winRate = total > 0 ? (wins / total) : 0

	return { total, wins, losses, winRate: parseFloat(winRate.toFixed(2)), matchType: pool === sameSetup ? 'broad' : 'medium' }
}
