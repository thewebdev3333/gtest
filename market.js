// market.js
const db = require('./database')
const houseEdge = require('./houseEdge')

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

  // Edge cases for Over/Under (barrier 0 + over, barrier 9 + under)
const OVER_UNDER_EDGE_MULTIPLIER = 1.19

// Match/Differ: 'differ' wins ~90% of time - same discounted rate as edges
const MATCH_DIFFER_DIFFER_MULTIPLIER = 1.19

function calculatePayout(contractType, stake, direction = null, selectedDigit = null, accountClass = null) {
  const override = houseEdge.getMultiplier(accountClass, contractType, direction, selectedDigit)
  if (override !== null) {
    return parseFloat((stake * override).toFixed(8))
  }

  let multiplier = PAYOUT_MULTIPLIERS[contractType] ?? 1.88
  
  // Special case: Over/Under edge barriers
  if (contractType === 'over_under' && direction && selectedDigit !== null) {
    const isEdge = (selectedDigit === 0 && direction === 'over') || 
                   (selectedDigit === 9 && direction === 'under')
    if (isEdge) {
      multiplier = OVER_UNDER_EDGE_MULTIPLIER
      console.log(`[Payout] Edge case detected: ${direction} ${selectedDigit}  multiplier ${multiplier}`)
    }
  }

  // Match/Differ: 'differ' has ~90% win rate
  if (contractType === 'match_differ' && direction === 'differ') {
    multiplier = MATCH_DIFFER_DIFFER_MULTIPLIER
  }
  
  return parseFloat((stake * multiplier).toFixed(8))
}

// ── Outcome Resolution ────────────────────────────────────────────

function naturalOutcome(contract, exitPrice) {
  const entry = parseFloat(contract.entry_price)
  const exit = parseFloat(exitPrice)
  const dir = contract.direction

  switch (contract.contract_type) {
    case 'rise_fall':
      return dir === 'rise' ? (exit > entry ? 'win' : 'loss')
                            : (exit < entry ? 'win' : 'loss')

    case 'over_under': {
      const selectedDigit = contract.selected_digit ?? 5
      const lastDigit = Math.floor(exit) % 10
      return dir === 'over' ? (lastDigit > selectedDigit ? 'win' : 'loss')
                            : (lastDigit < selectedDigit ? 'win' : 'loss')
    }

    case 'even_odd': {
      const lastDigit = Math.floor(exit) % 10
      return dir === 'even' ? (lastDigit % 2 === 0 ? 'win' : 'loss')
                            : (lastDigit % 2 !== 0 ? 'win' : 'loss')
    }

    case 'match_differ': {
      const selectedDigit = contract.selected_digit ?? 0
      const exitDigit = Math.floor(exit) % 10
      return dir === 'match' ? (exitDigit === selectedDigit ? 'win' : 'loss')
                             : (exitDigit !== selectedDigit ? 'win' : 'loss')
    }

    default: return 'loss'
  }
}

function resolveOutcome(contract, exitPrice) {
  return houseEdge.applyForcedOutcome(contract.id, naturalOutcome(contract, exitPrice))
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

  const due = contracts.filter(
    (c) => parseInt(c.entry_tick) + parseInt(c.duration_ticks) <= currentTick
  )
  if (due.length === 0) return

  // One round trip for the whole batch. This used to be four round trips
  // per contract (conditional update, credit balance, insert transaction,
  // update P/L), all awaited inside the tick's setInterval callback -
  // so a busy tick delayed the next tick for every symbol.
  const settledAt = new Date().toISOString()
  const items = due.map((c) => ({
    contract_id: c.id,
    exit_price: currentPrice,
    outcome: resolveOutcome(c, currentPrice),
    settled_at: settledAt,
  }))

  let results
  try {
    results = await db.settleContracts(items)
  } catch (err) {
    console.error('Settlement error for', symbolId, err)
    return
  }

  for (const r of results) {
    // Lost the race - some other path already settled this contract.
    if (r.already_settled) continue

    const payout = parseFloat(r.payout)
    const pnl = parseFloat(r.pl)

    if (r.outcome === 'win') {
      console.log(`[Settle] User ${r.user_id} won ${payout} on contract ${r.contract_id}`)
    } else {
      console.log(`[Settle] User ${r.user_id} lost on contract ${r.contract_id}`)
    }

    notifyUser(r.user_id, {
      type: 'contract_settled',
      contractId: r.contract_id,
      outcome: r.outcome,
      payout,
      exitPrice: currentPrice,
      pnl,
    })
  }

  for (const c of due) houseEdge.forgetContract(c.id)
}

// ── Engine ────────────────────────────────────────────────────────

function startEngine() {
  for (const symbol of Object.values(SYMBOLS)) {
    setInterval(async () => {
      try {
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
      } catch (err) {
        console.error(`[Engine] Error processing tick for ${symbol.id}:`, err)
      }
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
  resolveOutcome,
  SYMBOLS,
  PAYOUT_MULTIPLIERS,
  OVER_UNDER_EDGE_MULTIPLIER,
}