import dotenv from 'dotenv'
import fs from 'fs'
import { createSession, getCandles } from './capitalClient.js'
import { getIndicators, getMultiTFIndicators } from './indicators.js'
import { sendBacktestReport, sendBatchNotification } from './discordNotifier.js'
import { recordTrades, shouldSkipSetup, printSummary } from './backtestLearning.js'
import { waitForAISlot, recordAICall, getBatchSkipPrediction, clearPredictionCache } from './aiDecision.js'
import { recordPrediction as recordSkipPrediction, updateResult as updateSkipResult } from './aiSkipSkill.js'
import { recordTradeResult, querySimilarTrades } from './filterLearning.js'
import { saveWisdom, getWisdomForPrompt } from './filterWisdom.js'
import { aiLearnFromTrades, getLearnedRulesForPrompt, getSLTPAdjustment } from './aiLearn.js'
import { queryLogicRules, analyzeTradePatterns } from './logicLearning.js'
import { getGeminiModel } from './geminiClient.js'

dotenv.config()

const SYMBOLS = (process.env.BACKTEST_SYMBOLS ?? 'EURUSD,XAUUSD,GBPUSD,USDJPY,US30').split(',')
const TF = process.env.BACKTEST_TF ?? 'HOUR'
const CANDLE_COUNT = parseInt(process.env.BACKTEST_CANDLES ?? '720')
const BALANCE_PER_SYMBOL = parseFloat(process.env.BACKTEST_BALANCE ?? '500')
const USE_AI = process.env.BACKTEST_USE_AI === 'true'
const RISK_PERCENT = parseFloat(process.env.BACKTEST_RISK ?? '0.3')
const SL_PIPS_DEFAULT = parseInt(process.env.BACKTEST_SL_PIPS ?? '15')
const TP_PIPS_DEFAULT = parseInt(process.env.BACKTEST_TP_PIPS ?? '30')
const TREND_TF = TF === 'HOUR' ? 'HOUR_4' : 'DAY'
const CANDLE_OFFSET = parseInt(process.env.BACKTEST_OFFSET ?? '0')
const BACKTEST_TRAILING = process.env.BACKTEST_TRAILING === 'true'
const TRAILING_ACTIVATE = parseFloat(process.env.BACKTEST_TRAILING_ACTIVATE ?? '1.0')
const TRAILING_DISTANCE = parseFloat(process.env.BACKTEST_TRAILING_DISTANCE ?? '0.5')
const AI_SKIP_RATE = parseFloat(process.env.BACKTEST_AI_SKIP_RATE ?? '1.0')

const CACHE_FILE = './logs/candle_cache.json'

function loadCandleCache() {
	if (!fs.existsSync(CACHE_FILE)) return {}
	try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) }
	catch { return {} }
}

function saveCandleCache(cache) {
	const dir = CACHE_FILE.substring(0, CACHE_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
}

function pipToPrice(pips, symbol) {
	const s = symbol.toUpperCase()
	const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY']
	if (jpyPairs.some(p => s.includes(p.replace('/', '')))) return pips * 0.01
	if (s.includes('XAU') || s.includes('GOLD')) return pips * 0.01
	if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return pips * 1.0
	return pips * 0.0001
}

function pipValuePerLot(symbol) {
	const s = symbol.toUpperCase()
	if (s.includes('XAU') || s.includes('GOLD')) return 10
	if (s.includes('US30') || s.includes('WS30')) return 1
	if (s.includes('SPX') || s.includes('NAS')) return 1
	return 10
}

function calcSize(balance, slPips, symbol) {
	const riskBase = Math.min(balance, BALANCE_PER_SYMBOL * 3)
	const riskAmount = riskBase * (RISK_PERCENT / 100)
	const pvpl = pipValuePerLot(symbol)
	const lots = riskAmount / (slPips * pvpl)
	const minLot = symbol.includes('XAU') || symbol.includes('GOLD') ? 0.0001 : 0.01
	const size = Math.max(minLot, parseFloat(lots.toFixed(4)))
	const riskPct = (size * slPips * pvpl) / riskBase * 100
	if (riskPct > RISK_PERCENT * 3) return 0
	return size
}

function getPrice(c) { return c.closePrice?.bid ?? c.closePrice }
function getHigh(c) { return c.highPrice?.bid ?? c.highPrice }
function getLow(c) { return c.lowPrice?.bid ?? c.lowPrice }

const MAX_DD_PERCENT = parseFloat(process.env.BACKTEST_MAX_DD ?? '50')
const ddDisabled = {}

function isDDDisabled(sym, currentTotal, peakTotal) {
	if (ddDisabled[sym]) return true
	const dd = peakTotal > 0 ? ((peakTotal - currentTotal) / peakTotal) * 100 : 0
	if (dd > MAX_DD_PERCENT) {
		console.log(`[DD] ${sym} DD=${dd.toFixed(1)}% > ${MAX_DD_PERCENT}% — หยุดเทรด`)
		ddDisabled[sym] = true
		return true
	}
	return false
}

const SYMBOL_STRATEGY = {
	EURUSD: {
		allowedSetups: ['pullback_sell'],
		rsi: { pullback_sell: { min: 58, max: 78 } },
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.2, atrTpM: 3.0, minSl: 10, minTp: 22,
	},
	XAUUSD: {
		allowedSetups: ['trend_buy', 'trend_sell'],
		rsi: {
			trend_buy: { min: 30, max: 50 },
			trend_sell: { min: 50, max: 70 },
			momentum_sell: { min: 28, max: 48 },
			momentum_buy: { min: 48, max: 62 },
			pullback_sell: { min: 55, max: 75 },
			pullback_buy: { min: 30, max: 50 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.0,
		atrTpM: 5.0,
		minSl: 10,
		minTp: 25,
	},
	GBPUSD: {
		allowedSetups: ['momentum_sell'],
		rsi: { momentum_sell: { min: 28, max: 44 } },
		trendRequired: false, requireH1Trend: false, requireBelowEma50: false,
		atrSlM: 1.2, atrTpM: 3.0, minSl: 10, minTp: 22,
	},
	USDJPY: {
		allowedSetups: ['momentum_buy'],
		rsi: {
			momentum_buy: { min: 48, max: 60 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.2,
		atrTpM: 3.0,
		minSl: 10,
		minTp: 25,
	},
	US30: {
		allowedSetups: ['momentum_buy'],
		rsi: {
			momentum_buy: { min: 52, max: 62 },
		},
		trendRequired: false,
		requireH1Trend: false,
		requireBelowEma50: false,
		atrSlM: 1.2,
		atrTpM: 3.0,
		minSl: 20,
		minTp: 50,
	},
}

function atrParams(atr, symbol) {
	const cfg = SYMBOL_STRATEGY[symbol]
	const slM = parseFloat(process.env.BACKTEST_ATR_SL) || (cfg?.atrSlM ?? 2)
	const tpM = parseFloat(process.env.BACKTEST_ATR_TP) || (cfg?.atrTpM ?? 6)
	if (!atr || atr <= 0) return { slPips: cfg?.minSl ?? SL_PIPS_DEFAULT, tpPips: cfg?.minTp ?? TP_PIPS_DEFAULT }
	const pips = Math.round(atr / pipToPrice(1, symbol))
	return {
		slPips: Math.max(cfg?.minSl ?? 18, Math.round(pips * slM)),
		tpPips: Math.max(cfg?.minTp ?? 45, Math.round(pips * tpM)),
	}
}

function evaluate(params) {
	const { symbol, h4Trend, ind, knowledge } = params
	const { rsi, ema20, ema50, emaTrend: h1Trend, macd, atr, currentPrice, nearSupport, nearResistance } = ind
	if (rsi == null || !atr) return null

	const cfg = SYMBOL_STRATEGY[symbol]
	if (!cfg) return null

	const { slPips, tpPips } = atrParams(atr, symbol)
	const aboveEma50 = currentPrice && ema50 ? currentPrice > ema50 : false
	const belowEma50 = currentPrice && ema50 ? currentPrice < ema50 : false
	const aboveEma20 = currentPrice && ema20 ? currentPrice > ema20 : false
	const belowEma20 = currentPrice && ema20 ? currentPrice < ema20 : false
	const macdNegative = macd?.histogramTrend === 'negative'
	const macdPositive = macd?.histogramTrend === 'positive'
	const macdCrossoverBear = macd?.histogram < 0 && macd?.macd < macd?.signal
	const macdCrossoverBull = macd?.histogram > 0 && macd?.macd > macd?.signal

	const noMacdFilter = process.env.BACKTEST_NO_MACD_FILTER === 'true'
	const noRsiFilter = process.env.BACKTEST_NO_RSI_FILTER === 'true'
	const noEmaFilter = process.env.BACKTEST_NO_EMA_FILTER === 'true'

	const trendMode = process.env.BACKTEST_TREND_MODE || 'OR'
	const downtrend = cfg.trendRequired
		? h4Trend === 'bearish' && belowEma50 && h1Trend === 'bearish'
		: trendMode === 'AND'
			? (h4Trend === 'bearish' && belowEma50)
			: (h4Trend === 'bearish' || belowEma50)

	const uptrend = cfg.trendRequired
		? h4Trend === 'bullish' && aboveEma50 && h1Trend === 'bullish'
		: trendMode === 'AND'
			? (h4Trend === 'bullish' && aboveEma50)
			: (h4Trend === 'bullish' || aboveEma50)

	const activeSetups = process.env.BACKTEST_SETUPS
		? process.env.BACKTEST_SETUPS.split(',')
		: cfg.allowedSetups

	const candidates = []

	for (const setup of activeSetups) {
		const rsiRange = cfg.rsi[setup]
		if (!rsiRange) continue

		if (setup === 'trend_sell' && downtrend && (noMacdFilter || macdNegative) && nearResistance && (noEmaFilter || aboveEma20) && (noRsiFilter || (rsi >= rsiRange.min && rsi <= rsiRange.max))) {
			candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'trend_buy' && uptrend && (noMacdFilter || macdPositive) && nearSupport && (noEmaFilter || belowEma20) && (noRsiFilter || (rsi >= rsiRange.min && rsi <= rsiRange.max))) {
			candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
		}
		if (setup === 'momentum_sell' && downtrend && macdNegative) {
			let sellOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bearish') sellOk = false
			if (cfg.requireBelowEma50 && !belowEma50) sellOk = false
			if (sellOk) {
				candidates.push({ action: 'SELL', setup, confidence: 0.7, slPips, tpPips })
			}
		}
		if (setup === 'momentum_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) {
				candidates.push({ action: 'BUY', setup, confidence: 0.7, slPips, tpPips })
			}
		}
		if (setup === 'pullback_sell' && downtrend && macdNegative) {
			let sellOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && aboveEma20
			if (cfg.requireH1Trend && h1Trend !== 'bearish') sellOk = false
			if (cfg.requireBelowEma50 && !belowEma50) sellOk = false
			if (sellOk) {
				candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips, tpPips })
			}
		}
		if (setup === 'pullback_buy' && uptrend && macdPositive) {
			let buyOk = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && belowEma20
			if (cfg.requireH1Trend && h1Trend !== 'bullish') buyOk = false
			if (cfg.requireBelowEma50 && !aboveEma50) buyOk = false
			if (buyOk) {
				candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips, tpPips })
			}
		}
	}

	if (candidates.length === 0) return null

	candidates.sort((a, b) => b.confidence - a.confidence)
	if (knowledge) {
		for (const c of candidates) {
			if (!shouldSkipSetup(symbol, c.setup)) return c
		}
		return null
	}
	return candidates[0]
}

function checkPosition(pos, candles, startIdx, endIdx) {
	endIdx = Math.min(endIdx ?? candles.length, candles.length)
	for (let i = startIdx; i < endIdx; i++) {
		const c = candles[i]
		const high = getHigh(c)
		const low = getLow(c)
		const time = c.snapshotTime ?? c.snapshotTimeUTC ?? i
		if (pos.type === 'BUY') {
			if (low <= pos.sl) return { price: pos.sl, type: 'SL', at: time }
			if (high >= pos.tp) return { price: pos.tp, type: 'TP', at: time }
		} else {
			if (high >= pos.sl) return { price: pos.sl, type: 'SL', at: time }
			if (low <= pos.tp) return { price: pos.tp, type: 'TP', at: time }
		}
	}
	return null
}

async function loadCandles(symbol, tf, count, cache, label) {
	const key = `${symbol}:${tf}`
	if (cache[key] && cache[key].length >= count + CANDLE_OFFSET) {
		console.log(`[Cache] ${symbol} ${tf} (${label}): ใช้ cache ${cache[key].length} candles offset=${CANDLE_OFFSET}`)
		const off = CANDLE_OFFSET
		return cache[key].slice(-(count + off), off === 0 ? undefined : -off)
	}
	console.log(`[Fetch] ${symbol} ${tf} (${label}): กำลังโหลด ${count} candles...`)
	const raw = await getCandles(symbol, tf, count)
	if (raw && raw.length > 0) {
		cache[key] = raw
		saveCandleCache(cache)
	}
	return raw || []
}

function buildIndicatorSummary(candles, count = 200) {
	const slice = candles.slice(-count)
	const rows = []
	for (let i = 20; i < slice.length; i++) {
		const window = slice.slice(0, i + 1)
		const ind = getIndicators(window)
		const c = slice[i]
		const t = c.snapshotTime ?? c.snapshotTimeUTC ?? i
		rows.push(
			`${i},${t},P:${getPrice(c)?.toFixed(5)},` +
			`RSI:${ind.rsi?.toFixed(1) ?? '?'},` +
			`EMA:${ind.emaTrend},` +
			`MACD:${ind.macd?.histogram?.toFixed(4) ?? '?'},` +
			`ATR:${ind.atr?.toFixed(4) ?? '?'}`
		)
	}
	return rows.join('\n')
}

async function runAIBacktestFilter(activeSymbols, allData, minLen, h4IndCache, segStart = 60, segEnd = null) {
	const endIdx = segEnd ?? minLen
	console.log(`[AI] กำลังรวบรวมสัญญาณ Indicator ช่วง ${segStart}-${endIdx}...`)

	const aiFiltered = {}
	for (const sym of activeSymbols) aiFiltered[sym] = {}

	const ruleSignals = []

	for (let i = segStart; i < endIdx; i++) {
		for (const sym of activeSymbols) {
			const { h1 } = allData[sym]
			const window = h1.slice(0, i + 1)
			const ind = getIndicators(window)
			ind.currentPrice = getPrice(h1[i])
			if (!ind.rsi || !ind.atr) continue

			const h1Time = h1[i].snapshotTime ?? h1[i].snapshotTimeUTC ?? i
			const h4Cache = h4IndCache[sym]
			let h4Trend = 'neutral'
			if (h4Cache && h4Cache.length > 0) {
				const t = new Date(h1Time).getTime()
				let best = h4Cache[0]
				for (const entry of h4Cache) {
					if (new Date(entry.time).getTime() <= t) best = entry
				}
				h4Trend = best.emaTrend || 'neutral'
			}

			const decision = evaluate({ symbol: sym, h4Trend, ind, knowledge: false })
			if (decision) {
				ruleSignals.push({
					symbol: sym, candle: i,
					action: decision.action, setup: decision.setup,
					confidence: decision.confidence,
					rsi: ind.rsi, ema20: ind.ema20, ema50: ind.ema50,
					emaTrend: ind.emaTrend,
					macd: ind.macd, atr: ind.atr, currentPrice: ind.currentPrice,
				})
			}
		}
	}

	console.log(`[AI] Indicator สร้างสัญญาณ ${ruleSignals.length} รายการ — กำลังให้ AI filter...`)

	// Random signal sampling to save API calls
	const RANDOM_SIGNALS = parseInt(process.env.BACKTEST_RANDOM_SIGNALS ?? '0')
	if (RANDOM_SIGNALS > 0 && ruleSignals.length > RANDOM_SIGNALS * activeSymbols.length) {
		const bySymbol = {}
		for (const s of ruleSignals) {
			if (!bySymbol[s.symbol]) bySymbol[s.symbol] = []
			bySymbol[s.symbol].push(s)
		}
		const sampled = []
		let skipped = 0
		for (const sym of activeSymbols) {
			const symSignals = bySymbol[sym] || []
			if (symSignals.length <= RANDOM_SIGNALS) {
				sampled.push(...symSignals)
			} else {
				const shuffled = [...symSignals].sort(() => Math.random() - 0.5)
				sampled.push(...shuffled.slice(0, RANDOM_SIGNALS))
				skipped += symSignals.length - RANDOM_SIGNALS
			}
		}
		ruleSignals.length = 0
		ruleSignals.push(...sampled)
		console.log(`[AI] สุ่มตัวอย่าง ${sampled.length} สัญญาณ (ข้าม ${skipped} เพื่อประหยัด API)`)
	}

	const model = getGeminiModel()

	const BATCH_SIZE = 30
	let batchIdx = 0
	while (batchIdx < ruleSignals.length) {
		const gotSlot = await waitForAISlot()
		if (!gotSlot) {
			console.warn(`[AI] ⏰ rate limit timeout — สัญญาณที่เหลือทั้งหมด (${ruleSignals.length - batchIdx} signals) จะ PROCEED อัตโนมัติ`)
			for (let j = batchIdx; j < ruleSignals.length; j++) {
				const s = ruleSignals[j]
				aiFiltered[s.symbol][s.candle] = { action: 'PROCEED', holdOvernight: true, slMultiplier: 1.0, tpMultiplier: 1.0 }
			}
			break
		}

		const batch = ruleSignals.slice(batchIdx, batchIdx + BATCH_SIZE)

		// Pre-filter: auto-SKIP signals matching known losing patterns
		const filteredBatch = []
		let autoSkipped = 0
		for (const s of batch) {
			const patterns = querySimilarTrades({
				symbol: s.symbol, setup: s.setup,
				rsi: s.rsi ?? 50,
				macdHistogramTrend: s.macd?.histogramTrend ?? 'neutral',
			})
			if (patterns && patterns.winRate < 0.35 && patterns.total >= 3) {
				autoSkipped++
				continue
			}
			filteredBatch.push({ ...s, patterns })
		}

		if (autoSkipped > 0) {
			console.log(`[AI] Auto-skip ${autoSkipped} signals with known losing patterns`)
		}
		if (filteredBatch.length === 0) {
			batchIdx += BATCH_SIZE
			continue
		}

		// Build per-symbol learning context
		const learningBySymbol = {}
		for (const s of filteredBatch) {
			if (s.patterns) {
				const key = `${s.symbol}:${s.setup}`
				if (!learningBySymbol[key]) {
					learningBySymbol[key] = s.patterns
				}
			}
		}
		let learningContext = ''
		for (const [key, p] of Object.entries(learningBySymbol)) {
			const [sym, setup] = key.split(':')
			const riskLabel = p.winRate < 0.3 ? 'HIGH RISK' : p.winRate < 0.4 ? 'CAUTION' : 'NORMAL'
			learningContext += `\n- ${sym} ${setup}: ${p.total} past trades, WR ${(p.winRate * 100).toFixed(0)}% (${p.wins}W/${p.losses}L) — ${riskLabel}`
			const w = getWisdomForPrompt(sym, setup)
			if (w) learningContext += `\n  Wisdom: ${w}`
		}

		// Add AI-learned rules to context
		let aiRulesContext = ''
		for (const s of filteredBatch) {
			const rules = getLearnedRulesForPrompt(s.symbol)
			if (rules && rules.skipRules?.length > 0) {
				aiRulesContext += `\n[Ai Learned Rules for ${s.symbol}]\n` + rules.skipRules.map(r => `  SKIP: ${r}`).join('\n')
				if (rules.proceedRules?.length > 0) {
					aiRulesContext += '\n' + rules.proceedRules.map(r => `  PROCEED: ${r}`).join('\n')
				}
			}
		}

		const signalsText = filteredBatch.map(s =>
			`[${s.symbol} C${s.candle}] ${s.action} | ${s.setup} | RSI:${s.rsi?.toFixed(1)} | MACD:${s.macd?.histogram?.toFixed(4)} (${s.macd?.histogramTrend}) | Price${s.currentPrice > s.ema20 ? '>EMA20' : '<EMA20'} | Trend:${s.emaTrend}`
		).join('\n')

		const prompt = `You are a FOREX signal filter. The indicator detected signals below.
Default to PROCEED. SKIP only when the LEARNING section clearly shows <30% win rate with 5+ trades for that signal's pattern.
Be decisive: skip bad patterns, but default to proceed when unsure or data is limited.
${learningContext}
${aiRulesContext}
Signals:
${signalsText}

Also decide if each signal should be held overnight (past market close). Set holdOvernight=false when the signal is weak, near market close, or past similar trades held overnight performed poorly.

Respond ONLY valid JSON array (no markdown):
[{"candle":0,"symbol":"EURUSD","action":"PROCEED","confidence":0.9,"holdOvernight":true,"reason":"..."}]`

		let retry429 = 0
		let batchSuccess = false
		while (!batchSuccess && retry429 < 3) {
			try {
				const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
				recordAICall()
				const text = result.response.text()
				const cleaned = text.replace(/```json|```/g, '').trim()
				const decisions = JSON.parse(cleaned)

				if (Array.isArray(decisions)) {
					for (const d of decisions) {
						const candleIdx = parseInt(String(d.candle).replace(/^C/, ''), 10)
						if (!isNaN(candleIdx) && d?.symbol && aiFiltered[d.symbol]) {
							if (d.action === 'PROCEED') {
								aiFiltered[d.symbol][candleIdx] = { action: 'PROCEED', holdOvernight: d.holdOvernight !== false, slMultiplier: 1.0, tpMultiplier: 1.0 }
							}
						}
					}
					const proceed = decisions.filter(d => d?.action === 'PROCEED').length
					console.log(`[AI] Batch ${Math.ceil((batchIdx + BATCH_SIZE) / BATCH_SIZE)}/${Math.ceil(ruleSignals.length / BATCH_SIZE)}: ${decisions.length} signals, ${proceed} PROCEED`)
					await sendBatchNotification({
						symbols: [...new Set(batch.map(s => s.symbol))],
						decisions: decisions.map(d => ({ candle: d.candle, symbol: d.symbol, action: d.action })),
						batchNum: Math.ceil((batchIdx + BATCH_SIZE) / BATCH_SIZE),
						totalBatches: Math.ceil(ruleSignals.length / BATCH_SIZE),
					})
				}
				batchSuccess = true
				batchIdx += BATCH_SIZE
			} catch (err) {
				const status = String(err.status || err.code || err.message || '')
				if ((status === '429' || status.includes('429') || status.includes('RATE_LIMIT') || status.includes('Too Many Requests')) && retry429 < 2) {
					retry429++
					const baseWait = parseInt(err.message?.match(/retryDelay.*?(\d+)/i)?.[1] ?? '30') || 30
					const waitSec = baseWait * retry429  // exponential backoff
					console.warn(`[AI] 🐢 Batch 429 (ครั้งที่ ${retry429})! รอ ${waitSec}s แล้วลองใหม่`)
					// Add extra buffer to rate limiter
					for (let i = 0; i < Math.ceil(waitSec / (60000 / 13)); i++) recordAICall()
					await new Promise(r => setTimeout(r, Math.min(waitSec * 1000, 60000)))
				} else {
					console.warn(`[AI] batch filter error (${err.message?.slice(0, 60)}) — fallback PROCEED`)
					for (const s of batch) {
						aiFiltered[s.symbol][s.candle] = { action: 'PROCEED', holdOvernight: true, slMultiplier: 1.0, tpMultiplier: 1.0 }
					}
					batchSuccess = true
					batchIdx += BATCH_SIZE
				}
			}
		}
	}

	const totalProceed = Object.values(aiFiltered).reduce((sum, map) => sum + Object.keys(map).length, 0)
	console.log(`[AI] Filter complete: ${ruleSignals.length} signals → ${totalProceed} PROCEED (${((totalProceed / ruleSignals.length) * 100).toFixed(1)}%)`)
	return { filtered: aiFiltered, calls: Math.ceil(ruleSignals.length / BATCH_SIZE) }
}

async function runBacktest() {
	const totalBalance = BALANCE_PER_SYMBOL * SYMBOLS.length
	console.log(`\n[Backtest] ===== เริ่ม Backtest =====`)
	console.log(`[Backtest] Symbols: ${SYMBOLS.join(', ')} | ${TF} + ${TREND_TF} | ${CANDLE_COUNT} candles | AI: ${USE_AI}`)
	console.log(`[Backtest] Balance: $${BALANCE_PER_SYMBOL}/symbol (รวม $${totalBalance})`)

	await createSession()
	const cache = loadCandleCache()

	const allData = {}
	let minLen = Infinity
	for (const sym of SYMBOLS) {
		const h1 = await loadCandles(sym, TF, CANDLE_COUNT, cache, 'entry')
		const h4Count = Math.ceil(CANDLE_COUNT / 4) + 50
		const h4 = await loadCandles(sym, TREND_TF, h4Count, cache, 'trend')
		if (h1.length < 60) { console.error(`[Backtest] ${sym}: ข้อมูลไม่พอ`); continue }
		allData[sym] = { h1, h4 }
		if (h1.length < minLen) minLen = h1.length
	}

	const activeSymbols = Object.keys(allData)
	if (activeSymbols.length === 0) { console.error('[Backtest] ไม่มี symbol'); return }

	const balances = {}
	const positions = {}
	const trades = {}
	let aiCallsUsed = 0
	let peakTotal = totalBalance
	let maxDD = 0

	for (const sym of activeSymbols) {
		balances[sym] = BALANCE_PER_SYMBOL
		positions[sym] = null
		trades[sym] = []
	}

	const h4IndCache = {}
	for (const sym of activeSymbols) {
		const { h4 } = allData[sym]
		h4IndCache[sym] = []
		for (let i = 50; i < h4.length; i++) {
			const ind = getIndicators(h4.slice(0, i + 1))
			h4IndCache[sym].push({ time: h4[i].snapshotTime ?? h4[i].snapshotTimeUTC ?? i, emaTrend: ind.emaTrend, ema50: ind.ema50 })
		}
	}

	function getH4Trend(sym, h1Time) {
		const cache = h4IndCache[sym]
		if (!cache || cache.length === 0) return 'neutral'
		const t = new Date(h1Time).getTime()
		let best = cache[0]
		for (const entry of cache) {
			const et = new Date(entry.time).getTime()
			if (et <= t) best = entry
		}
		return best.emaTrend || 'neutral'
	}

	const startIdx = 60
	const NUM_SEGMENTS = Math.max(1, parseInt(process.env.BACKTEST_SEGMENTS ?? '1'))
	const segSize = NUM_SEGMENTS > 1 ? Math.floor((minLen - startIdx) / NUM_SEGMENTS) : (minLen - startIdx)

	const allSegmentTrades = {}
	for (const sym of activeSymbols) allSegmentTrades[sym] = []
	const signalLog = []
	let cumProfit = 0
	let segAiCalls = 0
	let globalMaxDD = 0

	for (let seg = 0; seg < NUM_SEGMENTS; seg++) {
		const segStart = startIdx + seg * segSize
		const segEnd = seg < NUM_SEGMENTS - 1 ? segStart + segSize : minLen

		if (NUM_SEGMENTS > 1) {
			console.log(`\n───── Segment ${seg + 1}/${NUM_SEGMENTS} (candle ${segStart}-${segEnd}) ─────`)
		}

		const balances = {}
		const positions = {}
		const trades = {}
		let peakTotal = BALANCE_PER_SYMBOL * activeSymbols.length
		let maxDD = 0

		for (const sym of activeSymbols) {
			balances[sym] = BALANCE_PER_SYMBOL
			positions[sym] = null
			trades[sym] = []
		}
		clearPredictionCache()
		let aiFilteredMap = {}
		if (USE_AI) {
			const result = await runAIBacktestFilter(activeSymbols, allData, minLen, h4IndCache, segStart, segEnd)
			aiFilteredMap = result.filtered
			segAiCalls += result.calls
		}

		for (let i = segStart; i < segEnd; i++) {
			for (const sym of activeSymbols) {
			const { h1 } = allData[sym]
			const current = h1[i]
			const price = getPrice(current)
			const pos = positions[sym]

			if (pos) {
				// Trailing stop logic (applies to all positions if enabled)
				if (BACKTEST_TRAILING) {
					const currentBest = pos.type === 'BUY'
						? Math.max(pos.bestPrice, price)
						: Math.min(pos.bestPrice, price)
					const pnlPct = pos.atrValue > 0
						? Math.abs(price - pos.entry) / pos.atrValue
						: 0
					if (pnlPct >= TRAILING_ACTIVATE && !pos.trailingActivated) {
						pos.trailingActivated = true
					}
					if (pos.trailingActivated) {
						const newSl = pos.type === 'BUY'
							? Math.max(pos.sl, currentBest - TRAILING_DISTANCE * pos.atrValue)
							: Math.min(pos.sl, currentBest + TRAILING_DISTANCE * pos.atrValue)
						if (newSl !== pos.sl) {
							pos.sl = newSl
							pos.bestPrice = currentBest
						}
					}
				}
				// Overnight hold close: if AI said holdOvernight=false and position age >= 6h, close at market
				if (pos.holdOvernight === false && (i - pos.entryIdx) >= 6) {
					const closePrice = price
					const multiplier = pos.type === 'BUY' ? 1 : -1
					const pnlPips2 = (closePrice - pos.entry) / pipToPrice(1, sym)
					const pnl2 = pnlPips2 * pos.size * pipValuePerLot(sym) * multiplier
					const slPips = Math.round(Math.abs(pos.sl - pos.entry) / pipToPrice(1, sym))
					const tpPips = Math.round(Math.abs(pos.tp - pos.entry) / pipToPrice(1, sym))
					balances[sym] += pnl2
					trades[sym].push({
						symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
						exit: closePrice, pnl: parseFloat(pnl2.toFixed(2)), result: pnl2 >= 0 ? 'WIN' : 'LOSS',
						exitTime: current.snapshotTime ?? current.snapshotTimeUTC ?? i,
						entryTime: pos.entryTime, bars: i - pos.entryIdx,
						reason: pos.reason, confidence: pos.confidence,
						slPips, tpPips, exitReason: 'CLOSE',
					})
					recordTradeResult({
						symbol: sym, action: pos.type, setup: pos.setup,
						entryIndicators: pos.entryIndicators,
						result: pnl2 >= 0 ? 'WIN' : 'LOSS',
						pnl: parseFloat(pnl2.toFixed(2)),
						aiDecision: USE_AI ? 'PROCEED' : 'NONE',
						slPips, tpPips, exitReason: 'CLOSE',
						holdOvernight: false, heldOvernight: false,
					})
					if (AI_SKIP_RATE > 0 && pos.signalIndex != null && signalLog[pos.signalIndex]) {
						signalLog[pos.signalIndex].tradeResult = pnl2 >= 0 ? 'WIN' : 'LOSS'
						signalLog[pos.signalIndex].pnl = parseFloat(pnl2.toFixed(2))
					}
					positions[sym] = null
					const ct = Object.values(balances).reduce((a, b) => a + b, 0)
					if (ct > peakTotal) peakTotal = ct
					const dd2 = ((peakTotal - ct) / peakTotal) * 100
					if (dd2 > maxDD) maxDD = dd2
					continue
				}
				const result = checkPosition(pos, h1, pos.entryIdx + 1, i + 1)
				if (result) {
					const multiplier = pos.type === 'BUY' ? 1 : -1
					const pnlPips = (result.price - pos.entry) / pipToPrice(1, sym)
					const spreadPips = parseFloat(process.env.BACKTEST_SPREAD_PIPS ?? '0')
				const spreadCost = spreadPips * pos.size * pipValuePerLot(sym)
				const pnl = pnlPips * pos.size * pipValuePerLot(sym) * multiplier - spreadCost
					const slPips = Math.round(Math.abs(pos.sl - pos.entry) / pipToPrice(1, sym))
					const tpPips = Math.round(Math.abs(pos.tp - pos.entry) / pipToPrice(1, sym))
					balances[sym] += pnl
					trades[sym].push({
						symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
						exit: result.price, pnl: parseFloat(pnl.toFixed(2)), result: pnl >= 0 ? 'WIN' : 'LOSS',
						exitTime: result.at, entryTime: pos.entryTime, bars: i - pos.entryIdx,
						reason: pos.reason, confidence: pos.confidence,
						slPips, tpPips, exitReason: result.type,
					})
					recordTradeResult({
						symbol: sym, action: pos.type, setup: pos.setup,
						entryIndicators: pos.entryIndicators,
						result: pnl >= 0 ? 'WIN' : 'LOSS',
						pnl: parseFloat(pnl.toFixed(2)),
						aiDecision: USE_AI ? 'PROCEED' : 'NONE',
						slPips, tpPips, exitReason: result.type,
						holdOvernight: pos.holdOvernight ?? true,
						heldOvernight: false,
					})
					if (AI_SKIP_RATE > 0 && pos.signalIndex != null && signalLog[pos.signalIndex]) {
						signalLog[pos.signalIndex].tradeResult = pnl >= 0 ? 'WIN' : 'LOSS'
						signalLog[pos.signalIndex].pnl = parseFloat(pnl.toFixed(2))
						updateSkipResult({
							symbol: sym, action: pos.type, setup: pos.setup,
							entryPrice: pos.entry,
							actualResult: pnl >= 0 ? 'WIN' : 'LOSS',
							pnl: parseFloat(pnl.toFixed(2)),
						})
					}
					positions[sym] = null
					const currentTotal = Object.values(balances).reduce((a, b) => a + b, 0)
					if (currentTotal > peakTotal) peakTotal = currentTotal
					const dd = ((peakTotal - currentTotal) / peakTotal) * 100
					if (dd > maxDD) maxDD = dd
				} else if (i >= minLen - 1) {
					trades[sym].push({
						symbol: sym, type: pos.type, setup: pos.setup, entry: pos.entry,
						exit: price, pnl: 0, result: 'UNKNOWN',
						entryTime: pos.entryTime, exitTime: current.snapshotTime ?? i,
						bars: i - pos.entryIdx, reason: pos.reason, confidence: pos.confidence,
					})
					positions[sym] = null
				}
				continue
			}

			if (isDDDisabled(sym, balances)) continue

			const window = h1.slice(0, i + 1)
			const sw = h1.slice(Math.max(0, i - 95), i + 1)
			const candleMap = { [TF]: window }
			if (sw.length >= 20) candleMap[`${TF}_secondary`] = sw
			const indicators = getMultiTFIndicators(candleMap)
			const h4Trend = getH4Trend(sym, current.snapshotTime ?? current.snapshotTimeUTC ?? i)
			const mainInd = Object.values(indicators)[0]
			if (mainInd) mainInd.currentPrice = price

			const ruleDecision = evaluate({ symbol: sym, h4Trend, ind: mainInd, knowledge: true })
			if (!ruleDecision || ruleDecision.action === 'HOLD') continue

			// Logic self-learned pre-filter (no API cost) — only when learning enabled
			let logicCheck = { action: 'PROCEED' }
			if (process.env.BACKTEST_LEARN === 'true') {
				logicCheck = queryLogicRules(sym, { setup: ruleDecision.setup, rsi: mainInd?.rsi })
				if (logicCheck.action === 'SKIP') continue
			}

			if (USE_AI) {
				const filterAction = aiFilteredMap[sym]?.[i]
				if (!filterAction || filterAction.action !== 'PROCEED') continue
			}

			const finalAction = ruleDecision.action
			const setupName = ruleDecision.reason?.slice(0, 30) ?? 'rules'
			const entryReason = ruleDecision.reason
			const entryConf = ruleDecision.confidence

			// Record signal for AI skip analysis (no Auto-SKIP — AI decides)
			const signalEntry = {
				index: signalLog.length,
				symbol: sym, action: finalAction, setup: setupName,
				price, rsi: mainInd?.rsi, emaTrend: mainInd?.emaTrend, h4Trend,
				tradeResult: null, pnl: null,
			}
			signalLog.push(signalEntry)

			const atrVal = mainInd?.atr ?? 0
			let { slPips, tpPips } = atrParams(atrVal, sym)
			// SL/TP adjustments only when learning enabled
			if (process.env.BACKTEST_LEARN === 'true') {
				const aiAdj = getSLTPAdjustment(sym)
				const logicAdj = logicCheck.slMultiplier ? { slMultiplier: logicCheck.slMultiplier, tpMultiplier: logicCheck.tpMultiplier } : { slMultiplier: 1.0, tpMultiplier: 1.0 }
				const finalSlM = parseFloat(((aiAdj.slMultiplier ?? 1.0) * (logicAdj.slMultiplier ?? 1.0)).toFixed(2))
				const finalTpM = parseFloat(((aiAdj.tpMultiplier ?? 1.0) * (logicAdj.tpMultiplier ?? 1.0)).toFixed(2))
				if (finalSlM !== 1.0 || finalTpM !== 1.0) {
					const oldSl = slPips; const oldTp = tpPips
					slPips = Math.max(5, Math.round(slPips * finalSlM))
					tpPips = Math.max(10, Math.round(tpPips * finalTpM))
					if (oldSl !== slPips || oldTp !== tpPips) {
						console.log(`[Adjust] ${sym} SL:${oldSl}→${slPips} TP:${oldTp}→${tpPips} (AI ${aiAdj.slMultiplier ?? 1.0}x logic ${logicAdj.slMultiplier ?? 1.0}x)`)
					}
				}
			}
			const entryPrice = price
			const slPrice = finalAction === 'BUY' ? entryPrice - slPips * pipToPrice(1, sym) : entryPrice + slPips * pipToPrice(1, sym)
			const tpPrice = finalAction === 'BUY' ? entryPrice + tpPips * pipToPrice(1, sym) : entryPrice - tpPips * pipToPrice(1, sym)
			const size = calcSize(balances[sym], slPips, sym)
			if (!size) continue

			const holdOvernight = USE_AI ? (aiFilteredMap[sym]?.[i]?.holdOvernight ?? true) : true
			positions[sym] = {
				type: finalAction, entry: entryPrice, sl: slPrice, tp: tpPrice,
				size, entryIdx: i, entryTime: current.snapshotTime ?? current.snapshotTimeUTC ?? i,
				setup: setupName, reason: entryReason, confidence: entryConf,
				atrValue: atrVal,
				bestPrice: entryPrice,
				trailingActivated: false,
				signalIndex: signalEntry.index,
				holdOvernight,
			entryIndicators: mainInd ? {
				rsi: mainInd.rsi,
				ema20: mainInd.ema20,
				emaTrend: mainInd.emaTrend,
				macd: mainInd.macd,
				atr: mainInd.atr,
				currentPrice: price,
			} : null,
			}
			console.log(`[${sym}] ${finalAction} @ ${entryPrice} SL=${slPrice.toFixed(5)} TP=${tpPrice.toFixed(5)} size=${size.toFixed(4)} ${setupName}`)
		}
	}

		// Copy segment trades to cumulative
		for (const sym of activeSymbols) {
			allSegmentTrades[sym].push(...trades[sym])
		}

		const segAllTrades = Object.values(trades).flat()
		recordTrades(segAllTrades)

		saveWisdom()
		if (USE_AI || process.env.BACKTEST_LEARN === 'true') {
			await aiLearnFromTrades()
			analyzeTradePatterns()
		}

		const segFinal = Object.values(balances).reduce((a, b) => a + b, 0)
		const segPnl = segFinal - BALANCE_PER_SYMBOL * activeSymbols.length
		cumProfit += segPnl
		if (maxDD > globalMaxDD) globalMaxDD = maxDD
		const segClosed = segAllTrades.filter(t => t.result !== 'UNKNOWN')
		console.log(`➡️  Segment ${seg + 1}: $${segPnl >= 0 ? '+' : ''}${segPnl.toFixed(2)} | ${segClosed.length} trades | WR: ${segClosed.length > 0 ? (segClosed.filter(t => t.result === 'WIN').length / segClosed.length * 100).toFixed(1) : 'N/A'}%`)
	} // end segment loop

	// === Post-hoc AI skip analysis (all signals, rate=1.0) ===
	const aiSkipResults = []
	if (AI_SKIP_RATE > 0) {
		const tradedSignals = signalLog.filter(s => s.tradeResult === 'WIN' || s.tradeResult === 'LOSS')
		if (tradedSignals.length > 0) {
			const withCacheKeys = tradedSignals.map(s => ({
				...s,
				cacheKey: `${s.symbol}:${s.action}:${s.setup}:${s.rsi != null ? s.rsi.toFixed(0) : '?'}:${s.emaTrend || '?'}`,
			}))
			console.log(`\n[AI Skip] Analyzing ${withCacheKeys.length} signals (rate=1.0)...`)
			try {
				const predictions = await getBatchSkipPrediction(withCacheKeys, false)
				for (const p of predictions) {
					const signal = withCacheKeys.find(s => s.index === p.index)
					if (!signal) continue
					aiSkipResults.push({
						...signal,
						aiDecision: p.decision,
						aiConfidence: p.confidence,
						aiCorrect: (p.decision === 'SKIP' && signal.tradeResult === 'LOSS') ||
							(p.decision === 'PROCEED' && signal.tradeResult === 'WIN'),
					})
				}
			} catch (err) {
				console.error('[AI Skip] error:', err.message)
			}
		}

		if (aiSkipResults.length > 0) {
			const aiSkipped = aiSkipResults.filter(r => r.aiDecision === 'SKIP')
			const aiProceed = aiSkipResults.filter(r => r.aiDecision === 'PROCEED')
			const correctSkip = aiSkipped.filter(r => r.tradeResult === 'LOSS').length
			const falseSkip = aiSkipped.filter(r => r.tradeResult === 'WIN').length
			const correctProceed = aiProceed.filter(r => r.tradeResult === 'WIN').length
			const falseProceed = aiProceed.filter(r => r.tradeResult === 'LOSS').length
			const aiAccuracy = aiSkipResults.filter(r => r.aiCorrect).length / aiSkipResults.length * 100
			const skippedLossPnl = aiSkipped.filter(r => r.tradeResult === 'LOSS').reduce((s, r) => s + Math.abs(r.pnl || 0), 0)
			const skippedWinPnl = aiSkipped.filter(r => r.tradeResult === 'WIN').reduce((s, r) => s + (r.pnl || 0), 0)

			console.log(`\n${'='.repeat(60)}`)
			console.log(`📊 AI Skip Analysis (${aiSkipResults.length} signals)`)
			console.log(`${'='.repeat(60)}`)
			console.log(`AI Accuracy: ${aiAccuracy.toFixed(1)}% (${aiSkipResults.filter(r => r.aiCorrect).length}/${aiSkipResults.length})`)
			console.log(`\nAI said SKIP: ${aiSkipped.length} times`)
			console.log(`  ✓ Correct (was LOSS): ${correctSkip} (${correctSkip > 0 ? (correctSkip/aiSkipped.length*100).toFixed(1) : 0}%)`)
			console.log(`  ✗ False (was WIN): ${falseSkip} — กำไรที่พลาด: $${skippedWinPnl.toFixed(2)}`)
			console.log(`  💰 Loss ที่หลีกเลี่ยง: $${skippedLossPnl.toFixed(2)}`)
			console.log(`\nAI said PROCEED: ${aiProceed.length} times`)
			console.log(`  ✓ Correct (was WIN): ${correctProceed}`)
			console.log(`  ✗ False (was LOSS): ${falseProceed}`)
			const netAIBenefit = skippedLossPnl - skippedWinPnl
			console.log(`\n💵 Net AI benefit (loss avoided - profit missed): ${netAIBenefit >= 0 ? '+' : ''}$${netAIBenefit.toFixed(2)}`)
			console.log(`${'='.repeat(60)}\n`)
		}
	}

	const finalBalance = BALANCE_PER_SYMBOL * activeSymbols.length + cumProfit
	const allTrades = Object.values(allSegmentTrades).flat()
	const closedTrades = allTrades.filter(t => t.result !== 'UNKNOWN')
	// Calculate final balances per symbol from cumulative trade pnl
	const finalBalances = {}
	for (const sym of activeSymbols) {
		const symTrades = allSegmentTrades[sym] || []
		const symPnl = symTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
		finalBalances[sym] = BALANCE_PER_SYMBOL + symPnl
	}
	await printReport(allSegmentTrades, finalBalances, BALANCE_PER_SYMBOL * activeSymbols.length, finalBalance, closedTrades, segAiCalls, globalMaxDD)
	if (NUM_SEGMENTS > 1) {
		console.log(`\n📈 Cumulative PnL across ${NUM_SEGMENTS} segments: ${cumProfit >= 0 ? '+' : ''}${cumProfit.toFixed(2)}`)
	}
	printSummary()
}

async function printReport(tradesMap, balances, totalBalance, finalBalance, allClosedTrades, aiCalls, maxDD) {
	console.log(`\n${'='.repeat(60)}`)
	console.log(`📊 สรุป Backtest ทุกค่าเงิน`)
	console.log(`${'='.repeat(60)}`)
	const h = (s, w) => s.padEnd(w)
	const hr = (s, w) => s.padStart(w)
	console.log(`${h('สินทรัพย์',12)} ${hr('Balance',10)} ${hr('PnL',10)} ${hr('เทรด',6)} ${hr('WIN',5)} ${hr('LOSS',5)} ${hr('WinRate',8)} ${hr('PF',6)}`)
	console.log('-'.repeat(60))

	let totalTrades = 0, totalWins = 0, totalLosses = 0
	let grossProfit = 0, grossLoss = 0
	let allProfit = true

	for (const sym of Object.keys(tradesMap)) {
		const trades = tradesMap[sym]
		const pnl = (balances[sym] || 0) - BALANCE_PER_SYMBOL
		const closed = trades.filter(t => t.result !== 'UNKNOWN')
		const wins = closed.filter(t => t.result === 'WIN')
		const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 'N/A'
		const gp = wins.reduce((s, t) => s + t.pnl, 0)
		const gl = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (closed.length > 0 ? '∞' : '-')
		totalTrades += trades.length
		totalWins += wins.length
		totalLosses += losses.length
		grossProfit += gp
		grossLoss += Math.abs(gl)
		if (pnl < 0) allProfit = false
		console.log(`${sym.padEnd(12)} $${(balances[sym] || 0).toFixed(2).padStart(7)} ${(pnl >= 0 ? '+' : '') + pnl.toFixed(2).padStart(7)} ${String(trades.length).padStart(6)} ${wins.length.toString().padStart(5)} ${losses.length.toString().padStart(5)} ${String(wr).padStart(7)}% ${pf.toString().padStart(5)}`)
	}

	const netPnl = finalBalance - totalBalance
	const overallWR = (totalWins + totalLosses) > 0 ? (totalWins / (totalWins + totalLosses) * 100).toFixed(1) : 'N/A'
	const overallPF = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (totalTrades > 0 ? '∞' : '-')

	console.log('-'.repeat(60))
	console.log(`${'รวม'.padEnd(12)} $${finalBalance.toFixed(2).padStart(7)} ${(netPnl >= 0 ? '+' : '') + netPnl.toFixed(2).padStart(7)} ${String(totalTrades).padStart(6)} ${totalWins.toString().padStart(5)} ${totalLosses.toString().padStart(5)} ${String(overallWR).padStart(7)}% ${overallPF.toString().padStart(5)}`)
	console.log(`${'='.repeat(60)}`)
	console.log(`เรียก AI: ${aiCalls} ครั้ง`)
	console.log(`ยอดรวม: $${totalBalance.toFixed(2)} → $${finalBalance.toFixed(2)}`)
	console.log(`PnL: $${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} (${(netPnl / totalBalance * 100).toFixed(2)}%)`)
	console.log(`Max DD: ${maxDD.toFixed(2)}% | PF: ${overallPF} | WR: ${overallWR}%`)

	const profitable = netPnl > 0 && allProfit
	console.log(`\n🎯 สรุป: ${profitable ? '✅ กำไรทุกสินทรัพย์!' : '❌ ยังไม่ผ่าน'} (ต้องการกำไรทุกตัว + WR ≥ 50%)`)
	console.log(`${'='.repeat(60)}\n`)

	const symbolSummaries = Object.entries(tradesMap).map(([sym, trades]) => {
		const closed = trades.filter(t => t.result !== 'UNKNOWN')
		const wins = closed.filter(t => t.result === 'WIN')
		const losses = closed.filter(t => t.result === 'LOSS')
		const wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : '0.0'
		const gp = wins.reduce((s, t) => s + t.pnl, 0)
		const gl = losses.reduce((s, t) => s + t.pnl, 0)
		const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (closed.length > 0 ? '∞' : '-')
		return `${sym}: $${((balances[sym] || 0) - BALANCE_PER_SYMBOL) >= 0 ? '+' : ''}${((balances[sym] || 0) - BALANCE_PER_SYMBOL).toFixed(2)} | ${closed.length}เทรด | WR ${wr}% | PF ${pf}`
	}).join('\n')

	const allWins = allClosedTrades.filter(t => t.result === 'WIN')
	const allLosses = allClosedTrades.filter(t => t.result === 'LOSS')

	await sendBacktestReport({
		symbol: `${SYMBOLS.length} สินทรัพย์`,
		tf: TF,
		candles: CANDLE_COUNT,
		aiCalls,
		totalTrades,
		closed: allClosedTrades.length,
		wins: totalWins,
		losses: totalLosses,
		winRate: overallWR,
		profitFactor: overallPF,
		initialBalance: totalBalance,
		finalBalance,
		netProfit: netPnl,
		returnPct: ((netPnl / totalBalance) * 100).toFixed(2),
		maxDrawdown: maxDD.toFixed(2),
		bestTrade: allWins.length > 0 ? Math.max(...allWins.map(t => t.pnl)) : 0,
		worstTrade: allLosses.length > 0 ? Math.min(...allLosses.map(t => t.pnl)) : 0,
		symbolSummaries,
	})
}

runBacktest().catch(async err => {
	console.error('[Backtest] fatal:', err.message)
	process.exit(1)
})
