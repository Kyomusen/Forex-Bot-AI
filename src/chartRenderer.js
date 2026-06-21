import axios from 'axios'

const QUICKCHART_URL = 'https://quickchart.io/chart'

function calcRSI(closes) {
	return closes.map((_, i) => {
		if (i < 14) return null
		const slice = closes.slice(i - 14, i + 1)
		let gains = 0, losses = 0
		for (let j = 0; j < slice.length - 1; j++) {
			const diff = slice[j + 1] - slice[j]
			if (diff > 0) gains += diff
			else losses -= diff
		}
		const rs = gains / (losses || 0.0001)
		return parseFloat((100 - 100 / (1 + rs)).toFixed(2))
	})
}

function buildConfig(candles, timeframe) {
	const recent = candles.slice(-40)
	const closes = recent.map(c => c.closePrice.bid)
	const highs = recent.map(c => c.highPrice.bid)
	const lows = recent.map(c => c.lowPrice.bid)
	const opens = recent.map(c => c.openPrice.bid)
	const rsi = calcRSI(closes)
	const labels = recent.map((_, i) => i % 8 === 0 ? String(i) : '')

	const bullBodies = recent.map((c, i) => {
		const o = opens[i], cl = closes[i]
		return cl >= o ? cl - o : 0
	})
	const bearBodies = recent.map((c, i) => {
		const o = opens[i], cl = closes[i]
		return cl < o ? o - cl : 0
	})
	const bullBase = recent.map((c, i) => closes[i] >= opens[i] ? opens[i] : closes[i])
	const bearBase = recent.map((c, i) => closes[i] < opens[i] ? closes[i] : opens[i])

	const wickHigh = recent.map((c, i) => highs[i] - Math.max(opens[i], closes[i]))
	const wickLow = recent.map((c, i) => Math.min(opens[i], closes[i]) - lows[i])

	return {
		type: 'bar',
		data: {
			labels,
			datasets: [
				{
					label: 'bullBase',
					data: bullBase,
					backgroundColor: 'rgba(0,0,0,0)',
					borderWidth: 0,
					stack: 'candle',
					yAxisID: 'y',
				},
				{
					label: 'Bull',
					data: bullBodies,
					backgroundColor: 'rgba(0,200,150,0.9)',
					borderColor: '#00c896',
					borderWidth: 1,
					stack: 'candle',
					yAxisID: 'y',
				},
				{
					label: 'bearBase',
					data: bearBase,
					backgroundColor: 'rgba(0,0,0,0)',
					borderWidth: 0,
					stack: 'bear',
					yAxisID: 'y',
				},
				{
					label: 'Bear',
					data: bearBodies,
					backgroundColor: 'rgba(255,70,100,0.9)',
					borderColor: '#ff4466',
					borderWidth: 1,
					stack: 'bear',
					yAxisID: 'y',
				},
				{
					label: 'RSI',
					type: 'line',
					data: rsi,
					borderColor: '#ffaa00',
					borderWidth: 1.5,
					pointRadius: 0,
					fill: false,
					yAxisID: 'rsi',
				},
			],
		},
		options: {
			animation: false,
			plugins: {
				legend: { display: false },
				title: {
					display: true,
					text: timeframe,
					color: '#ccccff',
				},
			},
			scales: {
				y: {
					position: 'left',
					stacked: true,
					ticks: { color: '#aaaacc' },
					grid: { color: '#333355' },
				},
				rsi: {
					position: 'right',
					min: 0,
					max: 100,
					ticks: { color: '#ffaa00' },
					grid: { drawOnChartArea: false },
				},
				x: {
					stacked: true,
					ticks: { color: '#666688' },
					grid: { color: '#222244' },
				},
			},
		},
	}
}

async function renderChart(candles, timeframe) {
	const config = buildConfig(candles, timeframe)

	const res = await axios.post(
		QUICKCHART_URL,
		{
			chart: JSON.stringify(config),
			width: 700,
			height: 350,
			backgroundColor: '#1a1a2e',
			format: 'png',
			version: '3',
		},
		{
			responseType: 'arraybuffer',
			timeout: 15000,
			headers: { 'Content-Type': 'application/json' },
		}
	)

	const buf = Buffer.from(res.data)

	if (buf.slice(0, 4).toString('hex') !== '89504e47') {
		const msg = buf.toString('utf-8').slice(0, 300)
		throw new Error(`QuickChart ไม่ได้ส่ง PNG กลับมา: ${msg}`)
	}

	return buf
}

export { renderChart }
