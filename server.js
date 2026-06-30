// server.js
require('dotenv').config()

const http = require('http')
const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const { WebSocketServer } = require('ws')

const db = require('./database')
const mw = require('./middleware')
const auth = require('./auth')
const wallet = require('./wallet')
const market = require('./market')
const admin = require('./admin')
const exchange = require('./exchange')

const app = express()
const httpServer = http.createServer(app)

// ── Global middleware ──────────────────────────────────────────────

app.use(mw.securityHeaders())
app.use(cors(mw.corsOptions))
app.use(express.json({ limit: '10kb' }))
app.use(morgan('combined'))
app.use(mw.apiLimiter)

// ── Health check ───────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// ── Auth routes ────────────────────────────────────────────────────

app.post('/auth/on-signup', auth.onSignup)
app.get('/auth/me', mw.authenticate, auth.getMe)
app.patch('/auth/profile', mw.authenticate, mw.validators.updateProfile, mw.validate, auth.updateProfile)

// ── Trade routes ───────────────────────────────────────────────────

app.get('/trade/symbols', (req, res) => {
  res.json({ success: true, data: { symbols: Object.values(market.SYMBOLS) } })
})

app.get('/trade/payout-preview', (req, res) => {
  const { contractType, stake } = req.query
  if (!contractType || !stake) {
    return res.status(400).json({ 
      success: false, 
      error: 'contractType and stake required.', 
      code: 'VALIDATION_ERROR' 
    })
  }
  const payout = market.calculatePayout(contractType, parseFloat(stake))
  res.json({ success: true, data: { potentialPayout: payout } })
})

app.post('/trade/place', 
  mw.authenticate, 
  mw.validators.placeTrade, 
  mw.validate, 
  async (req, res, next) => {
    try {
      const { accountType, symbol, contractType, direction, selectedDigit, stake, durationTicks } = req.body

      const account = await db.getAccountByUserAndType(req.user.id, accountType)
      if (!account) {
        return res.status(404).json({ 
          success: false, 
          error: 'Account not found.', 
          code: 'NOT_FOUND' 
        })
      }

      const tick = market.getLatestTick(symbol)
      if (!tick) {
        return res.status(503).json({ 
          success: false, 
          error: 'Market not ready.', 
          code: 'MARKET_UNAVAILABLE' 
        })
      }

      const potentialPayout = market.calculatePayout(contractType, stake)

      await db.deductBalance(account.id, stake)
      await db.createTransaction({ 
        user_id: req.user.id, 
        type: 'stake', 
        amount_usd: stake, 
        status: 'completed' 
      })

      const contract = await db.createContract({
        user_id: req.user.id,
        account_id: account.id,
        symbol,
        contract_type: contractType,
        direction,
        selected_digit: selectedDigit ?? null,
        stake,
        potential_payout: potentialPayout,
        entry_price: tick.price,
        entry_tick: tick.tick,
        duration_ticks: durationTicks,
      })

      res.json({
        success: true,
        data: {
          contractId: contract.id,
          entryPrice: tick.price,
          entryTick: tick.tick,
          potentialPayout,
          expiresAtTick: tick.tick + durationTicks,
        },
      })
    } catch (err) {
      if (err.message === 'INSUFFICIENT_BALANCE') {
        return res.status(400).json({ 
          success: false, 
          error: 'Insufficient balance.', 
          code: 'INSUFFICIENT_BALANCE' 
        })
      }
      next(err)
    }
  }
)

// ── Position routes ────────────────────────────────────────────────

app.get('/positions/open', 
  mw.authenticate, 
  async (req, res, next) => {
    try {
      const { accountType = 'real' } = req.query
      const account = await db.getAccountByUserAndType(req.user.id, accountType)
      const positions = await db.getOpenContractsByAccount(account.id)
      res.json({ success: true, data: { positions } })
    } catch (err) { next(err) }
  }
)

app.get('/positions/history', 
  mw.authenticate, 
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, accountType = 'real' } = req.query
      const account = await db.getAccountByUserAndType(req.user.id, accountType)
      const positions = await db.getContractsByAccount(account.id, {
        limit: parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit),
      })
      res.json({ 
        success: true, 
        data: { 
          positions, 
          page: parseInt(page), 
          limit: parseInt(limit) 
        } 
      })
    } catch (err) { next(err) }
  }
)

app.get('/positions/:id',
  mw.authenticate,
  mw.requireOwnership(req => db.getContractById(req.params.id)),
  (req, res) => res.json({ success: true, data: { position: req.resource } })
)

// ── Wallet routes ──────────────────────────────────────────────────

app.get('/wallet/balance', mw.authenticate, wallet.getBalance)
app.get('/wallet/transactions', mw.authenticate, wallet.getTransactions)
app.get('/wallet/rate', wallet.getRateHandler)
app.get('/wallet/withdrawals', mw.authenticate, wallet.getWithdrawals)

app.post('/wallet/deposit/mpesa', 
  mw.authenticate, 
  mw.checkIdempotency(),
  mw.validators.depositMpesa, 
  mw.validate, 
  wallet.depositMpesa
)

app.post('/wallet/palpluss/callback', wallet.palplussCallback)

app.post('/wallet/withdraw/mpesa', 
  mw.authenticate, 
  mw.withdrawalLimiter,
  mw.checkIdempotency(),
  mw.validators.withdrawMpesa, 
  mw.validate, 
  wallet.withdrawMpesa
)

app.post('/wallet/kyc/upload', 
  mw.authenticate, 
  wallet.kycUpload.fields([
    { name: 'id_front', maxCount: 1 },
    { name: 'id_back', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
  ]), 
  wallet.uploadKycDocuments
)

app.get('/wallet/kyc/status', mw.authenticate, wallet.getKycStatusHandler)

// ── Test Routes (Development Only) ────────────────────────────────

if (process.env.NODE_ENV === 'development') {
  app.post('/wallet/test/complete/:reference',
    mw.authenticate,
    wallet.completeTransactionManually
  )
  
  app.get('/wallet/test/status', (req, res) => {
    res.json({
      success: true,
      data: {
        mode: 'mock',
        message: 'PalPluss is running in mock mode for local testing',
        endpoints: {
          deposit: 'POST /wallet/deposit/mpesa',
          complete: 'POST /wallet/test/complete/:reference',
          withdraw: 'POST /wallet/withdraw/mpesa',
        }
      }
    })
  })
}

// ── Admin routes ───────────────────────────────────────────────────

app.get('/admin/kyc/pending', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  admin.getPendingKyc
)

app.get('/admin/kyc/:userId', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  admin.getKycDetails
)

app.post('/admin/kyc/review', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  mw.validators.adminKycReview, 
  mw.validate, 
  admin.reviewKyc
)

app.get('/admin/withdrawals/pending', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  admin.getPendingWithdrawals
)

app.post('/admin/withdrawals/review', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  mw.validators.adminWithdrawalReview, 
  mw.validate, 
  admin.reviewWithdrawal
)

app.get('/admin/users', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  admin.getUsers
)

app.post('/admin/users/:userId/role', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  mw.validators.setUserRole, 
  mw.validate, 
  admin.setUserRole
)

app.get('/admin/audit-log', 
  mw.authenticate, 
  mw.requireRole('admin'), 
  admin.getAuditLog
)

app.get('/admin/exchange/rate',
  mw.authenticate,
  mw.requireRole('admin'),
  admin.getExchangeRateAdmin
)

app.post('/admin/exchange/refresh',
  mw.authenticate,
  mw.requireRole('admin'),
  admin.refreshExchangeRate
)

// ── Global error handler ───────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message || err)
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error.', 
    code: 'SERVER_ERROR' 
  })
})

// ── WebSocket server ───────────────────────────────────────────────

const wss = new WebSocketServer({ 
  server: httpServer, 
  path: '/ws'
})

// Store user ID on WebSocket connection for broadcasting
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const token = url.searchParams.get('token')
  
  if (token) {
    try {
      const jwt = require('jsonwebtoken')
      const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET)
      ws.userId = payload.sub
    } catch {
      // Invalid token - connection still allowed for public tick stream
    }
  }
  
  market.handleWsConnection(ws, req)
})

// Set WebSocket server reference in wallet module for broadcasting
wallet.setWebSocketServer(wss)

// ── Boot sequence ──────────────────────────────────────────────────

async function start() {
  console.log('[G Wave] Starting engine...')
  
  // Start exchange rate updater
  exchange.startExchangeRateUpdater()
  
  // Start market engine
  market.startEngine()
  console.log('[G Wave] Market engine started')

  const port = process.env.PORT || 4000
  httpServer.listen(port, () => {
    console.log(`[G Wave] API: http://localhost:${port}`)
    console.log(`[G Wave] WS: ws://localhost:${port}/ws`)
    console.log(`[G Wave] Environment: ${process.env.NODE_ENV || 'development'}`)
  })
}

app.get('/wallet/pending/check', 
  mw.authenticate, 
  wallet.checkPendingTransactions
)

start().catch(err => {
  console.error('[G Wave] Boot failed:', err)
  process.exit(1)
})

// ── Graceful shutdown ─────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[G Wave] Shutting down...')
  exchange.stopExchangeRateUpdater()
  httpServer.close(() => {
    console.log('[G Wave] Server closed')
    process.exit(0)
  })
})