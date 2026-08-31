#!/usr/bin/env python3
"""
Auto Hit Master - Standalone Python Backend Server & Admin Dashboard
"""

import os
import sys
import json
import sqlite3
import hashlib
import secrets
import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

PORT = 3000
DB_FILE = os.path.join(os.path.dirname(__file__), 'db', 'autohitmaster.db')
SECRET_KEY = "autohitmaster_python_secret_key_2026"

os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
SESSIONS = {}

def hash_password(password):
    return hashlib.sha256((password + SECRET_KEY).encode('utf-8')).hexdigest()

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT,
            phone TEXT,
            status TEXT DEFAULT 'active',
            hwid TEXT DEFAULT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            action TEXT,
            hwid TEXT,
            ip TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("SELECT * FROM admins WHERE username = 'admin'")
    if not cursor.fetchone():
        admin_hash = hash_password('adminpassword123')
        cursor.execute("INSERT INTO admins (username, password_hash) VALUES ('admin', ?)", (admin_hash,))
        conn.commit()
        print("[DB] Created default admin: username='admin', password='adminpassword123'")

    conn.close()

init_db()

class RequestHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print(f"[{self.date_time_string()}] {self.command} {self.path} -> {args[0]}")

    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def send_json(self, data, code=200):
        self.send_response(code)
        self.send_cors_headers()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def send_html(self, html_content, code=200, cookie_hdr=None):
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        if cookie_hdr:
            self.send_header('Set-Cookie', cookie_hdr)
        self.end_headers()
        self.wfile.write(html_content.encode('utf-8'))

    def redirect(self, location, cookie_hdr=None):
        self.send_response(302)
        self.send_header('Location', location)
        if cookie_hdr:
            self.send_header('Set-Cookie', cookie_hdr)
        self.end_headers()

    def get_session_admin(self):
        cookie_header = self.headers.get('Cookie', '')
        if 'session_id=' in cookie_header:
            sid = cookie_header.split('session_id=')[1].split(';')[0].strip()
            return SESSIONS.get(sid)
        return None

    def read_body_json(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length).decode('utf-8')
        return json.loads(body)

    def read_body_form(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length).decode('utf-8')
        parsed = parse_qs(body)
        return {k: v[0] for k, v in parsed.items()}

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        query = parse_qs(parsed_url.query)

        if path == '/' or path == '/admin':
            return self.redirect('/admin/dashboard')

        if path == '/admin/login':
            return self.render_admin_login()

        if path == '/admin/logout':
            cookie_header = self.headers.get('Cookie', '')
            if 'session_id=' in cookie_header:
                sid = cookie_header.split('session_id=')[1].split(';')[0].strip()
                if sid in SESSIONS:
                    del SESSIONS[sid]
            return self.redirect('/admin/login', cookie_hdr='session_id=; Max-Age=0; Path=/')

        if path == '/admin/dashboard':
            admin = self.get_session_admin()
            if not admin:
                return self.redirect('/admin/login')
            return self.render_admin_dashboard(admin)

        if path == '/admin/users':
            admin = self.get_session_admin()
            if not admin:
                return self.redirect('/admin/login')
            msg = query.get('msg', [None])[0]
            error = query.get('error', [None])[0]
            return self.render_admin_users(admin, msg, error)

        if path == '/admin/users/create':
            admin = self.get_session_admin()
            if not admin:
                return self.redirect('/admin/login')
            return self.render_admin_create_user(admin)

        self.send_json({'ok': False, 'error': '404 Not Found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == '/api/v1/auth/login':
            return self.handle_api_login()

        if path == '/api/v1/license/check':
            return self.handle_api_license_check()

        if path == '/admin/login':
            return self.handle_admin_login_post()

        admin = self.get_session_admin()
        if not admin:
            return self.redirect('/admin/login')

        if path == '/admin/users/create':
            return self.handle_create_user_post()

        if path.startswith('/admin/users/') and path.endswith('/renew'):
            user_id_num = path.split('/')[3]
            return self.handle_renew_user_post(user_id_num)

        if path.startswith('/admin/users/') and path.endswith('/reset-pc'):
            user_id_num = path.split('/')[3]
            return self.handle_reset_pc_post(user_id_num)

        if path.startswith('/admin/users/') and path.endswith('/toggle-status'):
            user_id_num = path.split('/')[3]
            return self.handle_toggle_status_post(user_id_num)

        if path.startswith('/admin/users/') and path.endswith('/delete'):
            user_id_num = path.split('/')[3]
            return self.handle_delete_user_post(user_id_num)

        self.send_json({'ok': False, 'error': 'Endpoint not found'}, 404)

    def handle_api_login(self):
        data = self.read_body_json()
        user_id = data.get('user_id', '').strip()
        password = data.get('password', '').strip()
        hwid = data.get('hwid', '').strip()

        if not user_id or not password:
            return self.send_json({'ok': False, 'error': 'User ID and Password required'}, 400)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        user = cursor.fetchone()

        if not user or user['password_hash'] != hash_password(password):
            conn.close()
            return self.send_json({'ok': False, 'error': 'Invalid User ID or Password'}, 401)

        if user['status'] != 'active':
            conn.close()
            return self.send_json({'ok': False, 'error': 'Account suspended or inactive. Contact admin.'}, 403)

        now = datetime.datetime.utcnow()
        exp_dt = datetime.datetime.fromisoformat(user['expires_at'].replace(' ', 'T'))
        if now > exp_dt:
            conn.close()
            return self.send_json({
                'ok': False,
                'expired': True,
                'error': f"Subscription expired on {exp_dt.strftime('%Y-%m-%d')}. Contact admin to renew."
            }, 403)

        if not hwid:
            conn.close()
            return self.send_json({'ok': False, 'error': 'Hardware ID missing'}, 400)

        if not user['hwid']:
            cursor.execute("UPDATE users SET hwid = ? WHERE id = ?", (hwid, user['id']))
            conn.commit()
        elif user['hwid'] != hwid:
            conn.close()
            return self.send_json({
                'ok': False,
                'device_locked': True,
                'error': 'Access Denied: Account is already bound to another PC.'
            }, 403)

        token = f"TOKEN_{user['id']}_{secrets.token_hex(16)}"
        days_left = max(0, (exp_dt - now).days)

        conn.close()
        return self.send_json({
            'ok': True,
            'token': token,
            'user': {
                'user_id': user['user_id'],
                'name': user['name'],
                'expires_at': user['expires_at'],
                'days_left': days_left
            }
        })

    def handle_api_license_check(self):
        data = self.read_body_json()
        user_id = data.get('user_id', '').strip()
        hwid = data.get('hwid', '').strip()

        if not user_id:
            return self.send_json({'ok': False, 'error': 'User ID required'}, 400)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        user = cursor.fetchone()
        conn.close()

        if not user:
            return self.send_json({'ok': False, 'error': 'User not found'}, 404)

        if user['status'] != 'active':
            return self.send_json({'ok': False, 'error': 'Account suspended'}, 403)

        now = datetime.datetime.utcnow()
        exp_dt = datetime.datetime.fromisoformat(user['expires_at'].replace(' ', 'T'))
        if now > exp_dt:
            return self.send_json({'ok': False, 'expired': True, 'error': 'Subscription expired.'}, 403)

        if hwid and user['hwid'] and user['hwid'] != hwid:
            return self.send_json({'ok': False, 'error': 'Locked to another PC'}, 403)

        days_left = max(0, (exp_dt - now).days)
        return self.send_json({
            'ok': True,
            'valid': True,
            'user_id': user['user_id'],
            'name': user['name'],
            'expires_at': user['expires_at'],
            'days_left': days_left
        })

    def handle_admin_login_post(self):
        form = self.read_body_form()
        username = form.get('username', '').strip()
        password = form.get('password', '').strip()

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM admins WHERE username = ?", (username,))
        admin = cursor.fetchone()
        conn.close()

        if admin and admin['password_hash'] == hash_password(password):
            sid = secrets.token_hex(16)
            SESSIONS[sid] = {'username': admin['username'], 'id': admin['id']}
            return self.redirect('/admin/dashboard', cookie_hdr=f'session_id={sid}; Path=/; HttpOnly')

        return self.render_admin_login(error='Invalid admin credentials.')

    def handle_create_user_post(self):
        form = self.read_body_form()
        user_id = form.get('user_id', '').strip()
        password = form.get('password', '').strip()
        name = form.get('name', '').strip()
        phone = form.get('phone', '').strip()
        days = int(form.get('duration_days', 30))

        if not user_id or not password:
            return self.render_admin_create_user(error='User ID and Password required.')

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        if cursor.fetchone():
            conn.close()
            return self.render_admin_create_user(error='User ID already exists.')

        pwd_hash = hash_password(password)
        exp_dt = datetime.datetime.utcnow() + datetime.timedelta(days=days)
        exp_str = exp_dt.strftime('%Y-%m-%d %H:%M:%S')

        cursor.execute(
            "INSERT INTO users (user_id, password_hash, name, phone, status, expires_at) VALUES (?, ?, ?, ?, 'active', ?)",
            (user_id, pwd_hash, name, phone, exp_str)
        )
        conn.commit()
        conn.close()

        return self.redirect('/admin/users?msg=User+created+successfully')

    def handle_renew_user_post(self, user_num_id):
        form = self.read_body_form()
        extend_days = int(form.get('extend_days', 30))

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_num_id,))
        user = cursor.fetchone()

        if user:
            current_exp = datetime.datetime.fromisoformat(user['expires_at'].replace(' ', 'T'))
            now = datetime.datetime.utcnow()
            base = current_exp if current_exp > now else now
            new_exp = base + datetime.timedelta(days=extend_days)
            new_exp_str = new_exp.strftime('%Y-%m-%d %H:%M:%S')

            cursor.execute("UPDATE users SET expires_at = ?, status = 'active' WHERE id = ?", (new_exp_str, user_num_id))
            conn.commit()

        conn.close()
        return self.redirect('/admin/users?msg=Subscription+renewed')

    def handle_reset_pc_post(self, user_num_id):
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET hwid = NULL WHERE id = ?", (user_num_id,))
        conn.commit()
        conn.close()
        return self.redirect('/admin/users?msg=PC+Lock+Reset')

    def handle_toggle_status_post(self, user_num_id):
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM users WHERE id = ?", (user_num_id,))
        u = cursor.fetchone()
        if u:
            new_status = 'suspended' if u['status'] == 'active' else 'active'
            cursor.execute("UPDATE users SET status = ? WHERE id = ?", (new_status, user_num_id))
            conn.commit()
        conn.close()
        return self.redirect('/admin/users?msg=Status+updated')

    def handle_delete_user_post(self, user_num_id):
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM users WHERE id = ?", (user_num_id,))
        conn.commit()
        conn.close()
        return self.redirect('/admin/users?msg=User+deleted')

    def render_admin_login(self, error=None):
        err_div = f'<div style="color:#ef4444; font-size:12px; margin-bottom:10px;">{error}</div>' if error else ''
        html = f'''<!DOCTYPE html>
<html>
<head><title>Admin Login - Auto Hit Master</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body {{ background:#0f172a; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }} .card {{ background:#1e293b; border:1px solid #334155; padding:30px; border-radius:12px; width:360px; }}</style>
</head>
<body>
<div class="card">
  <div class="text-center mb-3">
    <img src="/logo.png" style="width:48px; height:48px; object-fit:contain;" alt="Logo"><br>
    <h3 class="text-info fw-bold mt-2 mb-0">Auto Hit Master</h3>
  </div>
  <p class="text-center text-muted small mb-4">Admin Dashboard Login</p>
  {err_div}
  <form action="/admin/login" method="POST">
    <div class="mb-3"><label class="small text-muted">USERNAME</label><input type="text" name="username" class="form-control bg-dark text-white border-secondary" required></div>
    <div class="mb-4"><label class="small text-muted">PASSWORD</label><input type="password" name="password" class="form-control bg-dark text-white border-secondary" required></div>
    <button type="submit" class="btn btn-primary w-100 fw-bold">Login to Admin</button>
  </form>
</div>
</body></html>'''
        self.send_html(html)

    def render_admin_dashboard(self, admin):
        conn = get_db()
        cursor = conn.cursor()
        total = cursor.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        active = cursor.execute("SELECT COUNT(*) FROM users WHERE status = 'active' AND expires_at > datetime('now')").fetchone()[0]
        expired = cursor.execute("SELECT COUNT(*) FROM users WHERE expires_at <= datetime('now')").fetchone()[0]
        suspended = cursor.execute("SELECT COUNT(*) FROM users WHERE status = 'suspended'").fetchone()[0]
        recent = cursor.execute("SELECT * FROM users ORDER BY created_at DESC LIMIT 5").fetchall()
        conn.close()

        recent_rows = ''
        for u in recent:
            recent_rows += f'''<tr>
                <td class="fw-bold text-info">{u['user_id']}</td>
                <td>{u['name'] or '-'}</td>
                <td><span class="badge bg-{'success' if u['status']=='active' else 'danger'}">{u['status']}</span></td>
                <td>{u['expires_at'][:10]}</td>
            </tr>'''

        html = f'''<!DOCTYPE html>
<html>
<head><title>Dashboard - Auto Hit Master</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body {{ background:#0f172a; color:#fff; }} .sidebar {{ background:#1e293b; min-height:100vh; width:240px; padding:20px; }} .stat {{ background:#1e293b; border:1px solid #334155; padding:20px; border-radius:10px; }}</style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Hit Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-white mb-3 text-decoration-none font-weight-bold">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-muted mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/users/create" class="d-block text-muted mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold mb-4">Overview Dashboard</h2>
    <div class="row g-3 mb-4">
      <div class="col-md-3"><div class="stat"><div class="text-muted small">TOTAL USERS</div><div class="fs-2 fw-bold">{total}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-muted small">ACTIVE</div><div class="fs-2 text-success fw-bold">{active}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-muted small">EXPIRED</div><div class="fs-2 text-warning fw-bold">{expired}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-muted small">SUSPENDED</div><div class="fs-2 text-danger fw-bold">{suspended}</div></div></div>
    </div>
    <div class="stat">
      <h5 class="fw-bold mb-3">Recently Added Accounts</h5>
      <table class="table table-dark">
        <thead><tr><th>USER ID</th><th>NAME</th><th>STATUS</th><th>EXPIRY</th></tr></thead>
        <tbody>{recent_rows or '<tr><td colspan="4" class="text-muted">No users found.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>
</body></html>'''
        self.send_html(html)

    def render_admin_users(self, admin, msg=None, error=None):
        conn = get_db()
        cursor = conn.cursor()
        users = cursor.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
        conn.close()

        now = datetime.datetime.utcnow()
        rows = ''
        for u in users:
            exp_dt = datetime.datetime.fromisoformat(u['expires_at'].replace(' ', 'T'))
            is_exp = now > exp_dt
            days_left = max(0, (exp_dt - now).days)
            hwid_badge = '<span class="badge bg-secondary">PC Locked</span>' if u['hwid'] else '<span class="badge bg-success">Unbound</span>'
            status_badge = '<span class="badge bg-danger">Suspended</span>' if u['status'] == 'suspended' else ('<span class="badge bg-warning text-dark">Expired</span>' if is_exp else '<span class="badge bg-success">Active</span>')

            rows += f'''<tr>
                <td class="fw-bold text-info">{u['user_id']}</td>
                <td>{u['name'] or '-'}</td>
                <td>{hwid_badge}</td>
                <td>{status_badge}</td>
                <td>{u['expires_at'][:10]}</td>
                <td class="fw-bold {'text-danger' if is_exp else 'text-success'}">{days_left} Days</td>
                <td>
                  <form action="/admin/users/{u['id']}/renew" method="POST" style="display:inline-block;">
                    <select name="extend_days" onchange="this.form.submit()" class="form-select form-select-sm bg-dark text-white border-secondary" style="width:110px;">
                      <option value="">+ Renew</option>
                      <option value="7">+ 7 Days</option>
                      <option value="30">+ 30 Days</option>
                      <option value="90">+ 90 Days</option>
                      <option value="365">+ 1 Year</option>
                    </select>
                  </form>
                  {'<form action="/admin/users/' + str(u['id']) + '/reset-pc" method="POST" style="display:inline-block;"><button class="btn btn-sm btn-outline-warning">Reset PC</button></form>' if u['hwid'] else ''}
                  <form action="/admin/users/{u['id']}/toggle-status" method="POST" style="display:inline-block;"><button class="btn btn-sm btn-outline-secondary">Toggle</button></form>
                  <form action="/admin/users/{u['id']}/delete" method="POST" style="display:inline-block;" onsubmit="return confirm('Delete user?');"><button class="btn btn-sm btn-outline-danger">X</button></form>
                </td>
            </tr>'''

        msg_alert = f'<div class="alert alert-success py-2">{msg}</div>' if msg else ''
        err_alert = f'<div class="alert alert-danger py-2">{error}</div>' if error else ''

        html = f'''<!DOCTYPE html>
<html>
<head><title>Users & Licenses - Auto Hit Master</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body {{ background:#0f172a; color:#fff; }} .sidebar {{ background:#1e293b; min-height:100vh; width:240px; padding:20px; }} .stat {{ background:#1e293b; border:1px solid #334155; padding:20px; border-radius:10px; }}</style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Hit Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-muted mb-3 text-decoration-none">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-white mb-3 text-decoration-none font-weight-bold">👥 Users & Licenses</a>
    <a href="/admin/users/create" class="d-block text-muted mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <div class="d-flex justify-content-between mb-4">
      <h2 class="fw-bold">User Accounts & Licenses</h2>
      <a href="/admin/users/create" class="btn btn-primary">+ Create User ID</a>
    </div>
    {msg_alert}{err_alert}
    <div class="stat">
      <table class="table table-dark">
        <thead><tr><th>USER ID</th><th>NAME</th><th>PC LOCK</th><th>STATUS</th><th>EXPIRY</th><th>REMAINING</th><th>ACTIONS</th></tr></thead>
        <tbody>{rows or '<tr><td colspan="7" class="text-muted">No client users yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>
</body></html>'''
        self.send_html(html)

    def render_admin_create_user(self, admin, error=None):
        err_div = f'<div class="alert alert-danger py-2">{error}</div>' if error else ''
        html = f'''<!DOCTYPE html>
<html>
<head><title>Add User - Auto Hit Master</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>body {{ background:#0f172a; color:#fff; }} .sidebar {{ background:#1e293b; min-height:100vh; width:240px; padding:20px; }} .stat {{ background:#1e293b; border:1px solid #334155; padding:30px; border-radius:10px; max-width:500px; }}</style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Hit Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-muted mb-3 text-decoration-none">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-muted mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/users/create" class="d-block text-white mb-3 text-decoration-none font-weight-bold">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold mb-4">Create Client User ID</h2>
    {err_div}
    <div class="stat">
      <form action="/admin/users/create" method="POST">
        <div class="mb-3"><label class="small text-muted">USER ID (LOGIN ID) *</label><input type="text" name="user_id" class="form-control bg-dark text-white border-secondary" required placeholder="e.g. client_01"></div>
        <div class="mb-3"><label class="small text-muted">PASSWORD *</label><input type="text" name="password" class="form-control bg-dark text-white border-secondary" required placeholder="Password"></div>
        <div class="mb-3"><label class="small text-muted">CLIENT NAME</label><input type="text" name="name" class="form-control bg-dark text-white border-secondary" placeholder="Client Name"></div>
        <div class="mb-3"><label class="small text-muted">PHONE NUMBER</label><input type="text" name="phone" class="form-control bg-dark text-white border-secondary" placeholder="01700000000"></div>
        <div class="mb-4"><label class="small text-muted">DURATION *</label>
          <select name="duration_days" class="form-select bg-dark text-white border-secondary">
            <option value="7">7 Days (1 Week)</option>
            <option value="30" selected>30 Days (1 Month)</option>
            <option value="90">90 Days (3 Months)</option>
            <option value="365">365 Days (1 Year)</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary w-100 fw-bold">Create Account & Grant Access</button>
      </form>
    </div>
  </div>
</div>
</body></html>'''
        self.send_html(html)

def run_server():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, RequestHandler)
    print(f"=======================================================")
    print(f"  Auto Hit Master Python Backend Server Running!")
    print(f"  Admin Panel URL : http://localhost:{PORT}/admin")
    print(f"  Default Admin   : admin / adminpassword123")
    print(f"=======================================================")
    httpd.serve_forever()

if __name__ == '__main__':
    run_server()
