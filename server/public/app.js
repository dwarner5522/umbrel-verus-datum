'use strict'

const $ = (id) => document.getElementById(id)
const number = new Intl.NumberFormat('en-US')

function scale(value, units, base = 1000) {
	let unit = 0
	value = Number(value) || 0
	while (value >= base && unit < units.length - 1) {
		value /= base
		unit++
	}
	return {value: value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1), unit: units[unit]}
}

const HASH_UNITS = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s']
const hashrate = (value) => {
	const scaled = scale(value, HASH_UNITS)
	return `${scaled.value} ${scaled.unit}`
}

function duration(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return {value: '–', unit: 'on average'}
	if (seconds < 5400) return {value: Math.max(Math.round(seconds / 60), 1), unit: 'minutes on average'}
	if (seconds < 172800) return {value: (seconds / 3600).toFixed(1), unit: 'hours on average'}
	if (seconds < 63072000) return {value: (seconds / 86400).toFixed(1), unit: 'days on average'}
	return {value: (seconds / 31557600).toFixed(1), unit: 'years on average'}
}

function ago(timestamp, now) {
	if (!timestamp) return 'never'
	const seconds = Math.max(Math.round((now - timestamp) / 1000), 0)
	if (seconds < 90) return `${seconds}s ago`
	if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`
	if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`
	return `${Math.round(seconds / 86400)}d ago`
}

function setPill(state, label) {
	$('status-pill').dataset.state = state
	$('status-pill').textContent = label
}

function emptyRow(body, columns, text) {
	const cell = body.insertRow().insertCell()
	cell.colSpan = columns
	cell.className = 'empty'
	cell.textContent = text
}

function numCell(row, text) {
	const cell = row.insertCell()
	cell.className = 'num'
	cell.textContent = text
}

function renderMiners(pool) {
	const body = $('miners')
	body.replaceChildren()
	const miners = pool?.miners.list || []
	$('miner-count').textContent = miners.length ? `(${pool.miners.online} online${pool.miners.offline ? `, ${pool.miners.offline} offline` : ''})` : ''
	if (!miners.length) return emptyRow(body, 10, 'No miners have connected yet')
	for (const miner of miners) {
		const row = body.insertRow()
		if (!miner.online) row.className = 'offline'
		// Miner-supplied strings (names) are untrusted: text only, never HTML.
		row.insertCell().textContent = miner.name
		row.insertCell().textContent = miner.ip
		row.insertCell().textContent = miner.online ? (miner.connections > 1 ? `Online ×${miner.connections}` : 'Online') : 'Offline'
		numCell(row, miner.difficulty ? number.format(Math.round(miner.difficulty)) : '–')
		numCell(row, hashrate(miner.hashrate))
		numCell(row, hashrate(miner.hashrate1h))
		numCell(row, number.format(miner.accepted))
		numCell(row, number.format(miner.rejected))
		numCell(row, number.format(miner.stale))
		numCell(row, ago(miner.lastShare, pool.time))
	}
}

function renderBlocks(pool) {
	const body = $('blocks')
	body.replaceChildren()
	const blocks = (pool?.blocks || []).slice().reverse()
	$('block-count').textContent = blocks.length ? `(${blocks.length})` : ''
	if (!blocks.length) return emptyRow(body, 5, 'No blocks found yet')
	for (const block of blocks) {
		const row = body.insertRow()
		row.insertCell().textContent = new Date(block.time).toLocaleString()
		numCell(row, number.format(block.height))
		row.insertCell().textContent = String(block.worker).split('.')[1] || block.worker
		numCell(row, block.pbaasOnly ? 'PBaaS only' : `${block.reward} VRSC`)
		row.insertCell().textContent = block.hash
	}
}

function renderStats(pool) {
	const set = (id, value, unitId, unit) => {
		$(id).textContent = value
		if (unitId) $(unitId).textContent = unit
	}
	if (!pool) {
		for (const id of ['stat-miners', 'stat-hour', 'stat-network', 'stat-height', 'stat-time', 'stat-blocks']) $(id).textContent = '–'
		$('sync-percent').textContent = '–'
		$('sync-label').textContent = 'Hashrate'
		return
	}

	const current = scale(pool.hashrate.current, HASH_UNITS)
	$('sync-percent').textContent = current.value
	$('sync-label').textContent = `${current.unit} · last ${Math.round(pool.hashrateWindow / 60)} minutes`

	set('stat-miners', number.format(pool.miners.online), 'stat-miners-unit', pool.miners.offline ? `online, ${pool.miners.offline} offline` : 'online')
	const hour = scale(pool.hashrate.hour, HASH_UNITS)
	set('stat-hour', hour.value, 'stat-hour-unit', hour.unit)
	const network = scale(pool.daemon.networkHashrate, HASH_UNITS)
	set('stat-network', pool.daemon.reachable ? network.value : '–', 'stat-network-unit', network.unit)
	set('stat-height', pool.job ? number.format(pool.job.height) : '–', 'stat-height-unit', pool.job ? `${pool.job.reward} VRSC reward` : 'height')
	const time = duration(pool.job?.secondsPerBlock)
	set('stat-time', time.value, 'stat-time-unit', time.unit)
	set('stat-blocks', number.format(pool.blocks.length))
}

function renderPayout(status) {
	const pool = status.pool
	$('payout-address').textContent = status.payoutAddress || 'not set'
	const check = $('payout-state')
	check.className = ''
	if (!status.payoutAddress) {
		check.textContent = 'Enter an address to start mining'
	} else if (pool?.payout.verified) {
		check.textContent = 'The current work pays this address'
		check.className = 'state-good'
	} else if (pool?.payout.error) {
		check.textContent = `Not mining: ${pool.payout.error}`
		check.className = 'state-bad'
	} else {
		check.textContent = 'Not checked yet'
	}
	const input = $('payout-input')
	if (document.activeElement !== input && !input.value) input.placeholder = status.payoutAddress ? 'New R-address' : 'R-address'
	$('payout-save').textContent = status.payoutAddress ? 'Change' : 'Save'
}

function renderConnect(connect) {
	const host = connect.host || location.hostname
	$('stratum-host').textContent = host
	$('stratum-port').textContent = connect.port
	$('stratum-url').textContent = `stratum+tcp://${host}:${connect.port}`
	$('example').textContent = `ccminer -a verus -o stratum+tcp://${host}:${connect.port} -u solo.miner1 -p x`
}

const PILLS = {
	setup: ['starting', 'Setup needed'],
	starting: ['syncing', 'Starting'],
	node: ['syncing', 'Waiting for node'],
	payout: ['error', 'Not mining'],
	ready: ['synced', 'Ready'],
	stopping: ['starting', 'Stopping'],
	stopped: ['error', 'Stopped'],
}

async function refresh() {
	try {
		const response = await fetch('api/status', {cache: 'no-store'})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const status = await response.json()

		const [pill, label] = PILLS[status.phase] || PILLS.starting
		setPill(pill, status.phase === 'ready' && status.pool?.miners.online ? 'Mining' : label)
		$('sync-message').textContent = status.message || ''
		if (status.pool?.daemon.reachable) {
			$('version').textContent = `Solo mining stratum server · verusd ${status.pool.daemon.version} · ${status.pool.daemon.testnet ? 'testnet' : 'mainnet'}`
		}

		renderStats(status.pool)
		renderConnect(status.connect)
		renderPayout(status)
		renderMiners(status.pool)
		renderBlocks(status.pool)

		$('error').hidden = !status.error
		$('error').textContent = status.error || ''
		if (status.error) setPill('error', 'Attention')
	} catch {
		setPill('error', 'Offline')
		$('sync-message').textContent = 'Cannot reach the app. Retrying…'
	}
}

async function refreshLog() {
	if (!$('log-details').open) return
	try {
		const {lines} = await (await fetch('api/logs', {cache: 'no-store'})).json()
		const log = $('log')
		const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24
		log.textContent = lines.length ? lines.join('\n') : 'The log is empty.'
		if (pinned) log.scrollTop = log.scrollHeight
	} catch {
		// keep showing the last log we had
	}
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		// The Clipboard API only exists in secure contexts, and Umbrel is usually opened over plain http.
		const field = document.createElement('textarea')
		field.value = text
		field.setAttribute('readonly', '')
		field.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
		document.body.append(field)
		field.select()
		let copied = false
		try {
			copied = document.execCommand('copy')
		} catch {}
		field.remove()
		return copied
	}
}

for (const button of document.querySelectorAll('[data-copy]')) {
	button.addEventListener('click', async () => {
		button.textContent = (await copyText($(button.dataset.copy).textContent)) ? 'Copied' : 'Select to copy'
		setTimeout(() => (button.textContent = 'Copy'), 2000)
	})
}

$('payout-form').addEventListener('submit', async (event) => {
	event.preventDefault()
	const address = $('payout-input').value.trim()
	const result = $('payout-result')
	if (!address) return
	const current = $('payout-address').textContent
	if (current !== 'not set' && current !== address && !confirm(`Pay block rewards to ${address} instead of ${current}? Miners are disconnected for a moment.`)) return
	result.hidden = false
	result.className = 'hint'
	result.textContent = 'Saving…'
	try {
		const response = await fetch('api/payout', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({address})})
		const body = await response.json()
		if (response.ok) {
			result.textContent = 'Saved. Block rewards will be paid to this address.'
			$('payout-input').value = ''
		} else {
			result.textContent = body.error
			result.className = 'hint state-bad'
		}
	} catch {
		result.textContent = 'Could not save the address. Try again.'
		result.className = 'hint state-bad'
	}
	refresh()
})

$('log-details').addEventListener('toggle', refreshLog)

refresh()
setInterval(refresh, 3000)
setInterval(refreshLog, 5000)
