// wallet.js
const db = require('./database')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { getKycStatus } = require('./auth')

// Ensure upload directory exists
const kycUploadPath = process.env.KYC_UPLOAD_PATH || './uploads/kyc'
if (!fs.existsSync(kycUploadPath)) {
  fs.mkdirSync(kycUploadPath, { recursive: true })
}

// ── PalPluss API Configuration ────────────────────────────────────

const PALPLUSS_BASE_URL = process.env.PALPLUSS_BASE_URL || 'https://api.palpluss.com/v1'
const PALPLUSS_API_KEY = process.env.PALPLUSS_API_KEY
const PALPLUSS_API_SECRET = process.env.PALPLUSS_API_SECRET
const PALPLUSS_BASIC_AUTH_TOKEN = process.env.PALPLUSS_BASIC_AUTH_TOKEN

/**
 * Get PalPluss Authorization Header
 * The correct format uses the API key as the username with no password
 */
function getAuthHeader() {
  // Option 1: Use pre-encoded token if provided
  if (PALPLUSS_BASIC_AUTH_TOKEN) {
    return 'Basic ' + PALPLUSS_BASIC_AUTH_TOKEN
  }
  
  // Option 2: Build from API Key (username) with no password
  // This matches the curl example: -u "$PALPLUSS_API_KEY:"
  if (PALPLUSS_API_KEY) {
    // The colon after the API key is required for Basic Auth with an empty password
    const credentials = `${PALPLUSS_API_KEY}:`
    const encoded = Buffer.from(credentials).toString('base64')
    return 'Basic ' + encoded
  }
  
  // No credentials - mock mode
  return null
}

// Check if we have real credentials
const HAS_PALPLUSS_CREDENTIALS = !!(PALPLUSS_BASIC_AUTH_TOKEN || PALPLUSS_API_KEY)

console.log(`[PalPluss] Credentials: ${HAS_PALPLUSS_CREDENTIALS ? '✅ Configured' : '⚠️ Mock Mode'}`)

async function palplussRequest(endpoint, method = 'POST', data = null) {
  const authHeader = getAuthHeader()
  
  // If no credentials, use mock mode
  if (!authHeader) {
    console.log(`[PalPluss MOCK] ${method} ${endpoint}`, data)
    return {
      checkoutRequestId: `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      merchantRequestId: `mock_merchant_${Date.now()}`,
      status: 'pending',
      message: 'STK Push sent (MOCK)',
    }
  }

  // Real API call
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

// ── PalPluss Integration Functions ──────────────────────────────

/**
 * Initiate STK Push via PalPluss
 * Using the correct endpoint: /payments/stk
 */
async function initiateStkPush(phone, amountKES, reference, channelId = null) {
  console.log(`[PalPluss] STK Push to ${phone} for KES ${amountKES}, ref: ${reference}`)
  
  // Format phone number (remove leading 0 if present)
  let formattedPhone = phone
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '254' + formattedPhone.substring(1)
  }
  if (!formattedPhone.startsWith('254')) {
    formattedPhone = '254' + formattedPhone
  }
  
  // Get channel ID from env or use default
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

/**
 * Check transaction status with PalPluss
 */
async function checkTransactionStatus(transactionId) {
  return await palplussRequest(`/transactions/${transactionId}`, 'GET')
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

/**
 * DEPOSIT: Initiate M-Pesa deposit via STK Push
 */
async function depositMpesa(req, res, next) {
  try {
    const { phone, amountKES } = req.body
    const userId = req.user.id

    // 1. Validate amount
    if (amountKES < 260) {
      return res.status(400).json({
        success: false,
        error: 'Minimum deposit is KES 260 (~$2)',
        code: 'VALIDATION_ERROR'
      })
    }

    // 2. Check for pending deposit (prevent duplicates)
    const { data: pending } = await db.supabase
      .from('transactions')
      .select('id, reference, created_at')
      .eq('user_id', userId)
      .eq('type', 'deposit')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)

    if (pending && pending.length > 0) {
      // Check if pending is older than 5 minutes (stale)
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
        // Stale pending transaction - mark as failed and continue
        await db.updateTransactionStatus(pending[0].id, 'failed')
        console.log(`[Deposit] Stale pending transaction ${pending[0].id} marked as failed`)
      }
    }

    // 3. Get exchange rate
    const rate = await db.getExchangeRate('USD', 'KES')
    const amountUSD = parseFloat((amountKES / rate).toFixed(8))

    // 4. Create transaction record (pending)
    const tx = await db.createTransaction({
      user_id: userId,
      type: 'deposit',
      amount_usd: amountUSD,
      amount_kes: amountKES,
      method: 'mpesa',
      status: 'pending',
    })

    const reference = `GWAVE_DEP_${tx.id.substring(0, 8).toUpperCase()}`

    // 5. Initiate STK Push with PalPluss
    let checkoutRequestId
    try {
      const result = await initiateStkPush(phone, Math.round(amountKES), reference)
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

    // 6. Update transaction with PalPluss reference
    await db.updateTransactionStatus(tx.id, 'pending', checkoutRequestId)

    // 7. Store idempotency response if key provided
    if (req.idempotencyKey && req.idempotencyStore) {
      await req.idempotencyStore({
        success: true,
        data: {
          reference: checkoutRequestId,
          message: 'STK Push sent. Approve the prompt on your phone.',
        },
      })
    }

    // 8. Return success response
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

/**
 * PalPluss Webhook Callback Handler
 * Called by PalPluss when payment status changes
 */
async function palplussCallback(req, res, next) {
  try {
    // 1. Get the webhook payload
    const payload = req.body
    console.log('[PalPluss] Webhook received:', JSON.stringify(payload, null, 2))
    
    // 2. Extract data from PalPluss webhook format
    const { 
      event,           // "transaction.updated"
      event_type,      // "transaction.success" or "transaction.failed"
      transaction 
    } = payload

    // 3. Validate we have the required data
    if (!transaction || !transaction.id) {
      console.warn('[PalPluss] Invalid webhook payload - missing transaction')
      return res.status(200).json({ success: true, received: true })
    }

    const { 
      id: transactionId,
      status,          // "SUCCESS" or "FAILED"
      amount,
      currency,
      phone_number,
      result_code,     // "0" for success
      result_desc      // Description of the result
    } = transaction

    // 4. Find our transaction by the PalPluss reference
    const tx = await db.getTransactionByReference(transactionId)
    
    if (!tx) {
      console.warn(`[PalPluss] Unknown transaction reference: ${transactionId}`)
      return res.status(200).json({ success: true, received: true })
    }

    console.log(`[PalPluss] Found transaction: ${tx.id} for user ${tx.user_id}`)

    // 5. Determine if the transaction was successful
    const isSuccess = result_code === '0' || status === 'SUCCESS'
    const isFailed = result_code !== '0' || status === 'FAILED' || status === 'CANCELLED'

    // 6. Update our transaction and credit balance
    if (isSuccess) {
      if (tx.status !== 'completed') {
        await db.updateTransactionStatus(tx.id, 'completed', transactionId)
        console.log(`[PalPluss] Transaction ${tx.id} marked as completed`)
        
        if (tx.type === 'deposit') {
          const account = await db.getAccountByUserAndType(tx.user_id, 'real')
          await db.addBalance(account.id, parseFloat(tx.amount_usd))
          console.log(`[PalPluss] Credited ${tx.amount_usd} USD to account ${account.id}`)
        }
      } else {
        console.log(`[PalPluss] Transaction ${tx.id} already completed, skipping`)
      }
    } else if (isFailed) {
      if (tx.status !== 'failed') {
        await db.updateTransactionStatus(tx.id, 'failed', transactionId)
        console.log(`[PalPluss] Transaction ${tx.id} marked as failed: ${result_desc || status}`)
        
        if (tx.type === 'withdrawal') {
          const account = await db.getAccountByUserAndType(tx.user_id, 'real')
          await db.addBalance(account.id, parseFloat(tx.amount_usd))
          console.log(`[PalPluss] Re-credited ${tx.amount_usd} USD for failed withdrawal`)
        }
      }
    }

    // 7. Always return 2xx success
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

/**
 * MANUAL COMPLETE: For testing deposits locally
 */
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
        phone,
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
}