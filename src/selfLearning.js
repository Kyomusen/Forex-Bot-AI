import fs from 'fs'
import path from 'path'

const KNOWLEDGE_FILE = path.resolve('./logs/knowledge.md')

function ensureDir() {
	const dir = path.dirname(KNOWLEDGE_FILE)
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadKnowledge() {
	ensureDir()
	if (!fs.existsSync(KNOWLEDGE_FILE)) return null
	return fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')
}

function syncTradeResults(history, openDealIds) {
	let updated = false
	for (const trade of history) {
		if (!trade.dealId || trade.result === 'WIN' || trade.result === 'LOSS') continue
		if (!openDealIds.has(trade.dealId)) {
			// position ปิดแล้ว แต่ยังไม่รู้ผล — mark เป็น UNKNOWN
			// WIN/LOSS จะถูก set จาก updateTradeResult() เมื่อรู้ผลจาก history API
			trade.result = 'CLOSED'
			updated = true
		}
	}
	return updated
}

function extractPatterns(history) {
	const closed = history.filter(t => t.result === 'WIN' || t.result === 'LOSS')
	if (closed.length < 2) return { patterns: [], summary: null }

	const wins = closed.filter(t => t.result === 'WIN')
	const losses = closed.filter(t => t.result === 'LOSS')
	const total = closed.length
	const winrate = ((wins.length / total) * 100).toFixed(1)

	const summary = { total, wins: wins.length, losses: losses.length, winrate }
	const patterns = []

	function addPattern(label, groupWins, groupLosses) {
		const total = groupWins.length + groupLosses.length
		if (total < 2) return
		const rate = groupWins.length / total
		patterns.push({
			label,
			winRate: parseFloat((rate * 100).toFixed(0)),
			wins: groupWins.length,
			losses: groupLosses.length,
			type: rate >= 0.6 ? 'positive' : rate <= 0.4 ? 'negative' : 'neutral',
		})
	}

	const symbols = [...new Set(closed.map(t => t.symbol))]
	for (const sym of symbols) {
		const symClosed = closed.filter(t => t.symbol === sym)
		const symWins = symClosed.filter(t => t.result === 'WIN')
		const symLosses = symClosed.filter(t => t.result === 'LOSS')
		addPattern(`${sym} overall`, symWins, symLosses)

		for (const act of ['BUY', 'SELL']) {
			const actTrades = symClosed.filter(t => t.action === act)
			addPattern(`${sym} ${act}`, actTrades.filter(t => t.result === 'WIN'), actTrades.filter(t => t.result === 'LOSS'))
		}
	}

	for (const trend of ['bullish', 'bearish']) {
		const trendTrades = closed.filter(t => t.indicators?.emaTrend === trend)
		addPattern(`EMA ${trend}`, trendTrades.filter(t => t.result === 'WIN'), trendTrades.filter(t => t.result === 'LOSS'))
	}

	for (const [label, filterFn] of [
		['RSI > 70', t => t.indicators?.rsi > 70],
		['RSI < 30', t => t.indicators?.rsi < 30],
	]) {
		const group = closed.filter(filterFn)
		if (group.length >= 2) {
			addPattern(label, group.filter(t => t.result === 'WIN'), group.filter(t => t.result === 'LOSS'))
		}
	}

	return { patterns, summary }
}

function buildKnowledgeMd(history) {
	const { patterns, summary } = extractPatterns(history)
	if (!summary) return null

	const lines = []
	lines.push('# 🤖 Forex Bot Knowledge')
	lines.push('')
	lines.push(`> อัปเดตล่าสุด: ${new Date().toISOString()}`)
	lines.push('')
	lines.push('## 📊 สถิติรวม')
	lines.push('')
	lines.push('| รายการ | จำนวน |')
	lines.push('|--------|------:|')
	lines.push(`| เทรดทั้งหมด | ${summary.total} |`)
	lines.push(`| ชนะ (WIN) | ${summary.wins} |`)
	lines.push(`| แพ้ (LOSS) | ${summary.losses} |`)
	lines.push(`| Win Rate | **${summary.winrate}%** |`)
	lines.push('')

	const positive = patterns.filter(p => p.type === 'positive')
	const negative = patterns.filter(p => p.type === 'negative')

	if (positive.length > 0) {
		lines.push('## ✅ รูปแบบที่ได้ผลดี')
		lines.push('')
		lines.push('| Pattern | Win Rate | W/L |')
		lines.push('|---------|--------:|----:|')
		for (const p of positive) {
			lines.push(`| ${p.label} | **${p.winRate}%** | ${p.wins}W / ${p.losses}L |`)
		}
		lines.push('')
	}

	if (negative.length > 0) {
		lines.push('## ⚠️ รูปแบบที่ควรระวัง')
		lines.push('')
		lines.push('| Pattern | Win Rate | W/L |')
		lines.push('|---------|--------:|----:|')
		for (const p of negative) {
			lines.push(`| ${p.label} | **${p.winRate}%** | ${p.wins}W / ${p.losses}L |`)
		}
		lines.push('')
	}

	lines.push('## 📝 กฎที่สรุปได้')
	lines.push('')
	for (const p of positive.filter(p => p.winRate >= 70).slice(0, 5)) {
		lines.push(`- ✅ **${p.label}**: มีแนวโน้มชนะสูง (${p.winRate}%) — ควรให้ความสำคัญ`)
	}
	for (const p of negative.filter(p => p.winRate <= 30).slice(0, 5)) {
		lines.push(`- ❌ **${p.label}**: มีแนวโน้มแพ้สูง (${100 - p.winRate}%) — ควรหลีกเลี่ยง`)
	}
	if (positive.length === 0 && negative.length === 0) {
		lines.push('- ยังมีข้อมูลไม่พอสรุปกฎ ต้องเทรดเพิ่มอีก')
	}
	lines.push('')

	return lines.join('\n')
}

function updateKnowledge(history) {
	const md = buildKnowledgeMd(history)
	if (!md) return null
	ensureDir()
	fs.writeFileSync(KNOWLEDGE_FILE, md, 'utf-8')
	console.log('[Learn] ✅ อัปเดต knowledge.md แล้ว')
	return md
}

export { loadKnowledge, updateKnowledge, syncTradeResults }
