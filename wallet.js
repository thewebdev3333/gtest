// wallet.js
const db = require('./database')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { getKycStatus } = require('./auth')

// Ensure upload directory exists
const kycUploadPath = process.env.KYC_UPLOAD_PATH || './uploads/kyc'
if (!fs.existsSync(kycUploadPath)) {
  fs.mkdirSync(kycUploadPath, { recursive: true })
}

// ── PalPluss API Configuration ────────────────────────────────────

const PALPLUSS_BASE_URL = process.env.PALPLUSS_BASE_URL || 'https://api.palpluss.com/v1'
const PALPLUSS_API_KEY = process.env.PALPLUSS_API_KEY
const PALPLUSS_BASIC_AUTH_TOKEN = process.env.PALPLUSS_BASIC_AUTH_TOKEN

function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\s/g, '')
  
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1)
  }
  
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1)
  }
  
  if (cleaned.startsWith('1') && !cleaned.startsWith('2541')) {
    cleaned = '254' + cleaned
  }
  
  if (cleaned.startsWith('7') && !cleaned.startsWith('2547')) {
    cleaned = '254' + cleaned
  }
  
  if (!/^254[17]\d{8}$/.test(cleaned)) {
    return null
  }
  
  return cleaned
}

function getAuthHeader() {
  if (PALPLUSS_BASIC_AUTH_TOKEN) {
    return 'Basic ' + PALPLUSS_BASIC_AUTH_TOKEN
  }
  
  if (PALPLUSS_API_KEY) {
    const credentials = `${PALPLUSS_API_KEY}:`
    const encoded = Buffer.from(credentials).toString('base64')
    return 'Basic ' + encoded
  }
  
  return null
}

const HAS_PALPLUSS_CREDENTIALS = !!(PALPLUSS_BASIC_AUTH_TOKEN || PALPLUSS_API_KEY)

console.log(`[PalPluss] Credentials: ${HAS_PALPLUSS_CREDENTIALS ? '✅ Configured' : '⚠️ Mock Mode'}`)

async function palplussRequest(endpoint, method = 'POST', data = null) {
  const authHeader = getAuthHeader()
  
  if (!authHeader) {
    console.log(`[PalPluss MOCK] ${method} ${endpoint}`, data)
    return {
      checkoutRequestId: `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      merchantRequestId: `mock_merchant_${Date.now()}`,
      status: 'pending',
      message: 'STK Push sent (MOCK)',
    }
  }

  const url = `${PALPLUSS_BASE_URL}${endpoint}`
  console.log(`[PalPluss] Request URL: ${url}`)
  
  const options = {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }

  if (data) {
    options.body = JSON.stringify(data)
  }

  try {
    const response = await fetch(url, options)
    const result = await response.json()

    if (!result.success) {
      const error = result.error || { message: 'PalPluss API error', code: 'UNKNOWN_ERROR' }
      throw new Error(`PalPluss: ${error.message} (${error.code})`)
    }

    return result.data
  } catch (error) {
    console.error('[PalPluss] API Error:', error.message)
    throw error
  }
}

async function initiateStkPush(phone, amountKES, reference, channelId = null) {
  console.log(`[PalPluss] STK Push to ${phone} for KES ${amountKES}, ref: ${reference}`)
  
  const formattedPhone = formatPhoneNumber(phone)
  if (!formattedPhone) {
    throw new Error('Invalid phone number format. Use 07XXXXXXXX, 01XXXXXXXX, or 2547XXXXXXXX')
  }
  
  const paymentChannelId = channelId || process.env.PALPLUSS_CHANNEL_ID || 'your-payment-channel-id'
  
  const requestData = {
    amount: amountKES,
    phone: formattedPhone,
    accountReference: reference || 'GWave',
    transactionDesc: `G Wave deposit - ${reference}`,
    channelId: paymentChannelId,
    callbackUrl: process.env.PALPLUSS_CALLBACK_URL || 'https://your-ngrok-url.ngrok.io/wallet/palpluss/callback',
  }
  
  console.log('[PalPluss] Request data:', JSON.stringify(requestData, null, 2))
  
  const data = await palplussRequest('/payments/stk', 'POST', requestData)

  return { 
    checkoutRequestId: data.checkoutRequestId || data.merchantRequestId || data.id || data.reference,
    ...data 
  }
}

async function checkPalPlussTransactionStatus(palplussTransactionId) {
  try {
    return await palplussRequest(`/transactions/${palplussTransactionId}`, 'GET')
  } catch (error) {
    console.error('[PalPluss] Status check failed:', error.message)
    return null
  }
}

// ── Handler Functions ─────────────────────────────────────────────

async function getBalance(req, res, next) {
  try {
    const accounts = await db.getAccountsByUserId(req.user.id)
    const rate = await db.getExchangeRate('USD', 'KES')

    const fmt = (usd) => ({
      usd: parseFloat(usd || 0).toFixed(2),
      kes: (parseFloat(usd || 0) * rate).toFixed(2),
    })

    const demo = accounts.find(a => a.type === 'demo')
    const real = accounts.find(a => a.type === 'real')

    res.json({
      success: true,
      data: {
        demo: fmt(demo?.balance),
        real: fmt(real?.balance),
        rate,
      },
    })
  } catch (err) { next(err) }
}

async function getTransactions(req, res, next) {
  try {
    const { page = 1, limit = 20, type } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)
    const transactions = await db.getTransactionsByUser(req.user.id, {
      limit: parseInt(limit), 
      offset, 
      type,
    })
    res.json({ 
      success: true, 
      data: { 
        transactions, 
        page: parseInt(page), 
        limit: parseInt(limit) 
      } 
    })
  } catch (err) { next(err) }
}

async function getRateHandler(req, res, next) {
  try {
    const exchange = require('./exchange')
    const rateData = await exchange.getExchangeRateWithMetadata()
    res.json({
      success: true,
      data: {
        rate: rateData.rate,
        from: 'USD',
        to: 'KES',
        lastUpdated: rateData.updated_at,
        source: rateData.source,
      },
    })
  } catch (err) { next(err) }
}

async function depositMpesa(req, res, next) {
  try {
    const { phone, amountKES } = req.body
    const userId = req.user.id

    const formattedPhone = formatPhoneNumber(phone)
    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Use 07XXXXXXXX or 01XXXXXXXX format.',
        code: 'VALIDATION_ERROR'
      })
    }

    if (amountKES < 260) {
      return res.status(400).json({
        success: false,
        error: 'Minimum deposit is KES 260 (~$2)',
        code: 'VALIDATION_ERROR'
      })
    }

    // Check for stale pending transactions
    const { data: pending } = await db.supabase
      .from('transactions')
      .select('id, reference, created_at')
      .eq('user_id', userId)
      .eq('type', 'deposit')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)

    if (pending && pending.length > 0) {
      const createdAt = new Date(pending[0].created_at)
      const now = new Date()
      const ageMinutes = (now - createdAt) / 60000

      if (ageMinutes < 5) {
        return res.json({
          success: true,
          data: {
            reference: pending[0].reference,
            message: 'Deposit already pending. Check your phone for the STK prompt.',
            existing: true,
          },
        })
      } else {
        await db.updateTransactionStatus(pending[0].id, 'failed')
        console.log(`[Deposit] Stale pending transaction ${pending[0].id} marked as failed`)
      }
    }

    const rate = await db.getExchangeRate('USD', 'KES')
    const amountUSD = parseFloat((amountKES / rate).toFixed(8))

    // Generate reference BEFORE creating transaction
    const txId = crypto.randomUUID()
    const reference = `GWAVE_DEP_${txId.substring(0, 8).toUpperCase()}`

    // Create transaction with reference already set
    const tx = await db.createTransaction({
      id: txId,
      user_id: userId,
      type: 'deposit',
      amount_usd: amountUSD,
      amount_kes: amountKES,
      method: 'mpesa',
      status: 'pending',
      reference: reference,
    })

    let checkoutRequestId
    try {
      const result = await initiateStkPush(formattedPhone, Math.round(amountKES), reference)
      checkoutRequestId = result.checkoutRequestId || result.reference || result.id
    } catch (mpesaErr) {
      console.error('[Deposit] STK Push failed:', mpesaErr.message)
      await db.updateTransactionStatus(tx.id, 'failed')
      return res.status(502).json({ 
        success: false, 
        error: 'Failed to initiate M-Pesa push. Please try again.',
        code: 'MPESA_ERROR',
        details: mpesaErr.message,
      })
    }

    // Store the checkoutRequestId in the reference field (keep our reference too)
    // We'll store it as a separate update
    await db.updateTransactionStatus(tx.id, 'pending', checkoutRequestId)

    if (req.idempotencyKey && req.idempotencyStore) {
      await req.idempotencyStore({
        success: true,
        data: {
          reference: checkoutRequestId,
          message: 'STK Push sent. Approve the prompt on your phone.',
        },
      })
    }

    const response = {
      success: true,
      data: {
        reference: checkoutRequestId,
        transactionId: tx.id,
        amount: amountKES,
        currency: 'KES',
        message: 'STK Push sent. Please check your phone and enter your PIN to complete the payment.',
        ...(!HAS_PALPLUSS_CREDENTIALS && {
          testMode: true,
          note: 'Running in test mode - use /wallet/test/complete/:reference to manually complete',
        }),
      },
    }

    res.json(response)
  } catch (err) {
    console.error('[Deposit] Error:', err)
    next(err)
  }
}

// ── NEW: Check pending transaction status ─────────────────────────

async function checkPendingTransactions(req, res, next) {
  try {
    const userId = req.user.id
    
    // Get all pending deposit transactions
    const { data: pendingTxs, error } = await db.supabase
      .from('transactions')
      .select('id, reference, amount_usd, amount_kes, created_at')
      .eq('user_id', userId)
      .eq('type', 'deposit')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) throw error

    if (!pendingTxs || pendingTxs.length === 0) {
      return res.json({ 
        success: true, 
        data: { transactions: [] } 
      })
    }

    const updatedTransactions = []

    for (const tx of pendingTxs) {
      // Check if the transaction is older than 5 minutes
      const createdAt = new Date(tx.created_at)
      const now = new Date()
      const ageMinutes = (now - createdAt) / 60000

      if (ageMinutes > 5) {
        // Mark as failed if older than 5 minutes
        await db.updateTransactionStatus(tx.id, 'failed')
        updatedTransactions.push({
          id: tx.id,
          status: 'failed',
          amount_usd: tx.amount_usd,
          amount_kes: tx.amount_kes,
        })
        console.log(`[Polling] Transaction ${tx.id} marked as failed (timeout)`)
        continue
      }

      // Check with PalPluss if we have a reference
      if (tx.reference) {
        try {
          const result = await checkPalPlussTransactionStatus(tx.reference)
          
          if (result) {
            const isSuccess = result.result_code === '0' || result.status === 'SUCCESS'
            const isFailed = result.result_code !== '0' || result.status === 'FAILED' || result.status === 'CANCELLED'

            if (isSuccess && tx.status === 'pending') {
              await db.updateTransactionStatus(tx.id, 'completed', tx.reference)
              
              // Credit the account
              const account = await db.getAccountByUserAndType(userId, 'real')
              await db.addBalance(account.id, parseFloat(tx.amount_usd))
              
              updatedTransactions.push({
                id: tx.id,
                status: 'completed',
                amount_usd: tx.amount_usd,
                amount_kes: tx.amount_kes,
              })
              console.log(`[Polling] Transaction ${tx.id} marked as completed`)
            } else if (isFailed && tx.status === 'pending') {
              await db.updateTransactionStatus(tx.id, 'failed', tx.reference)
              updatedTransactions.push({
                id: tx.id,
                status: 'failed',
                amount_usd: tx.amount_usd,
                amount_kes: tx.amount_kes,
              })
              console.log(`[Polling] Transaction ${tx.id} marked as failed`)
            }
          }
        } catch (err) {
          console.error(`[Polling] Failed to check transaction ${tx.id}:`, err.message)
        }
      }
    }

    res.json({ 
      success: true, 
      data: { 
        transactions: updatedTransactions,
        hasPending: pendingTxs.length > 0
      } 
    })
  } catch (err) {
    console.error('[Polling] Error:', err)
    next(err)
  }
}

// ── Webhook Callback (simplified - just updates DB, no broadcast) ──

async function palplussCallback(req, res, next) {
  try {
    const payload = req.body
    console.log('[PalPluss] Webhook received:', JSON.stringify(payload, null, 2))
    
    const { transaction } = payload

    if (!transaction || !transaction.id) {
      console.warn('[PalPluss] Invalid webhook payload - missing transaction')
      return res.status(200).json({ success: true, received: true })
    }

    const { 
      id: palplussTransactionId,
      status,
      result_code,
      result_desc,
      external_reference
    } = transaction

    console.log('[PalPluss] Looking up transaction by external_reference:', external_reference)

    let tx = null
    
    if (external_reference) {
      tx = await db.getTransactionByReference(external_reference)
      if (tx) {
        console.log('[PalPluss] Found transaction by external_reference:', tx.id)
      }
    }
    
    if (!tx) {
      console.log('[PalPluss] Trying to find by PalPluss transaction ID:', palplussTransactionId)
      tx = await db.getTransactionByReference(palplussTransactionId)
      if (tx) {
        console.log('[PalPluss] Found transaction by PalPluss ID:', tx.id)
      }
    }

    if (!tx) {
      console.warn(`[PalPluss] Unknown transaction. External ref: ${external_reference}, PalPluss ID: ${palplussTransactionId}`)
      return res.status(200).json({ success: true, received: true })
    }

    console.log(`[PalPluss] Found transaction: ${tx.id} for user ${tx.user_id}`)

    const isSuccess = result_code === '0' || status === 'SUCCESS'
    const isFailed = result_code !== '0' || status === 'FAILED' || status === 'CANCELLED'

    if (isSuccess && tx.status === 'pending') {
      await db.updateTransactionStatus(tx.id, 'completed', palplussTransactionId)
      console.log(`[PalPluss] Transaction ${tx.id} marked as completed`)
      
      if (tx.type === 'deposit') {
        const account = await db.getAccountByUserAndType(tx.user_id, 'real')
        await db.addBalance(account.id, parseFloat(tx.amount_usd))
        console.log(`[PalPluss] Credited ${tx.amount_usd} USD to account ${account.id}`)
      }
    } else if (isFailed && tx.status === 'pending') {
      await db.updateTransactionStatus(tx.id, 'failed', palplussTransactionId)
      console.log(`[PalPluss] Transaction ${tx.id} marked as failed: ${result_desc || status}`)
    }

    res.status(200).json({ 
      success: true, 
      received: true,
      message: 'Webhook processed successfully'
    })
    
  } catch (err) {
    console.error('[PalPluss] Webhook error:', err)
    res.status(200).json({ 
      success: true, 
      received: true,
      message: 'Webhook received with errors, but acknowledged'
    })
  }
}

// ── Manual completion for testing ─────────────────────────────────

async function completeTransactionManually(req, res, next) {
  try {
    if (process.env.NODE_ENV !== 'development' && !req.isAdmin) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only available in development mode',
        code: 'FORBIDDEN'
      })
    }

    const { reference } = req.params
    
    const tx = await db.getTransactionByReference(reference)
    if (!tx) {
      return res.status(404).json({ 
        success: false, 
        error: 'Transaction not found',
        code: 'NOT_FOUND'
      })
    }

    if (tx.user_id !== req.user.id && !req.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        code: 'FORBIDDEN'
      })
    }

    if (tx.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Transaction already ${tx.status}`,
        code: 'INVALID_STATE'
      })
    }

    await db.updateTransactionStatus(tx.id, 'completed', reference)

    if (tx.type === 'deposit') {
      const account = await db.getAccountByUserAndType(tx.user_id, 'real')
      await db.addBalance(account.id, parseFloat(tx.amount_usd))
      console.log(`[Test] Manually completed deposit ${tx.id} - Credited ${tx.amount_usd} USD`)
    }

    res.json({
      success: true,
      data: {
        transactionId: tx.id,
        status: 'completed',
        amount: tx.amount_usd,
        currency: 'USD',
        message: 'Transaction completed manually for testing',
      },
    })
  } catch (err) { 
    console.error('[Test] Error completing transaction:', err)
    next(err) 
  }
}

// ── Withdrawal ─────────────────────────────────────────────────────

async function withdrawMpesa(req, res, next) {
  try {
    const { phone, amountUSD } = req.body
    const userId = req.user.id

    const formattedPhone = formatPhoneNumber(phone)
    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Use 07XXXXXXXX or 01XXXXXXXX format.',
        code: 'VALIDATION_ERROR'
      })
    }

    const kycStatus = await getKycStatus(userId)
    if (kycStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        error: 'KYC verification required.',
        code: 'KYC_REQUIRED'
      })
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { count } = await db.supabase
      .from('withdrawal_requests')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', today.toISOString())
      .in('status', ['pending_review', 'approved', 'processing', 'completed'])

    if (count >= 3) {
      return res.status(429).json({
        success: false,
        error: 'Maximum 3 withdrawals per day.',
        code: 'RATE_LIMITED'
      })
    }

    const { data: pending } = await db.supabase
      .from('withdrawal_requests')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'pending_review')
      .single()

    if (pending) {
      return res.status(400).json({
        success: false,
        error: 'You have a pending withdrawal request.',
        code: 'PENDING_WITHDRAWAL'
      })
    }

    const account = await db.getAccountByUserAndType(userId, 'real')
    if (parseFloat(account.balance) < amountUSD) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient balance.',
        code: 'INSUFFICIENT_BALANCE'
      })
    }

    const rate = await db.getExchangeRate('USD', 'KES')
    const amountKES = Math.round(amountUSD * rate)

    await db.deductBalance(account.id, amountUSD)

    const { data: withdrawalReq, error: wError } = await db.supabase
      .from('withdrawal_requests')
      .insert({
        user_id: userId,
        amount_usd: amountUSD,
        amount_kes: amountKES,
        phone: formattedPhone,
        status: 'pending_review',
      })
      .select()
      .single()

    if (wError) throw wError

    const tx = await db.createTransaction({
      user_id: userId,
      type: 'withdrawal',
      amount_usd: amountUSD,
      amount_kes: amountKES,
      method: 'mpesa',
      status: 'pending',
      metadata: { withdrawal_request_id: withdrawalReq.id },
    })

    await db.supabase
      .from('withdrawal_requests')
      .update({ transaction_id: tx.id })
      .eq('id', withdrawalReq.id)

    res.json({
      success: true,
      data: {
        withdrawalId: withdrawalReq.id,
        message: 'Withdrawal request submitted for review.',
        status: 'pending_review',
      },
    })
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ success: false, error: 'Insufficient balance.', code: 'INSUFFICIENT_BALANCE' })
    }
    next(err)
  }
}

async function getWithdrawals(req, res, next) {
  try {
    const { data, error } = await db.supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
    
    if (error) throw error
    res.json({ success: true, data: { withdrawals: data } })
  } catch (err) { next(err) }
}

// ── KYC Upload ─────────────────────────────────────────────────────

const kycStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, kycUploadPath)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const safe = `${req.user.id}_${file.fieldname}_${Date.now()}${ext}`
    cb(null, safe)
  },
})

const kycUpload = multer({
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf']
    cb(null, allowed.includes(file.mimetype))
  },
})

async function uploadKycDocuments(req, res, next) {
  try {
    const files = req.files
    if (!files?.id_front || !files?.id_back || !files?.selfie) {
      return res.status(400).json({ 
        success: false, 
        error: 'All three documents required.',
        code: 'VALIDATION_ERROR' 
      })
    }

    const userId = req.user.id
    const { data: existing } = await db.supabase
      .from('kyc_submissions')
      .select('status')
      .eq('user_id', userId)
      .single()

    if (existing && existing.status === 'pending') {
      return res.status(400).json({
        success: false,
        error: 'KYC already pending review.',
        code: 'KYC_PENDING'
      })
    }

    const docs = [
      { user_id: userId, doc_type: 'id_front', file_path: files.id_front[0].path },
      { user_id: userId, doc_type: 'id_back', file_path: files.id_back[0].path },
      { user_id: userId, doc_type: 'selfie', file_path: files.selfie[0].path },
    ]

    for (const doc of docs) await db.createKycDocument(doc)

    await db.supabase
      .from('kyc_submissions')
      .upsert({
        user_id: userId,
        status: 'pending',
        submitted_at: new Date().toISOString(),
      })

    res.json({ success: true, data: { message: 'Documents submitted. Review takes 1–2 business days.' } })
  } catch (err) { next(err) }
}

async function getKycStatusHandler(req, res, next) {
  try {
    const status = await getKycStatus(req.user.id)
    const docs = await db.getKycDocumentsByUser(req.user.id)
    res.json({
      success: true,
      data: {
        status,
        documents: docs.map(d => d.doc_type),
        documentsSubmitted: docs.length,
      },
    })
  } catch (err) { next(err) }
}

// ── Exports ──────────────────────────────────────────────────────

module.exports = {
  getBalance,
  getTransactions,
  getRateHandler,
  depositMpesa,
  palplussCallback,
  withdrawMpesa,
  getWithdrawals,
  uploadKycDocuments,
  getKycStatusHandler,
  getKycStatus,
  kycUpload,
  initiateStkPush,
  checkTransactionStatus,
  completeTransactionManually,
  checkPendingTransactions,
  formatPhoneNumber,
}