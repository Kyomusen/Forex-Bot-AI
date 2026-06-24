import fs from 'fs'

const KNOWLEDGE_FILE = './logs/filter_knowledge.json'
const LOGIC_RULES_FILE = './logs/logic_learned_rules.json'

function loadTrades() {
	if (!fs.existsSync(KNOWLEDGE_FILE)) return []
	try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'))?.trades ?? [] }
	catch { return [] }
}

function loadRules() {
	if (!fs.existsSync(LOGIC_RULES_FILE)) return {}
	try { return JSON.parse(fs.readFileSync(LOGIC_RULES_FILE, 'utf-8')) }
	catch { return {} }
}

function saveRules(rules) {
	const dir = LOGIC_RULES_FILE.substring(0, LOGIC_RULES_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(LOGIC_RULES_FILE, JSON.stringify(rules, null, 2))
}

function analyzeTradePatterns() {
	const allTrades = loadTrades()
	const closed = allTrades.filter(t => t.result === 'WIN' || t.result === 'LOSS')
	if (closed.length < 10) {
		console.log(`[Logic] Not enough data (${closed.length}/10) — skip`)
		return null
	}

	const bySymbol = {}
	for (const t of closed) {
		if (!bySymbol[t.symbol]) bySymbol[t.symbol] = []
		bySymbol[t.symbol].push(t)
	}

	const rules = {}
	let changed = false

	for (const [symbol, trades] of Object.entries(bySymbol)) {
		if (trades.length < 10) continue
		const sym = {}

		const bySetup = {}
		for (const t of trades) {
			const setup = t.setup || 'rules'
			if (!bySetup[setup]) bySetup[setup] = []
			bySetup[setup].push(t)
		}

		sym.rsiRanges = {}
		for (const [setup, setupTrades] of Object.entries(bySetup)) {
			const withRsi = setupTrades.filter(t => t.rsi != null)
			if (withRsi.length < 10) continue

			const buckets = {}
			for (const t of withRsi) {
				const rsi = Math.round(t.rsi)
				const key = Math.floor(rsi / 3) * 3
				const label = `${key}-${key + 2}`
				if (!buckets[label]) buckets[label] = { trades: 0, wins: 0, losses: 0 }
				buckets[label].trades++
				if (t.result === 'WIN') buckets[label].wins++
				else if (t.result === 'LOSS') buckets[label].losses++
			}

			const bucketList = Object.entries(buckets)
				.filter(([_, d]) => d.trades >= 10)
				.map(([range, d]) => ({
					range,
					min: parseInt(range.split('-')[0]),
					max: parseInt(range.split('-')[1]),
					trades: d.trades,
					wins: d.wins,
					losses: d.losses,
					wr: parseFloat((d.wins / d.trades).toFixed(2)),
				}))
				.sort((a, b) => b.wr - a.wr)

			if (bucketList.length > 0) {
				const best = bucketList[0]
				sym.rsiRanges[setup] = {
					bestMin: best.min,
					bestMax: best.max,
					bestWr: best.wr,
					buckets: bucketList,
				}
			}
		}

		const withExit = trades.filter(t => t.exitReason && t.slPips && t.tpPips)
		if (withExit.length >= 10) {
			const hitSL = withExit.filter(t => t.exitReason === 'SL')
			const slRate = hitSL.length / withExit.length
			const slM = slRate > 0.65 ? 1.3 : slRate < 0.35 ? 0.7 : 1.0
			const tpM = slM === 1.3 ? 0.7 : slM === 0.7 ? 1.3 : 0.9
			sym.slTpOptimal = {
				slMultiplier: slM,
				tpMultiplier: tpM,
				slHitRate: parseFloat((slRate * 100).toFixed(0)),
				evalTrades: withExit.length,
			}
		}

		const wr = trades.filter(t => t.result === 'WIN').length / trades.length
		if (trades.length >= 20) {
			let adj = 0.6
			if (wr >= 0.50) adj = Math.max(0.5, 0.6 - (wr - 0.50) * 0.5)
			else if (wr < 0.35) adj = Math.min(0.7, 0.6 + (0.35 - wr) * 0.5)
			sym.confidenceThreshold = {
				default: 0.6,
				adjusted: parseFloat(adj.toFixed(2)),
				evalTrades: trades.length,
				wr: parseFloat((wr * 100).toFixed(1)),
			}
		}

		if (trades.length >= 20) {
			let risk = 3.0
			if (wr >= 0.50) risk = Math.min(5.0, 3.0 + (wr - 0.50) * 10)
			else if (wr < 0.35) risk = Math.max(1.0, 3.0 - (0.35 - wr) * 10)
			sym.positionSizing = {
				default: 3.0,
				adjusted: parseFloat(risk.toFixed(1)),
				evalTrades: trades.length,
				wr: parseFloat((wr * 100).toFixed(1)),
			}
		}

		const skipConditions = []
		for (const [setup, rsiData] of Object.entries(sym.rsiRanges || {})) {
			for (const b of rsiData.buckets || []) {
				if (b.wr < 0.30 && b.trades >= 10) {
					skipConditions.push({
						type: 'rsi_range',
						setup,
						minRsi: b.min,
						maxRsi: b.max,
						wr: b.wr,
						trades: b.trades,
						reason: `RSI ${b.range} (${setup}) WR ${(b.wr * 100).toFixed(0)}% (${b.trades} trades)`,
					})
				}
			}
		}
		if (skipConditions.length > 0) sym.skipConditions = skipConditions

		// Overnight hold analysis
		const overnightTrades = trades.filter(t => t.heldOvernight === true)
		if (overnightTrades.length >= 5) {
			const overnightWins = overnightTrades.filter(t => t.result === 'WIN')
			const overnightWr = overnightWins.length / overnightTrades.length
			const dayTrades = trades.filter(t => t.heldOvernight !== true)
			const dayWins = dayTrades.filter(t => t.result === 'WIN')
			const dayWr = dayTrades.length > 0 ? dayWins.length / dayTrades.length : 0

			sym.overnight = {
				overnightWr: parseFloat((overnightWr * 100).toFixed(1)),
				dayWr: parseFloat((dayWr * 100).toFixed(1)),
				overnightTrades: overnightTrades.length,
				dayTrades: dayTrades.length,
				recommendHold: overnightWr > dayWr ? true : false,
			}
		}

		sym.totalTrades = trades.length
		sym.lastUpdated = new Date().toISOString()
		rules[symbol] = sym
		changed = true
		console.log(`[Logic] ${symbol}: ${trades.length} trades, RSI buckets ${Object.keys(sym.rsiRanges || {}).length}, SL/TP adj ${sym.slTpOptimal?.slMultiplier ?? 1.0}x/${sym.slTpOptimal?.tpMultiplier ?? 1.0}x, conf ${sym.confidenceThreshold?.adjusted ?? 0.6}, risk ${sym.positionSizing?.adjusted ?? 3.0}%`)
	}

	if (changed) {
		saveRules(rules)
		console.log(`[Logic] Saved logic rules for ${Object.keys(rules).length} symbols`)
	}
	return rules
}

function matchesCondition(cond, signal) {
	if (cond.type === 'rsi_range') {
		if (cond.setup && cond.setup !== signal.setup) return false
		if (signal.rsi == null) return false
		return signal.rsi >= cond.minRsi && signal.rsi <= cond.maxRsi
	}
	return false
}

function queryLogicRules(symbol, signal) {
	const rules = loadRules()
	const sym = rules[symbol]
	if (!sym) return { action: 'PROCEED', confidenceOverride: null, rsiOverride: null, slMultiplier: 1.0, tpMultiplier: 1.0, reason: null }

	for (const cond of sym.skipConditions || []) {
		if (matchesCondition(cond, signal)) {
			return { action: 'SKIP', confidenceOverride: null, rsiOverride: null, slMultiplier: 1.0, tpMultiplier: 1.0, reason: cond.reason }
		}
	}

	const setup = signal.setup || 'rules'
	let rsiOverride = null
	if (sym.rsiRanges?.[setup]?.bestMin != null) {
		rsiOverride = { min: sym.rsiRanges[setup].bestMin, max: sym.rsiRanges[setup].bestMax }
	}

	let confidenceOverride = null
	if (sym.confidenceThreshold?.adjusted != null) {
		confidenceOverride = sym.confidenceThreshold.adjusted
	}

	const slM = sym.slTpOptimal?.slMultiplier ?? 1.0
	const tpM = sym.slTpOptimal?.tpMultiplier ?? 1.0

	return {
		action: 'PROCEED',
		rsiOverride,
		confidenceOverride,
		slMultiplier: slM,
		tpMultiplier: tpM,
		riskPercent: sym.positionSizing?.adjusted ?? null,
		reason: null,
	}
}

export { analyzeTradePatterns, queryLogicRules, loadRules }
