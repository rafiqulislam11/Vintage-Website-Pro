const db = require('../database/db');

function checkRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

  try {
    // Delete login attempts older than 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    db.prepare('DELETE FROM login_attempts WHERE attempt_time < ?').run(oneDayAgo);

    const attempts = db.prepare(`
      SELECT COUNT(*) as count FROM login_attempts 
      WHERE ip_address = ? AND attempt_time > ?
    `).get(ip, fifteenMinutesAgo);

    if (attempts && attempts.count >= 5) {
      return res.status(429).json({
        success: false,
        message: 'Too many failed login attempts from your IP. Please try again in 15 minutes.'
      });
    }

    req.clientIp = ip;
    next();
  } catch (err) {
    console.error('Rate limit error:', err);
    next();
  }
}

function recordFailedAttempt(ip, email) {
  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    db.prepare('INSERT INTO login_attempts (ip_address, email, attempt_time) VALUES (?, ?, ?)').run(ip, email || null, now);
  } catch (err) {
    console.error('Record failed attempt error:', err);
  }
}

function clearFailedAttempts(ip) {
  try {
    db.prepare('DELETE FROM login_attempts WHERE ip_address = ?').run(ip);
  } catch (err) {
    console.error('Clear failed attempts error:', err);
  }
}

module.exports = { checkRateLimit, recordFailedAttempt, clearFailedAttempts };
