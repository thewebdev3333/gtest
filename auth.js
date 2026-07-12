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
    
    // Get display name from user metadata using the user's own token
    let displayName = req.user.email?.split('@')[0] || 'User'
    try {
      const { data: userData, error: userError } = await supabaseAuth.auth.getUser(req.token)
      if (!userError && userData?.user?.user_metadata?.display_name) {
        displayName = userData.user.user_metadata.display_name
      }
    } catch (err) {
      console.warn('[getMe] Could not fetch user metadata:', err.message)
    }

    res.json({
      success: true,
      data: {
        user: {
          id: req.user.id,
          email: req.user.email,
          displayName: displayName,
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
    
    // Update user metadata using admin API
    const { data, error } = await supabaseAuth.auth.admin.updateUserById(
      req.user.id,
      {
        user_metadata: { display_name: name },
      }
    )
    
    if (error) throw error
    
    // Return the updated user data with display name
    res.json({ 
      success: true, 
      data: { 
        message: 'Profile updated.',
        user: {
          id: req.user.id,
          email: req.user.email,
          displayName: data.user.user_metadata?.display_name || name,
        }
      } 
    })
  } catch (err) { 
    console.error('[Profile Update] Error:', err)
    next(err) 
  }
}

async function getKycStatus(userId) {
  const { data } = await db.supabase
    .from('kyc_submissions')
    .select('status')
    .eq('user_id', userId)
    .single()
  return data?.status || 'none'
}

// Get user profile with display name - simpler approach with fallback
async function getProfile(req, res, next) {
  try {
    // Try to get the user data from the authenticated client
    let displayName = req.user.email?.split('@')[0] || 'User'
    
    try {
      // Attempt to get the full user data with metadata
      const { data, error } = await supabaseAuth.auth.getUser(req.token)
      if (!error && data?.user?.user_metadata?.display_name) {
        displayName = data.user.user_metadata.display_name
      }
    } catch (err) {
      // If this fails, just use the email-based name
      console.warn('[getProfile] Could not fetch user metadata, using email fallback:', err.message)
    }
    
    res.json({
      success: true,
      data: {
        id: req.user.id,
        email: req.user.email,
        displayName: displayName,
      }
    })
  } catch (err) {
    console.error('[getProfile] Error:', err)
    // Always return a success response with fallback data
    res.json({
      success: true,
      data: {
        id: req.user.id,
        email: req.user.email,
        displayName: req.user.email?.split('@')[0] || 'User',
      }
    })
  }
}

module.exports = { 
  onSignup, 
  getMe, 
  updateProfile, 
  getKycStatus,
  getProfile
}