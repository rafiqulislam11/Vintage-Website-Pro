const jwt = require('jsonwebtoken');
const db = require('../database/db');

function requireAuth(req, res, next) {
  let token = null;

  // 1. Check cookies
  if (req.cookies && req.cookies.saas_token) {
    token = req.cookies.saas_token;
  }

  // 2. Check Authorization header
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please log in.'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_for_jwt');

    // Verify session exists in DB and is not expired
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const session = db.prepare(`
      SELECT * FROM sessions WHERE token = ? AND expires_at > ?
    `).get(token, now);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or invalidated. Please log in again.'
      });
    }

    // Fetch user details including role
    const user = db.prepare(`
      SELECT id, full_name, email, mobile_number, role, email_verified, created_at, last_login 
      FROM users WHERE id = ?
    `).get(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User account not found.'
      });
    }

    req.user = user;
    req.sessionToken = token;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired session token.'
    });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Administrator privileges required.'
      });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
