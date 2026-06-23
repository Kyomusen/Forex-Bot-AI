// Retroactively eval AI decisions on all accumulated trades in filter_knowledge.json
import fs from 'fs'
import { getGeminiModel } from '../src/geminiClient.js'
import { waitForAISlot, recordAICall } from '../src/aiDecision.js'
import { getWisdomForPrompt } from '../src/filterWisdom.js'
import { getLearnedRulesForPrompt } from '../src/aiLearn.js'

const KNOWLEDGE_FILE = './logs/filter_knowledge.json'

function load() {
  const raw = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'))
  return raw.trades || []
}

function save(trades) {
  const dir = KNOWLEDGE_FILE.substring(0, KNOWLEDGE_FILE.lastIndexOf('/'))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify({ trades }, null, 2))
}

async function main() {
  const trades = load()
  const noAI = trades.map((t, i) => ({ ...t, _idx: i }))
    .filter(t => !t.aiDecision || t.aiDecision === 'NONE')

  console.log(`\n=== Retro AI Evaluation ===`)
  console.log(`ทั้งหมด ${trades.length} trades`)
  console.log(`ยังไม่มี AI decision: ${noAI.length} trades\n`)

  if (noAI.length === 0) {
    console.log('ทุก trade มี AI decision แล้ว — ข้าม')
    return
  }

  const model = getGeminiModel()
  const BATCH = 30
  let updated = 0
  let failed = 0

  for (let start = 0; start < noAI.length; start += BATCH) {
    const batch = noAI.slice(start, start + BATCH)
    const batchNum = Math.floor(start / BATCH) + 1
    const totalBatches = Math.ceil(noAI.length / BATCH)

    const signalsText = batch.map((t, i) =>
      `[${t.symbol} S${start + i}] ${t.action || '?'} ${t.setup || 'rules'} ` +
      `| RSI:${t.rsi ?? '?'} | MACD:${t.macdHistogram ?? '?'} (${t.macdHistogramTrend ?? '?'}) ` +
      `| Price:${t.priceVsEma20 ?? '?'} EMA20 | Trend:${t.emaTrend ?? '?'} | ATR:${t.atr ?? '?'}`
    ).join('\n')

    const prompt = `You are a FOREX signal filter evaluating past trade signals.
Default to PROCEED. SKIP only when the learning section clearly shows <30% win rate with 5+ similar trades.
Be decisive: skip bad patterns, but default to proceed when unsure or data is limited.
Signals:
${signalsText}

Respond ONLY valid JSON array (no markdown):
[{"signalIndex":0,"symbol":"XAUUSD","action":"PROCEED","confidence":0.9,"reason":"..."}]`

    const gotSlot = await waitForAISlot()
    if (!gotSlot) {
      console.warn(`[Batch ${batchNum}/${totalBatches}] ⏰ rate limit timeout — fallback PROCEED`)
      for (const t of batch) {
        trades[t._idx].aiDecision = 'PROCEED'
        updated++
      }
      continue
    }

    let retry429 = 0
    let success = false
    while (!success && retry429 < 3) {
      try {
        const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
        recordAICall()
        const text = result.response.text()
        const cleaned = text.replace(/```json|```|```/g, '').trim()
        const decisions = JSON.parse(cleaned)

        if (Array.isArray(decisions)) {
          let proceed = 0, skip = 0
          const seen = new Set()
          for (const d of decisions) {
            const action = (d.action || '').toUpperCase()
            const si = parseInt(String(d.signalIndex).replace(/^S/, ''), 10)
            const batchIdx = si - start
            if (batchIdx >= 0 && batchIdx < batch.length && (action === 'PROCEED' || action === 'SKIP')) {
              trades[batch[batchIdx]._idx].aiDecision = action
              seen.add(batchIdx)
              if (action === 'PROCEED') proceed++
              else skip++
              updated++
            }
          }
          if (decisions.length > 0 && proceed === 0 && skip === 0) {
            console.log(`  ⚠️ Batch ${batchNum} returned ${decisions.length} decisions, first action="${decisions[0]?.action}"`)
          }
          // Fallback for undecided signals in this batch
          for (let bi = 0; bi < batch.length; bi++) {
            if (!seen.has(bi)) {
              trades[batch[bi]._idx].aiDecision = 'PROCEED'
              updated++
            }
          }
          console.log(`[Batch ${batchNum}/${totalBatches}] ${decisions.length} decisions → ${proceed} PROCEED / ${skip} SKIP / ${batch.length - seen.size} default PROCEED`)
        }
        success = true
      } catch (err) {
        const status = String(err.status || err.code || err.message || '')
        if ((status.includes('429') || status.includes('RATE_LIMIT') || status.includes('Too Many Requests')) && retry429 < 2) {
          retry429++
          const waitSec = 30 * retry429
          console.warn(`[Batch ${batchNum}/${totalBatches}] 🐢 429 (ครั้งที่ ${retry429}) — รอ ${waitSec}s`)
          await new Promise(r => setTimeout(r, waitSec * 1000))
        } else {
          console.warn(`[Batch ${batchNum}/${totalBatches}] ❌ ${err.message?.slice(0, 60)} — fallback PROCEED`)
          for (const t of batch) {
            trades[t._idx].aiDecision = 'PROCEED'
            updated++
          }
          failed++
          success = true
        }
      }
    }
  }

  save(trades)
  console.log(`\n✅ อัปเดต AI decision เรียบร้อย: ${updated} trades (ล้มเหลว ${failed} batch)`)

  // Accuracy report
  const withAI = trades.filter(t => t.aiDecision && t.aiDecision !== 'NONE')
  const bySym = {}
  for (const t of withAI) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { proceedWin: 0, proceedLoss: 0, skipWin: 0, skipLoss: 0 }
    const d = bySym[t.symbol]
    if (t.aiDecision === 'PROCEED') {
      if (t.result === 'WIN') d.proceedWin++
      else if (t.result === 'LOSS') d.proceedLoss++
    } else if (t.aiDecision === 'SKIP') {
      if (t.result === 'WIN') d.skipWin++
      else if (t.result === 'LOSS') d.skipLoss++
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`📊 AI Decision Accuracy Report`)
  console.log(`${'='.repeat(60)}`)
  for (const [sym, d] of Object.entries(bySym)) {
    const pTotal = d.proceedWin + d.proceedLoss
    const sTotal = d.skipWin + d.skipLoss
    const correct = d.proceedWin + d.skipLoss
    const wrong = d.proceedLoss + d.skipWin
    const total = correct + wrong
    const acc = total > 0 ? (correct / total * 100).toFixed(1) : 'N/A'
    console.log(`${sym}:`)
    console.log(`  PROCEED ${pTotal} → WIN ${d.proceedWin} / LOSS ${d.proceedLoss} (WR ${pTotal > 0 ? (d.proceedWin/pTotal*100).toFixed(1) : 'N/A'}%)`)
    console.log(`  SKIP    ${sTotal} → ถูก ${d.skipLoss} (จะเสีย) / ผิด ${d.skipWin} (จะได้)`)
    console.log(`  ✅ ${correct}/${total} = ${acc}% | ❌ ต้อง self-correct: PROCEED→LOSS ${d.proceedLoss}, SKIP→WIN ${d.skipWin}`)
    console.log()
  }

  const allPW = Object.values(bySym).reduce((s, d) => s + d.proceedWin, 0)
  const allPL = Object.values(bySym).reduce((s, d) => s + d.proceedLoss, 0)
  const allSW = Object.values(bySym).reduce((s, d) => s + d.skipWin, 0)
  const allSL = Object.values(bySym).reduce((s, d) => s + d.skipLoss, 0)
  const allCorrect = allPW + allSL
  const allWrong = allPL + allSW
  console.log(`${'='.repeat(60)}`)
  console.log(`รวม PROCEED: ${allPW + allPL} → WIN ${allPW} / LOSS ${allPL} (WR ${(allPW + allPL) > 0 ? (allPW / (allPW + allPL) * 100).toFixed(1) : 'N/A'}%)`)
  console.log(`รวม SKIP:    ${allSW + allSL} → ถูก ${allSL} / ผิด ${allSW}`)
  console.log(`AI รวม: ✅ ${allCorrect}/${allCorrect + allWrong} = ${(allCorrect / (allCorrect + allWrong) * 100).toFixed(1)}% | ❌ ${allWrong} ครั้งต้อง self-correct`)
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1) })
