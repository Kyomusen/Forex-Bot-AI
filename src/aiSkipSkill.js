import fs from 'fs'

const SKILL_FILE = './logs/ai_skip_skill.json'

function load() {
	if (!fs.existsSync(SKILL_FILE)) return { predictions: [] }
	try { return JSON.parse(fs.readFileSync(SKILL_FILE, 'utf-8')) }
	catch { return { predictions: [] } }
}

function save(data) {
	const dir = SKILL_FILE.substring(0, SKILL_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(SKILL_FILE, JSON.stringify(data, null, 2))
}

export function recordPrediction({ symbol, action, setup, rsi, emaTrend, h4Trend, srAtrRatio, aiDecision, aiConfidence, actualResult, pnl, entryPrice }) {
	const data = load()
	data.predictions.push({
		symbol, action, setup,
		entryPrice: entryPrice ?? null,
		rsi: rsi ?? null,
		emaTrend: emaTrend ?? null,
		h4Trend: h4Trend ?? null,
		srAtrRatio: srAtrRatio ?? null,
		aiDecision,
		aiConfidence: aiConfidence ?? null,
		actualResult: actualResult ?? null,
		pnl: pnl ?? null,
		timestamp: new Date().toISOString(),
	})
	if (data.predictions.length > 5_000) {
		data.predictions.splice(0, data.predictions.length - 5_000)
	}
	save(data)
}

export function updateResult({ symbol, action, setup, entryPrice, actualResult, pnl }) {
	const data = load()
	for (let i = data.predictions.length - 1; i >= 0; i--) {
		const p = data.predictions[i]
		if (p.symbol === symbol && p.action === action && p.setup === setup && p.pnl == null && p.actualResult == null) {
			if (entryPrice != null && p.entryPrice != null && Math.abs(p.entryPrice - entryPrice) > 0.0001) continue
			p.actualResult = actualResult
			p.pnl = pnl ?? null
			break
		}
	}
	save(data)
}

export function querySimilar(rsi, emaTrend, h4Trend, threshold = 3) {
	const data = load()
	if (data.predictions.length < 3) return null

	const completed = data.predictions.filter(p => p.actualResult != null)
	if (completed.length < 3) return null

	const similar = completed.filter(p => {
		let score = 0
		if (p.rsi != null && rsi != null && Math.abs(p.rsi - rsi) <= 3) score++
		if (p.emaTrend && emaTrend && p.emaTrend === emaTrend) score++
		if (p.h4Trend && h4Trend && p.h4Trend === h4Trend) score++
		return score >= threshold
	})

	if (similar.length < 3) {
		const broader = completed.filter(p => {
			if (p.rsi != null && rsi != null && Math.abs(p.rsi - rsi) <= 5) return true
			if (p.emaTrend && emaTrend && p.emaTrend === emaTrend) return true
			return false
		})
		if (broader.length >= 3) return summarizeGroup(broader)
		return null
	}

	return summarizeGroup(similar)
}

function summarizeGroup(group) {
	const aiSkipped = group.filter(p => p.aiDecision === 'SKIP')
	const aiProceed = group.filter(p => p.aiDecision === 'PROCEED')
	const skipLosses = aiSkipped.filter(p => p.actualResult === 'LOSS').length
	const skipWins = aiSkipped.filter(p => p.actualResult === 'WIN').length
	const proceedWins = aiProceed.filter(p => p.actualResult === 'WIN').length
	const proceedLosses = aiProceed.filter(p => p.actualResult === 'LOSS').length

	return {
		total: group.length,
		aiSkipped: aiSkipped.length,
		aiProceed: aiProceed.length,
		skipAccuracy: aiSkipped.length > 0 ? skipLosses / aiSkipped.length : null,
		proceedAccuracy: aiProceed.length > 0 ? proceedWins / aiProceed.length : null,
		overallAccuracy: group.filter(p =>
			(p.aiDecision === 'SKIP' && p.actualResult === 'LOSS') ||
			(p.aiDecision === 'PROCEED' && p.actualResult === 'WIN')
		).length / group.length,
	}
}

export function getSkillSummary() {
	const data = load()
	if (data.predictions.length === 0) return null

	const completed = data.predictions.filter(p => p.actualResult != null)
	if (completed.length === 0) return null

	const correct = completed.filter(p =>
		(p.aiDecision === 'SKIP' && p.actualResult === 'LOSS') ||
		(p.aiDecision === 'PROCEED' && p.actualResult === 'WIN')
	).length
	const skipped = completed.filter(p => p.aiDecision === 'SKIP')
	const correctSkips = skipped.filter(p => p.actualResult === 'LOSS').length
	const falseSkips = skipped.filter(p => p.actualResult === 'WIN').length
	const skippedLossPnl = skipped.filter(p => p.actualResult === 'LOSS').reduce((s, p) => s + Math.abs(p.pnl || 0), 0)
	const skippedWinPnl = skipped.filter(p => p.actualResult === 'WIN').reduce((s, p) => s + (p.pnl || 0), 0)

	return {
		total: completed.length,
		accuracy: (correct / completed.length * 100).toFixed(1),
		skipPrecision: skipped.length > 0 ? (correctSkips / skipped.length * 100).toFixed(1) : 'N/A',
		skippedCount: skipped.length,
		correctSkips,
		falseSkips,
		skippedLossPnl: skippedLossPnl.toFixed(2),
		skippedWinPnl: skippedWinPnl.toFixed(2),
		netBenefit: (skippedLossPnl - skippedWinPnl).toFixed(2),
	}
}

export function clearSkill() {
	save({ predictions: [] })
}

export function getSkillPredictions() {
	return load().predictions
}
