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
	// shares that were only good enough for a merge-mined chain are listed with that chain's blocks
	const blocks = (pool?.blocks || []).filter((block) => !block.pbaasOnly).reverse()
	$('block-count').textContent = blocks.length ? `(${blocks.length})` : ''
	if (!blocks.length) return emptyRow(body, 5, 'No blocks found yet')
	for (const block of blocks) {
		const row = body.insertRow()
		row.insertCell().textContent = new Date(block.time).toLocaleString()
		numCell(row, number.format(block.height))
		row.insertCell().textContent = String(block.worker).split('.')[1] || block.worker
		numCell(row, `${block.reward} VRSC`)
		row.insertCell().textContent = block.hash
	}
}

function renderStats(pool, mergeChains) {
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
	const merged = (mergeChains || []).reduce((sum, chain) => sum + chain.foundCount, 0)
	set('stat-blocks', number.format(pool.blocks.filter((block) => !block.pbaasOnly).length + merged), 'stat-blocks-unit', merged ? `blocks, ${merged} merge-mined` : 'blocks')
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

// ---------------------------------------------------------------------------
// Merge mining

let chainNames = null

function chainStatus(chain) {
	if (chain.phase === 'off') return ['Off', '']
	if (chain.error) return ['Attention', chain.error]
	if (chain.phase !== 'running' || !chain.node) return [chain.phase === 'waiting' ? 'Waiting' : 'Starting', chain.message || '']
	const node = chain.node
	if (!node.synced) {
		// Never show 100% until the chain is actually at the tip.
		const percent = Math.min(Math.floor(node.progress * 1000) / 10, 99.9)
		return [node.longestChain > 0 ? `Syncing ${percent}%` : 'Waiting for peers', chain.mine ? 'Merge mining starts once it has synced' : '']
	}
	if (chain.mining) return ['Merge mining', '']
	return ['Synchronized', chain.mine ? 'Merge mining starts once VRSC has synced' : '']
}

function makeSwitch(name, key, label) {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = 'switch'
	button.setAttribute('role', 'switch')
	button.setAttribute('aria-checked', 'false')
	button.setAttribute('aria-label', `${label} ${name}`)
	button.addEventListener('click', () => setChain(name, {[key]: button.getAttribute('aria-checked') !== 'true'}, button))
	return button
}

function renderMerge(status) {
	const merge = status.merge || {available: false, chains: []}
	$('merge-unavailable').hidden = merge.available
	$('merge-unavailable').textContent = merge.message || ''
	$('merge-body').hidden = !merge.available
	if (!merge.available) {
		$('merge-state').textContent = ''
		$('merge-blocks-card').hidden = true
		return
	}

	const chains = merge.chains
	const mining = chains.filter((chain) => chain.mining).length
	$('merge-state').textContent = mining ? `· ${mining} chain${mining > 1 ? 's' : ''}` : '· off'
	$('merge-payout').textContent = merge.payoutAddress || 'not set'
	const work = status.pool?.merged
	$('merge-work').textContent = !work
		? '–'
		: work.chains
			? `${work.chains} merge-mined chain${work.chains > 1 ? 's' : ''} next to VRSC`
			: 'VRSC only'

	// Rows are only rebuilt when the list of chains changes, so the switches keep their focus.
	const body = $('chain-rows')
	const names = chains.map((chain) => chain.name).join(',')
	if (names !== chainNames) {
		chainNames = names
		body.replaceChildren()
		for (const chain of chains) {
			const row = body.insertRow()
			for (let cell = 0; cell < 4; cell++) row.insertCell()
			row.insertCell().append(makeSwitch(chain.name, 'enabled', 'Run'))
			row.insertCell().append(makeSwitch(chain.name, 'mine', 'Merge mine'))
		}
		if (!chains.length) {
			const cell = body.insertRow().insertCell()
			cell.colSpan = 6
			cell.className = 'empty'
			cell.textContent = 'No chains known yet'
		}
	}
	chains.forEach((chain, index) => {
		const [name, state, height, found, run, mine] = body.rows[index].cells
		name.className = 'chain-name'
		name.textContent = chain.name
		const [text, detail] = chainStatus(chain)
		state.className = 'chain-status'
		state.replaceChildren(text)
		if (detail) {
			const small = document.createElement('small')
			small.textContent = detail
			state.append(small)
		}
		height.className = found.className = 'num'
		height.textContent = chain.node ? number.format(chain.node.blocks) : '–'
		found.textContent = number.format(chain.foundCount)
		run.firstChild.setAttribute('aria-checked', String(!!chain.enabled))
		mine.firstChild.setAttribute('aria-checked', String(!!chain.mine))
	})

	const blocks = chains.flatMap((chain) => (chain.found || []).map((block) => ({...block, chain: chain.name}))).sort((a, b) => b.time - a.time)
	const total = chains.reduce((sum, chain) => sum + chain.foundCount, 0)
	$('merge-blocks-card').hidden = !total
	$('merge-block-count').textContent = total ? `(${total})` : ''
	const table = $('merge-blocks')
	table.replaceChildren()
	for (const block of blocks.slice(0, 50)) {
		const row = table.insertRow()
		row.insertCell().textContent = new Date(block.time).toLocaleString()
		row.insertCell().textContent = block.chain
		const height = row.insertCell()
		height.className = 'num'
		height.textContent = number.format(block.height)
		const reward = row.insertCell()
		reward.className = 'num'
		reward.textContent = `${block.reward} ${block.chain}`
		const hash = row.insertCell()
		const code = document.createElement('code')
		code.textContent = block.hash
		hash.append(code)
	}
}

async function setChain(name, patch, button) {
	const result = $('merge-result')
	if (patch.enabled === false && !confirm(`Stop the ${name} chain? Merge mining it stops too. Its downloaded blockchain is kept.`)) return
	button.disabled = true
	try {
		const response = await fetch(`api/chains/${name}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(patch)})
		const body = await response.json().catch(() => ({}))
		if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
		result.hidden = true
	} catch (error) {
		result.hidden = false
		result.textContent = error.message
	} finally {
		button.disabled = false
	}
	refresh()
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

		renderStats(status.pool, status.merge?.chains)
		renderConnect(status.connect)
		renderPayout(status)
		renderMiners(status.pool)
		renderBlocks(status.pool)
		renderMerge(status)

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
