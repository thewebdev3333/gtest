// database.js
const { createClient } = require('@supabase/supabase-js')

// Service role client — full DB access, never sent to frontend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Accounts ──────────────────────────────────────────────────────

async function createUserAccounts(userId) {
  const { error } = await supabase.from('accounts').insert([
    { user_id: userId, type: 'demo', balance: 10000 },
    { user_id: userId, type: 'real', balance: 0 },
  ])
  if (error) throw error
}

async function getAccountsByUserId(userId) {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
  if (error) throw error
  return data
}

async function getAccountByUserAndType(userId, type) {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('type', type)
    .single()
  if (error) throw error
  return data
}

// Atomic balance operations using Postgres functions
async function deductBalance(accountId, amount) {
  const { error } = await supabase.rpc('deduct_balance', {
    p_account_id: accountId,
    p_amount: amount,
  })
  if (error) {
    if (error.message.includes('INSUFFICIENT_BALANCE')) throw new Error('INSUFFICIENT_BALANCE')
    throw error
  }
}

async function addBalance(accountId, amount) {
  const { error } = await supabase.rpc('increment_balance', {
    p_account_id: accountId,
    p_amount: amount,
  })
  if (error) throw error
}

async function updatePL(accountId, plDelta) {
  const { error } = await supabase.rpc('update_pl', {
    p_account_id: accountId,
    p_delta: plDelta,
  })
  if (error) throw error
}

// ── Contracts ─────────────────────────────────────────────────────

async function createContract(data) {
  const { data: contract, error } = await supabase
    .from('contracts')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return contract
}

async function getOpenContractsByAccount(accountId) {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

async function getContractsByAccount(accountId, { limit = 20, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('account_id', accountId)
    .neq('status', 'open')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return data
}

async function getContractById(contractId) {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('id', contractId)
    .single()
  if (error) return null
  return data
}

async function getOpenContractsBySymbol(symbol, currentTick) {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('symbol', symbol)
    .eq('status', 'open')
    .lte('entry_tick', currentTick - 1)
  if (error) throw error
  return data
}

async function settleContract(contractId, { exitPrice, outcome, settledAt }) {
  // Atomic claim: only matches a row if it's STILL 'open' at the moment
  // this runs. If another process already settled it (e.g. the client hit
  // POST /trade/settle/:id right as the engine's own tick loop was about
  // to settle the same expiring contract), this matches zero rows and
  // `data` comes back empty. Callers must check the return value and skip
  // crediting balance / writing a transaction when it's null, or the same
  // win gets paid out twice.
  const { data, error } = await supabase
    .from('contracts')
    .update({ exit_price: exitPrice, outcome, status: 'settled', settled_at: settledAt })
    .eq('id', contractId)
    .eq('status', 'open')
    .select()
  if (error) throw error
  return data && data.length > 0 ? data[0] : null
}

// ── Transactions ──────────────────────────────────────────────────

async function createTransaction(data) {
  const { data: tx, error } = await supabase
    .from('transactions')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return tx
}

// database.js - Replace the getTransactionsByUser function

async function getTransactionsByUser(userId, { limit = 20, offset = 0, type, status } = {}) {
  let q = supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  
  if (type) q = q.eq('type', type)
  if (status) q = q.eq('status', status)
  
  const { data, error } = await q
  if (error) throw error
  return data
}

// Also add a count function for pagination
async function getTransactionsCount(userId, { type, status } = {}) {
  let q = supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
  
  if (type) q = q.eq('type', type)
  if (status) q = q.eq('status', status)
  
  const { count, error } = await q
  if (error) throw error
  return count || 0
}

async function updateTransactionStatus(transactionId, status, reference = null) {
  const update = { status }
  if (reference) update.reference = reference
  const { error } = await supabase
    .from('transactions')
    .update(update)
    .eq('id', transactionId)
  if (error) throw error
}

async function getTransactionByReference(reference) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('reference', reference)
    .single()
  if (error) return null
  return data
}

// ── KYC ──────────────────────────────────────────────────────────

async function createKycDocument(data) {
  const { error } = await supabase.from('kyc_documents').insert(data)
  if (error) throw error
}

async function getKycDocumentsByUser(userId) {
  const { data, error } = await supabase
    .from('kyc_documents')
    .select('*')
    .eq('user_id', userId)
  if (error) throw error
  return data
}

// ── Exchange rates ────────────────────────────────────────────────

// database.js - replace the getExchangeRate function

// ── Exchange rates ────────────────────────────────────────────────

// database.js - update the getExchangeRate function

async function getExchangeRate(fromCcy, toCcy) {
  // If it's USD to KES, use the exchange module
  if (fromCcy === 'USD' && toCcy === 'KES') {
    const exchange = require('./exchange')
    return exchange.getExchangeRate()
  }
  
  // Generic fallback for other pairs
  const { data } = await supabase
    .from('exchange_rates')
    .select('rate')
    .eq('from_ccy', fromCcy)
    .eq('to_ccy', toCcy)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single()
  return data?.rate ?? parseFloat(process.env.DEFAULT_USD_KES_RATE || '130')
}

async function getAccountById(accountId) {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single()
  if (error) throw error
  return data
}

// ── Admin: transactions & stats ─────────────────────────────────────

async function getAllTransactionsAdmin({ limit = 20, offset = 0, type, status } = {}) {
  // PostgREST never exposes the `auth` schema (see profiles.sql), so
  // embedding `users:auth.users(email)` here threw at the DB layer on
  // every call — that's what was surfacing as "transactions fail to
  // load" on the admin dashboard. admin.js's getAllTransactions already
  // calls attachProfiles() against `public.profiles` to attach
  // email/display_name, so this embed was both broken and redundant.
  let q = supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (type) q = q.eq('type', type)
  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) throw error
  return data
}

async function getAllTransactionsCountAdmin({ type, status } = {}) {
  let q = supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })

  if (type) q = q.eq('type', type)
  if (status) q = q.eq('status', status)

  const { count, error } = await q
  if (error) throw error
  return count || 0
}

async function getPlatformStats() {
  const { data, error } = await supabase.rpc('get_platform_stats').single()
  if (error) throw error
  return data
}

// ── Influencer withdrawals (mock flow) ──────────────────────────────

async function createInfluencerWithdrawal(data) {
  const { data: row, error } = await supabase
    .from('influencer_withdrawals')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return row
}

async function getInfluencerWithdrawalById(id) {
  const { data, error } = await supabase
    .from('influencer_withdrawals')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return null
  return data
}

async function getInfluencerWithdrawalsByUser(userId) {
  const { data, error } = await supabase
    .from('influencer_withdrawals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

async function getAllInfluencerWithdrawals({ status } = {}) {
  // Same broken auth.users embed as getAllTransactionsAdmin above — removed
  // for the same reason. Email/display_name should be attached via
  // attachProfiles() by the caller (admin.js) if the UI needs it.
  let q = supabase
    .from('influencer_withdrawals')
    .select('*')
    .order('created_at', { ascending: false })

  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) throw error
  return data
}

async function updateInfluencerWithdrawalStatus(id, status, { simulatedBy = null, notes = null } = {}) {
  const update = { status }
  if (status !== 'pending') {
    update.simulated_at = new Date().toISOString()
    update.simulated_by = simulatedBy
  }
  if (notes) update.notes = notes

  const { data, error } = await supabase
    .from('influencer_withdrawals')
    .update(update)
    .eq('id', id)
    .eq('status', 'pending') // atomic claim, same pattern as settleContract
    .select()
  if (error) throw error
  return data && data.length > 0 ? data[0] : null
}

module.exports = {
  supabase,
  createUserAccounts,
  getAccountsByUserId,
  getAccountByUserAndType,
  deductBalance,
  addBalance,
  updatePL,
  getAccountById,
  createContract,
  getOpenContractsByAccount,
  getContractsByAccount,
  getContractById,
  getOpenContractsBySymbol,
  settleContract,
  createTransaction,
  getTransactionsByUser,
  getTransactionsCount,
  updateTransactionStatus,
  getTransactionByReference,
  createKycDocument,
  getKycDocumentsByUser,
  getExchangeRate,
  getAllTransactionsAdmin,
  getAllTransactionsCountAdmin,
  getPlatformStats,
  createInfluencerWithdrawal,
  getInfluencerWithdrawalById,
  getInfluencerWithdrawalsByUser,
  getAllInfluencerWithdrawals,
  updateInfluencerWithdrawalStatus,
}