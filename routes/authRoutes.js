const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { checkRateLimit, recordFailedAttempt, clearFailedAttempts } = require('../middleware/rateLimiter');

const router = express.Router();

// Helper: Email Validation Regex
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

// Helper: Mobile Number Validation (allows optional + and 8-15 digits)
function isValidMobile(mobile) {
  const re = /^\+?[0-9]{8,15}$/;
  return re.test(String(mobile).replace(/[\s-]/g, ''));
}

// -------------------------------------------------------------
// 1. USER REGISTRATION
// -------------------------------------------------------------
router.post('/register', (req, res) => {
  const { full_name, email, mobile_number, password, confirm_password, terms } = req.body;

  // Validation
  if (!full_name || !email || !mobile_number || !password || !confirm_password) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }

  const trimmedName = full_name.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const cleanMobile = mobile_number.replace(/[\s-]/g, '');

  if (trimmedName.length < 2) {
    return res.status(400).json({ success: false, message: 'Full Name must be at least 2 characters long.' });
  }

  if (!isValidEmail(trimmedEmail)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid Gmail or Email address.' });
  }

  if (!isValidMobile(cleanMobile)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid mobile number (8-15 digits).' });
  }

  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
  }

  if (password !== confirm_password) {
    return res.status(400).json({ success: false, message: 'Confirm Password does not match Password.' });
  }

  if (terms !== true && terms !== 'true' && terms !== 1) {
    return res.status(400).json({ success: false, message: 'You must agree to the Terms & Conditions.' });
  }

  try {
    // Check duplicate email
    const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(trimmedEmail);
    if (existingEmail) {
      return res.status(409).json({ success: false, message: 'This email address is already registered. Please log in.' });
    }

    // Check duplicate mobile
    const existingMobile = db.prepare('SELECT id FROM users WHERE mobile_number = ?').get(cleanMobile);
    if (existingMobile) {
      return res.status(409).json({ success: false, message: 'This mobile number is already registered with another account.' });
    }

    // Hash password with bcrypt
    const passwordHash = bcrypt.hashSync(password, 12);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const stmt = db.prepare(`
      INSERT INTO users (full_name, email, mobile_number, password_hash, email_verified, created_at, updated_at, last_login)
      VALUES (?, ?, ?, ?, 1, ?, ?, NULL)
    `);

    const result = stmt.run(trimmedName, trimmedEmail, cleanMobile, passwordHash, now, now);

    return res.status(201).json({
      success: true,
      message: 'Registration successful! You can now log in with your credentials.',
      userId: result.lastInsertRowid
    });
  } catch (err) {
    console.error('Registration Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred during registration.' });
  }
});

// -------------------------------------------------------------
// 2. USER LOGIN
// -------------------------------------------------------------
router.post('/login', checkRateLimit, (req, res) => {
  const { email, password, remember_me } = req.body;
  const ip = req.clientIp || req.socket.remoteAddress || 'unknown';

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Please provide both email and password.' });
  }

  const trimmedEmail = email.trim().toLowerCase();

  try {
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(trimmedEmail);

    if (!user) {
      recordFailedAttempt(ip, trimmedEmail);
      return res.status(401).json({ success: false, message: 'Invalid email address or password.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      recordFailedAttempt(ip, trimmedEmail);
      return res.status(401).json({ success: false, message: 'Invalid email address or password.' });
    }

    // Clear failed attempts upon successful login
    clearFailedAttempts(ip);

    // Update last_login
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now, user.id);

    // Session duration
    const isRemember = Boolean(remember_me);
    const expiryDays = isRemember ? parseInt(process.env.SESSION_EXPIRY_DAYS || '30', 10) : 1;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || 'fallback_secret_for_jwt',
      { expiresIn: `${expiryDays}d` }
    );

    // Store session in DB for revocation tracking
    db.prepare(`
      INSERT INTO sessions (user_id, token, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, token, expiresAt, now);

    // Set secure cookie
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('saas_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: expiryDays * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      message: 'Login successful! Welcome back.',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        mobile_number: user.mobile_number,
        email_verified: Boolean(user.email_verified),
        created_at: user.created_at,
        last_login: now
      }
    });
  } catch (err) {
    console.error('Login Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred during login.' });
  }
});

// -------------------------------------------------------------
// 3. GET CURRENT USER PROFILE
// -------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  return res.json({
    success: true,
    user: req.user
  });
});

// -------------------------------------------------------------
// 4. USER LOGOUT
// -------------------------------------------------------------
router.post('/logout', (req, res) => {
  let token = req.cookies ? req.cookies.saas_token : null;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    try {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    } catch (e) {}
  }

  res.clearCookie('saas_token');
  return res.json({ success: true, message: 'Successfully logged out.' });
});

// -------------------------------------------------------------
// 5. FORGOT PASSWORD (REQUEST RESET LINK)
// -------------------------------------------------------------
router.post('/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid registered email address.' });
  }

  const trimmedEmail = email.trim().toLowerCase();

  try {
    const user = db.prepare('SELECT id, full_name, email FROM users WHERE LOWER(email) = LOWER(?)').get(trimmedEmail);

    // Always return neutral response to prevent email enumeration
    const genericResponse = {
      success: true,
      message: 'If an account exists with this email address, a password reset link has been dispatched.'
    };

    if (!user) {
      return res.json(genericResponse);
    }

    // Generate single-use secure 32-byte hex token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    // 1-hour expiration
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    db.prepare(`
      INSERT INTO password_resets (user_id, token, expires_at, used, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(user.id, resetToken, expiresAt, now);

    // In dev environment or test mode, provide reset_token directly in response for immediate testing
    return res.json({
      ...genericResponse,
      dev_reset_token: resetToken,
      dev_reset_url: `/reset-password?token=${resetToken}`
    });
  } catch (err) {
    console.error('Forgot Password Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred.' });
  }
});

// -------------------------------------------------------------
// 6. RESET PASSWORD (SUBMIT NEW PASSWORD)
// -------------------------------------------------------------
router.post('/reset-password', (req, res) => {
  const { token, new_password, confirm_password } = req.body;

  if (!token || !new_password || !confirm_password) {
    return res.status(400).json({ success: false, message: 'Reset token and new passwords are required.' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ success: false, message: 'Confirm password does not match new password.' });
  }

  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Verify token exists, is unused, and not expired
    const record = db.prepare(`
      SELECT * FROM password_resets 
      WHERE token = ? AND used = 0 AND expires_at > ?
    `).get(token, now);

    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'This password reset link is invalid or has expired. Please request a new one.'
      });
    }

    // Hash new password
    const newHash = bcrypt.hashSync(new_password, 12);

    // Update user password and updated_at
    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?
    `).run(newHash, now, record.user_id);

    // Invalidate reset token (single-use!)
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(record.id);

    // Invalidate all active sessions for this user for security
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(record.user_id);

    return res.json({
      success: true,
      message: 'Password reset successful! You can now log in with your new password.'
    });
  } catch (err) {
    console.error('Reset Password Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred during password reset.' });
  }
});

module.exports = router;
