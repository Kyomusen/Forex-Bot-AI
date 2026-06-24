import http from 'http'
import { spawn } from 'child_process'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

dotenv.config()

const PORT = parseInt(process.env.WEBHOOK_PORT ?? '3000')
const BOT_PATH = process.env.WEBHOOK_PATH ?? '/run'
const BOT_TOKEN = process.env.WEBHOOK_TOKEN ?? ''

let running = false
let lastRun = 0
let lastStatus = 'never'
let lastDuration = 0
let pid = null

function getLogPath() {
	const dir = path.resolve('logs')
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	return path.join(dir, `bot_${new Date().toISOString().slice(0, 10)}.log`)
}

async function runBot() {
	return new Promise((resolve) => {
		const logFile = getLogPath()
		const out = fs.openSync(logFile, 'a')
		const err = fs.openSync(logFile, 'a')

		const child = spawn('node', ['src/bot.js'], {
			env: { ...process.env, SINGLE_RUN: 'true' },
			stdio: ['ignore', out, err],
			cwd: process.cwd(),
		})

		pid = child.pid

		const startTime = Date.now()
		child.on('close', (code) => {
			pid = null
			lastDuration = Date.now() - startTime
			fs.closeSync(out)
			fs.closeSync(err)
			resolve(code === 0 ? 'success' : `exit ${code}`)
		})
	})
}

const server = http.createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*')

	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({
			status: 'alive',
			running,
			lastRun,
			lastStatus,
			lastDuration,
			pid,
		}))
		return
	}

	if (req.method !== 'GET' && req.method !== 'POST') {
		res.writeHead(405)
		return res.end('Method not allowed')
	}

	if (req.url !== BOT_PATH) {
		res.writeHead(404)
		return res.end('Not found')
	}

	if (BOT_TOKEN) {
		const auth = req.headers['authorization'] || ''
		if (auth !== `Bearer ${BOT_TOKEN}`) {
			res.writeHead(401)
			return res.end('Unauthorized')
		}
	}

	if (running) {
		res.writeHead(429, { 'Content-Type': 'application/json' })
		return res.end(JSON.stringify({ status: 'busy', runningSince: lastRun }))
	}

	running = true
	lastRun = Date.now()
	res.writeHead(202, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify({ status: 'started', pid: 'spawning' }))

	lastStatus = await runBot()
	running = false
})

server.listen(PORT, '0.0.0.0', () => {
	console.log(`[Webhook] Listening on 0.0.0.0:${PORT}`)
	console.log(`[Webhook] Trigger: GET/POST ${BOT_PATH}`)
	console.log(`[Webhook] Token auth: ${BOT_TOKEN ? 'enabled' : 'disabled'}`)
})
