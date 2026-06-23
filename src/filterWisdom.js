import fs from 'fs'

const WISDOM_FILE = './logs/filter_wisdom.md'
const KNOWLEDGE_FILE = './logs/filter_knowledge.json'

function loadTrades() {
	if (!fs.existsSync(KNOWLEDGE_FILE)) return []
	try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'))?.trades ?? [] }
	catch { return [] }
}

function generateWisdom() {
	const trades = loadTrades().filter(t => t.result === 'WIN' || t.result === 'LOSS')
	if (trades.length < 5) return `# AI Filter Wisdom\n\nยังไม่มีข้อมูลเพียงพอ (ต้องการอย่างน้อย 5 เทรด มี ${trades.length})`

	const groups = {}
	for (const t of trades) {
		const key = `${t.symbol}:${t.setup}`
		if (!groups[key]) groups[key] = []
		groups[key].push(t)
	}

	let md = `# AI Filter Wisdom\nอัปเดตล่าสุด: ${new Date().toISOString().slice(0, 10)}\n\n`
	md += `วิเคราะห์จาก **${trades.length}** เทรดที่ปิดแล้ว\n\n`

	for (const [key, gt] of Object.entries(groups).sort()) {
		if (gt.length < 3) continue
		const total = gt.length
		const wins = gt.filter(t => t.result === 'WIN').length
		const losses = gt.filter(t => t.result === 'LOSS').length
		const wr = (wins / total * 100).toFixed(1)

		md += `## ${key}\n`
		md += `${total} เทรด | ${wins}W/${losses}L | WR ${wr}%\n\n`

		const buckets = {}
		for (const t of gt) {
			if (t.rsi == null) continue
			const b = Math.floor(t.rsi / 5) * 5
			const label = `${b}-${b + 4}`
			if (!buckets[label]) buckets[label] = []
			buckets[label].push(t)
		}

		for (const [range, bt] of Object.entries(buckets).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
			if (bt.length < 2) continue
			const bw = bt.filter(t => t.result === 'WIN').length
			const bl = bt.filter(t => t.result === 'LOSS').length
			const bwr = bw / bt.length
			const badge = bwr < 0.3 ? '🔴 SKIP' : bwr < 0.4 ? '🟡 CAUTION' : bwr < 0.5 ? '🟢 NORMAL' : '✅ GOOD'
			md += `- RSI ${range}: ${bt.length} เทรด | ${(bwr * 100).toFixed(0)}% WR — ${badge}\n`
		}

		const emaBuckets = {}
		for (const t of gt.filter(t => t.priceVsEma20)) {
			const key2 = t.priceVsEma20
			if (!emaBuckets[key2]) emaBuckets[key2] = []
			emaBuckets[key2].push(t)
		}
		if (Object.keys(emaBuckets).length > 0) {
			for (const [pos, bt] of Object.entries(emaBuckets)) {
				if (bt.length < 2) continue
				const bw = bt.filter(t => t.result === 'WIN').length
				const bl = bt.filter(t => t.result === 'LOSS').length
				const bwr = bw / bt.length
				md += `- Price ${pos} EMA20: ${bt.length} เทรด | ${(bwr * 100).toFixed(0)}% WR\n`
			}
		}
		md += '\n'
	}

	return md
}

function saveWisdom() {
	const md = generateWisdom()
	const dir = WISDOM_FILE.substring(0, WISDOM_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(WISDOM_FILE, md)
	console.log(`[Wisdom] 💡 บันทึก AI wisdom แล้ว (${md.split('\n').length} บรรทัด)`)
	return md
}

function loadWisdom() {
	if (!fs.existsSync(WISDOM_FILE)) return null
	return fs.readFileSync(WISDOM_FILE, 'utf-8')
}

function getWisdomForPrompt(symbol, setup) {
	const wisdom = loadWisdom()
	if (!wisdom) return null

	const target = `## ${symbol}:${setup}`
	const lines = wisdom.split('\n')
	const relevant = []
	let inSection = false

	for (const line of lines) {
		if (line.startsWith('## ')) {
			inSection = line.trim() === target
			continue
		}
		if (inSection) {
			if (line.startsWith('## ')) break
			if (line.trim()) relevant.push(line)
		}
	}

	return relevant.length > 0 ? relevant.join('\n').trim() : null
}

export { generateWisdom, saveWisdom, loadWisdom, getWisdomForPrompt }
