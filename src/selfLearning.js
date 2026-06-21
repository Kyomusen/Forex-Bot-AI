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
		if (!trade.dealId || trade.result) continue
		if (!openDealIds.has(trade.dealId)) {
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

	const summary = {
		total,
		wins: wins.length,
		losses: losses.length,
		winrate,
	}

	const patterns = []

	function addPattern(label, group, totalGroup, type) {
		if (group.length + totalGroup.length < 2) return
		const rate = group.length / (group.length + totalGroup.length)
		const threshold = type === 'good' ? 0.6 : 0.4
		if (rate >= threshold || rate <= 1 - threshold) {
			patterns.push({
				label,
				winRate: parseFloat((rate * 100).toFixed(0)),
				wins: group.length,
				losses: totalGroup.length,
				type: rate >= 0.6 ? 'positive' : 'negative',
			})
		}
	}

	const symbols = [...new Set(closed.map(t => t.symbol))]

	for (const sym of symbols) {
		const symClosed = closed.filter(t => t.symbol === sym)
		const symWins = symClosed.filter(t => t.result === 'WIN')
		const symLosses = symClosed.filter(t => t.result === 'LOSS')
		const symRate = symWins.length / symClosed.length
		patterns.push({
			label: `${sym} overall`,
			winRate: parseFloat((symRate * 100).toFixed(0)),
			wins: symWins.length,
			losses: symLosses.length,
			type: symRate >= 0.6 ? 'positive' : symRate <= 0.4 ? 'negative' : 'neutral',
		})

		const symActions = [...new Set(symClosed.map(t => t.action))]
		for (const act of symActions) {
			const actTrades = symClosed.filter(t => t.action === act)
			const actWins = actTrades.filter(t => t.result === 'WIN')
			addPattern(`${sym} ${act}`, actWins, actTrades.filter(t => t.result === 'LOSS'), 'good')
		}
	}

	const emaPatterns = [...new Set(closed.map(t => t.indicators?.emaTrend).filter(Boolean))]
	for (const trend of emaPatterns) {
		const trendTrades = closed.filter(t => t.indicators?.emaTrend === trend)
		const trendWins = trendTrades.filter(t => t.result === 'WIN')
		addPattern(`EMA ${trend}`, trendWins, trendTrades.filter(t => t.result === 'LOSS'), 'good')
	}

	for (const rsiThreshold of [70, 30]) {
		const isHigh = rsiThreshold === 70
		const rsiTrades = closed.filter(t => t.indicators?.rsi !== undefined &&
			(isHigh ? t.indicators.rsi > rsiThreshold : t.indicators.rsi < rsiThreshold))
		if (rsiTrades.length >= 2) {
			const rsiWins = rsiTrades.filter(t => t.result === 'WIN')
			addPattern(`RSI ${isHigh ? '>' : '<'} ${rsiThreshold}`, rsiWins, rsiTrades.filter(t => t.result === 'LOSS'), 'good')
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
	lines.push(`| รายการ | จำนวน |`)
	lines.push(`|--------|------:|`)
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
	if (positive.length > 0) {
		for (const p of positive.slice(0, 5)) {
			if (p.winRate >= 70) {
				lines.push(`- ✅ **${p.label}**: มีแนวโน้มชนะสูง (${p.winRate}%) — ควรให้ความสำคัญ`)
			}
		}
	}
	if (negative.length > 0) {
		for (const p of negative.slice(0, 5)) {
			if (p.winRate <= 30) {
				lines.push(`- ❌ **${p.label}**: มีแนวโน้มแพ้สูง (${100 - p.winRate}%) — ควรหลีกเลี่ยง`)
			}
		}
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
