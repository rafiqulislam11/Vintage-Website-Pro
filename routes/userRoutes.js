const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// -------------------------------------------------------------
// 1. GET USER PROFILE
// -------------------------------------------------------------
router.get('/profile', requireAuth, (req, res) => {
  return res.json({
    success: true,
    user: req.user
  });
});

// -------------------------------------------------------------
// 2. CHANGE PASSWORD
// -------------------------------------------------------------
router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ success: false, message: 'All password fields are required.' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ success: false, message: 'Confirm password does not match new password.' });
  }

  try {
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const isMatch = bcrypt.compareSync(current_password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    const newHash = bcrypt.hashSync(new_password, 12);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, user.id);

    return res.json({
      success: true,
      message: 'Password changed successfully.'
    });
  } catch (err) {
    console.error('Change Password Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred.' });
  }
});

// -------------------------------------------------------------
// 3. UPDATE PROFILE
// -------------------------------------------------------------
router.post('/update-profile', requireAuth, (req, res) => {
  const { full_name, mobile_number } = req.body;

  if (!full_name || !mobile_number) {
    return res.status(400).json({ success: false, message: 'Full name and mobile number are required.' });
  }

  const trimmedName = full_name.trim();
  const cleanMobile = mobile_number.replace(/[\s-]/g, '');

  if (trimmedName.length < 2) {
    return res.status(400).json({ success: false, message: 'Name must be at least 2 characters.' });
  }

  try {
    // Check if mobile number taken by another user
    const existingMobile = db.prepare('SELECT id FROM users WHERE mobile_number = ? AND id != ?').get(cleanMobile, req.user.id);
    if (existingMobile) {
      return res.status(409).json({ success: false, message: 'This mobile number is already in use by another account.' });
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    db.prepare('UPDATE users SET full_name = ?, mobile_number = ?, updated_at = ? WHERE id = ?').run(trimmedName, cleanMobile, now, req.user.id);

    return res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        ...req.user,
        full_name: trimmedName,
        mobile_number: cleanMobile
      }
    });
  } catch (err) {
    console.error('Update Profile Error:', err);
    return res.status(500).json({ success: false, message: 'An internal server error occurred.' });
  }
});

module.exports = router;
