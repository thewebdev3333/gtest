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

// ── Daraja API Configuration ────────────────────────────────────

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE
const MPESA_PASSKEY = process.env.MPESA_PASSKEY
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL
const MPESA_ENV = process.env.MPESA_ENV || 'development'

// Determine base URLs based on environment
const MPESA_BASE_URL = MPESA_ENV === 'production' 
  ? 'https://api.safaricom.co.ke' 
  : 'https://sandbox.safaricom.co.ke'

console.log(`[M-Pesa] Environment: ${MPESA_ENV}`)
console.log(`[M-Pesa] Base URL: ${MPESA_BASE_URL}`)
console.log(`[M-Pesa] Shortcode: ${MPESA_SHORTCODE}`)

// ── OAuth Token Management ──────────────────────────────────────

let mpesaAccessToken = null
let tokenExpiryTime = null

async function getMpesaAccessToken() {
  if (mpesaAccessToken && tokenExpiryTime && Date.now() < tokenExpiryTime) {
    return mpesaAccessToken
  }

  try {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64')
    
    const response = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OAuth failed: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    
    if (!data.access_token) {
      throw new Error('No access token in response')
    }

    mpesaAccessToken = data.access_token
    tokenExpiryTime = Date.now() + (50 * 60 * 1000)
    
    console.log('[M-Pesa] Access token obtained successfully')
    return mpesaAccessToken
  } catch (error) {
    console.error('[M-Pesa] Failed to get access token:', error.message)
    throw new Error(`Failed to authenticate with M-Pesa: ${error.message}`)
  }
}

// ── Daraja STK Push Implementation ──────────────────────────────

async function initiateStkPush(phone, amountKES, reference) {
  console.log(`[M-Pesa] STK Push to ${phone} for KES ${amountKES}, ref: ${reference}`)
  
  const formattedPhone = formatPhoneNumber(phone)
  if (!formattedPhone) {
    throw new Error('Invalid phone number format. Use 07XXXXXXXX, 01XXXXXXXX, or 2547XXXXXXXX')
  }

  const accessToken = await getMpesaAccessToken()
  
  const phoneForSTK = formattedPhone.replace(/^254/, '')
  
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  
  const passwordBuffer = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`)
  const password = passwordBuffer.toString('base64')

  const stkData = {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amountKES),
    PartyA: formattedPhone,
    PartyB: MPESA_SHORTCODE,
    PhoneNumber: formattedPhone,
    CallBackURL: MPESA_CALLBACK_URL,
    AccountReference: reference || 'GWaveDeposit',
    TransactionDesc: `G Wave deposit - ${reference}`,
  }

  console.log('[M-Pesa] STK Push request:', JSON.stringify({
    ...stkData,
    Password: '***HIDDEN***',
  }, null, 2))

  try {
    const response = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(stkData),
    })

    const result = await response.json()
    console.log('[M-Pesa] STK Push response:', JSON.stringify(result, null, 2))

    if (!response.ok || result.ResponseCode !== '0') {
      const errorMsg = result.ResponseDescription || result.errorMessage || 'STK Push failed'
      throw new Error(`STK Push failed: ${errorMsg}`)
    }

    return {
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      responseCode: result.ResponseCode,
      responseDescription: result.ResponseDescription,
      customerMessage: result.CustomerMessage,
    }
  } catch (error) {
    console.error('[M-Pesa] STK Push error:', error.message)
    throw error
  }
}

async function checkMpesaTransactionStatus(checkoutRequestId) {
  try {
    const accessToken = await getMpesaAccessToken()
    
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const passwordBuffer = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`)
    const password = passwordBuffer.toString('base64')

    const statusData = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }

    const response = await fetch(`${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(statusData),
    })

    const result = await response.json()
    console.log('[M-Pesa] Status query response:', JSON.stringify(result, null, 2))

    if (!response.ok) {
      throw new Error(`Status query failed: ${result.errorMessage || 'Unknown error'}`)
    }

    return result
  } catch (error) {
    console.error('[M-Pesa] Status check error:', error.message)
    return null
  }
}

// ── Phone Number Formatting ─────────────────────────────────────

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

    // ✅ UPDATED: Minimum deposit is now $4 (520 KES)
    if (amountKES < 520) {
      return res.status(400).json({
        success: false,
        error: 'Minimum deposit is KES 520 (~$4)',
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

    const txId = crypto.randomUUID()
    const reference = `GWAVE_DEP_${txId.substring(0, 8).toUpperCase()}`

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
      checkoutRequestId = result.checkoutRequestId
      
      await db.updateTransactionStatus(tx.id, 'pending', checkoutRequestId)
      
      console.log(`[Deposit] STK Push initiated. CheckoutRequestID: ${checkoutRequestId}`)
      
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
        checkoutRequestId: checkoutRequestId,
      },
    }

    res.json(response)
  } catch (err) {
    console.error('[Deposit] Error:', err)
    next(err)
  }
}

// ── M-Pesa Callback ─────────────────────────────────────────────

async function mpesaCallback(req, res, next) {
  try {
    const payload = req.body
    console.log('[M-Pesa] Callback received:', JSON.stringify(payload, null, 2))
    
    const { Body } = payload
    
    if (!Body || !Body.stkCallback) {
      console.warn('[M-Pesa] Invalid callback payload - missing stkCallback')
      return res.status(200).json({ 
        ResultCode: 0, 
        ResultDesc: 'Callback received but ignored (invalid payload)' 
      })
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata
    } = Body.stkCallback

    console.log(`[M-Pesa] Callback: CheckoutRequestID: ${CheckoutRequestID}, ResultCode: ${ResultCode}`)

    let tx = await db.getTransactionByReference(CheckoutRequestID)
    
    if (!tx) {
      tx = await db.getTransactionByReference(MerchantRequestID)
    }

    if (!tx) {
      console.warn(`[M-Pesa] Unknown transaction. CheckoutRequestID: ${CheckoutRequestID}, MerchantRequestID: ${MerchantRequestID}`)
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received' })
    }

    console.log(`[M-Pesa] Found transaction: ${tx.id} for user ${tx.user_id}`)

    if (tx.status !== 'pending') {
      console.log(`[M-Pesa] Transaction ${tx.id} already ${tx.status}, ignoring callback`)
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received' })
    }

    if (ResultCode === 0) {
      let amount = 0
      let phoneNumber = ''
      let transactionDate = ''
      
      if (CallbackMetadata && CallbackMetadata.Item) {
        for (const item of CallbackMetadata.Item) {
          if (item.Name === 'Amount') {
            amount = parseFloat(item.Value)
          } else if (item.Name === 'MpesaReceiptNumber') {
            // Store receipt number for reference
          } else if (item.Name === 'PhoneNumber') {
            phoneNumber = item.Value
          } else if (item.Name === 'TransactionDate') {
            transactionDate = item.Value
          }
        }
      }

      await db.updateTransactionStatus(tx.id, 'completed', CheckoutRequestID)
      console.log(`[M-Pesa] Transaction ${tx.id} marked as completed`)
      
      const account = await db.getAccountByUserAndType(tx.user_id, 'real')
      if (account) {
        await db.addBalance(account.id, parseFloat(tx.amount_usd))
        console.log(`[M-Pesa] Credited ${tx.amount_usd} USD to account ${account.id}`)
      }

    } else {
      await db.updateTransactionStatus(tx.id, 'failed', CheckoutRequestID)
      console.log(`[M-Pesa] Transaction ${tx.id} marked as failed: ${ResultDesc}`)
    }

    res.status(200).json({ 
      ResultCode: 0, 
      ResultDesc: 'Callback processed successfully' 
    })
    
  } catch (err) {
    console.error('[M-Pesa] Callback error:', err)
    res.status(200).json({ 
      ResultCode: 0, 
      ResultDesc: 'Callback received with errors, but acknowledged' 
    })
  }
}

// ── Check pending transactions ─────────────────────────────────

async function checkPendingTransactions(req, res, next) {
  try {
    const userId = req.user.id
    
    const { data: pendingTxs, error } = await db.supabase
      .from('transactions')
      .select('id, reference, amount_usd, amount_kes, created_at, status')
      .eq('user_id', userId)
      .eq('type', 'deposit')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) throw error

    if (!pendingTxs || pendingTxs.length === 0) {
      return res.json({ 
        success: true, 
        data: { 
          transactions: [],
          hasPending: false 
        } 
      })
    }

    const updatedTransactions = []
    let hasPending = false

    for (const tx of pendingTxs) {
      const createdAt = new Date(tx.created_at)
      const now = new Date()
      const ageMinutes = (now - createdAt) / 60000

      if (ageMinutes > 5) {
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

      if (tx.reference) {
        try {
          const result = await checkMpesaTransactionStatus(tx.reference)
          
          if (result) {
            if (result.ResultCode === '0' && result.ResultDesc === 'The service request is processed successfully.') {
              await db.updateTransactionStatus(tx.id, 'completed', tx.reference)
              
              const account = await db.getAccountByUserAndType(userId, 'real')
              if (account) {
                await db.addBalance(account.id, parseFloat(tx.amount_usd))
              }
              
              updatedTransactions.push({
                id: tx.id,
                status: 'completed',
                amount_usd: tx.amount_usd,
                amount_kes: tx.amount_kes,
              })
              console.log(`[Polling] Transaction ${tx.id} marked as completed`)
            } else if (result.ResultCode !== '1037') {
              await db.updateTransactionStatus(tx.id, 'failed', tx.reference)
              updatedTransactions.push({
                id: tx.id,
                status: 'failed',
                amount_usd: tx.amount_usd,
                amount_kes: tx.amount_kes,
              })
              console.log(`[Polling] Transaction ${tx.id} marked as failed`)
            } else {
              hasPending = true
              updatedTransactions.push({
                id: tx.id,
                status: 'pending',
                amount_usd: tx.amount_usd,
                amount_kes: tx.amount_kes,
              })
            }
          } else {
            hasPending = true
            updatedTransactions.push({
              id: tx.id,
              status: 'pending',
              amount_usd: tx.amount_usd,
              amount_kes: tx.amount_kes,
            })
          }
        } catch (err) {
          console.error(`[Polling] Failed to check transaction ${tx.id}:`, err.message)
          hasPending = true
          updatedTransactions.push({
            id: tx.id,
            status: 'pending',
            amount_usd: tx.amount_usd,
            amount_kes: tx.amount_kes,
          })
        }
      } else {
        hasPending = true
        updatedTransactions.push({
          id: tx.id,
          status: 'pending',
          amount_usd: tx.amount_usd,
          amount_kes: tx.amount_kes,
        })
      }
    }

    res.json({ 
      success: true, 
      data: { 
        transactions: updatedTransactions,
        hasPending: hasPending || updatedTransactions.some(t => t.status === 'pending')
      } 
    })
  } catch (err) {
    console.error('[Polling] Error:', err)
    next(err)
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

    // Only require KYC for withdrawals over $100
    if (amountUSD > 100) {
      const kycStatus = await getKycStatus(userId)
      if (kycStatus !== 'approved') {
        return res.status(403).json({
          success: false,
          error: 'KYC verification required for withdrawals over $100.',
          code: 'KYC_REQUIRED'
        })
      }
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

// ── GET /wallet/withdrawals - Unified withdrawal list ──────────────

async function getWithdrawals(req, res, next) {
  try {
    const userId = req.user.id
    
    // Get regular withdrawal requests
    const { data: regularWithdrawals, error: regularError } = await db.supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (regularError) throw regularError

    // Check if user is an influencer - only fetch influencer withdrawals if they are
    const { data: roleData, error: roleError } = await db.supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .single()

    let allWithdrawals = [...(regularWithdrawals || []).map(w => ({ ...w, is_influencer: false }))]

    // Only fetch influencer withdrawals if user has the influencer role
    if (!roleError && roleData && roleData.role === 'influencer') {
      const { data: influencerWithdrawals, error: influencerError } = await db.supabase
        .from('influencer_withdrawals')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (!influencerError && influencerWithdrawals) {
        // Map influencer withdrawals to match withdrawal_requests format
        const mapped = influencerWithdrawals.map(w => {
          // Determine status mapping: 'sent' is success for influencer
          let mappedStatus = w.status
          if (w.status === 'sent') mappedStatus = 'completed'
          
          return {
            id: w.id,
            user_id: w.user_id,
            amount_usd: w.amount_usd,
            amount_kes: w.amount_usd * 130, // Approximate KES amount
            phone: null,
            status: mappedStatus,
            transaction_id: null,
            reviewed_at: w.simulated_at || null,
            reviewed_by: w.simulated_by || null,
            approved_at: w.simulated_at || null,
            completed_at: w.status === 'sent' ? w.simulated_at || w.created_at : null,
            notes: w.notes || null,
            created_at: w.created_at,
            is_influencer: true,
            original_status: w.status,
          }
        })
        
        allWithdrawals = [...allWithdrawals, ...mapped]
      }
    }

    // Sort by created_at descending
    allWithdrawals.sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    res.json({ success: true, data: { withdrawals: allWithdrawals } })
  } catch (err) {
    console.error('[Wallet] Error fetching withdrawals:', err)
    next(err)
  }
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
  mpesaCallback,
  withdrawMpesa,
  getWithdrawals,
  uploadKycDocuments,
  getKycStatusHandler,
  getKycStatus,
  kycUpload,
  initiateStkPush,
  checkMpesaTransactionStatus,
  completeTransactionManually,
  checkPendingTransactions,
  formatPhoneNumber,
}