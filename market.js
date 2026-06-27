// market.js
const db = require('./database')

const SYMBOLS = {
  V20_1S: {
    id: 'V20_1S',
    label: 'Volatility 20 (1s) Index',
    sigma: 0.0002,
    tickIntervalMs: 1000,
    startPrice: 5000,
  },
  V50_1S: {
    id: 'V50_1S',
    label: 'Volatility 50 (1s) Index',
    sigma: 0.0008,
    tickIntervalMs: 1000,
    startPrice: 8000,
  },
  V100_1S: {
    id: 'V100_1S',
    label: 'Volatility 100 (1s) Index',
    sigma: 0.002,
    tickIntervalMs: 1000,
    startPrice: 10000,
  },
}

const TICK_BUFFER_SIZE = 500

const engineState = {
  V20_1S: { price: 5000, tickCount: 0, sessionOpen: 5000 },
  V50_1S: { price: 8000, tickCount: 0, sessionOpen: 8000 },
  V100_1S: { price: 10000, tickCount: 0, sessionOpen: 10000 },
}

const tickBuffers = {
  V20_1S: [],
  V50_1S: [],
  V100_1S: [],
}

const latestTick = {
  V20_1S: null,
  V50_1S: null,
  V100_1S: null,
}

const subscribers = {
  V20_1S: new Set(),
  V50_1S: new Set(),
  V100_1S: new Set(),
}

const userConnections = new Map()

// ── Price Generation ──────────────────────────────────────────────

function gaussianRandom() {
  let u, v
  do { u = Math.random() } while (u === 0)
  do { v = Math.random() } while (v === 0)
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

function nextPrice(currentPrice, sigma) {
  const change = currentPrice * sigma * gaussianRandom()
  return Math.max(0.01, parseFloat((currentPrice + change).toFixed(5)))
}

// ── Payout Calculation ────────────────────────────────────────────

const PAYOUT_MULTIPLIERS = {
  rise_fall: 1.88,
  over_under: 1.88,
  even_odd: 1.96,
  match_differ: 8.00,
}

function calculatePayout(contractType, stake) {
  const multiplier = PAYOUT_MULTIPLIERS[contractType] ?? 1.88
  return parseFloat((stake * multiplier).toFixed(8))
}

// ── Outcome Resolution ────────────────────────────────────────────

function resolveOutcome(contract, exitPrice) {
  const entry = parseFloat(contract.entry_price)
  const exit = parseFloat(exitPrice)
  const dir = contract.direction

  switch (contract.contract_type) {
    case 'rise_fall':
      return dir === 'rise' ? (exit > entry ? 'win' : 'loss')
                            : (exit < entry ? 'win' : 'loss')

    case 'over_under':
      return dir === 'over' ? (exit > entry ? 'win' : 'loss')
                            : (exit < entry ? 'win' : 'loss')

    case 'even_odd': {
      const lastDigit = Math.floor(exit) % 10
      return dir === 'even' ? (lastDigit % 2 === 0 ? 'win' : 'loss')
                            : (lastDigit % 2 !== 0 ? 'win' : 'loss')
    }

    case 'match_differ': {
      const exitDigit = Math.floor(exit) % 10
      const entryDigit = Math.floor(entry) % 10
      return dir === 'match' ? (exitDigit === entryDigit ? 'win' : 'loss')
                             : (exitDigit !== entryDigit ? 'win' : 'loss')
    }

    default: return 'loss'
  }
}

// ── Broadcasting ──────────────────────────────────────────────────

function broadcastTick(symbolId, tick) {
  const payload = JSON.stringify({ type: 'tick', ...tick })
  for (const ws of subscribers[symbolId]) {
    if (ws.readyState === 1) {
      ws.send(payload)
    } else {
      subscribers[symbolId].delete(ws)
    }
  }
}

function notifyUser(userId, message) {
  const connections = userConnections.get(userId)
  if (!connections) return
  const payload = JSON.stringify(message)
  for (const ws of connections) {
    if (ws.readyState === 1) ws.send(payload)
    else connections.delete(ws)
  }
}

// ── Contract Settlement ───────────────────────────────────────────

async function settleExpiredContracts(symbolId, currentPrice, currentTick) {
  let contracts
  try {
    contracts = await db.getOpenContractsBySymbol(symbolId, currentTick)
  } catch (err) {
    console.error('Failed to fetch contracts for settlement:', err)
    return
  }

  for (const contract of contracts) {
    if (parseInt(contract.entry_tick) + parseInt(contract.duration_ticks) > currentTick) continue
    await settleOneContract(contract, currentPrice)
  }
}

async function settleOneContract(contract, exitPrice) {
  const outcome = resolveOutcome(contract, exitPrice)
  const payout = outcome === 'win' ? parseFloat(contract.potential_payout) : 0
  const pl = parseFloat((payout - parseFloat(contract.stake)).toFixed(8))

  try {
    await db.settleContract(contract.id, {
      exitPrice,
      outcome,
      settledAt: new Date().toISOString(),
    })

    if (outcome === 'win') {
      await db.addBalance(contract.account_id, payout)
      await db.createTransaction({
        user_id: contract.user_id,
        type: 'trade_win',
        amount_usd: payout,
        status: 'completed',
      })
    } else {
      await db.createTransaction({
        user_id: contract.user_id,
        type: 'trade_loss',
        amount_usd: parseFloat(contract.stake),
        status: 'completed',
      })
    }

    await db.updatePL(contract.account_id, pl)

  } catch (err) {
    console.error('Settlement error for contract', contract.id, err)
    return
  }

  notifyUser(contract.user_id, {
    type: 'contract_settled',
    contractId: contract.id,
    outcome,
    payout,
    exitPrice,
    pl,
  })
}

// ── Engine ────────────────────────────────────────────────────────

function startEngine() {
  for (const symbol of Object.values(SYMBOLS)) {
    setInterval(async () => {
      const state = engineState[symbol.id]

      state.price = nextPrice(state.price, symbol.sigma)
      state.tickCount++

      const change = parseFloat((state.price - state.sessionOpen).toFixed(5))
      const changePct = parseFloat(((change / state.sessionOpen) * 100).toFixed(4))

      const tick = {
        symbol: symbol.id,
        price: state.price,
        tick: state.tickCount,
        change,
        changePct,
        timestamp: Date.now(),
      }

      latestTick[symbol.id] = tick

      tickBuffers[symbol.id].push(tick)
      if (tickBuffers[symbol.id].length > TICK_BUFFER_SIZE) {
        tickBuffers[symbol.id].shift()
      }

      broadcastTick(symbol.id, tick)
      await settleExpiredContracts(symbol.id, state.price, state.tickCount)

    }, symbol.tickIntervalMs)
  }
}

// ── WebSocket Handler ─────────────────────────────────────────────

function handleWsConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost')
  const token = url.searchParams.get('token')
  let userId = null

  if (token) {
    try {
      const jwt = require('jsonwebtoken')
      const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET)
      userId = payload.sub
      if (!userConnections.has(userId)) userConnections.set(userId, new Set())
      userConnections.get(userId).add(ws)
    } catch {
      // Invalid token - connection still allowed for public tick stream
    }
  }

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    switch (msg.type) {
      case 'subscribe': {
        const sym = msg.symbol
        if (!SYMBOLS[sym]) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            code: 'INVALID_SYMBOL', 
            message: 'Unknown symbol' 
          }))
        }
        subscribers[sym].add(ws)

        ws.send(JSON.stringify({ 
          type: 'history', 
          symbol: sym, 
          ticks: tickBuffers[sym] 
        }))

        if (latestTick[sym]) {
          ws.send(JSON.stringify({ type: 'tick', ...latestTick[sym] }))
        }
        break
      }

      case 'unsubscribe':
        subscribers[msg.symbol]?.delete(ws)
        break

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }))
        break
    }
  })

  ws.on('close', () => {
    for (const set of Object.values(subscribers)) set.delete(ws)
    if (userId) userConnections.get(userId)?.delete(ws)
  })
}

function getLatestTick(symbolId) {
  return latestTick[symbolId]
}

module.exports = {
  startEngine,
  handleWsConnection,
  getLatestTick,
  calculatePayout,
  SYMBOLS,
  PAYOUT_MULTIPLIERS,
}