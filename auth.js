// auth.js
const db = require('./database')
const { supabaseAuth } = require('./middleware')

async function onSignup(req, res) {
  const secret = req.headers['x-supabase-webhook-secret']
  if (secret !== process.env.SUPABASE_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { record } = req.body
  const userId = record.id

  try {
    // Create accounts
    await db.createUserAccounts(userId)
    
    // Create KYC submission record
    await db.supabase.from('kyc_submissions').insert({
      user_id: userId,
      status: 'pending'
    })
    
    // Set default user role
    await db.supabase.from('user_roles').insert({
      user_id: userId,
      role: 'user'
    })
    
    // Check if this is an admin email
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim())
    if (adminEmails.includes(record.email)) {
      await db.supabase.from('user_roles').upsert({
        user_id: userId,
        role: 'admin'
      })
    }
    
    res.status(200).json({ success: true })
  } catch (err) {
    console.error('Failed to create accounts for user', userId, err)
    res.status(500).json({ error: 'Account setup failed' })
  }
}

async function getMe(req, res, next) {
  try {
    const [accounts, kycSub, role] = await Promise.all([
      db.getAccountsByUserId(req.user.id),
      db.supabase.from('kyc_submissions').select('*').eq('user_id', req.user.id).single(),
      db.supabase.from('user_roles').select('role').eq('user_id', req.user.id).single(),
    ])

    const kycStatus = kycSub.data?.status || 'none'

    res.json({
      success: true,
      data: {
        user: {
          id: req.user.id,
          email: req.user.email,
        },
        accounts,
        kycStatus,
        role: role.data?.role || 'user',
      },
    })
  } catch (err) { next(err) }
}

async function updateProfile(req, res, next) {
  try {
    const { name } = req.body
    const { error } = await db.supabase.auth.admin.updateUserById(req.user.id, {
      user_metadata: { display_name: name },
    })
    if (error) throw error
    res.json({ success: true, data: { message: 'Profile updated.' } })
  } catch (err) { next(err) }
}

async function getKycStatus(userId) {
  const { data } = await db.supabase
    .from('kyc_submissions')
    .select('status')
    .eq('user_id', userId)
    .single()
  return data?.status || 'none'
}

module.exports = { onSignup, getMe, updateProfile, getKycStatus }