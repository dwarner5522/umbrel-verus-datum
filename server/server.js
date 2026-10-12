'use strict'

// Runs the Verus solo stratum server (verus-datum-cli) and serves the dashboard, its JSON API
// and the Umbrel widgets. No npm dependencies: everything here is Node's standard library.

const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const {spawn} = require('node:child_process')

const config = {
	httpPort: Number(process.env.PORT || 3000),
	stratumDir: process.env.STRATUM_DIR || '/opt/verus-datum-cli',
	dataDir: process.env.DATA_DIR || '/data',
	stratumPort: Number(process.env.STRATUM_PORT || 9999),
	// the stratum server's own command port, only ever on loopback
	commandPort: Number(process.env.COMMAND_PORT || 17117),
	startDifficulty: Number(process.env.START_DIFFICULTY || 8192),
	daemon: {
		host: process.env.DAEMON_HOST || '',
		port: Number(process.env.DAEMON_RPC_PORT || 27486),
		user: process.env.DAEMON_RPC_USER || '',
		password: process.env.DAEMON_RPC_PASS || '',
	},
	// The Verus Node app's own API: it runs the PBaaS chain daemons and switches their merge mining.
	nodeUrl: (process.env.NODE_API_URL || '').replace(/\/+$/, ''),
	deviceDomainName: process.env.DEVICE_DOMAIN_NAME || '',
}

const SETTINGS_FILE = path.join(config.dataDir, 'settings.json')
const STRATUM_CONFIG_FILE = path.join(config.dataDir, 'stratum.json')
const RESTART_DELAY_MS = 10_000
const POLL_INTERVAL_MS = 3_000
const LOG_LINES = 300

// the same address check the stratum server applies to its own config
const payout = require(path.join(config.stratumDir, 'lib/stratum/payout.js'))

const state = {
	// setup (no payout address yet) -> starting -> node (waiting for the Verus node) -> ready; payout, stopped
	phase: 'setup',
	message: 'Enter a payout address to start.',
	error: null,
	payoutAddress: null,
	pool: null,
	// PBaaS chains as the Verus Node app reports them; available is false when that app is too old or not reachable
	merge: {available: false, message: 'Merge mining needs the Verus Node app.', payoutAddress: '', chains: []},
	updatedAt: null,
}

const logLines = []
let child = null
let shuttingDown = false
let restartTimer = null
let pollTimer = null
let mergeTimer = null

const log = (...args) => console.log(new Date().toISOString(), ...args)

// ---------------------------------------------------------------------------
// Settings

async function loadSettings() {
	try {
		const settings = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'))
		payout.addressToScript(settings.payoutAddress)
		state.payoutAddress = settings.payoutAddress
	} catch (error) {
		if (error.code !== 'ENOENT') log('Ignoring unreadable settings:', error.message)
	}
}

async function writeFileAtomic(file, content) {
	await fsp.writeFile(`${file}.tmp`, content, {mode: 0o600})
	await fsp.rename(`${file}.tmp`, file)
}

async function savePayoutAddress(address) {
	payout.addressToScript(address) // throws with a readable message
	await writeFileAtomic(SETTINGS_FILE, JSON.stringify({payoutAddress: address}, null, '\t') + '\n')
	state.payoutAddress = address
}

// ---------------------------------------------------------------------------
// Stratum server process

function stratumConfig() {
	return {
		logLevel: 'info',
		logColors: false,
		cliHost: '127.0.0.1',
		cliPort: config.commandPort,
		daemon: config.daemon,
		payoutAddress: state.payoutAddress,
		blocksFile: path.join(config.dataDir, 'blocks.log'),
		stratumHost: '0.0.0.0',
		ports: {
			[config.stratumPort]: {
				diff: config.startDifficulty,
				varDiff: {minDiff: 256, maxDiff: 1048576, targetTime: 15, retargetTime: 60, variancePercent: 30},
			},
		},
		blockRefreshInterval: 1000,
		jobRebroadcastTimeout: 55,
		connectionTimeout: 600,
		hashrateWindow: 300,
		statusInterval: 600,
		banning: {enabled: false},
	}
}

function pumpOutput(stream) {
	let pending = ''
	stream.setEncoding('utf8')
	stream.on('data', (chunk) => {
		const lines = (pending + chunk).split('\n')
		pending = lines.pop()
		for (const line of lines) {
			if (!line) continue
			logLines.push(line)
			if (logLines.length > LOG_LINES) logLines.shift()
			console.log(line)
		}
	})
}

async function startStratum() {
	if (shuttingDown || child || !state.payoutAddress) return
	await writeFileAtomic(STRATUM_CONFIG_FILE, JSON.stringify(stratumConfig(), null, '\t') + '\n')

	state.phase = 'starting'
	state.message = 'Starting the stratum server…'
	state.pool = null

	log('Starting the stratum server')
	child = spawn(process.execPath, [path.join(config.stratumDir, 'init.js'), '--no-console', STRATUM_CONFIG_FILE], {
		cwd: config.stratumDir,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	pumpOutput(child.stdout)
	pumpOutput(child.stderr)

	const started = child
	child.on('error', (error) => {
		log('Failed to start the stratum server:', error.message)
		if (child === started) child = null
		state.phase = 'stopped'
		state.error = `Failed to start the stratum server: ${error.message}`
		if (!shuttingDown) restartTimer = setTimeout(startStratum, RESTART_DELAY_MS)
	})
	child.on('exit', (code, signal) => {
		log(`Stratum server exited (code=${code} signal=${signal})`)
		if (child !== started) return
		child = null
		state.pool = null
		if (shuttingDown) return
		state.phase = 'stopped'
		state.message = 'The stratum server stopped. Restarting…'
		if (code !== 0) state.error = `The stratum server exited unexpectedly (${signal || `code ${code}`}). See the log below.`
		restartTimer = setTimeout(startStratum, RESTART_DELAY_MS)
	})
}

function stopStratum() {
	return new Promise((resolve) => {
		clearTimeout(restartTimer)
		if (!child) return resolve()
		const stopping = child
		child = null
		state.pool = null
		stopping.once('exit', resolve)
		stopping.kill('SIGTERM')
	})
}

// One command to the stratum server's command port: a line of JSON in, text out.
function command(name) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({host: '127.0.0.1', port: config.commandPort})
		let reply = ''
		socket.setEncoding('utf8')
		socket.setTimeout(15_000, () => socket.destroy(new Error('timeout')))
		socket.on('connect', () => socket.write(JSON.stringify({command: name, params: []}) + '\n'))
		socket.on('data', (chunk) => (reply += chunk))
		socket.on('end', () => resolve(reply))
		socket.on('error', reject)
	})
}

let polling = false
async function poll() {
	if (!child || shuttingDown || polling) return
	polling = true
	try {
		const pool = JSON.parse(await command('json'))
		if (!child) return
		state.pool = pool
		state.updatedAt = Date.now()
		state.error = null

		if (!pool.daemon.reachable) {
			state.phase = 'node'
			state.message = 'Waiting for the Verus node…'
		} else if (pool.payout.address && pool.payout.checkedAt && !pool.payout.verified) {
			// the node handed out work that pays someone else; no miner is given that work
			state.phase = 'payout'
			state.message = 'Waiting for work that pays your address.'
		} else if (!pool.stratum.listening) {
			const behind = pool.daemon.longestChain > pool.daemon.blocks
			state.phase = 'node'
			state.message = behind
				? `Waiting for the Verus node to finish syncing (block ${pool.daemon.blocks} of ${pool.daemon.longestChain}).`
				: 'Waiting for the Verus node to hand out work…'
		} else {
			state.phase = 'ready'
			state.message = pool.miners.online > 0 ? 'Mining' : 'Ready for miners'
		}
	} catch {
		// not listening yet, the next poll will tell
	} finally {
		polling = false
	}
}

// ---------------------------------------------------------------------------
// Merge mining (PBaaS chains run by the Verus Node app)

async function nodeFetch(pathname, body) {
	const response = await fetch(`${config.nodeUrl}${pathname}`, {
		method: body ? 'POST' : 'GET',
		headers: body ? {'content-type': 'application/json'} : {},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(8000),
	})
	const result = await response.json().catch(() => ({}))
	if (!response.ok) {
		const error = new Error(result.error || `HTTP ${response.status}`)
		error.status = response.status
		throw error
	}
	return result
}

function setMerge({chains, payoutAddress}) {
	state.merge = {available: true, message: null, payoutAddress: payoutAddress || '', chains: Array.isArray(chains) ? chains : []}
}

// Rewards of merge-mined chains are paid by each chain's own daemon, so the node has to know the address.
// Only fill it in when the node has none: an address chosen in the Verus Node app is left alone.
async function sharePayoutAddress(force) {
	if (!config.nodeUrl || !state.payoutAddress || !state.merge.available) return
	if (state.merge.payoutAddress === state.payoutAddress) return
	if (state.merge.payoutAddress && !force) return
	setMerge(await nodeFetch('/api/payout', {address: state.payoutAddress}))
	log(`Merge mining payout address set to ${state.payoutAddress}`)
}

let mergePolling = false
async function pollMerge() {
	if (!config.nodeUrl || mergePolling || shuttingDown) return
	mergePolling = true
	try {
		setMerge(await nodeFetch('/api/chains'))
		await sharePayoutAddress(false)
	} catch (error) {
		state.merge = {
			available: false,
			message: error.status === 404 ? 'Update the Verus Node app to merge mine PBaaS chains.' : 'The Verus Node app is not reachable.',
			payoutAddress: '',
			chains: [],
		}
	} finally {
		mergePolling = false
	}
}

// ---------------------------------------------------------------------------
// HTTP

const PUBLIC_DIR = path.join(__dirname, 'public')
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'})
	response.end(body)
}

async function sendStatic(response, urlPath) {
	const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1)
	const file = path.join(PUBLIC_DIR, relative)
	if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) return sendJson(response, 404, {error: 'Not found'})
	try {
		const content = await fsp.readFile(file)
		response.writeHead(200, {'content-type': MIME[path.extname(file)], 'cache-control': 'no-cache'})
		response.end(content)
	} catch {
		sendJson(response, 404, {error: 'Not found'})
	}
}

function readJsonBody(request, limit = 4096) {
	return new Promise((resolve, reject) => {
		let body = ''
		request.setEncoding('utf8')
		request.on('data', (chunk) => {
			body += chunk
			if (body.length > limit) reject(new Error('Request too large'))
		})
		request.on('end', () => {
			try {
				resolve(JSON.parse(body))
			} catch {
				reject(new Error('Invalid request'))
			}
		})
		request.on('error', reject)
	})
}

function formatHashrate(hashps) {
	const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s']
	let value = Number(hashps) || 0
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000
		unit++
	}
	return {text: value >= 100 ? value.toFixed(0) : value.toFixed(1), subtext: units[unit]}
}

function formatDuration(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return {text: '-', subtext: ''}
	if (seconds < 5400) return {text: String(Math.max(Math.round(seconds / 60), 1)), subtext: 'minutes'}
	if (seconds < 172800) return {text: (seconds / 3600).toFixed(1), subtext: 'hours'}
	if (seconds < 63072000) return {text: (seconds / 86400).toFixed(1), subtext: 'days'}
	return {text: (seconds / 31557600).toFixed(1), subtext: 'years'}
}

// VRSC blocks plus the blocks found on merge-mined chains
function blocksFound(pool) {
	const merged = state.merge.chains.reduce((sum, chain) => sum + (Number(chain.foundCount) || 0), 0)
	return pool.blocks.filter((block) => !block.pbaasOnly).length + merged
}

function widgetStats() {
	const pool = state.pool
	const hashrate = formatHashrate(pool?.hashrate.current)
	const time = formatDuration(pool?.job?.secondsPerBlock)
	return {
		type: 'four-stats',
		refresh: '5s',
		link: '',
		items: [
			{title: 'Hashrate', text: pool ? hashrate.text : '-', subtext: hashrate.subtext},
			{title: 'Miners', text: pool ? String(pool.miners.online) : '-', subtext: 'online'},
			{title: 'Blocks found', text: pool ? String(blocksFound(pool)) : '-', subtext: 'blocks'},
			{title: 'Time to block', text: time.text, subtext: time.subtext || 'average'},
		],
	}
}

function connectDetails() {
	return {host: config.deviceDomainName, port: config.stratumPort}
}

// State-changing requests must come from our own page: browsers can't send a JSON content type
// cross-origin without a preflight, and the Origin header has to match the host we were reached on.
function isSameOrigin(request) {
	if (!(request.headers['content-type'] || '').startsWith('application/json')) return false
	const origin = request.headers.origin
	if (!origin) return true
	try {
		return new URL(origin).host === request.headers.host
	} catch {
		return false
	}
}

const server = http.createServer(async (request, response) => {
	const {pathname} = new URL(request.url, 'http://localhost')
	try {
		if (request.method === 'GET') {
			if (pathname === '/api/status') return sendJson(response, 200, {...state, connect: connectDetails()})
			if (pathname === '/api/logs') return sendJson(response, 200, {lines: logLines})
			if (pathname === '/api/widget/stats') return sendJson(response, 200, widgetStats())
			if (pathname.startsWith('/api/')) return sendJson(response, 404, {error: 'Not found'})
			return await sendStatic(response, pathname)
		}
		if (request.method === 'POST' && pathname === '/api/payout') {
			if (!isSameOrigin(request)) return sendJson(response, 403, {error: 'Forbidden'})
			let address
			try {
				address = String((await readJsonBody(request)).address || '').trim()
				payout.addressToScript(address)
			} catch (error) {
				return sendJson(response, 400, {error: error.message})
			}
			if (address !== state.payoutAddress) {
				await stopStratum()
				await savePayoutAddress(address)
				log(`Payout address set to ${address}`)
				state.error = null
				await startStratum()
			}
			// the merge-mined chains follow the address chosen here
			await sharePayoutAddress(true).catch((error) => log('Could not set the merge mining payout address:', error.message))
			return sendJson(response, 200, {ok: true, payoutAddress: address})
		}
		// Switch a PBaaS chain or its merge mining on or off: {"enabled": true} or {"mine": true}
		const chainPost = request.method === 'POST' && /^\/api\/chains\/([A-Za-z0-9]+)$/.exec(pathname)
		if (chainPost) {
			if (!isSameOrigin(request)) return sendJson(response, 403, {error: 'Forbidden'})
			let patch
			try {
				const body = await readJsonBody(request)
				patch = {enabled: body.enabled, mine: body.mine}
			} catch (error) {
				return sendJson(response, 400, {error: error.message})
			}
			if (!state.merge.available) return sendJson(response, 409, {error: state.merge.message})
			if (patch.mine === true && !state.payoutAddress && !state.merge.payoutAddress) {
				return sendJson(response, 409, {error: 'Enter a payout address first.'})
			}
			try {
				await sharePayoutAddress(false)
				setMerge(await nodeFetch(`/api/chains/${chainPost[1]}`, patch))
			} catch (error) {
				return sendJson(response, error.status >= 400 && error.status < 500 ? error.status : 502, {error: error.message})
			}
			return sendJson(response, 200, {ok: true, merge: state.merge})
		}
		sendJson(response, 405, {error: 'Method not allowed'})
	} catch (error) {
		log('Request failed:', error.message)
		sendJson(response, 500, {error: 'Internal error'})
	}
})

// ---------------------------------------------------------------------------
// Lifecycle

async function shutdown(signal) {
	if (shuttingDown) return
	shuttingDown = true
	log(`${signal} received, stopping the stratum server`)
	state.phase = 'stopping'
	state.message = 'Shutting down…'
	clearInterval(pollTimer)
	clearInterval(mergeTimer)
	server.close()
	server.closeAllConnections?.()
	await stopStratum()
	process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

async function main() {
	if (!config.daemon.host || !config.daemon.user || !config.daemon.password) {
		console.error('DAEMON_HOST, DAEMON_RPC_USER and DAEMON_RPC_PASS are required')
		process.exit(1)
	}
	await fsp.mkdir(config.dataDir, {recursive: true})
	await loadSettings()
	server.listen(config.httpPort, () => log(`Dashboard listening on :${config.httpPort}`))
	if (state.payoutAddress) await startStratum()
	else log('No payout address yet, the stratum server starts once one is entered in the app')
	pollTimer = setInterval(poll, POLL_INTERVAL_MS)
	if (config.nodeUrl) {
		pollMerge()
		mergeTimer = setInterval(pollMerge, POLL_INTERVAL_MS)
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
