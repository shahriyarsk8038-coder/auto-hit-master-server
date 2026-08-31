const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const config = require('../config');

// Helper function to query DB using Promises
function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
  });
}

// Login API for Chrome Extension
router.post('/auth/login', async (req, res) => {
  try {
    const { user_id, password, hwid } = req.body;

    if (!user_id || !password) {
      return res.status(400).json({ ok: false, error: 'User ID and Password are required.' });
    }

    const user = await dbGet('SELECT * FROM users WHERE user_id = ?', [user_id.trim()]);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid User ID or Password.' });
    }

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Invalid User ID or Password.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'Account suspended or inactive. Contact Admin.' });
    }

    // Check expiration date
    const now = new Date();
    const expiresAt = new Date(user.expires_at);
    if (now > expiresAt) {
      return res.status(403).json({ 
        ok: false, 
        expired: true, 
        error: 'Subscription expired on ' + expiresAt.toLocaleDateString() + '. Please renew your package.' 
      });
    }

    // Check HWID binding (1 PC per User ID)
    const clientHwid = hwid ? hwid.trim() : null;
    if (!clientHwid) {
      return res.status(400).json({ ok: false, error: 'Device Hardware ID missing.' });
    }

    if (!user.hwid) {
      // First login - bind this device
      await dbRun('UPDATE users SET hwid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [clientHwid, user.id]);
    } else if (user.hwid !== clientHwid) {
      return res.status(403).json({ 
        ok: false, 
        device_locked: true,
        error: 'Access Denied: This account is already locked to another PC.' 
      });
    }

    // Log access
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    dbRun('INSERT INTO logs (user_id, action, hwid, ip) VALUES (?, ?, ?, ?)', [user.user_id, 'LOGIN_SUCCESS', clientHwid, ip]);

    // Sign JWT
    const token = jwt.sign(
      { id: user.id, user_id: user.user_id, hwid: clientHwid, expires_at: user.expires_at },
      config.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({
      ok: true,
      token,
      user: {
        user_id: user.user_id,
        name: user.name,
        expires_at: user.expires_at,
        days_left: Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24))
      }
    });

  } catch (err) {
    console.error('[API Auth Login Error]', err);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

// Verification API for Chrome Extension
router.post('/license/check', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const { user_id, hwid } = req.body;
    let tokenUserId = user_id;
    let tokenHwid = hwid;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        tokenUserId = decoded.user_id;
        tokenHwid = decoded.hwid;
      } catch (e) {
        return res.status(401).json({ ok: false, error: 'Invalid or expired session token.' });
      }
    }

    if (!tokenUserId) {
      return res.status(400).json({ ok: false, error: 'User ID required.' });
    }

    const user = await dbGet('SELECT * FROM users WHERE user_id = ?', [tokenUserId]);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User account not found.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'Account suspended.' });
    }

    const now = new Date();
    const expiresAt = new Date(user.expires_at);
    if (now > expiresAt) {
      return res.status(403).json({ 
        ok: false, 
        expired: true, 
        error: 'Subscription expired. Contact admin to renew.' 
      });
    }

    if (tokenHwid && user.hwid && user.hwid !== tokenHwid) {
      return res.status(403).json({ ok: false, error: 'Account locked to a different PC.' });
    }

    const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

    return res.json({
      ok: true,
      valid: true,
      user_id: user.user_id,
      name: user.name,
      expires_at: user.expires_at,
      days_left: daysLeft,
      hwid: user.hwid
    });

  } catch (err) {
    console.error('[API License Check Error]', err);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

module.exports = router;
