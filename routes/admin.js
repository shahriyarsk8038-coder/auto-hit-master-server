const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

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

// Middleware to protect admin routes
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  res.redirect('/admin/login');
}

// GET Login
router.get('/login', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin/dashboard');
  }
  res.render('login', { error: null });
});

// POST Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const admin = await dbGet('SELECT * FROM admins WHERE username = ?', [username.trim()]);
    if (admin && bcrypt.compareSync(password, admin.password_hash)) {
      req.session.admin = { id: admin.id, username: admin.username };
      return res.redirect('/admin/dashboard');
    }
    res.render('login', { error: 'Invalid admin username or password.' });
  } catch (err) {
    res.render('login', { error: 'Database error.' });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// GET Dashboard
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const totalUsersRow = await dbGet('SELECT COUNT(*) as count FROM users');
    const activeUsersRow = await dbGet("SELECT COUNT(*) as count FROM users WHERE status = 'active' AND expires_at > datetime('now')");
    const expiredUsersRow = await dbGet("SELECT COUNT(*) as count FROM users WHERE expires_at <= datetime('now')");
    const suspendedUsersRow = await dbGet("SELECT COUNT(*) as count FROM users WHERE status = 'suspended'");
    
    const recentUsers = await dbAll('SELECT * FROM users ORDER BY created_at DESC LIMIT 5');

    res.render('dashboard', {
      admin: req.session.admin,
      stats: {
        total: totalUsersRow ? totalUsersRow.count : 0,
        active: activeUsersRow ? activeUsersRow.count : 0,
        expired: expiredUsersRow ? expiredUsersRow.count : 0,
        suspended: suspendedUsersRow ? suspendedUsersRow.count : 0
      },
      recentUsers
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// GET User Management List
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await dbAll('SELECT * FROM users ORDER BY created_at DESC');
    const now = new Date();
    
    const processedUsers = users.map(u => {
      const expiresAt = new Date(u.expires_at);
      const isExpired = now > expiresAt;
      const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
      return {
        ...u,
        isExpired,
        daysLeft: daysLeft > 0 ? daysLeft : 0
      };
    });

    res.render('users', {
      admin: req.session.admin,
      users: processedUsers,
      msg: req.query.msg || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// GET Create User Form
router.get('/users/create', requireAdmin, (req, res) => {
  res.render('create-user', { admin: req.session.admin, error: null });
});

// POST Create User
router.post('/users/create', requireAdmin, async (req, res) => {
  const { user_id, password, name, phone, duration_days } = req.body;

  if (!user_id || !password || !duration_days) {
    return res.render('create-user', { admin: req.session.admin, error: 'User ID, Password, and Duration are required.' });
  }

  try {
    const existing = await dbGet('SELECT * FROM users WHERE user_id = ?', [user_id.trim()]);
    if (existing) {
      return res.render('create-user', { admin: req.session.admin, error: 'User ID already exists. Choose a different ID.' });
    }

    const passwordHash = bcrypt.hashSync(password.trim(), 10);
    
    // Calculate expiration date
    const days = parseInt(duration_days, 10) || 30;
    const expiresDate = new Date();
    expiresDate.setDate(expiresDate.getDate() + days);
    const expiresAtStr = expiresDate.toISOString().replace('T', ' ').substring(0, 19);

    await dbRun(
      'INSERT INTO users (user_id, password_hash, name, phone, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [user_id.trim(), passwordHash, name ? name.trim() : '', phone ? phone.trim() : '', 'active', expiresAtStr]
    );

    res.redirect('/admin/users?msg=User created successfully');
  } catch (err) {
    console.error(err);
    res.render('create-user', { admin: req.session.admin, error: 'Failed to create user.' });
  }
});

// POST Renew User Expiry Date
router.post('/users/:id/renew', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { extend_days } = req.body;

  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.redirect('/admin/users?error=User not found');
    }

    const addDays = parseInt(extend_days, 10) || 30;
    const currentExpiry = new Date(user.expires_at);
    const now = new Date();
    
    // If user is already expired, extend from TODAY. Otherwise extend from current expiry date.
    const baseDate = currentExpiry > now ? currentExpiry : now;
    baseDate.setDate(baseDate.getDate() + addDays);
    const newExpiryStr = baseDate.toISOString().replace('T', ' ').substring(0, 19);

    await dbRun(
      "UPDATE users SET expires_at = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newExpiryStr, userId]
    );

    res.redirect(`/admin/users?msg=Subscription for ${user.user_id} renewed for ${addDays} days.`);
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users?error=Failed to renew user');
  }
});

// POST Reset PC Lock (HWID)
router.post('/users/:id/reset-pc', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.redirect('/admin/users?error=User not found');

    await dbRun('UPDATE users SET hwid = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    res.redirect(`/admin/users?msg=PC lock reset for user ${user.user_id}. They can now login on a new PC.`);
  } catch (err) {
    res.redirect('/admin/users?error=Failed to reset PC lock');
  }
});

// POST Toggle User Status (Active / Suspended)
router.post('/users/:id/toggle-status', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.redirect('/admin/users?error=User not found');

    const newStatus = user.status === 'active' ? 'suspended' : 'active';
    await dbRun('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newStatus, userId]);
    res.redirect(`/admin/users?msg=User ${user.user_id} status changed to ${newStatus}.`);
  } catch (err) {
    res.redirect('/admin/users?error=Failed to update user status');
  }
});

// POST Delete User
router.post('/users/:id/delete', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    await dbRun('DELETE FROM users WHERE id = ?', [userId]);
    res.redirect('/admin/users?msg=User deleted successfully');
  } catch (err) {
    res.redirect('/admin/users?error=Failed to delete user');
  }
});

module.exports = router;
