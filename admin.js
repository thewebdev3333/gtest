// admin.js
const db = require('./database')
const { getKycStatus } = require('./auth')
const { initiatePayout } = require('./wallet')

async function getPendingKyc(req, res, next) {
  try {
    const { data, error } = await db.supabase
      .from('kyc_submissions')
      .select(`
        id,
        user_id,
        status,
        submitted_at,
        users:auth.users(email, user_metadata)
      `)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true })

    if (error) throw error
    res.json({ success: true, data: { submissions: data } })
  } catch (err) { next(err) }
}

async function getKycDetails(req, res, next) {
  try {
    const { userId } = req.params
    
    const [submission, documents] = await Promise.all([
      db.supabase
        .from('kyc_submissions')
        .select('*')
        .eq('user_id', userId)
        .single(),
      db.getKycDocumentsByUser(userId),
    ])

    res.json({
      success: true,
      data: {
        submission: submission.data,
        documents,
      },
    })
  } catch (err) { next(err) }
}

async function reviewKyc(req, res, next) {
  try {
    const { userId, status, notes } = req.body
    const adminId = req.user.id

    // Get current status
    const { data: current } = await db.supabase
      .from('kyc_submissions')
      .select('status')
      .eq('user_id', userId)
      .single()

    if (!current) {
      return res.status(404).json({
        success: false,
        error: 'KYC submission not found.',
        code: 'NOT_FOUND'
      })
    }

    if (current.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'KYC already reviewed.',
        code: 'INVALID_STATE'
      })
    }

    await db.supabase
      .from('kyc_submissions')
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: adminId,
        notes,
      })
      .eq('user_id', userId)

    await db.supabase.from('admin_audit_log').insert({
      admin_id: adminId,
      action: 'kyc_review',
      target_type: 'user',
      target_id: userId,
      details: { status, notes },
    })

    res.json({
      success: true,
      data: { message: `KYC ${status} for user ${userId}` },
    })
  } catch (err) { next(err) }
}

async function getPendingWithdrawals(req, res, next) {
  try {
    const { data, error } = await db.supabase
      .from('withdrawal_requests')
      .select(`
        id,
        user_id,
        amount_usd,
        amount_kes,
        phone,
        status,
        created_at,
        users:auth.users(email, user_metadata)
      `)
      .eq('status', 'pending_review')
      .order('created_at', { ascending: true })

    if (error) throw error
    res.json({ success: true, data: { withdrawals: data } })
  } catch (err) { next(err) }
}

async function reviewWithdrawal(req, res, next) {
  try {
    const { withdrawalId, action, notes } = req.body
    const adminId = req.user.id

    const { data: withdrawal, error } = await db.supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', withdrawalId)
      .single()

    if (error || !withdrawal) {
      return res.status(404).json({ 
        success: false, 
        error: 'Withdrawal not found.', 
        code: 'NOT_FOUND' 
      })
    }

    if (withdrawal.status !== 'pending_review') {
      return res.status(400).json({
        success: false,
        error: 'Withdrawal already processed.',
        code: 'INVALID_STATE',
      })
    }

    if (action === 'approve') {
      try {
        const result = await initiatePayout(
          withdrawal.phone,
          Math.round(withdrawal.amount_kes),
          'GWave Withdrawal'
        )

        await db.supabase
          .from('withdrawal_requests')
          .update({
            status: 'completed',
            approved_at: new Date().toISOString(),
            reviewed_at: new Date().toISOString(),
            reviewed_by: adminId,
            notes,
          })
          .eq('id', withdrawalId)

        await db.updateTransactionStatus(
          withdrawal.transaction_id,
          'completed',
          result.conversationId
        )

      } catch (err) {
        const account = await db.getAccountByUserAndType(withdrawal.user_id, 'real')
        await db.addBalance(account.id, parseFloat(withdrawal.amount_usd))

        await db.supabase
          .from('withdrawal_requests')
          .update({
            status: 'failed',
            reviewed_at: new Date().toISOString(),
            reviewed_by: adminId,
            notes: `Failed: ${err.message}`,
          })
          .eq('id', withdrawalId)

        await db.updateTransactionStatus(withdrawal.transaction_id, 'failed')

        return res.status(502).json({
          success: false,
          error: 'Payout failed. Balance restored.',
          code: 'PAYOUT_FAILED',
        })
      }

    } else if (action === 'reject') {
      const account = await db.getAccountByUserAndType(withdrawal.user_id, 'real')
      await db.addBalance(account.id, parseFloat(withdrawal.amount_usd))

      await db.supabase
        .from('withdrawal_requests')
        .update({
          status: 'rejected',
          reviewed_at: new Date().toISOString(),
          reviewed_by: adminId,
          notes,
        })
        .eq('id', withdrawalId)

      await db.updateTransactionStatus(withdrawal.transaction_id, 'failed')
    }

    await db.supabase.from('admin_audit_log').insert({
      admin_id: adminId,
      action: 'withdrawal_review',
      target_type: 'withdrawal_request',
      target_id: withdrawalId,
      details: { action, notes },
    })

    res.json({
      success: true,
      data: { message: `Withdrawal ${action}d successfully.` },
    })
  } catch (err) { next(err) }
}

async function getUsers(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const { data, error } = await db.supabase
      .from('auth.users')
      .select(`
        id,
        email,
        created_at,
        user_metadata,
        roles:user_roles(role),
        kyc:kyc_submissions(status)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (error) throw error
    res.json({
      success: true,
      data: {
        users: data,
        page: parseInt(page),
        limit: parseInt(limit),
      },
    })
  } catch (err) { next(err) }
}

async function setUserRole(req, res, next) {
  try {
    const { userId } = req.params
    const { role } = req.body

    if (!['user', 'support', 'admin'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role.',
        code: 'VALIDATION_ERROR',
      })
    }

    await db.supabase
      .from('user_roles')
      .upsert({ user_id: userId, role })

    await db.supabase.from('admin_audit_log').insert({
      admin_id: req.user.id,
      action: 'set_user_role',
      target_type: 'user',
      target_id: userId,
      details: { role },
    })

    res.json({ success: true, data: { message: `Role updated to ${role}` } })
  } catch (err) { next(err) }
}

async function getAuditLog(req, res, next) {
  try {
    const { page = 1, limit = 50 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const { data, error } = await db.supabase
      .from('admin_audit_log')
      .select(`
        *,
        admin:auth.users(email)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (error) throw error
    res.json({
      success: true,
      data: {
        logs: data,
        page: parseInt(page),
        limit: parseInt(limit),
      },
    })
  } catch (err) { next(err) }
}

// ── Admin Exchange Rate Endpoints ──────────────────────────────────

/**
 * GET /admin/exchange/rate
 * Get current rate with history
 */
async function getExchangeRateAdmin(req, res, next) {
  try {
    const exchange = require('./exchange')
    const current = await exchange.getExchangeRateWithMetadata()
    const history = await exchange.getRateHistory(24)
    
    res.json({
      success: true,
      data: {
        current,
        history,
      },
    })
  } catch (err) { next(err) }
}

/**
 * POST /admin/exchange/refresh
 * Force refresh the exchange rate
 */
async function refreshExchangeRate(req, res, next) {
  try {
    const exchange = require('./exchange')
    const rate = await exchange.forceRefreshExchangeRate()
    
    await db.supabase.from('admin_audit_log').insert({
      admin_id: req.user.id,
      action: 'refresh_exchange_rate',
      target_type: 'exchange_rate',
      details: { rate },
    })
    
    res.json({
      success: true,
      data: {
        rate,
        message: 'Exchange rate refreshed successfully',
      },
    })
  } catch (err) {
    res.status(502).json({
      success: false,
      error: 'Failed to refresh exchange rate',
      code: 'EXCHANGE_RATE_ERROR',
    })
  }
}

module.exports = {
  getPendingKyc,
  getExchangeRateAdmin,
  refreshExchangeRate,
  getKycDetails,
  reviewKyc,
  getPendingWithdrawals,
  reviewWithdrawal,
  getUsers,
  setUserRole,
  getAuditLog,
}