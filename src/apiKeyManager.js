import fs from 'fs'
import dotenv from 'dotenv'

const USAGE_FILE = './logs/api_usage.json'

function ensureEnv() {
	dotenv.config()
}

function getPacificOffsetMinutes() {
	const now = new Date()
	const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' })
	const pacStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
	return (new Date(utcStr) - new Date(pacStr)) / 60000
}

export function getNextResetUTC() {
	const pacOffset = getPacificOffsetMinutes()
	const ptNow = Date.now() - pacOffset * 60000
	const ptDayStart = Math.floor(ptNow / 86400000) * 86400000
	return ptDayStart + 86400000 + pacOffset * 60000
}

function loadUsage() {
	try {
		if (fs.existsSync(USAGE_FILE)) return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'))
	} catch {}
	return { calls: 0, resetAt: getNextResetUTC() }
}

function saveUsage(u) {
	const dir = USAGE_FILE.substring(0, USAGE_FILE.lastIndexOf('/'))
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2))
}

export function recordApiCall(count = 1) {
	const u = loadUsage()
	if (Date.now() >= u.resetAt) {
		u.calls = 0
		u.resetAt = getNextResetUTC()
	}
	u.calls += count
	saveUsage(u)
	return u.calls
}

export function getUsage() {
	const u = loadUsage()
	if (Date.now() >= u.resetAt) {
		u.calls = 0
		u.resetAt = getNextResetUTC()
		saveUsage(u)
	}
	return u
}

export function getAvailableKeys() {
	ensureEnv()
	const keys = []
	const add = k => { if (k) keys.push(k) }
	add(process.env.GEMINI_API_KEY)
	add(process.env.FALLBACK_GEMINI_API_KEY)
	for (let i = 2; i <= 5; i++) add(process.env[`FALLBACK_GEMINI_API_KEY_${i}`])
	return keys
}
