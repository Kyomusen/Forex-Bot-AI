import dotenv from 'dotenv'
import fs from 'fs'
import { getGeminiModel } from './geminiClient.js'
dotenv.config()

const model = getGeminiModel()

const KNOWLEDGE_FILE = './logs/filter_knowledge.json'
const AI_LEARN_FILE = './logs/ai_learned_rules.json'

const _callTimestamps = []
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW = 60000

async function waitForSlot() {
	const now = Date.now()
	const cutoff = now - RATE_LIMIT_WINDOW
	while (_callTimestamps.length > 0 && _callTimestamps[0] < cutoff) {
		_callTimestamps.shift()
	}
	if (_callTimestamps.length >= RATE_LIMIT_MAX) {
		const oldest = _callTimestamps[0]
		const waitMs = RATE_LIMIT_WINDOW - (now - oldest) + 2000
		console.log(`[AI Learn] Rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s`)
		await new Promise(r => setTimeout(r, Math.min(waitMs, 20000)))
	}
	_callTimestamps.push(Date.now())
}

async function waitWithCooldown() {
	await new Promise(r => setTimeout(r, 1000))
	await waitForSlot()
}

function loadTrades() {
	if (!fs.existsSync(KNOWLEDGE_FILE)) return []
	try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'))?.trades ?? [] }
	catch { return [] }
}

function loadLearnedRules() {
	if (!fs.existsSync(AI_LEARN_FILE)) return {}
	try { return JSON.parse(fs.readFileSync(AI_LEARN_FILE, 'utf-8')) }
	catch { return {} }
}

function saveLearnedRules(rules) {
	const dir = AI_LEARN_FILE.substring(0, AI_LEARN_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(AI_LEARN_FILE, JSON.stringify(rules, null, 2))
}

export async function aiLearnFromTrades() {
	const allTrades = loadTrades()
	const closed = allTrades.filter(t => t.result === 'WIN' || t.result === 'LOSS')
	if (closed.length < 5) {
		console.log(`[AI Learn] Not enough data (${closed.length}/5) — skip`)
		return null
	}

	const bySymbol = {}
	for (const t of closed) {
		if (!bySymbol[t.symbol]) bySymbol[t.symbol] = []
		bySymbol[t.symbol].push(t)
	}

	const existing = loadLearnedRules()
	let changed = false

	// Self-correction: analyze AI mistakes
	const selfCorrect = (symbol, trades) => {
		const aiDecisions = trades.filter(t => t.aiDecision && t.aiDecision !== 'NONE')
		if (aiDecisions.length < 3) return null

		const falseProceed = aiDecisions.filter(t => t.aiDecision === 'PROCEED' && t.result === 'LOSS')
		const falseSkip = aiDecisions.filter(t => t.aiDecision === 'SKIP' && t.result === 'WIN')
		const correctProceed = aiDecisions.filter(t => t.aiDecision === 'PROCEED' && t.result === 'WIN')
		const correctSkip = aiDecisions.filter(t => t.aiDecision === 'SKIP' && t.result === 'LOSS')

		return {
			total: aiDecisions.length,
			falseProceed: falseProceed.length,
			falseSkip: falseSkip.length,
			correctRate: ((correctProceed.length + correctSkip.length) / aiDecisions.length * 100).toFixed(1),
			falseSamples: [...falseProceed.slice(0, 3), ...falseSkip.slice(0, 3)].map(t =>
				`${t.aiDecision}→${t.result} RSI:${t.rsi} MACD:${t.macdHistogramTrend} PnL:${(t.pnl||0).toFixed(2)}`
			),
		}
	}

	for (const [symbol, trades] of Object.entries(bySymbol)) {
		if (trades.length < 5) continue

		const wins = trades.filter(t => t.result === 'WIN')
		const losses = trades.filter(t => t.result === 'LOSS')
		const wr = (wins.length / trades.length * 100).toFixed(1)

		const correction = selfCorrect(symbol, trades)

		const sampleSize = Math.min(trades.length, 30)
		const shuffled = [...trades].sort(() => Math.random() - 0.5).slice(0, sampleSize)

		const tradeSummary = shuffled.map((t, i) =>
			`${i + 1}. ${t.action} ${t.symbol} ${t.setup || 'rules'} | RSI:${t.rsi ?? '?'} | MACD:${t.macdHistogramTrend ?? '?'} | EMA Trend:${t.emaTrend ?? '?'} | Price ${t.priceVsEma20 ?? '?'} EMA20 | AI:${t.aiDecision || 'NONE'} | Result: ${t.result} (${t.pnl >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(2)})`
		).join('\n')

		let correctionSection = ''
		if (correction && correction.total >= 3) {
			correctionSection = `\n\n=== SELF-CORRECTION ANALYSIS ===\nAI made ${correction.total} decisions on ${symbol}.\nCorrect rate: ${correction.correctRate}%\nAI Proceeded and LOST: ${correction.falseProceed} times\nAI Skipped and WOULD HAVE WON: ${correction.falseSkip} times\n\nExamples of AI mistakes:\n${correction.falseSamples.map(s => `- ${s}`).join('\n')}\n\nBased on these mistakes, suggest UPDATED rules that would have prevented them.`
		}

		const prompt = `You are a Forex trading analyst reviewing past trades.

Below are ${sampleSize} sample trades out of ${trades.length} total closed trades for ${symbol}.
Win Rate: ${wr}% (${wins.length}W / ${losses.length}L)

${tradeSummary}${correctionSection}

Analyze these trades and identify:
1. What specific conditions (RSI range, MACD trend, EMA position) led to LOSSES?
2. What specific conditions led to WINS?
3. Give 3-5 specific SKIP rules for future ${symbol} ${trades[0]?.setup || 'rules'} signals. These are conditions where the signal historically loses.
4. Give 1-2 specific PROCEED rules (conditions that historically win).
${correction ? '\n5. Based on AI mistakes above, give 1-2 CORRECTED rules that fix past errors.' : ''}

Rules must be specific and actionable (e.g. "SKIP when RSI is 30-34 AND MACD histogram is negative", not generic advice).

Respond ONLY valid JSON (no markdown):
{
  "symbol": "${symbol}",
  "totalTrades": ${trades.length},
  "winRate": ${wr},
  "skipRules": ["rule 1", "rule 2", ...],
  "proceedRules": ["rule 1", ...],
  "corrections": ["corrected rule 1", ...],
  "summary": "brief one-line summary of key insight"
}`

		try {
			await waitWithCooldown()
			const result = await model.generateContent(prompt)
			const text = result.response.text()
			const cleaned = text.replace(/```json|```/g, '').trim()
			const parsed = JSON.parse(cleaned)

			if (parsed && parsed.skipRules && Array.isArray(parsed.skipRules)) {
				existing[symbol] = {
					...parsed,
					learnedAt: new Date().toISOString(),
					tradesCount: trades.length,
				}
				changed = true
				console.log(`[AI Learn] ${symbol}: ${parsed.skipRules.length} skip rules, ${parsed.proceedRules?.length || 0} proceed rules (${trades.length} trades)`)
			}
		} catch (err) {
			console.warn(`[AI Learn] ${symbol} error: ${err.message?.slice(0, 60)}`)
		}
	}

	if (changed) {
		saveLearnedRules(existing)
		console.log(`[AI Learn] Saved ${Object.keys(existing).length} AI learned rules`)
	}
	return existing
}

export function getLearnedRulesForPrompt(symbol) {
	const rules = loadLearnedRules()
	const entry = rules[symbol]
	if (!entry || !entry.skipRules || entry.skipRules.length === 0) return null
	return entry
}

export { loadLearnedRules, saveLearnedRules }

if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(`[AI Learn] Standalone mode — loading ${loadTrades().length} trades...`)
	aiLearnFromTrades().then(result => {
		const count = result ? Object.keys(result).length : 0
		console.log(`[AI Learn] Done — ${count} symbols learned`)
		process.exit(0)
	}).catch(err => {
		console.error('[AI Learn] Fatal:', err.message)
		process.exit(1)
	})
}
