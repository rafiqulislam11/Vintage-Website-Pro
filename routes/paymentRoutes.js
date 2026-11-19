const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Multer storage configuration for payment screenshots
const uploadDir = path.resolve(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'payment-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid image type. Only PNG, JPG, JPEG, and WEBP files are allowed.'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter
});

// Helper to get system settings
function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

// -------------------------------------------------------------
// 1. GET SUBSCRIPTION PLANS & PAYMENT NUMBERS
// -------------------------------------------------------------
router.get('/plans-and-settings', (req, res) => {
  const bkashNumber = getSetting('bkash_number', '01930279175');
  const nagadNumber = getSetting('nagad_number', '01930279175');
  const whatsappNumber = getSetting('whatsapp_number', '01310824987');

  const priceMonthly = parseFloat(getSetting('price_monthly', '500'));
  const priceYearly = parseFloat(getSetting('price_yearly', '1500'));
  const priceLifetime = parseFloat(getSetting('price_lifetime', '3000'));

  const durMonthly = parseInt(getSetting('duration_monthly', '30'), 10);
  const durYearly = parseInt(getSetting('duration_yearly', '365'), 10);

  const plans = {
    monthly: {
      id: 'monthly',
      name: 'MONTHLY PLAN',
      price: priceMonthly,
      display_price: `৳${priceMonthly.toLocaleString()}`,
      validity_days: durMonthly,
      validity_text: `${durMonthly} Days`,
      features: [
        'Full Vintage Paper Texture Studio',
        '100 Historic Paper Categories',
        '100 Antique Color Palettes',
        '100 Authentic Edge Styles',
        'Multi-Artboard Generator',
        '30 Days Commercial Access'
      ]
    },
    yearly: {
      id: 'yearly',
      name: 'YEARLY PLAN',
      price: priceYearly,
      display_price: `৳${priceYearly.toLocaleString()}`,
      validity_days: durYearly,
      validity_text: `${durYearly} Days`,
      popular: true,
      features: [
        'Everything in Monthly Plan',
        'Priority High-Speed Rendering',
        'Batch Export Generator (ZIP)',
        'Print-Ready 4K & 8K Resolution',
        'Full Vector AI & SVG Export',
        '365 Days Uninterrupted Access'
      ]
    },
    lifetime: {
      id: 'lifetime',
      name: 'LIFETIME PLAN',
      price: priceLifetime,
      display_price: `৳${priceLifetime.toLocaleString()}`,
      validity_days: null,
      validity_text: 'Lifetime Access',
      badge: 'Best Value',
      features: [
        'Permanent Commercial License',
        'Ultra-Resolution 12,000×12,000 px',
        'Photoshop JSX Script Generator',
        'All Future Texture Packs & Updates',
        'VIP Direct WhatsApp Support',
        'Never Expires · Pay Once'
      ]
    }
  };

  return res.json({
    success: true,
    payment_numbers: {
      bkash: bkashNumber,
      nagad: nagadNumber
    },
    whatsapp_support: {
      number: whatsappNumber,
      direct_url: `https://wa.me/88${whatsappNumber.replace(/[^0-9]/g, '')}?text=Hello%20Admin%2C%20I%20need%20help%20regarding%20my%20subscription%2Fpayment.`
    },
    plans
  });
});

// -------------------------------------------------------------
// 2. GET CURRENT USER'S SUBSCRIPTION & PAYMENT HISTORY
// -------------------------------------------------------------
router.get('/my-status', requireAuth, (req, res) => {
  const userId = req.user.id;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    // 1. Expire any outdated subscriptions automatically
    db.prepare(`
      UPDATE subscriptions 
      SET status = 'expired', updated_at = ?
      WHERE user_id = ? AND status = 'active' AND expiry_date IS NOT NULL AND expiry_date < ?
    `).run(now, userId, now);

    // 2. Fetch active subscription
    const activeSub = db.prepare(`
      SELECT * FROM subscriptions 
      WHERE user_id = ? AND status = 'active' 
      ORDER BY id DESC LIMIT 1
    `).get(userId);

    // 3. Fetch payment history
    const payments = db.prepare(`
      SELECT id, plan_type, amount, payment_method, sender_number, transaction_id, 
             screenshot_url, status, rejection_reason, created_at, updated_at
      FROM payments 
      WHERE user_id = ? 
      ORDER BY id DESC
    `).all(userId);

    // Also check if user has any pending payment request
    const pendingPayment = payments.find(p => p.status === 'pending');

    return res.json({
      success: true,
      user: {
        id: req.user.id,
        full_name: req.user.full_name,
        email: req.user.email,
        mobile_number: req.user.mobile_number,
        role: req.user.role
      },
      has_active_subscription: Boolean(activeSub),
      current_subscription: activeSub ? {
        id: activeSub.id,
        plan_type: activeSub.plan_type,
        status: activeSub.status,
        start_date: activeSub.start_date,
        expiry_date: activeSub.expiry_date,
        is_lifetime: activeSub.expiry_date === null
      } : null,
      pending_payment: pendingPayment || null,
      payments
    });
  } catch (err) {
    console.error('Fetch Subscription Status Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve subscription status.' });
  }
});

// -------------------------------------------------------------
// 3. SUBMIT PAYMENT REQUEST
// -------------------------------------------------------------
router.post('/submit-payment', requireAuth, upload.single('screenshot'), (req, res) => {
  const { plan_type, payment_method, sender_number, transaction_id } = req.body;
  const userId = req.user.id;

  // Validation
  if (!plan_type || !payment_method || !sender_number || !transaction_id) {
    return res.status(400).json({
      success: false,
      message: 'Plan type, payment method, sender mobile number, and Transaction ID (TrxID) are required.'
    });
  }

  const validPlans = ['monthly', 'yearly', 'lifetime'];
  if (!validPlans.includes(plan_type)) {
    return res.status(400).json({ success: false, message: 'Invalid subscription plan selected.' });
  }

  const validMethods = ['bkash', 'nagad'];
  if (!validMethods.includes(payment_method.toLowerCase())) {
    return res.status(400).json({ success: false, message: 'Payment method must be either bKash or Nagad.' });
  }

  const cleanTrx = transaction_id.trim().toUpperCase();
  if (cleanTrx.length < 4) {
    return res.status(400).json({ success: false, message: 'Please provide a valid Transaction ID (TrxID).' });
  }

  const cleanSender = sender_number.trim().replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{8,15}$/.test(cleanSender)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid sender mobile number.' });
  }

  // Calculate server-side expected price
  let expectedAmount = 500;
  if (plan_type === 'monthly') expectedAmount = parseFloat(getSetting('price_monthly', '500'));
  else if (plan_type === 'yearly') expectedAmount = parseFloat(getSetting('price_yearly', '1500'));
  else if (plan_type === 'lifetime') expectedAmount = parseFloat(getSetting('price_lifetime', '3000'));

  try {
    // 1. Prevent duplicate Transaction ID (TrxID)
    const existingTrx = db.prepare('SELECT id, status FROM payments WHERE UPPER(transaction_id) = ?').get(cleanTrx);
    if (existingTrx) {
      return res.status(409).json({
        success: false,
        message: 'This Transaction ID (TrxID) has already been submitted. Please check your transaction ID.'
      });
    }

    // 2. Screenshot URL
    let screenshotUrl = null;
    if (req.file) {
      screenshotUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.screenshot_url) {
      screenshotUrl = req.body.screenshot_url;
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // 3. Insert into payments table (Status: PENDING)
    const stmt = db.prepare(`
      INSERT INTO payments (user_id, plan_type, amount, payment_method, sender_number, transaction_id, screenshot_url, status, rejection_reason, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
    `);

    const result = stmt.run(userId, plan_type, expectedAmount, payment_method.toLowerCase(), cleanSender, cleanTrx, screenshotUrl, now, now);

    return res.status(201).json({
      success: true,
      message: 'Your payment request has been submitted successfully. Please wait for Admin verification.',
      payment: {
        id: result.lastInsertRowid,
        plan_type,
        amount: expectedAmount,
        payment_method: payment_method.toLowerCase(),
        sender_number: cleanSender,
        transaction_id: cleanTrx,
        screenshot_url: screenshotUrl,
        status: 'pending',
        created_at: now
      }
    });
  } catch (err) {
    console.error('Submit Payment Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred while processing your payment.' });
  }
});

module.exports = router;
