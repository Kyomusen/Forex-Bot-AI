import fs from 'fs'
import path from 'path'

const KNOWLEDGE_FILE = path.resolve('./logs/backtest_knowledge.json')

function load() {
	if (!fs.existsSync(KNOWLEDGE_FILE)) return { setups: {}, totalRuns: 0 }
	try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')) }
	catch { return { setups: {}, totalRuns: 0 } }
}

function save(knowledge) {
	const dir = path.dirname(KNOWLEDGE_FILE)
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2))
}

function recordTrades(trades) {
	const knowledge = load()
	knowledge.totalRuns = (knowledge.totalRuns || 0) + 1
	for (const t of trades) {
		if (!t.setup || t.result === 'UNKNOWN') continue
		const key = `${t.symbol}:${t.setup}`
		if (!knowledge.setups[key]) {
			knowledge.setups[key] = { symbol: t.symbol, setup: t.setup, trades: 0, wins: 0, totalPnl: 0 }
		}
		const s = knowledge.setups[key]
		s.trades++
		if (t.result === 'WIN') s.wins++
		s.totalPnl += t.pnl
	}
	save(knowledge)
}

function getWinRate(symbol, setup, minTrades = 3) {
	const knowledge = load()
	const key = `${symbol}:${setup}`
	const s = knowledge.setups[key]
	if (!s || s.trades < minTrades) return null
	return s.wins / s.trades
}

function shouldSkipSetup(symbol, setup) {
	const wr = getWinRate(symbol, setup)
	if (wr === null) return false
	const knowledge = load()
	const key = `${symbol}:${setup}`
	const s = knowledge.setups[key]
	if (s && s.trades >= 5 && s.totalPnl <= 0) return true
	if (s && s.trades >= 10 && wr < 0.42) return true
	return wr < 0.20
}

function printSummary() {
	const knowledge = load()
	const entries = Object.entries(knowledge.setups)
	if (entries.length === 0) { console.log('[Learning] ยังไม่มีข้อมูล'); return }
	console.log(`\n${'='.repeat(60)}`)
	console.log('🧠 Knowledge Summary')
	console.log(`${'='.repeat(60)}`)
	const pad = (s, w) => s.padEnd(w)
	const padr = (s, w) => s.padStart(w)
	console.log(`${pad('Key',22)} ${padr('เทรด',6)} ${padr('WIN',5)} ${padr('WR',7)} ${padr('PnL',10)}`)
	console.log('-'.repeat(60))
	for (const [key, s] of entries.sort((a, b) => b.trades - a.trades)) {
		const wr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(1) : 'N/A'
		console.log(`${key.padEnd(22)} ${String(s.trades).padStart(6)} ${String(s.wins).padStart(5)} ${String(wr).padStart(6)}% ${(s.totalPnl >= 0 ? '+' : '') + s.totalPnl.toFixed(2).padStart(8)}`)
	}
	console.log(`${'='.repeat(60)}`)
}

export { load as loadKnowledge, save as saveKnowledge, recordTrades, getWinRate, shouldSkipSetup, printSummary }
