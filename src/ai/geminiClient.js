import { GoogleGenerativeAI } from '@google/generative-ai'
import { getAvailableKeys, recordApiCall } from './apiKeyManager.js'
import dotenv from 'dotenv'

let keys = []
let keyIdx = 0

function initKeys() {
	if (keys.length === 0) {
		dotenv.config()
		keys = getAvailableKeys()
		keyIdx = 0
	}
}

function currentKey() {
	initKeys()
	return keys[keyIdx] || keys[0] || ''
}

function tryNextKey() {
	initKeys()
	if (keyIdx < keys.length - 1) {
		keyIdx++
		return true
	}
	return false
}

function shouldRetry(err, retries) {
	const msg = String(err.message || '')
	const status = err.status ?? -1
	const isQuota =
		status === 429 || status === 403 ||
		msg.includes('403') || msg.includes('Forbidden') ||
		msg.includes('quota') || msg.includes('RATE_LIMIT') ||
		msg.includes('Too Many Requests') || msg.includes('unregistered')
	const isNetwork = retries < 3 && (
		msg.includes('fetch') || msg.includes('network') ||
		msg.includes('ENOTFOUND') || msg.includes('ECONNRESET') ||
		msg.includes('ETIMEDOUT') || msg.includes('Error fetching from') ||
		msg.includes('Failed to fetch')
	)
	return { isQuota, isNetwork }
}

export function getGeminiModel(modelName = 'gemini-3.1-flash-lite') {
	initKeys()

	let genAI = new GoogleGenerativeAI(currentKey())
	let model = genAI.getGenerativeModel({ model: modelName })
	let generateFn = model.generateContent.bind(model)
	let retries = 0

	model.generateContent = async function(...args) {
		while (true) {
			try {
				const result = await generateFn(...args)
				recordApiCall()
				retries = 0
				return result
			} catch (err) {
				const { isQuota, isNetwork } = shouldRetry(err, retries)

				if (isQuota && tryNextKey()) {
					retries++
					const wait = Math.min(1000 * Math.pow(2, retries), 30000)
					console.warn(`[Gemini] Key exhausted — switching to key ${keyIdx + 1}/${keys.length} (wait ${wait}ms)`)
					genAI = new GoogleGenerativeAI(currentKey())
					model = genAI.getGenerativeModel({ model: modelName })
					generateFn = model.generateContent.bind(model)
					await new Promise(r => setTimeout(r, wait))
					continue
				}

				if (isNetwork) {
					retries++
					const wait = Math.min(2000 * Math.pow(2, retries - 1), 20000)
					console.warn(`[Gemini] Network error — retry ${retries}/3 in ${wait}ms`)
					await new Promise(r => setTimeout(r, wait))
					continue
				}

				retries = 0
				throw err
			}
		}
	}

	return model
}
