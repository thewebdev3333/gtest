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
const influencer = require('./influencer')

const app = express()
const httpServer = http.createServer(app)

// ── Global middleware ──────────────────────────────────────────────

app.use(mw.securityHeaders())
app.use(cors(mw.corsOptions))
app.use(express.json({ limit: '10kb' }))
app.use(morgan('combined'))
app.use(mw.apiLimiter)


//static file serving
app.use(express.static('public'));

// ── Health check ───────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// server.js - Add this before the admin routes

// ── Admin Login ───────────────────────────────────────────────────
app.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password required.',
        code: 'VALIDATION_ERROR'
      });
    }

    // Sign in using the anon-key client (mw.supabaseAuth), NOT db.supabase.
    // db.supabase is the service-role client, shared as a module-level
    // singleton across the whole app (auth.js, admin.js, requireRole, etc.)
    // specifically so it can bypass RLS. Calling .auth.signInWithPassword()
    // on a supabase-js client makes that client start sending the signed-in
    // user's access token as the Authorization header on every subsequent
    // .from() call instead of the service-role key it was built with. Doing
    // that on db.supabase would silently "downgrade" it for the rest of the
    // process to acting as whichever admin last logged in — every query
    // anywhere in the app (getUsers, getPendingKyc, getAllTransactions,
    // getPlatformStats, even requireRole's own role check) would then run
    // under RLS as that one user, which is why the dashboard only showed
    // that admin's own rows. mw.supabaseAuth is a separate anon-key client
    // used only for this sign-in exchange, so db.supabase never gets touched.
    const { data, error } = await mw.supabaseAuth.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials.',
        code: 'AUTH_FAILED'
      });
    }

    // Check if user has a role allowed through this login form — safe to use
    // db.supabase here, this is a plain .from() read, not an auth call, so it
    // doesn't touch its session.
    // This same form is also used for influencer sign-in (login.html reads
    // `role` from the response below to decide whether to redirect to
    // /admin/dashboard.html or /admin/influencer.html), so 'influencer' is
    // allowed alongside 'admin'. Every other role (user, support, tech) has
    // no page under /admin/ to land on and stays rejected.
    const { data: roleData, error: roleError } = await db.supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', data.user.id)
      .single();

    if (roleError || !roleData || !['admin', 'influencer'].includes(roleData.role)) {
      await mw.supabaseAuth.auth.signOut();
      return res.status(403).json({
        success: false,
        error: 'Admin access required.',
        code: 'FORBIDDEN'
      });
    }

    res.json({
      success: true,
      data: {
        token: data.session.access_token,
        user: {
          id: data.user.id,
          email: data.user.email,
          role: roleData.role
        }
      }
    });
  } catch (err) {
    console.error('[Admin Login] Error:', err);
    res.status(500).json({
      success: false,
      error: 'Login failed.',
      code: 'SERVER_ERROR'
    });
  }
});

// ── Auth routes ────────────────────────────────────────────────────

app.post('/auth/on-signup', auth.onSignup)
app.get('/auth/me', mw.authenticate, auth.getMe)
app.patch('/auth/profile', mw.authenticate, mw.validators.updateProfile, mw.validate, auth.updateProfile)

// ── Trade routes ───────────────────────────────────────────────────

app.get('/trade/symbols', (req, res) => {
  res.json({ success: true, data: { symbols: Object.values(market.SYMBOLS) } })
})

app.get('/trade/payout-preview', (req, res) => {
  const { contractType, stake, direction, selectedDigit } = req.query
  if (!contractType || !stake) {
    return res.status(400).json({ 
      success: false, 
      error: 'contractType and stake required.', 
      code: 'VALIDATION_ERROR' 
    })
  }
  const payout = market.calculatePayout(contractType, parseFloat(stake), direction, selectedDigit ? parseInt(selectedDigit) : null)
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

      const potentialPayout = market.calculatePayout(contractType, stake, direction, selectedDigit)

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

// ── Trade Settlement Endpoint ─────────────────────────────

app.post('/trade/settle/:contractId',
  mw.authenticate,
  async (req, res, next) => {
    try {
      const { contractId } = req.params
      const { exitPrice } = req.body

      const contract = await db.getContractById(contractId)
      if (!contract) {
        return res.status(404).json({
          success: false,
          error: 'Contract not found.',
          code: 'NOT_FOUND'
        })
      }

      if (contract.user_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: 'Access denied.',
          code: 'FORBIDDEN'
        })
      }

      const account = await db.getAccountById(contract.account_id)
      if (!account) {
        return res.status(404).json({
          success: false,
          error: 'Account not found.',
          code: 'NOT_FOUND'
        })
      }

      if (contract.status !== 'open') {
        const existingPayout = contract.outcome === 'win' ? parseFloat(contract.potential_payout) : 0
        const existingPnl = existingPayout - parseFloat(contract.stake)
        return res.json({
          success: true,
          data: {
            contractId: contract.id,
            outcome: contract.outcome,
            pnl: existingPnl,
            newBalance: parseFloat(account.balance),
            accountType: account.type,
            alreadySettled: true,
          },
        })
      }

      const outcome = market.resolveOutcome(contract, exitPrice)
      const payout = outcome === 'win' ? parseFloat(contract.potential_payout) : 0
      const pnl = payout - parseFloat(contract.stake)

      const claimed = await db.settleContract(contract.id, {
        exitPrice,
        outcome,
        settledAt: new Date().toISOString(),
      })

      if (!claimed) {
        const settled = await db.getContractById(contract.id)
        const updatedAccount = await db.getAccountById(contract.account_id)
        const settledPayout = settled.outcome === 'win' ? parseFloat(settled.potential_payout) : 0
        return res.json({
          success: true,
          data: {
            contractId: settled.id,
            outcome: settled.outcome,
            pnl: settledPayout - parseFloat(settled.stake),
            newBalance: parseFloat(updatedAccount.balance),
            accountType: updatedAccount.type,
            alreadySettled: true,
          },
        })
      }

      if (outcome === 'win') {
        await db.addBalance(account.id, payout)
        console.log(`[Settle] User ${req.user.id} won ${payout} on contract ${contractId}`)
      } else {
        console.log(`[Settle] User ${req.user.id} lost on contract ${contractId}`)
      }

      await db.updatePL(account.id, pnl)

      await db.createTransaction({
        user_id: req.user.id,
        type: outcome === 'win' ? 'trade_win' : 'trade_loss',
        amount_usd: outcome === 'win' ? payout : parseFloat(contract.stake),
        status: 'completed',
      })

      const updatedAccount = await db.getAccountById(account.id)

      res.json({
        success: true,
        data: {
          contractId: contract.id,
          outcome,
          pnl,
          newBalance: parseFloat(updatedAccount.balance),
          accountType: updatedAccount.type,
        },
      })
    } catch (err) {
      console.error('[Settle] Error:', err)
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
// In server.js - Replace the GET /wallet/transactions route

app.get('/wallet/transactions', 
  mw.authenticate, 
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, type, status } = req.query
      const offset = (parseInt(page) - 1) * parseInt(limit)
      
      const transactions = await db.getTransactionsByUser(req.user.id, {
        limit: parseInt(limit), 
        offset, 
        type,
        status,  // ← Add status filter
      })
      
      const total = await db.getTransactionsCount(req.user.id, { type, status })
      
      res.json({ 
        success: true, 
        data: { 
          transactions, 
          page: parseInt(page), 
          limit: parseInt(limit),
          total,  // ← Add total count for pagination
          totalPages: Math.ceil(total / parseInt(limit))
        } 
      })
    } catch (err) { next(err) }
  }
)
app.get('/wallet/rate', wallet.getRateHandler)
app.get('/wallet/withdrawals', mw.authenticate, wallet.getWithdrawals)

app.post('/wallet/deposit/mpesa', 
  mw.authenticate, 
  mw.checkIdempotency(),
  mw.validators.depositMpesa, 
  mw.validate, 
  wallet.depositMpesa
)

// ✅ Updated: M-Pesa callback endpoint for Daraja
app.post('/wallet/mpesa/callback', wallet.mpesaCallback)

// ❌ Commented out: PalPluss callback
// app.post('/wallet/palpluss/callback', wallet.palplussCallback)

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
        message: 'M-Pesa is running in mock mode for local testing',
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

app.get('/admin/transactions',
  mw.authenticate,
  mw.requireRole('admin'),
  admin.getAllTransactions
)

app.get('/admin/stats',
  mw.authenticate,
  mw.requireRole('admin'),
  admin.getStats
)

app.get('/admin/influencer-withdrawals',
  mw.authenticate,
  mw.requireRole('admin'),
  admin.getInfluencerWithdrawals
)

app.post('/admin/influencer-withdrawals/:id/mark-sent',
  mw.authenticate,
  mw.requireRole('admin'),
  mw.validators.adminInfluencerWithdrawalReview,
  mw.validate,
  admin.markInfluencerWithdrawalSent
)

app.post('/admin/influencer-withdrawals/:id/mark-failed',
  mw.authenticate,
  mw.requireRole('admin'),
  mw.validators.adminInfluencerWithdrawalReview,
  mw.validate,
  admin.markInfluencerWithdrawalFailed
)

// ── Influencer routes (mock withdrawal demo flow) ───────────────────
// Influencers cannot access the admin dashboard — requireRole('influencer')
// is a distinct role from 'admin', so these are the only endpoints they can hit.

app.get('/influencer/balance',
  mw.authenticate,
  mw.requireRole('influencer'),
  influencer.getBalance
)

app.get('/influencer/withdrawals',
  mw.authenticate,
  mw.requireRole('influencer'),
  influencer.getWithdrawals
)

app.post('/influencer/withdraw',
  mw.authenticate,
  mw.requireRole('influencer'),
  mw.withdrawalLimiter,
  mw.validators.influencerWithdraw,
  mw.validate,
  influencer.requestWithdrawal
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

wss.on('connection', (ws, req) => {
  market.handleWsConnection(ws, req)
})

// ── Boot sequence ──────────────────────────────────────────────────

async function start() {
  console.log('[G Wave] Starting engine...')
  
  exchange.startExchangeRateUpdater()
  market.startEngine()
  console.log('[G Wave] Market engine started')

  const port = process.env.PORT || 4000
  httpServer.listen(port, () => {
    console.log(`[G Wave] API: http://localhost:${port}`)
    console.log(`[G Wave] WS: ws://localhost:${port}/ws`)
    console.log(`[G Wave] Environment: ${process.env.NODE_ENV || 'development'}`)
  })
}

start().catch(err => {
  console.error('[G Wave] Boot failed:', err)
  process.exit(1)
})

process.on('SIGTERM', () => {
  console.log('[G Wave] Shutting down...')
  exchange.stopExchangeRateUpdater()
  httpServer.close(() => {
    console.log('[G Wave] Server closed')
    process.exit(0)
  })
})