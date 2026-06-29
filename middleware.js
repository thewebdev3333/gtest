// middleware.js
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { createClient } = require('@supabase/supabase-js')
const { validationResult, body, param, header } = require('express-validator')

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
}

const corsOptions = {
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, error: 'Rate limit exceeded.', code: 'RATE_LIMITED' },
})

const withdrawalLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: { success: false, error: 'Maximum 3 withdrawals per day.', code: 'RATE_LIMITED' },
})

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Not authenticated.', code: 'UNAUTHORIZED' })
  }

  const token = authHeader.split(' ')[1]

  const { data: { user }, error } = await supabaseAuth.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ success: false, error: 'Session expired or invalid.', code: 'TOKEN_EXPIRED' })
  }

  req.user = { id: user.id, email: user.email }
  req.token = token
  next()
}

function requireRole(role) {
  return async (req, res, next) => {
    try {
      const { data, error } = await supabaseAuth
        .from('user_roles')
        .select('role')
        .eq('user_id', req.user.id)
        .single()
      
      if (error || !data || data.role !== role) {
        return res.status(403).json({ 
          success: false, 
          error: 'Admin access required.', 
          code: 'FORBIDDEN' 
        })
      }
      
      req.isAdmin = true
      next()
    } catch (err) {
      res.status(403).json({ success: false, error: 'Admin access required.', code: 'FORBIDDEN' })
    }
  }
}

function requireOwnership(getResourceFn) {
  return async (req, res, next) => {
    try {
      const resource = await getResourceFn(req)
      if (!resource) {
        return res.status(404).json({ success: false, error: 'Not found.', code: 'NOT_FOUND' })
      }
      if (resource.user_id !== req.user.id && !req.isAdmin) {
        return res.status(403).json({ success: false, error: 'Access denied.', code: 'FORBIDDEN' })
      }
      req.resource = resource
      next()
    } catch (err) {
      next(err)
    }
  }
}

function validate(req, res, next) {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed.',
      code: 'VALIDATION_ERROR',
      fields: errors.array().map(e => ({ field: e.path, message: e.msg })),
    })
  }
  next()
}

function checkIdempotency() {
  return async (req, res, next) => {
    const key = req.headers['x-idempotency-key']
    if (!key) {
      req.idempotencyKey = null
      req.idempotencyStore = null
      return next()
    }
    
    const { data, error } = await supabaseAuth
      .from('idempotency_keys')
      .select('response, created_at')
      .eq('key', key)
      .eq('user_id', req.user.id)
      .gt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .single()
    
    if (data) {
      return res.status(200).json(data.response)
    }
    
    req.idempotencyKey = key
    req.idempotencyStore = (response) => {
      return supabaseAuth.from('idempotency_keys').insert({
        key,
        user_id: req.user.id,
        response,
      })
    }
    next()
  }
}

/**
 * Format phone number for validation
 * Supports: 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX
 */
function isValidKenyanPhone(phone) {
  if (!phone) return false
  const cleaned = phone.replace(/\s/g, '')
  // Accept: 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX
  // Also: 7XXXXXXXX, 1XXXXXXXX (without leading 0)
  const patterns = [
    /^07\d{8}$/,           // 0712345678
    /^01\d{8}$/,           // 0112345678
    /^2547\d{8}$/,         // 254712345678
    /^2541\d{8}$/,         // 254112345678
    /^7\d{8}$/,            // 712345678
    /^1\d{8}$/,            // 112345678
  ]
  return patterns.some(p => p.test(cleaned))
}

// Export the validator function for use elsewhere
const validatePhone = (value) => {
  if (!isValidKenyanPhone(value)) {
    throw new Error('Phone must be in format 07XXXXXXXX or 01XXXXXXXX')
  }
  return true
}

const validators = {
  placeTrade: [
    body('accountType').isIn(['demo', 'real']),
    body('symbol').isIn(['V20_1S', 'V50_1S', 'V100_1S']),
    body('contractType').isIn(['rise_fall', 'over_under', 'match_differ', 'even_odd']),
    body('direction').isIn(['rise', 'fall', 'over', 'under', 'match', 'differ', 'even', 'odd']),
    body('stake').isFloat({ min: 2 }).withMessage('Minimum stake is $2'),
    body('durationTicks').isInt({ min: 1, max: 3600 }),
    body('selectedDigit').optional().isInt({ min: 0, max: 9 }),
  ],

  depositMpesa: [
    header('x-idempotency-key').optional().isString().isLength({ min: 10 }),
    body('phone').custom(validatePhone),
    body('amountKES').isFloat({ min: 260 }).withMessage('Minimum deposit is KES 260 (~$2)'),
  ],

  withdrawMpesa: [
    header('x-idempotency-key').optional().isString().isLength({ min: 10 }),
    body('phone').custom(validatePhone),
    body('amountUSD').isFloat({ min: 2 }).withMessage('Minimum withdrawal is $2'),
  ],

  updateProfile: [
    body('name').optional().trim().isLength({ min: 2, max: 100 }),
  ],

  adminKycReview: [
    body('userId').isUUID(),
    body('status').isIn(['approved', 'rejected']),
    body('notes').optional().isString().isLength({ max: 500 }),
  ],

  adminWithdrawalReview: [
    body('withdrawalId').isUUID(),
    body('action').isIn(['approve', 'reject']),
    body('notes').optional().isString().isLength({ max: 500 }),
  ],

  setUserRole: [
    param('userId').isUUID(),
    body('role').isIn(['user', 'support', 'admin']),
  ],

  kycUpload: [],
}

module.exports = {
  securityHeaders,
  corsOptions,
  authLimiter,
  apiLimiter,
  withdrawalLimiter,
  authenticate,
  requireRole,
  requireOwnership,
  validate,
  checkIdempotency,
  validators,
  supabaseAuth,
  isValidKenyanPhone,
  validatePhone,
}