const express = require('express');
const db = require('../database/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Helper to get system settings
function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

// All admin routes require admin privileges
router.use(requireAdmin);

// -------------------------------------------------------------
// 1. GET ALL PAYMENT REQUESTS (WITH USER DETAILS)
// -------------------------------------------------------------
router.get('/payments', (req, res) => {
  try {
    const payments = db.prepare(`
      SELECT p.*, 
             u.full_name AS user_name, 
             u.email AS user_email, 
             u.mobile_number AS user_mobile
      FROM payments p
      JOIN users u ON p.user_id = u.id
      ORDER BY p.id DESC
    `).all();

    return res.json({
      success: true,
      payments
    });
  } catch (err) {
    console.error('Admin Fetch Payments Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve payment requests.' });
  }
});

// -------------------------------------------------------------
// 2. APPROVE PAYMENT & AUTOMATICALLY ACTIVATE SUBSCRIPTION
// -------------------------------------------------------------
router.post('/payments/:id/approve', (req, res) => {
  const paymentId = parseInt(req.params.id, 10);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment request not found.' });
    }

    if (payment.status === 'approved') {
      return res.status(400).json({ success: false, message: 'This payment has already been approved.' });
    }

    // Calculate subscription duration
    let expiryDate = null;
    const durMonthly = parseInt(getSetting('duration_monthly', '30'), 10);
    const durYearly = parseInt(getSetting('duration_yearly', '365'), 10);

    if (payment.plan_type === 'monthly') {
      expiryDate = new Date(Date.now() + durMonthly * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    } else if (payment.plan_type === 'yearly') {
      expiryDate = new Date(Date.now() + durYearly * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    } else if (payment.plan_type === 'lifetime') {
      expiryDate = null; // Lifetime access: no expiry
    }

    // 1. Update Payment Status to APPROVED
    db.prepare(`
      UPDATE payments 
      SET status = 'approved', approved_by = ?, rejection_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(req.user.id, now, paymentId);

    // 2. Cancel/Deactivate any prior active subscription for this user
    db.prepare(`
      UPDATE subscriptions 
      SET status = 'cancelled', updated_at = ?
      WHERE user_id = ? AND status = 'active'
    `).run(now, payment.user_id);

    // 3. Insert newly activated subscription
    const subStmt = db.prepare(`
      INSERT INTO subscriptions (user_id, plan_type, status, start_date, expiry_date, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?)
    `);

    const subResult = subStmt.run(payment.user_id, payment.plan_type, now, expiryDate, now, now);

    return res.json({
      success: true,
      message: `Payment approved! Subscription successfully activated (${payment.plan_type.toUpperCase()}).`,
      subscription: {
        id: subResult.lastInsertRowid,
        user_id: payment.user_id,
        plan_type: payment.plan_type,
        status: 'active',
        start_date: now,
        expiry_date: expiryDate
      }
    });
  } catch (err) {
    console.error('Admin Approve Payment Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to approve payment request.' });
  }
});

// -------------------------------------------------------------
// 3. REJECT PAYMENT WITH REASON
// -------------------------------------------------------------
router.post('/payments/:id/reject', (req, res) => {
  const paymentId = parseInt(req.params.id, 10);
  const { rejection_reason } = req.body;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment request not found.' });
    }

    const reason = rejection_reason ? rejection_reason.trim() : 'Invalid Transaction ID or payment not received.';

    db.prepare(`
      UPDATE payments 
      SET status = 'rejected', rejection_reason = ?, approved_by = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, req.user.id, now, paymentId);

    return res.json({
      success: true,
      message: 'Payment request has been rejected.',
      payment: {
        id: paymentId,
        status: 'rejected',
        rejection_reason: reason
      }
    });
  } catch (err) {
    console.error('Admin Reject Payment Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reject payment request.' });
  }
});

// -------------------------------------------------------------
// 4. GET SYSTEM SETTINGS
// -------------------------------------------------------------
router.get('/settings', (req, res) => {
  try {
    const settings = db.prepare('SELECT key, value FROM system_settings').all();
    const map = {};
    settings.forEach(s => map[s.key] = s.value);

    return res.json({
      success: true,
      settings: map
    });
  } catch (err) {
    console.error('Admin Fetch Settings Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve settings.' });
  }
});

// -------------------------------------------------------------
// 5. UPDATE SYSTEM SETTINGS (PAYMENT NUMBERS, WHATSAPP, PRICING)
// -------------------------------------------------------------
router.post('/settings', (req, res) => {
  const { bkash_number, nagad_number, whatsapp_number, price_monthly, price_yearly, price_lifetime } = req.body;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    const updates = [
      ['bkash_number', bkash_number],
      ['nagad_number', nagad_number],
      ['whatsapp_number', whatsapp_number],
      ['price_monthly', price_monthly],
      ['price_yearly', price_yearly],
      ['price_lifetime', price_lifetime]
    ];

    const stmt = db.prepare(`
      INSERT INTO system_settings (key, value, updated_at) 
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    for (const [key, val] of updates) {
      if (typeof val !== 'undefined' && val !== null && String(val).trim() !== '') {
        stmt.run(key, String(val).trim(), now);
      }
    }

    return res.json({
      success: true,
      message: 'Admin settings updated successfully!'
    });
  } catch (err) {
    console.error('Admin Update Settings Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update settings.' });
  }
});

// -------------------------------------------------------------
// 6. ADMIN SUMMARY STATS
// -------------------------------------------------------------
router.get('/stats', (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const activeSubs = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'").get().c;
    const pendingPayments = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status = 'pending'").get().c;
    const approvedRevenue = db.prepare("SELECT SUM(amount) as s FROM payments WHERE status = 'approved'").get().s || 0;

    return res.json({
      success: true,
      stats: {
        total_users: totalUsers,
        active_subscriptions: activeSubs,
        pending_payments: pendingPayments,
        approved_revenue: approvedRevenue
      }
    });
  } catch (err) {
    console.error('Admin Stats Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve stats.' });
  }
});

module.exports = router;
