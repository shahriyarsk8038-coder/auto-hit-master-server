const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../config');

const dbDir = path.dirname(path.resolve(__dirname, '..', config.DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.resolve(__dirname, '..', config.DB_PATH);
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Admin Table
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // User Accounts Table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      status TEXT DEFAULT 'active',
      hwid TEXT DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      max_devices INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Access Logs Table
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT,
      hwid TEXT,
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Initialize Default Admin User if not exists
  db.get('SELECT * FROM admins WHERE username = ?', [config.DEFAULT_ADMIN.username], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync(config.DEFAULT_ADMIN.password, 10);
      db.run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [config.DEFAULT_ADMIN.username, hash], (err) => {
        if (!err) {
          console.log(`[DB] Default admin created: ${config.DEFAULT_ADMIN.username} / ${config.DEFAULT_ADMIN.password}`);
        }
      });
    }
  });
});

module.exports = db;
