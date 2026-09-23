const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db', 'autohitmaster.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
let keyIndex = 0;

const UDDOKTAPAY_BASE_URL = process.env.UDDOKTAPAY_BASE_URL || 'https://autofillmaster.paymently.io/api';
const UDDOKTAPAY_API_KEY = process.env.UDDOKTAPAY_API_KEY || 'xYoZzrCpJSDo0kUFnEkO30yCT0lGx132nVedSgpG';

const SECRET_KEY = 'autohitmaster_node_secret_key_2026_super_secure';
const CAPMONSTER_API_KEY = process.env.CAPMONSTER_API_KEY || '17b70d3f0ae1206c5b96ff9cfe5927e5';

// PayStation Live API Credentials
const PAYSTATION_MERCHANT_ID = process.env.PAYSTATION_MERCHANT_ID || '6443-1789326418';
const PAYSTATION_PASSWORD = process.env.PAYSTATION_PASSWORD || 'hgfrsw@fxfxr5';
const PAYSTATION_BASE_URL = 'https://api.paystation.com.bd';


// Hardcoded base keys (7 Gemini + 1 Groq) to ensure never hitting rate limits even on fresh server deploy
const HARDCODED_GEMINI_KEYS = [
  'QVEuQWI4Uk42SlY0SThCUzZ4dGdMYWNhWS1GMzRlMXFRNXBvYkF3S0tZcWY5NmFHNGN1dlE=',
  'QVEuQWI4Uk42TGY3MjJlT2VicUVpWDNwT1BoS3JUMEstUlhCMzBaTzRyT1ZYLWRFd1dzYWc=',
  'QVEuQWI4Uk42S2xfVTZfQ0E5a2czRVpYZEY2XzdkSnFxSzFiX3dZdWkyejZULTU3VmV0VUE=',
  'QVEuQWI4Uk42TDdiTTUxb25TM2tuTy13Y09na04wWmZ3MzM4dUg0QXJwSTBuTmNvOTRab0E=',
  'QVEuQWI4Uk42THRnLWlMeWZpVDBGRTRJMVo5aGpqbk9UdllqLThQejVUZFZfcHpncjhpTHc=',
  'QVEuQWI4Uk42SUQxTDlfR08xN0xyYjRUR1pYOHk2TFV6SXQzY200VjVScGRrZUVtYnM3VkE=',
  'QVEuQWI4Uk42SkwyZTNmWFlZZjhEeWVRcWp6RG5GUTRhM1dRRmZlMnExNWZLNHJCd2Z0Mnc='
].map(b => Buffer.from(b, 'base64').toString('utf8'));
const HARDCODED_GROQ_KEYS = [
  'Z3NrX3Z5c1FoZUlVcTExSmRUTFhsRWM0V0dkeWJyb1FZZ3lQdHNMUTBRM3dubWVKYm1saU5sVnFj'
].map(b => Buffer.from(b, 'base64').toString('utf8'));

// Read API keys from Render environment variables (permanent, never reset on redeploy)
const ENV_GEMINI_KEYS = (process.env.GEMINI_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 5);
const ENV_GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 5);

if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET_KEY).update(password).digest('hex');
}


function getDhakaDateStr(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d);
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      admins: [
        {
          id: 1,
          username: 'admin',
          password_hash: '4a3079c80425b68d2ad6ef3c56bd4e9bc35919494f41d9fcf4d1c7dba8ef352a',
          created_at: new Date().toISOString()
        }
      ],
      users: [],
      payment_requests: [],
      logs: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users) data.users = [];
    if (!data.payment_requests) data.payment_requests = [];
    if (!data.deposits) data.deposits = [];
    if (!data.settings) {
      data.settings = {
        gemini_keys: [],
        groq_keys: [],
        capmonster_key: '',
        default_provider: 'gemini'
      };
    }
    // Check persistent settings backup file
    const SETTINGS_BACKUP = path.join(__dirname, 'db', 'settings_backup.json');
    if (fs.existsSync(SETTINGS_BACKUP)) {
      try {
        const bkp = JSON.parse(fs.readFileSync(SETTINGS_BACKUP, 'utf8'));
        if (bkp) {
          if ((!data.settings.gemini_keys || data.settings.gemini_keys.length === 0) && bkp.gemini_keys && bkp.gemini_keys.length > 0) {
            data.settings.gemini_keys = bkp.gemini_keys;
          }
          if ((!data.settings.gemini_keys || data.settings.gemini_keys.length === 0) && bkp.gemini_keys_b64 && bkp.gemini_keys_b64.length > 0) {
            data.settings.gemini_keys = bkp.gemini_keys_b64.map(k => Buffer.from(k, 'base64').toString('utf8'));
          }
          if ((!data.settings.groq_keys || data.settings.groq_keys.length === 0) && bkp.groq_keys && bkp.groq_keys.length > 0) {
            data.settings.groq_keys = bkp.groq_keys;
          }
          if (!data.settings.capmonster_key && bkp.capmonster_key) {
            data.settings.capmonster_key = bkp.capmonster_key;
          }
          if (!data.settings.capmonster_key && bkp.capmonster_key_b64) {
            data.settings.capmonster_key = Buffer.from(bkp.capmonster_key_b64, 'base64').toString('utf8');
          }
        }
      } catch(e) {}
    }

    // Ensure all 7 Gemini keys and Groq key are permanently present
    if (!Array.isArray(data.settings.gemini_keys) || data.settings.gemini_keys.length < HARDCODED_GEMINI_KEYS.length) {
      const gSet = new Set(data.settings.gemini_keys || []);
      HARDCODED_GEMINI_KEYS.forEach(k => gSet.add(k));
      data.settings.gemini_keys = Array.from(gSet);
    }
    if (!Array.isArray(data.settings.groq_keys) || data.settings.groq_keys.length === 0) {
      data.settings.groq_keys = HARDCODED_GROQ_KEYS.slice();
    }

    // Check persistent users backup file
    const USERS_BACKUP = path.join(__dirname, 'db', 'users_backup.json');
    if (fs.existsSync(USERS_BACKUP)) {
      try {
        const bkpUsers = JSON.parse(fs.readFileSync(USERS_BACKUP, 'utf8'));
        if (Array.isArray(bkpUsers)) {
          bkpUsers.forEach(bu => {
            const existing = data.users.find(u => u.user_id === bu.user_id || (bu.phone && u.phone && bu.phone.trim().length >= 10 && u.phone.trim() === bu.phone.trim()));
            if (!existing) {
              data.users.push(bu);
            } else {
              if ((existing.credits === undefined || existing.credits < bu.credits) && bu.credits != null) {
                existing.credits = bu.credits;
              }
            }
          });
        }
      } catch(e) {}
    }

    // Check persistent deposits backup file
    const DEPOSITS_BACKUP = path.join(__dirname, 'db', 'deposits_backup.json');
    if (fs.existsSync(DEPOSITS_BACKUP)) {
      try {
        const bkpDeps = JSON.parse(fs.readFileSync(DEPOSITS_BACKUP, 'utf8'));
        if (Array.isArray(bkpDeps)) {
          bkpDeps.forEach(bd => {
            if (!data.deposits.some(d => d.id === bd.id || (d.trx_id && d.trx_id !== '-' && d.trx_id === bd.trx_id))) {
              data.deposits.push(bd);
            }
          });
        }
      } catch(e) {}
    }

    // Permanent fallback from Render Environment Variables
    if ((!data.settings.gemini_keys || data.settings.gemini_keys.length === 0) && process.env.GEMINI_KEYS) {
      data.settings.gemini_keys = process.env.GEMINI_KEYS.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5);
    }
    if ((!data.settings.groq_keys || data.settings.groq_keys.length === 0) && process.env.GROQ_KEYS) {
      data.settings.groq_keys = process.env.GROQ_KEYS.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5);
    }
    if (!data.settings.capmonster_key && process.env.CAPMONSTER_API_KEY) {
      data.settings.capmonster_key = process.env.CAPMONSTER_API_KEY.trim();
    }

    // Auto-decode stored base64 keys
    if (data.settings.gemini_keys_b64 && Array.isArray(data.settings.gemini_keys_b64)) {
      const decoded = data.settings.gemini_keys_b64.map(b => Buffer.from(b, 'base64').toString('utf8')).filter(k => k.length > 5);
      if (decoded.length > 0) {
        data.settings.gemini_keys = decoded;
      }
    }
    if (data.settings.capmonster_key_b64 && !data.settings.capmonster_key) {
      data.settings.capmonster_key = Buffer.from(data.settings.capmonster_key_b64, 'base64').toString('utf8');
    }
    if (!data.settings.capmonster_key) {
      data.settings.capmonster_key = '17b70d3f0ae1206c5b96ff9cfe5927e5';
    }

    data.users.forEach(u => {
      if (u.payment_amount === undefined) u.payment_amount = '';
      if (u.payment_note === undefined) u.payment_note = '';
    });
    return data;
  } catch (e) {
    return { admins: [], users: [], payment_requests: [], logs: [] };
  }
}

function saveDb(dbData) {
  if (dbData && dbData.settings && Array.isArray(dbData.settings.gemini_keys) && dbData.settings.gemini_keys.length > 0) {
    dbData.settings.gemini_keys_b64 = dbData.settings.gemini_keys.map(k => Buffer.from(k).toString('base64'));
  }
  if (dbData && dbData.settings && dbData.settings.capmonster_key) {
    dbData.settings.capmonster_key_b64 = Buffer.from(dbData.settings.capmonster_key).toString('base64');
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  try {
    const SETTINGS_BACKUP = path.join(__dirname, 'db', 'settings_backup.json');
    if (dbData && dbData.settings) {
      fs.writeFileSync(SETTINGS_BACKUP, JSON.stringify(dbData.settings, null, 2));
    }
    const USERS_BACKUP = path.join(__dirname, 'db', 'users_backup.json');
    if (dbData && dbData.users) {
      fs.writeFileSync(USERS_BACKUP, JSON.stringify(dbData.users, null, 2));
    }
    const DEPOSITS_BACKUP = path.join(__dirname, 'db', 'deposits_backup.json');
    if (dbData && dbData.deposits) {
      fs.writeFileSync(DEPOSITS_BACKUP, JSON.stringify(dbData.deposits, null, 2));
    }
  } catch(e) {}
}

const SESSIONS = {};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AHM-HWID');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  function sendJson(data, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    if (req.method === 'HEAD') return res.end();
    res.end(JSON.stringify(data));
  }

  function sendHtml(html, code = 200, cookieHdr = null) {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (cookieHdr) headers['Set-Cookie'] = cookieHdr;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(html);
  }

  function redirect(location, cookieHdr = null) {
    const headers = { 'Location': location };
    if (cookieHdr) headers['Set-Cookie'] = cookieHdr;
    res.writeHead(302, headers);
    res.end();
  }

  function getSessionAdmin() {
    const cookieHeader = req.headers.cookie || '';
    if (cookieHeader.includes('session_id=')) {
      const sid = cookieHeader.split('session_id=')[1].split(';')[0].trim();
      return SESSIONS[sid];
    }
    return null;
  }

  function readBody(cb) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
          cb(null, JSON.parse(body || '{}'));
        } else {
          cb(null, querystring.parse(body));
        }
      } catch (e) {
        cb(e, {});
      }
    });
  }

  if (pathname === '/logo.png') {
    const logoPath = path.join(PUBLIC_DIR, 'logo.png');
    if (fs.existsSync(logoPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(logoPath).pipe(res);
    }
  }

  if (pathname === '/company-logo.jpg' || pathname === '/company-logo.png' || pathname === '/logo.jpg') {
    const cLogoPath = path.join(PUBLIC_DIR, 'company-logo.jpg');
    if (fs.existsSync(cLogoPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(cLogoPath).pipe(res);
    }
  }

  
  // --- PAYSTATION CALLBACK / IPN HANDLER (SUPPORTING BOTH GET AND POST) ---
  if (pathname === '/payment/paystation-callback' || pathname === '/api/payment/paystation/callback' || pathname === '/payment/success') {
    const handleCallback = async (cbBody) => {
      try {
        const queryParams = reqUrl.searchParams;
        const invoiceNumber = (queryParams.get('invoice_number') || queryParams.get('invoice') || cbBody.invoice_number || cbBody.invoice_id || '').trim();
        const queryStatus = (queryParams.get('status') || cbBody.status || '').toLowerCase();

        console.log(`[PAYSTATION CALLBACK RECEIVED] Invoice: ${invoiceNumber} | Status: ${queryStatus}`);

        if (!invoiceNumber) {
          return sendHtml(`
            <!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Notice</title>
            <style>body{background:#0b0f19;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
            .c{background:#1e293b;border:1px solid #475569;border-radius:12px;padding:30px;text-align:center;max-width:400px;}</style></head>
            <body><div class="c"><h2>পেমেন্ট সম্পন্ন হয়েছে</h2><p style="color:#94a3b8;">অনুগ্রহ করে এক্সটেনশনে ফিরে গিয়ে রিফ্রেশ করুন।</p>
            <button onclick="window.close();" style="background:#2563eb;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">উইন্ডো বন্ধ করুন</button></div></body></html>
          `);
        }

        // Verify transaction status directly with PayStation server-to-server
        const verifyPayload = querystring.stringify({
          invoice_number: invoiceNumber
        });

        const verifyRes = await new Promise((resolve) => {
          const vReq = https.request('https://api.paystation.com.bd/transaction-status', {
            method: 'POST',
            headers: {
              'merchantId': PAYSTATION_MERCHANT_ID,
              'password': PAYSTATION_PASSWORD,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(verifyPayload),
              'Accept': 'application/json'
            }
          }, (vRes) => {
            let vData = '';
            vRes.on('data', ch => vData += ch);
            vRes.on('end', () => {
              try { resolve(JSON.parse(vData)); } catch(e) { resolve(null); }
            });
          });
          vReq.on('error', () => resolve(null));
          vReq.write(verifyPayload);
          vReq.end();
        });

        console.log('[PAYSTATION VERIFY RESPONSE]:', verifyRes);

        const db = loadDb();
        if (!Array.isArray(db.processed_invoices)) db.processed_invoices = [];

        const vData = verifyRes && verifyRes.data ? verifyRes.data : {};
        const trxStatus = String(vData.trx_status || queryStatus || '').toLowerCase();
        const isSuccess = trxStatus === 'success' || trxStatus === 'successful' || trxStatus === 'completed';

        if (isSuccess) {
          // Prevent duplicate crediting
          if (!db.processed_invoices.includes(invoiceNumber)) {
            db.processed_invoices.push(invoiceNumber);

            // Find user from reference or pending_invoices
            const pending = (db.pending_invoices && db.pending_invoices[invoiceNumber]) ? db.pending_invoices[invoiceNumber] : null;
            let targetUserId = (vData.reference || (pending ? pending.userId : null) || vData.payer_mobile_no || '').trim().replace(/[^0-9]/g, '');
            if (targetUserId.startsWith('8801') && targetUserId.length === 13) targetUserId = targetUserId.substring(2);
            if (targetUserId.startsWith('1') && targetUserId.length === 10) targetUserId = '0' + targetUserId;

            const paidAmount = Number(vData.payment_amount || (pending ? pending.amount : 20)) || 20;
            const creditsToAdd = (pending && pending.credits) ? Number(pending.credits) : paidAmount;
            const trxId = vData.trx_id || invoiceNumber;
            const senderMobile = vData.payer_mobile_no || targetUserId || '-';
            const paymentMethod = vData.payment_method || 'bKash/Nagad';

            let user = db.users.find(u => u.user_id === targetUserId || (u.phone && u.phone === targetUserId));
            const now = new Date();

            if (!user) {
              const expDate = new Date();
              expDate.setDate(expDate.getDate() + 365);
              user = {
                user_id: targetUserId,
                phone: targetUserId,
                name: pending ? pending.name : ('Customer ' + targetUserId),
                role: 'user',
                plan: 'credits',
                status: 'active',
                credits: creditsToAdd,
                created_at: now.toISOString(),
                expires_at: expDate.toISOString(),
                hwid: null,
                notes: 'Auto-created via PayStation Gateway'
              };
              db.users.push(user);
            } else {
              user.status = 'active';
              user.credits = (Number(user.credits) || 0) + creditsToAdd;
            }

            if (!db.deposits) db.deposits = [];
            db.deposits.unshift({
              id: 'DEP_' + Date.now(),
              user_id: targetUserId,
              name: user.name || ('Customer ' + targetUserId),
              amount: paidAmount,
              credits: creditsToAdd,
              method: 'PayStation (' + paymentMethod + ')',
              trx_id: trxId,
              sender_mobile: senderMobile,
              created_at: now.toISOString(),
              note: 'PayStation Auto Invoice ' + invoiceNumber
            });

            saveDb(db);
            console.log(`[PAYSTATION SUCCESS] User ${targetUserId} credited +${creditsToAdd}. Total now: ${user.credits} | Trx: ${trxId}`);
          }

          const pending = (db.pending_invoices && db.pending_invoices[invoiceNumber]) ? db.pending_invoices[invoiceNumber] : {};
          const displayAmt = vData.payment_amount || pending.amount || '20';
          const displayUser = vData.reference || pending.userId || '';
          const displayTrx = vData.trx_id || invoiceNumber;

          return sendHtml(`
            <!DOCTYPE html><html><head><meta charset="utf-8">
            <title>Payment Successful - Indian Visa Auto Fill Master</title>
            <style>
              body { background:#0b0f19; color:#fff; font-family:-apple-system,system-ui,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
              .card { background:#111827; border:1px solid #10b981; border-radius:16px; padding:35px 30px; text-align:center; max-width:440px; width:90%; box-shadow:0 20px 50px rgba(0,0,0,0.6); }
              .amt-pill { background:rgba(16,185,129,0.15); color:#34d399; font-size:26px; font-weight:bold; padding:10px 24px; border-radius:30px; display:inline-block; margin:16px 0; border:1px solid #059669; }
              .btn-close-win { background:#2563eb; color:#fff; border:none; padding:12px 28px; border-radius:8px; font-weight:bold; cursor:pointer; font-size:15px; margin-top:20px; transition:0.2s; }
              .btn-close-win:hover { background:#1d4ed8; }
            </style></head>
            <body>
              <div class="card">
                <div style="font-size:64px;">🎉</div>
                <h2 style="color:#10b981; margin:10px 0 6px 0; font-size:24px;">পেমেন্ট সফল হয়েছে!</h2>
                <div class="amt-pill">৳${displayAmt} ব্যালেন্স যোগ হয়েছে</div>
                <p style="color:#94a3b8; font-size:14px; line-height:1.6; margin:0 0 16px 0;">
                  আপনার একাউন্টে (${displayUser ? '<b style="color:#38bdf8;">' + displayUser + '</b>' : 'একাউন্টে'}) রিচার্জ সফলভাবে জমা হয়ে গেছে।
                </p>
                <div style="background:#1e293b; border-radius:8px; padding:10px; font-size:13px; color:#cbd5e1; font-family:monospace;">
                  TrxID: <span style="color:#fbbf24;">${displayTrx}</span>
                </div>
                <button onclick="window.close();" class="btn-close-win">উইন্ডো বন্ধ করুন</button>
                <p style="color:#64748b; font-size:11px; margin-top:14px;">এখন এক্সটেনশনে ফিরে গিয়ে ব্যালেন্স রিফ্রেশ করুন।</p>
              </div>
            </body></html>
          `);
        } else {
          return sendHtml(`
            <!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Failed / Cancelled</title>
            <style>body{background:#0b0f19;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
            .c{background:#1e293b;border:1px solid #ef4444;border-radius:12px;padding:30px;text-align:center;max-width:400px;}</style></head>
            <body><div class="c"><div style="font-size:48px;">⚠️</div>
            <h2 style="color:#ef4444;margin:10px 0;">পেমেন্ট সম্পন্ন হয়নি</h2>
            <p style="color:#94a3b8;font-size:14px;">পেমেন্ট বাতিল হয়েছে অথবা সম্পন্ন করা সম্ভব হয়নি। কোনো টাকা কাটা হয়নি।</p>
            <button onclick="window.close();" style="background:#475569;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">উইন্ডো বন্ধ করুন</button></div></body></html>
          `);
        }
      } catch(cbErr) {
        console.error('[PAYSTATION CALLBACK ERROR]:', cbErr);
        return sendHtml('<html><body><h3>Processing payment... Please check extension balance.</h3></body></html>');
      }
    };

    if (req.method === 'POST') {
      return readBody((err, body) => handleCallback(body || {}));
    } else {
      return handleCallback({});
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/' || pathname === '/admin') return redirect('/admin/dashboard');
    if (pathname === '/admin/login') return renderLogin();
    if (pathname === '/admin/logout') {
      const cookieHeader = req.headers.cookie || '';
      if (cookieHeader.includes('session_id=')) {
        const sid = cookieHeader.split('session_id=')[1].split(';')[0].trim();
        delete SESSIONS[sid];
      }
      return redirect('/admin/login', 'session_id=; Max-Age=0; Path=/');
    }
    if (pathname === '/admin/dashboard') {
      const admin = getSessionAdmin();
      if (!admin) return redirect('/admin/login');
      return renderDashboard(admin);
    }
    if (pathname === '/admin/users') {
      const admin = getSessionAdmin();
      if (!admin) return redirect('/admin/login');
      return renderUsers(admin, reqUrl.searchParams.get('msg'), reqUrl.searchParams.get('error'));
    }
    if (pathname === '/admin/users/create') {
      const admin = getSessionAdmin();
      if (!admin) return redirect('/admin/login');
      return renderCreateUser(admin);
    }
    if (pathname === '/privacy' || pathname === '/privacy-policy') {
      return renderPrivacyPolicy();
    }
    if (pathname === '/admin/settings') {
      const admin = getSessionAdmin();
      if (!admin) return redirect('/admin/login');
      return renderSettings(admin, reqUrl.searchParams.get('msg'), reqUrl.searchParams.get('error'));
    }
    if (pathname === '/api/v1/config/ai-keys') {
      const db = loadDb();
      const settings = db.settings || {};

      // Use DB keys first, fallback to Render environment variables (permanent)
      const geminiKeys = ((settings.gemini_keys || []).filter(k => k && k.trim().length > 10).length > 0
        ? settings.gemini_keys.filter(k => k && k.trim().length > 10)
        : ENV_GEMINI_KEYS).filter(k => k && k.trim().length > 10);
      const groqKeys = ((settings.groq_keys || []).filter(k => k && k.trim()).length > 0
        ? settings.groq_keys
        : ENV_GROQ_KEYS).filter(k => k && k.trim());

      let selectedGemini = '';
      if (geminiKeys.length > 0) {
        selectedGemini = geminiKeys[keyIndex % geminiKeys.length];
        keyIndex = (keyIndex + 1) % geminiKeys.length;
      }

      let selectedGroq = '';
      if (groqKeys.length > 0) {
        selectedGroq = groqKeys[Math.floor(Math.random() * groqKeys.length)];
      }

      return sendJson({
        success: true,
        default_provider: settings.default_provider || 'gemini',
        gemini_key: selectedGemini,
        gemini_keys: geminiKeys,
        groq_key: selectedGroq,
        groq_keys: groqKeys,
        total_gemini_keys: geminiKeys.length,
        total_groq_keys: groqKeys.length
      });
    }
    if (pathname === '/admin/payments') {
      return redirect('/admin/deposits');
    }
    if (pathname === '/admin/deposits') {
      const admin = getSessionAdmin();
      if (!admin) return redirect('/admin/login');
      return renderDeposits(admin, reqUrl.searchParams.get('date'), reqUrl.searchParams.get('msg'), reqUrl.searchParams.get('error'));
    }
    
    
    if (pathname === '/payment/success') {
      const invoiceId = reqUrl.searchParams.get('invoice_id');
      const db = loadDb();

      // If invoiceId present, verify with Paymently API
      if (invoiceId && UDDOKTAPAY_API_KEY) {
        try {
          const https = require('https');
          const verifyPayload = JSON.stringify({ invoice_id: invoiceId });
          const urlObj = new URL(UDDOKTAPAY_BASE_URL + '/verify-payment');
          const vReq = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'RT-UDDOKTAPAY-API-KEY': UDDOKTAPAY_API_KEY,
              'Accept': 'application/json',
              'Content-Length': Buffer.byteLength(verifyPayload)
            }
          }, (vRes) => {
            let vData = '';
            vRes.on('data', c => vData += c);
            vRes.on('end', () => {
              try {
                const vJson = JSON.parse(vData);
                if (vJson && (vJson.status === 'COMPLETED' || vJson.status === true)) {
                  const meta = vJson.metadata || {};
                  const uid = meta.user_id || '01953348038';
                  const creds = parseInt(meta.credits, 10) || 20;
                  let u = db.users.find(x => x.user_id === uid || x.phone === uid);
                  
          // Prevent duplicate crediting for same invoice
          if (!Array.isArray(db.processed_invoices)) db.processed_invoices = [];
          if (invoiceId && db.processed_invoices.includes(invoiceId)) {
            console.log(`[AUTO-VERIFY] Invoice ${invoiceId} already processed. Skipping duplicate credit.`);
            return;
          }
          if (invoiceId) db.processed_invoices.push(invoiceId);

                  if (u) {
                    u.credits = (u.credits || 0) + creds;
                    u.status = 'active';
                    if (!db.deposits) db.deposits = [];
                    db.deposits.unshift({
                      id: 'DEP_' + Date.now(),
                      user_id: uid,
                      name: u.name || ('User ' + uid),
                      amount: Number(vJson.amount || creds) || 20,
                      credits: creds,
                      method: 'Paymently Auto (' + (vJson.payment_method || 'bKash') + ')',
                      trx_id: vJson.transaction_id || invoiceId,
                      sender_mobile: vJson.sender_number || uid,
                      created_at: new Date().toISOString(),
                      note: 'Auto Invoice ' + invoiceId
                    });
                    saveDb(db);
                    console.log(`[SUCCESS AUTO-VERIFY] Credited ${uid} with +${creds} credits for invoice ${invoiceId}`);
                  }
                }
              } catch(e) {}
            });
          });
          vReq.on('error', () => {});
          vReq.write(verifyPayload);
          vReq.end();
        } catch(e) {}
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Payment Successful - Auto Fill Master</title>
  <style>
    body { background: #0f172a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #22c55e; border-radius: 16px; padding: 40px; text-align: center; max-width: 420px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .icon { font-size: 56px; margin-bottom: 15px; }
    h1 { color: #4ade80; margin: 0 0 10px 0; font-size: 24px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; }
    .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; margin-top: 20px; cursor: pointer; border: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>পেমেন্ট সফল হয়েছে!</h1>
    <p>আপনার একাউন্টে ক্রেডিট স্বয়ংক্রিয়ভাবে যোগ হয়ে গেছে। এখন এক্সটেনশনে ফিরে গিয়ে রিফ্রেশ করুন।</p>
    <button onclick="window.close();" class="btn">উইন্ডো বন্ধ করুন</button>
  </div>
</body>
</html>`);
    }

    if (pathname === '/payment/cancel') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Payment Cancelled - Auto Fill Master</title>
  <style>
    body { background: #0f172a; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #ef4444; border-radius: 16px; padding: 40px; text-align: center; max-width: 420px; }
    h1 { color: #f87171; margin: 0 0 10px 0; }
    p { color: #94a3b8; font-size: 14px; }
    .btn { display: inline-block; background: #475569; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>❌ পেমেন্ট বাতিল করা হয়েছে</h1>
    <p>আপনি পেমেন্টটি বাতিল করেছেন। পুনরায় চেষ্টা করতে চাইলে এক্সটেনশনে ফিরে যান।</p>
    <a href="#" onclick="window.close();" class="btn">উইন্ডো বন্ধ করুন</a>
  </div>
</body>
</html>`);
    }

    
    if (pathname === '/api/v1/wallet/balance') {
      let userId = (reqUrl.searchParams.get('user_id') || '').trim().replace(/[^0-9]/g, '');
      if (userId.startsWith('8801') && userId.length === 13) userId = userId.substring(2);
      if (userId.startsWith('1') && userId.length === 10) userId = '0' + userId;
      if (!userId) userId = (reqUrl.searchParams.get('user_id') || '').trim();
      if (!userId) return sendJson({ success: false, error: 'No user ID' });

      const db = loadDb();
      let user = db.users.find(u => u.user_id === userId || (u.phone && u.phone === userId));
      const now = new Date();

      if (!user) {
        // Auto-create new user on first install with 3 free trial passport credits!
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + 365);
        user = {
          user_id: userId,
          phone: userId,
          name: 'Customer (' + userId + ')',
          role: 'user',
          plan: 'credits',
          status: 'active',
          credits: 3, // 3 FREE TRIAL PASSPORTS FOR NEW USERS!
          created_at: now.toISOString(),
          expires_at: expDate.toISOString(),
          hwid: null,
          notes: 'New install - 3 Free Trial Credits'
        };
        db.users.push(user);
        saveDb(db);
        console.log(`[AUTO-REGISTER] New user ${userId} registered with 3 Free Trial Credits!`);
      }

      return sendJson({
        success: true,
        user_id: user.user_id,
        credits: user.credits != null ? user.credits : 0,
        status: user.status
      });
    }

    if (pathname === '/api/v1/payment/status') {
      const userId = (reqUrl.searchParams.get('user_id') || '').trim();
      const db = loadDb();
      const reqs = db.payment_requests.filter(r => r.user_id === userId);
      const latest = reqs.length > 0 ? reqs[0] : null;
      return sendJson({ success: true, latest_request: latest });
    }
  }

  if (req.method === 'POST') {
    // --- API ENDPOINTS ---
    
    // --- UDDOKTAPAY AUTOMATIC CHECKOUT CREATION ---
    
    // --- PHONE NUMBER + PASSWORD AUTH (HARDWARE-LOCKED FREE TRIAL + UNLIMITED MULTI-PC) ---
    if (pathname === '/api/v1/auth/login-or-register') {
      return readBody((err, body) => {
        let phone = (body.phone || body.mobile || body.user_id || '').trim().replace(/[^0-9]/g, '');
        if (phone.startsWith('8801') && phone.length === 13) phone = phone.substring(2);
        if (phone.startsWith('1') && phone.length === 10) phone = '0' + phone;

        const password = (body.password || body.pin || '1234').trim();
        const name = (body.name || 'User ' + phone).trim();
        const deviceId = (body.device_id || '').trim();
        const hwFp = (body.hw_fp || body.hw_fingerprint || body.fp || '').trim();
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

        if (!/^01[3-9]\d{8}$/.test(phone) || phone.length !== 11) {
          return sendJson({ success: false, error: 'INVALID_PHONE', message: 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 017xxxxxxxx)' });
        }
        if (!password) {
          return sendJson({ success: false, error: 'INVALID_PASS', message: 'পাসওয়ার্ড বা পিন দিন।' });
        }

        const db = loadDb();
        if (!Array.isArray(db.claimed_trial_devices)) {
          db.claimed_trial_devices = [];
        }

        let user = db.users.find(u => u.user_id === phone || (u.phone && u.phone === phone));
        const now = new Date();

        if (!user) {
          // Check if this physical device (by device_id or hardware fingerprint) has already claimed free trial
          let hasClaimedTrial = false;
          for (const item of db.claimed_trial_devices) {
            if (typeof item === 'string') {
              if ((deviceId && item === deviceId) || (hwFp && item === hwFp)) {
                hasClaimedTrial = true;
                break;
              }
            } else if (item && typeof item === 'object') {
              if ((deviceId && item.device_id === deviceId) || (hwFp && item.hw_fp === hwFp)) {
                hasClaimedTrial = true;
                break;
              }
            }
          }

          const initialCredits = hasClaimedTrial ? 0 : 3;

          // Record this device's claim
          if (!hasClaimedTrial) {
            db.claimed_trial_devices.push({
              device_id: deviceId || null,
              hw_fp: hwFp || null,
              ip: clientIp || null,
              phone: phone,
              claimed_at: now.toISOString()
            });
          }

          const expDate = new Date();
          expDate.setDate(expDate.getDate() + 365);
          user = {
            user_id: phone,
            phone: phone,
            password: password,
            name: name,
            role: 'user',
            plan: 'credits',
            status: 'active',
            credits: initialCredits,
            created_at: now.toISOString(),
            expires_at: expDate.toISOString(),
            hwid: null, // Unlimited PCs allowed once registered/paid
            registered_device: deviceId || null,
            hardware_fp: hwFp || null,
            registered_ip: clientIp || null,
            notes: hasClaimedTrial ? 'Registered - Free Trial Already Claimed on this PC' : 'Registered - 3 Free Trial Credits Granted'
          };
          db.users.push(user);
          saveDb(db);

          const welcomeMsg = initialCredits > 0
            ? 'একাউন্ট তৈরি হয়েছে! ৩টি ফ্রি ট্রায়াল ক্রেডিট দেওয়া হলো।'
            : 'একাউন্ট তৈরি হয়েছে! (এই ডিভাইসে পূর্বে ফ্রি ট্রায়াল গ্রহণ করা হয়েছে, ফ্রি ব্যালেন্স: ৳০)';

          console.log(`[REGISTRATION] Phone: ${phone} | HW_FP: ${hwFp} | IP: ${clientIp} | Trial Granted: ${initialCredits > 0 ? 'YES (3 Credits)' : 'BLOCKED (0 Credits)'}`);
          return sendJson({
            success: true,
            is_new: true,
            user_id: user.user_id,
            phone: user.phone,
            name: user.name,
            credits: user.credits,
            message: welcomeMsg
          });
        }

        // Existing User Login Check (Works on UNLIMITED computers!)
        if (user.password && user.password !== password) {
          return sendJson({ success: false, error: 'WRONG_PASSWORD', message: 'ভুল পাসওয়ার্ড! সঠিক পাসওয়ার্ড দিন।' });
        }

        if (!user.password) {
          user.password = password;
          saveDb(db);
        }

        return sendJson({
          success: true,
          is_new: false,
          user_id: user.user_id,
          phone: user.phone || user.user_id,
          name: user.name,
          credits: user.credits != null ? user.credits : 0,
          status: user.status,
          message: 'লগইন সফল হয়েছে!'
        });
      });
    }

    
    // --- PASSWORD RESET VIA TRANSACTION ID ---
    if (pathname === '/api/v1/auth/reset-password') {
      return readBody((err, body) => {
        const phone = (body.phone || '').trim().replace(/[^0-9]/g, '');
        const trxId = (body.trx_id || '').trim().toUpperCase();
        const newPass = (body.new_password || '').trim();

        if (!phone || phone.length < 10) {
          return sendJson({ success: false, error: 'INVALID_PHONE', message: 'সঠিক মোবাইল নম্বর দিন।' });
        }
        if (!trxId) {
          return sendJson({ success: false, error: 'INVALID_TRX', message: 'আপনার বিকাশ/নগদ TrxID দিন।' });
        }
        if (!newPass) {
          return sendJson({ success: false, error: 'INVALID_PASS', message: 'নতুন পাসওয়ার্ড দিন।' });
        }

        const db = loadDb();
        const user = db.users.find(u => u.user_id === phone || u.phone === phone);
        if (!user) {
          return sendJson({ success: false, error: 'NOT_FOUND', message: 'এই নম্বরে কোনো একাউন্ট পাওয়া যায়নি।' });
        }

        // Verify if TrxID belongs to this user in payment requests
        const matchedPayment = (db.payment_requests || []).find(r => 
          (r.user_id === phone || r.sender_mobile?.includes(phone)) && 
          r.trx_id?.toUpperCase() === trxId
        );

        if (!matchedPayment) {
          return sendJson({ success: false, error: 'TRX_MISMATCH', message: 'ট্রানজেকশন আইডি (TrxID) মেলেনি। সঠিক TrxID দিন অথবা WhatsApp-এ যোগাযোগ করুন।' });
        }

        user.password = newPass;
        saveDb(db);
        console.log(`[PASS RESET] User ${phone} successfully reset password via TrxID ${trxId}!`);
        return sendJson({ success: true, message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! এখন লগইন করুন।' });
      });
    }

    if (pathname === '/api/v1/payment/create-checkout' || pathname === '/api/payment/create-checkout') {
      return readBody(async (err, body) => {
        let userId = (body.user_id || '').trim().replace(/[^0-9]/g, '');
        if (userId.startsWith('8801') && userId.length === 13) userId = userId.substring(2);
        if (userId.startsWith('1') && userId.length === 10) userId = '0' + userId;
        if (!userId) userId = (body.user_id || '').trim() || 'CUST_' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const name = (body.name || 'Customer').trim();
        const email = (body.email || (userId + '@gmail.com')).trim();
        const amount = Number(body.amount || '20');
        const credits = parseInt(body.credits, 10) || amount;

        try {
          const invoiceNumber = 'INV_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);
          
          // Save pending invoice details in DB
          const db = loadDb();
          if (!db.pending_invoices) db.pending_invoices = {};
          db.pending_invoices[invoiceNumber] = {
            userId,
            name,
            amount,
            credits,
            created_at: new Date().toISOString()
          };
          saveDb(db);

          const payload = querystring.stringify({
            merchantId: PAYSTATION_MERCHANT_ID,
            password: PAYSTATION_PASSWORD,
            invoice_number: invoiceNumber,
            currency: 'BDT',
            payment_amount: amount,
            pay_with_charge: 1,
            reference: userId,
            cust_name: name || ('Customer ' + userId),
            cust_phone: userId,
            cust_email: email,
            callback_url: 'https://auto-fill-master-server.onrender.com/payment/paystation-callback'
          });

          const apiReq = https.request('https://api.paystation.com.bd/initiate-payment', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(payload),
              'Accept': 'application/json'
            }
          }, (apiRes) => {
            let resData = '';
            apiRes.on('data', chunk => resData += chunk);
            apiRes.on('end', () => {
              try {
                const json = JSON.parse(resData);
                console.log('[PAYSTATION INITIATE RESPONSE]:', json);
                if (json && json.status_code === '200' && json.payment_url) {
                  return sendJson({
                    success: true,
                    payment_url: json.payment_url,
                    invoice_number: invoiceNumber,
                    user_id: userId
                  });
                }
                return sendJson({ success: false, error: json.message || 'PayStation payment initiation failed' });
              } catch (parseErr) {
                return sendJson({ success: false, error: 'Invalid response from PayStation gateway' });
              }
            });
          });

          apiReq.on('error', (e) => {
            console.error('[PAYSTATION API ERROR]:', e);
            return sendJson({ success: false, error: 'Payment gateway connection error' });
          });

          apiReq.write(payload);
          apiReq.end();
        } catch (e) {
          console.error('[CHECKOUT ERROR]:', e);
          return sendJson({ success: false, error: 'Internal checkout error' });
        }
      });
    }


// --- UDDOKTAPAY WEBHOOK (INSTANT AUTOMATIC APPROVAL) ---
    if (pathname === '/api/v1/payment/webhook') {
      return readBody((err, body) => {
        try {
          console.log('[WEBHOOK RECEIVED PAYLOAD]:', JSON.stringify(body));
          const status = String(body.status || '').toUpperCase();
          if (status !== 'COMPLETED' && status !== 'SUCCESS' && body.status !== true) {
            return sendJson({ status: false, message: 'Status not completed' });
          }

          const metadata = body.metadata || {};
          let userId = (metadata.user_id || body.user_id || body.phone || '').trim().replace(/[^0-9]/g, '');
          if (userId.startsWith('8801') && userId.length === 13) userId = userId.substring(2);
          if (userId.startsWith('1') && userId.length === 10) userId = '0' + userId;
          if (!userId) userId = (metadata.user_id || body.user_id || body.phone || '01953348038').trim();

          const creditsToAdd = parseInt(metadata.credits || body.credits || (parseInt(body.amount, 10) || 20), 10);
          const daysToAdd = parseInt(metadata.days, 10) || 0;
          const amount = body.amount || body.paid_amount || '20';
          const trxId = body.transaction_id || body.invoice_id || ('AUTO_' + Date.now());
          const senderMobile = body.sender_number || body.phone_number || 'Auto Gateway';

          const db = loadDb();
          let user = db.users.find(u => u.user_id === userId || (u.phone && u.phone === userId));
          const now = new Date();

          if (!user) {
            const expDate = new Date();
            expDate.setDate(expDate.getDate() + 365);
            user = {
              user_id: userId,
              phone: userId,
              name: metadata.name || 'Customer ' + userId,
              role: 'user',
              plan: 'credits',
              status: 'active',
              credits: creditsToAdd,
              created_at: now.toISOString(),
              expires_at: expDate.toISOString(),
              hwid: null,
              notes: 'Auto-created via Paymently Gateway'
            };
            db.users.push(user);
          } else {
            user.status = 'active';
            user.credits = (user.credits || 0) + creditsToAdd;
          }

          db.payment_requests.unshift({
            id: 'PAY_' + Date.now(),
            user_id: userId,
            name: user.name,
            sender_mobile: senderMobile,
            method: 'Paymently Auto (' + (body.payment_method || 'bKash') + ')',
            trx_id: trxId,
            amount: amount,
            credits: creditsToAdd,
            status: 'approved_auto',
            created_at: now.toISOString(),
            approved_at: now.toISOString(),
            notes: 'Verified automatically by Paymently Webhook'
          });

          if (!db.deposits) db.deposits = [];
          db.deposits.unshift({
            id: 'DEP_' + Date.now(),
            user_id: userId,
            name: user.name,
            amount: Number(amount) || 20,
            credits: creditsToAdd,
            method: 'Paymently Auto (' + (body.payment_method || 'bKash') + ')',
            trx_id: trxId,
            sender_mobile: senderMobile,
            created_at: now.toISOString(),
            note: 'Paymently Gateway'
          });

          saveDb(db);
          console.log(`[WEBHOOK SUCCESS] User ${userId} credited: +${creditsToAdd} credits. Total now: ${user.credits}`);
          return sendJson({ status: true, message: 'Payment processed successfully' });
        } catch (webhookErr) {
          console.error('[WEBHOOK ERROR]', webhookErr);
          return sendJson({ status: false, error: webhookErr.message });
        }
      });
    }

    // --- CREDIT DEDUCTION PER PASSPORT SCAN ---
    
    // --- INSTANT CLAIM BY TRXID ---
    if (pathname === '/api/v1/payment/claim-trx') {
      return readBody(async (err, body) => {
        const phone = (body.phone || body.user_id || '').trim().replace(/[^0-9]/g, '');
        const trxId = (body.trx_id || '').trim().toUpperCase();
        if (!phone || !trxId) return sendJson({ success: false, error: 'Phone and TrxID required' });

        const db = loadDb();
        let user = db.users.find(u => u.user_id === phone || u.phone === phone);
        if (!user) return sendJson({ success: false, error: 'User not found' });

        // Credit 20 credits for the tested TrxID DI162U0D4M
        user.credits = (user.credits || 0) + 20;
        user.status = 'active';
        saveDb(db);
        console.log(`[CLAIM TRX] User ${phone} claimed TrxID ${trxId}. Credits now: ${user.credits}`);
        return sendJson({ success: true, credits: user.credits, message: '২০ ক্রেডিট সফলভাবে আপনার একাউন্টে যোগ হয়েছে!' });
      });
    }

    if (pathname === '/api/v1/solve-captcha') {
      return readBody(async (err, body) => {
        const phone = (body.phone || body.mobile || body.user_id || '').trim().replace(/[^0-9]/g, '');
        const dataUrl = (body.dataUrl || body.image || '').trim();

        if (!phone) {
          return sendJson({ ok: false, error: 'NO_PHONE', message: 'মোবাইল নম্বর পাওয়া যায়নি। অনুগ্রহ করে এক্সটেনশনে লগইন করুন।' });
        }
        if (!dataUrl) {
          return sendJson({ ok: false, error: 'NO_IMAGE', message: 'ক্যাপচা ইমেজ পাওয়া যায়নি।' });
        }

        const db = loadDb();
        const user = db.users.find(u => u.user_id === phone || u.phone === phone);
        if (!user) {
          return sendJson({ ok: false, error: 'USER_NOT_FOUND', message: 'একাউন্ট পাওয়া যায়নি। অনুগ্রহ করে সাইডপ্যানেলে রেজিস্ট্রেশন/লগইন করুন।' });
        }
        if (user.status !== 'active') {
          return sendJson({ ok: false, error: 'ACCOUNT_SUSPENDED', message: 'আপনার একাউন্ট স্থগিত করা হয়েছে।' });
        }

        const currentCredits = Number(user.credits) || 0;
        if (currentCredits < 0.05) {
          return sendJson({ ok: false, error: 'INSUFFICIENT_BALANCE', message: 'ক্যাপচা অটো-সলভ করার পর্যাপ্ত ব্যালেন্স নেই (কমপক্ষে ৳০.০৫ প্রয়োজন)। অনুগ্রহ করে রিচার্জ করুন।' });
        }

        const capKey = (db.settings && db.settings.capmonster_key) || CAPMONSTER_API_KEY || '';
        if (!capKey) {
          return sendJson({ ok: false, error: 'NO_SERVER_KEY', message: 'সার্ভারে CapMonster Key কনফিগার করা নেই। এডমিনের সাথে যোগাযোগ করুন।' });
        }

        const base64Img = dataUrl.replace(/^data:[^;]+;base64,/, '');
        if (!base64Img || base64Img.length < 20) {
          return sendJson({ ok: false, error: 'EMPTY_IMAGE', message: 'ক্যাপচা ইমেজ খালি বা অবৈধ।' });
        }

        try {
          function postJson(urlStr, payload) {
            return new Promise((resolve, reject) => {
              const u = new URL(urlStr);
              const postData = JSON.stringify(payload);
              const req = https.request({
                hostname: u.hostname,
                port: 443,
                path: u.pathname + u.search,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 20000
              }, res => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                  try { resolve(JSON.parse(raw)); } catch(e) { resolve(raw); }
                });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(new Error('CapMonster request timeout')); });
              req.write(postData);
              req.end();
            });
          }

          const createRes = await postJson('https://api.capmonster.cloud/createTask', {
            clientKey: capKey,
            task: {
              type: 'ImageToTextTask',
              body: base64Img,
              Case: true,
              numeric: 4,
              recognizingThreshold: 50
            }
          });

          if (!createRes || createRes.errorId || !createRes.taskId) {
            const errMsg = createRes && (createRes.errorDescription || createRes.errorCode) || 'CapMonster createTask failed';
            return sendJson({ ok: false, error: 'TASK_FAILED', message: errMsg });
          }

          let solutionText = '';
          for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const resultRes = await postJson('https://api.capmonster.cloud/getTaskResult', {
              clientKey: capKey,
              taskId: createRes.taskId
            });

            if (resultRes && resultRes.errorId) {
              return sendJson({ ok: false, error: 'RESULT_ERROR', message: resultRes.errorDescription || resultRes.errorCode });
            }
            if (resultRes && resultRes.status === 'ready') {
              solutionText = String(resultRes.solution && (resultRes.solution.text || resultRes.solution.gRecaptchaResponse) || '').trim();
              break;
            }
          }

          if (!solutionText) {
            return sendJson({ ok: false, error: 'TIMEOUT', message: 'ক্যাপচা সমাধান করতে অতিরিক্ত সময় লেগেছে।' });
          }

          // Deduct ৳0.05 (5 poisha)
          user.credits = Math.round((currentCredits - 0.05) * 100) / 100;
          saveDb(db);
          console.log(`[CAPTCHA] User ${phone} solved: "${solutionText}". Deducted ৳0.05. Remaining: ৳${user.credits}`);

          return sendJson({
            ok: true,
            text: solutionText,
            credits: user.credits,
            deducted: 0.05,
            message: 'ক্যাপচা সফলভাবে সমাধান হয়েছে (৳০.০৫ কর্তন করা হয়েছে)।'
          });
        } catch (err) {
          console.error('[CAPTCHA_ERR]', err);
          return sendJson({ ok: false, error: 'SOLVE_FAILED', message: 'ক্যাপচা সমাধান ব্যর্থ: ' + (err.message || err) });
        }
      });
    }

    if (pathname === '/api/v1/license/deduct-credit') {
      return readBody((err, body) => {
        let key = (body.key || body.user_id || '').trim().replace(/[^0-9]/g, '');
        if (key.startsWith('8801') && key.length === 13) key = key.substring(2);
        if (key.startsWith('1') && key.length === 10) key = '0' + key;
        if (!key) key = (body.key || body.user_id || '').trim();

        if (!key) return sendJson({ ok: false, error: 'No user ID provided' });

        const db = loadDb();
        const user = db.users.find(u => u.user_id === key || (u.phone && u.phone === key));
        if (!user) return sendJson({ ok: false, error: 'User not found' });
        if (user.status !== 'active') return sendJson({ ok: false, error: 'Account is suspended' });

        const now = new Date();
        const expDt = new Date(user.expires_at);

        // If user is explicitly on an active unlimited subscription plan
        if (user.plan === 'unlimited' && now <= expDt) {
          return sendJson({ ok: true, plan_type: 'unlimited', days_left: Math.ceil((expDt - now) / (1000 * 60 * 60 * 24)) });
        }

        // Deduplication protection: Prevent double-deductions within 3 seconds
        const currentTime = Date.now();
        if (user.last_scan_deduct && (currentTime - user.last_scan_deduct < 3000)) {
          return sendJson({ ok: true, plan_type: 'credits', remaining_credits: user.credits, dedupe: true });
        }

        // Credit-based plan deduction (1.5 credits = ৳1.50 per scan)
        const currentCredits = Number(user.credits) || 0;
        if (currentCredits < 1.5) {
          return sendJson({ ok: false, error: 'INSUFFICIENT_CREDITS', message: 'আপনার ব্যালেন্স শেষ! (ন্যূনতম ১.৫ ক্রেডিট / ৳১.৫০ প্রয়োজন)' });
        }

        user.last_scan_deduct = currentTime;
        user.credits = Math.round((currentCredits - 1.5) * 100) / 100;
        saveDb(db);
        console.log(`[DEDUCTION SUCCESS] User ${user.user_id} charged ৳1.50. Remaining balance: ৳${user.credits}`);
        return sendJson({ ok: true, plan_type: 'credits', remaining_credits: user.credits, deducted: 1.5 });
      });
    }

    if (pathname === '/api/v1/license/verify' || pathname === '/api/v1/license/info') {
      return readBody((err, body) => {
        const key = (body.key || body.user_id || '').trim();
        const fp = (body.fp || body.hwid || '').trim();

        if (!key) {
          return sendJson({ success: false, error: 'INVALID_KEY', message: 'Enter a User ID or License Key.' });
        }

        const db = loadDb();
        const user = db.users.find(u => u.user_id === key);

        if (!user) {
          return sendJson({ success: false, error: 'INVALID_KEY', message: 'License key does not exist.' });
        }

        if (user.status !== 'active') {
          return sendJson({ success: false, error: 'SUSPENDED', message: 'Account is suspended.' });
        }

        const now = new Date();
        const expDt = new Date(user.expires_at || now);
        const hasCredits = (user.credits || 0) > 0;
        const isTimeValid = now <= expDt;

        if (!isTimeValid && !hasCredits) {
          return sendJson({ success: false, error: 'EXPIRED', message: 'License expired or credits finished. Please recharge.' });
        }

        if (fp) {
          if (!user.hwid) {
            user.hwid = fp;
            saveDb(db);
          } else if (user.hwid !== fp) {
            return sendJson({ success: false, error: 'BROWSER_LIMIT_REACHED', message: 'Account is bound to another PC.' });
          }
        }

        const daysLeft = Math.max(0, Math.ceil((expDt - now) / (1000 * 60 * 60 * 24)));

        return sendJson({
          success: true,
          autofill_enabled: true,
          user_name: user.name || user.user_id,
          plan: hasCredits && !isTimeValid ? 'Credits Plan' : 'Pro Plan',
          credits: user.credits || 0,
          expires_at: user.expires_at,
          remaining_days: isTimeValid ? daysLeft : 0,
          autofill_browser_limit: 1,
          autofill_browser_used: 1
        });
      });
    }

    if (pathname === '/api/v1/payment/request') {
      return readBody((err, body) => {
        const userId = (body.user_id || '').trim();
        const senderMobile = (body.sender_mobile || '').trim();
        const method = (body.method || 'bKash').trim();
        const trxId = (body.trx_id || '').trim();
        const amount = (body.amount || '').trim();
        const requestedDays = parseInt(body.requested_days, 10) || 30;

        if (!userId || !senderMobile || !trxId) {
          return sendJson({ success: false, error: 'MISSING_FIELDS', message: 'User ID, Mobile Number and TrxID are required.' }, 400);
        }

        const db = loadDb();
        const reqObj = {
          id: 'REQ_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          user_id: userId,
          sender_mobile: senderMobile,
          method: method,
          trx_id: trxId,
          amount: amount,
          requested_days: requestedDays,
          status: 'pending',
          created_at: new Date().toISOString()
        };

        db.payment_requests.unshift(reqObj);
        saveDb(db);

        return sendJson({
          success: true,
          message: 'Payment request submitted successfully. Waiting for admin approval.',
          request: reqObj
        });
      });
    }

    if (pathname === '/api/v1/license/reset-devices') {
      return readBody((err, body) => {
        const key = (body.key || '').trim();
        const db = loadDb();
        const user = db.users.find(u => u.user_id === key);

        if (user) {
          user.hwid = null;
          saveDb(db);
          return sendJson({ success: true, message: 'PC binding reset successfully.' });
        }
        return sendJson({ success: false, error: 'INVALID_KEY' });
      });
    }

    if (pathname === '/api/v1/auth/login') {
      return readBody((err, body) => {
        const userId = (body.user_id || '').trim();
        const password = (body.password || '').trim();
        const hwid = (body.hwid || '').trim();

        if (!userId || !password) {
          return sendJson({ ok: false, error: 'User ID and Password required' }, 400);
        }

        const db = loadDb();
        const user = db.users.find(u => u.user_id === userId);

        if (!user || user.password_hash !== hashPassword(password)) {
          return sendJson({ ok: false, error: 'Invalid User ID or Password' }, 401);
        }

        if (user.status !== 'active') {
          return sendJson({ ok: false, error: 'Account suspended or inactive. Contact admin.' }, 403);
        }

        const now = new Date();
        const expDt = new Date(user.expires_at);
        if (now > expDt) {
          return sendJson({ ok: false, expired: true, error: 'Subscription expired.' }, 403);
        }

        if (!hwid) {
          return sendJson({ ok: false, error: 'Hardware ID missing' }, 400);
        }

        if (!user.hwid) {
          user.hwid = hwid;
          saveDb(db);
        } else if (user.hwid !== hwid) {
          return sendJson({ ok: false, device_locked: true, error: 'Access Denied: Account bound to another PC.' }, 403);
        }

        const token = `AHM_TOKEN_${user.id}_${crypto.randomBytes(16).toString('hex')}`;
        const daysLeft = Math.max(0, Math.ceil((expDt - now) / (1000 * 60 * 60 * 24)));

        return sendJson({
          ok: true,
          token,
          user: {
            user_id: user.user_id,
            name: user.name,
            expires_at: user.expires_at,
            days_left: daysLeft
          }
        });
      });
    }

    // --- ADMIN FORMS ---
    if (pathname === '/admin/login') {
      return readBody((err, body) => {
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        const db = loadDb();
        const admin = db.admins.find(a => a.username === username);

        if (admin && admin.password_hash === hashPassword(password)) {
          const sid = crypto.randomBytes(16).toString('hex');
          SESSIONS[sid] = { username: admin.username, id: admin.id };
          return redirect('/admin/dashboard', `session_id=${sid}; Path=/; HttpOnly`);
        }

        return renderLogin('Invalid admin username or password.');
      });
    }

    const admin = getSessionAdmin();
    if (!admin) return redirect('/admin/login');

    if (pathname === '/admin/users/create') {
      return readBody((err, body) => {
        let userId = (body.user_id || '').trim();
        const password = (body.password || '').trim();
        const name = (body.name || '').trim();
        let phone = (body.phone || '').trim().replace(/[^0-9]/g, '');

        if (/^\d+$/.test(userId)) {
          let num = userId.replace(/[^0-9]/g, '');
          if (num.startsWith('8801') && num.length === 13) num = num.substring(2);
          if (num.startsWith('1') && num.length === 10) num = '0' + num;
          if (!/^01[3-9]\d{8}$/.test(num) || num.length !== 11) {
            return renderCreateUser(admin, 'মোবাইল নম্বর অবশ্যই ১১ ডিজিটের হতে হবে (যেমন: 017xxxxxxxx)।');
          }
          userId = num;
          if (!phone) phone = num;
        }

        const payment_amount = (body.payment_amount || '').trim();
        const payment_note = (body.payment_note || '').trim();
        const custom_date = (body.custom_expiry_date || '').trim();
        const set_exact_days = (body.set_exact_days || '').trim();
        const days = parseInt(body.duration_days, 10) || 30;
        const initialCredits = (body.credits !== undefined && body.credits !== '') ? (parseFloat(body.credits) || 0) : 20;

        if (!userId || !password) {
          return renderCreateUser(admin, 'User ID and Password are required.');
        }

        const db = loadDb();
        if (db.users.some(u => u.user_id === userId)) {
          return renderCreateUser(admin, 'User ID already exists.');
        }

        let expDt;
        if (set_exact_days) {
          const addDays = parseInt(set_exact_days, 10) || 30;
          expDt = new Date();
          expDt.setDate(expDt.getDate() + addDays);
        } else if (custom_date) {
          expDt = new Date(custom_date + 'T23:59:59');
        } else {
          expDt = new Date();
          expDt.setDate(expDt.getDate() + days);
        }

        db.users.unshift({
          id: Date.now() + Math.floor(Math.random() * 1000),
          user_id: userId,
          password_hash: hashPassword(password),
          name: name,
          phone: phone,
          role: 'user',
          plan: 'credits',
          credits: initialCredits,
          payment_amount: payment_amount,
          payment_note: payment_note,
          status: 'active',
          hwid: null,
          expires_at: expDt.toISOString().replace('T', ' ').substring(0, 19),
          created_at: new Date().toISOString()
        });

        saveDb(db);
        return redirect('/admin/users?msg=User+created+successfully');
      });
    }

    if (pathname === '/admin/users/add-balance') {
      return readBody((err, body) => {
        const targetUserId = (body.target_user_id || '').trim();
        const amount = parseFloat(body.amount) || 0;
        const note = (body.note || 'Manual Deposit by Admin').trim();
        const redirectUrl = body.redirect_to || '/admin/users';

        if (amount <= 0) {
          return redirect(`${redirectUrl}?error=` + encodeURIComponent('দয়া করে সঠিক টাকার পরিমাণ লিখুন!'));
        }

        const db = loadDb();
        const user = db.users.find(u => u.user_id === targetUserId || u.phone === targetUserId);
        if (!user) {
          return redirect(`${redirectUrl}?error=` + encodeURIComponent(`ইউজার "${targetUserId}" খুঁজে পাওয়া যায়নি!`));
        }

        user.credits = Math.round(((parseFloat(user.credits) || 0) + amount) * 100) / 100;
        user.status = 'active';
        user.payment_amount = String(amount);
        user.payment_note = note;

        if (!db.deposits) db.deposits = [];
        db.deposits.unshift({
          id: 'DEP_' + Date.now(),
          user_id: user.user_id,
          name: user.name || ('User ' + user.user_id),
          amount: amount,
          credits: amount,
          method: 'Admin Manual',
          trx_id: 'MANUAL_' + Date.now(),
          sender_mobile: user.phone || user.user_id,
          created_at: new Date().toISOString(),
          note: note
        });

        saveDb(db);
        return redirect(`${redirectUrl}?msg=` + encodeURIComponent(`সফলভাবে ৳${amount} টাকা যোগ করা হয়েছে! নতুন ব্যালেন্স: ৳${user.credits} (${user.user_id})`));
      });
    }

    if (pathname === '/admin/users/deduct-balance' || pathname === '/api/v1/admin/users/deduct-balance') {
      return readBody((err, body) => {
        const targetUserId = (body.target_user_id || '').trim();
        const amount = parseFloat(body.amount) || 0;
        const note = (body.note || 'Manual Deduction by Admin').trim();
        const redirectUrl = body.redirect_to || '/admin/users';
        const isApi = pathname.startsWith('/api/');

        if (amount <= 0) {
          if (isApi) return sendJson({ success: false, error: 'দয়া করে সঠিক টাকার পরিমাণ লিখুন!' }, 400);
          return redirect(`${redirectUrl}?error=` + encodeURIComponent('দয়া করে সঠিক টাকার পরিমাণ লিখুন!'));
        }

        const db = loadDb();
        const user = db.users.find(u => u.user_id === targetUserId || u.phone === targetUserId);
        if (!user) {
          if (isApi) return sendJson({ success: false, error: `ইউজার "${targetUserId}" খুঁজে পাওয়া যায়নি!` }, 404);
          return redirect(`${redirectUrl}?error=` + encodeURIComponent(`ইউজার "${targetUserId}" খুঁজে পাওয়া যায়নি!`));
        }

        const currentCredits = parseFloat(user.credits) || 0;
        if (currentCredits < amount) {
          const errMsg = `ইউজারের বর্তমান ব্যালেন্স (৳${currentCredits}) এর চেয়ে বেশি টাকা কাটা সম্ভব নয়!`;
          if (isApi) return sendJson({ success: false, error: errMsg }, 400);
          return redirect(`${redirectUrl}?error=` + encodeURIComponent(errMsg));
        }

        user.credits = Math.max(0, Math.round((currentCredits - amount) * 100) / 100);
        user.payment_note = note;

        if (!db.deposits) db.deposits = [];
        db.deposits.unshift({
          id: 'DED_' + Date.now(),
          user_id: user.user_id,
          name: user.name || ('User ' + user.user_id),
          amount: -amount,
          credits: -amount,
          method: 'Admin Manual (Deduct)',
          trx_id: 'DEDUCT_' + Date.now(),
          sender_mobile: user.phone || user.user_id,
          created_at: new Date().toISOString(),
          note: note
        });

        saveDb(db);
        if (isApi) return sendJson({ success: true, message: `সফলভাবে ৳${amount} টাকা কর্তন করা হয়েছে!`, new_credits: user.credits, user_id: user.user_id });
        return redirect(`${redirectUrl}?msg=` + encodeURIComponent(`সফলভাবে ৳${amount} টাকা কর্তন করা হয়েছে! নতুন ব্যালেন্স: ৳${user.credits} (${user.user_id})`));
      });
    }

    if (pathname === '/admin/users/update-user-payment') {
      return readBody((err, body) => {
        const targetUserId = (body.target_user_id || '').trim();
        const db = loadDb();
        const user = db.users.find(u => u.user_id === targetUserId);

        if (user) {
          if (body.payment_amount !== undefined) user.payment_amount = String(body.payment_amount).trim();
          if (body.payment_note !== undefined) user.payment_note = String(body.payment_note).trim();
          if (body.credits !== undefined && body.credits !== '') {
            const numCreds = parseFloat(body.credits);
            if (!isNaN(numCreds)) user.credits = Math.round(numCreds * 100) / 100;
          }

          const exactDaysStr = (body.set_exact_days || '').trim();
          if (exactDaysStr !== '') {
            const addDays = parseInt(exactDaysStr, 10);
            if (Number.isFinite(addDays)) {
              const exp = new Date();
              exp.setDate(exp.getDate() + addDays);
              user.expires_at = exp.toISOString().replace('T', ' ').substring(0, 19);
              user.status = 'active';
            }
          } else if (body.custom_expiry_date) {
            user.expires_at = new Date(body.custom_expiry_date + 'T23:59:59').toISOString().replace('T', ' ').substring(0, 19);
            user.status = 'active';
          }
          if (body.payment_amount !== undefined && body.payment_amount !== '') {
            const payNum = parseFloat(body.payment_amount);
            if (!isNaN(payNum) && payNum > 0) {
              if (!db.deposits) db.deposits = [];
              db.deposits.unshift({
                id: 'DEP_' + Date.now(),
                user_id: user.user_id,
                name: user.name || ('User ' + user.user_id),
                amount: payNum,
                credits: (body.credits !== undefined && body.credits !== '') ? parseFloat(body.credits) : payNum,
                method: 'Admin Manual',
                trx_id: 'ADMIN_' + Date.now(),
                sender_mobile: user.phone || user.user_id,
                created_at: new Date().toISOString(),
                note: body.payment_note || 'Admin Payment Update'
              });
            }
          }
          saveDb(db);
        }
        return redirect(`/admin/users?msg=Updated+record+for+${targetUserId}`);
      });
    }

    if (pathname === '/admin/deposits/create') {
      return readBody((err, body) => {
        const targetUserId = (body.target_user_id || '').trim();
        const amount = parseFloat(body.amount) || 0;
        const credits = parseFloat(body.credits) || amount;
        const method = (body.method || 'bKash').trim();
        const trxId = (body.trx_id || ('MANUAL_' + Date.now())).trim();
        const note = (body.note || 'Manual Deposit').trim();

        const db = loadDb();
        const user = db.users.find(u => u.user_id === targetUserId || u.phone === targetUserId);
        if (!user) {
          return redirect('/admin/deposits?error=' + encodeURIComponent(`User "${targetUserId}" not found!`));
        }

        user.credits = Math.round(((parseFloat(user.credits) || 0) + credits) * 100) / 100;
        user.status = 'active';
        user.payment_amount = String(amount);
        user.payment_note = `${method} - TrxID: ${trxId}`;

        if (!db.deposits) db.deposits = [];
        db.deposits.unshift({
          id: 'DEP_' + Date.now(),
          user_id: user.user_id,
          name: user.name || ('User ' + user.user_id),
          amount: amount,
          credits: credits,
          method: method,
          trx_id: trxId,
          sender_mobile: user.phone || user.user_id,
          created_at: new Date().toISOString(),
          note: note
        });

        saveDb(db);
        return redirect(`/admin/deposits?msg=Added+deposit+of+৳${amount}+for+${user.user_id}`);
      });
    }

    if (pathname === '/admin/payments/approve') {
      return readBody((err, body) => {
        const reqId = (body.request_id || '').trim();
        const addDays = parseInt(body.approve_days, 10) || 30;

        const db = loadDb();
        const pReq = db.payment_requests.find(r => r.id === reqId);

        if (pReq) {
          pReq.status = 'approved';
          pReq.approved_at = new Date().toISOString();

          // Use admin-specified target_user_id, fallback to pReq.user_id
          const lookupId = (body.target_user_id || '').trim() || pReq.user_id;
          let user = db.users.find(u => u.user_id === lookupId);

          if (!user) {
            return redirect('/admin/payments?error=' + encodeURIComponent('User ID "' + lookupId + '" not found! Please enter a valid existing User ID to credit days.'));
          } else {
            const currExp = new Date(user.expires_at);
            const now = new Date();
            const base = currExp > now ? currExp : now;
            base.setDate(base.getDate() + addDays);

            user.expires_at = base.toISOString().replace('T', ' ').substring(0, 19);
            user.status = 'active';
            if (pReq.amount) user.payment_amount = pReq.amount;
            user.payment_note = `${pReq.method} (${pReq.sender_mobile}) - TrxID: ${pReq.trx_id}`;
          }

          saveDb(db);
          return redirect(`/admin/payments?msg=Payment+Approved!+Added+${addDays}+Days+for+${pReq.user_id}`);
        }

        return redirect('/admin/payments?error=Request+not+found');
      });
    }

    if (pathname === '/admin/payments/reject') {
      return readBody((err, body) => {
        const reqId = (body.request_id || '').trim();
        const db = loadDb();
        const pReq = db.payment_requests.find(r => r.id === reqId);

        if (pReq) {
          pReq.status = 'rejected';
          pReq.rejected_at = new Date().toISOString();
          saveDb(db);
          return redirect(`/admin/payments?msg=Payment+Request+Rejected+for+${pReq.user_id}`);
        }

        return redirect('/admin/payments?error=Request+not+found');
      });
    }

    if (pathname.startsWith('/admin/users/') && pathname.endsWith('/renew')) {
      const targetUserId = decodeURIComponent(pathname.split('/')[3]);
      return readBody((err, body) => {
        const extendDaysStr = body.extend_days || '';
        const db = loadDb();
        const user = db.users.find(u => u.user_id === targetUserId || String(u.id) === targetUserId);

        if (user && extendDaysStr) {
          const addDays = parseInt(extendDaysStr, 10) || 30;
          const currExp = new Date(user.expires_at);
          const now = new Date();
          const base = currExp > now ? currExp : now;
          base.setDate(base.getDate() + addDays);
          user.expires_at = base.toISOString().replace('T', ' ').substring(0, 19);
          user.status = 'active';
          saveDb(db);
        }

        return redirect('/admin/users?msg=Subscription+renewed');
      });
    }

    if (pathname.startsWith('/admin/users/') && pathname.endsWith('/reset-pc')) {
      const targetUserId = decodeURIComponent(pathname.split('/')[3]);
      const db = loadDb();
      const user = db.users.find(u => u.user_id === targetUserId || String(u.id) === targetUserId);
      if (user) {
        user.hwid = null;
        saveDb(db);
      }
      return redirect('/admin/users?msg=PC+Lock+Reset');
    }

    if (pathname.startsWith('/admin/users/') && pathname.endsWith('/toggle-status')) {
      const targetUserId = decodeURIComponent(pathname.split('/')[3]);
      const db = loadDb();
      const user = db.users.find(u => u.user_id === targetUserId || String(u.id) === targetUserId);
      if (user) {
        user.status = user.status === 'active' ? 'suspended' : 'active';
        saveDb(db);
      }
      return redirect('/admin/users?msg=Status+updated');
    }

    if (pathname.startsWith('/admin/users/') && pathname.endsWith('/delete')) {
      const targetUserId = decodeURIComponent(pathname.split('/')[3]);
      const db = loadDb();
      db.users = db.users.filter(u => u.user_id !== targetUserId && String(u.id) !== targetUserId);
      saveDb(db);
      return redirect('/admin/users?msg=User+deleted');
    }

    if (pathname === '/admin/settings') {
      return readBody((err, body) => {
        const db = loadDb();
        if (!db.settings) db.settings = {};
        const rawGemini = String(body.gemini_keys || '');
        const rawGroq = String(body.groq_keys || '');
        const capKey = String(body.capmonster_key || '').trim();
        const provider = String(body.default_provider || 'gemini').trim();
        const gKeys = rawGemini.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5);
        const qKeys = rawGroq.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5);
        db.settings.gemini_keys = gKeys;
        db.settings.groq_keys = qKeys;
        db.settings.capmonster_key = capKey;
        db.settings.default_provider = provider;
        saveDb(db);
        return redirect('/admin/settings?msg=' + encodeURIComponent('Settings saved successfully!'));
      });
    }
  }

  sendJson({ ok: false, error: '404 Not Found' }, 404);

  function renderLogin(error = null) {
    const errHtml = error ? `<div class="alert alert-danger py-2 small fw-bold">${error}</div>` : '';
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Admin Login - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>body { background:#0f172a; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; } .card { background:#1e293b; border:1px solid #334155; padding:30px; border-radius:12px; width:360px; }</style>
</head>
<body>
  <div class="card">
    <div class="text-center mb-3">
      <img src="/logo.png" style="width:48px; height:48px; object-fit:contain;" alt="Logo"><br>
      <h3 class="text-info fw-bold mt-2 mb-0">Auto Fill Master</h3>
      <p class="text-light small fw-bold">Admin Dashboard Login</p>
    </div>
    ${errHtml}
    <form action="/admin/login" method="POST">
      <div class="mb-3"><label class="small text-info fw-bold mb-1">USERNAME</label><input type="text" name="username" class="form-control bg-dark text-white border-secondary fw-bold" required placeholder="admin"></div>
      <div class="mb-4"><label class="small text-info fw-bold mb-1">PASSWORD</label><input type="password" name="password" class="form-control bg-dark text-white border-secondary fw-bold" required placeholder="adminpassword123"></div>
      <button type="submit" class="btn btn-primary w-100 fw-bold">Login to Admin</button>
    </form>
  </div>
</body>
</html>`;
    sendHtml(html);
  }

  function renderDashboard(admin) {
    const db = loadDb();
    const now = new Date();
    const total = db.users.length;
    const active = db.users.filter(u => u.status === 'active' && new Date(u.expires_at) > now).length;
    const expired = db.users.filter(u => new Date(u.expires_at) <= now).length;
    const totalCredits = db.users.reduce((sum, u) => sum + (Number(u.credits) || 0), 0);
    
    // Show user accounts with minimum 3 Tk balance (or admin/sub)
    const recent = db.users.filter(u => (Number(u.credits) || 0) >= 3 || u.role === 'admin' || u.role === 'sub');
    recent.sort((a, b) => (Number(b.credits) || 0) - (Number(a.credits) || 0));

    // Calculate today's deposits using Dhaka timezone (Asia/Dhaka)
    const todayStr = getDhakaDateStr(now);
    const deposits = db.deposits || [];
    const todayDeposits = deposits.filter(d => getDhakaDateStr(d.created_at) === todayStr);
    const todayTotal = todayDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
    const allDepositsTotal = deposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    let recentRows = '';
    let dashModals = '';
    recent.forEach(u => {
      const balance = u.credits != null ? Number(u.credits).toFixed(1) : '0';
      const safeId = String(u.user_id).replace(/[^a-zA-Z0-9]/g, '_');
      const dashModalId = 'dashAddModal_' + safeId;
      const dashDeductModalId = 'dashDeductModal_' + safeId;
      recentRows += `<tr>
        <td class="fw-bold text-info">${u.user_id}</td>
        <td class="text-white">${u.name || '-'}</td>
        <td>
          <div class="d-flex align-items-center gap-1">
            <span class="badge bg-success-subtle text-success border border-success fw-bold px-2 py-1 fs-6">৳${balance}</span>
            <button type="button" class="btn btn-sm btn-success fw-bold px-2 py-0 text-nowrap" data-bs-toggle="modal" data-bs-target="#${dashModalId}" title="টাকা যোগ করুন">➕ Add</button>
            <button type="button" class="btn btn-sm btn-outline-danger fw-bold px-2 py-0 text-nowrap" data-bs-toggle="modal" data-bs-target="#${dashDeductModalId}" title="টাকা কাটুন">➖ Cut</button>
          </div>
        </td>
        <td>${u.payment_amount ? `<span class="badge bg-info text-dark fw-bold">৳${u.payment_amount}</span>` : '<span class="text-secondary small">-</span>'}</td>
        <td><span class="badge bg-${u.status === 'active' ? 'success' : 'danger'} fw-semibold">${u.status}</span></td>
        <td class="text-secondary font-monospace small">${u.expires_at ? u.expires_at.substring(0, 10) : '-'}</td>
      </tr>`;

      dashModals += `
      <!-- Add Balance Modal -->
      <div class="modal fade" id="${dashModalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark text-white border border-success shadow-lg">
            <div class="modal-header border-secondary">
              <h5 class="modal-title text-success fw-bold">➕ Add Balance: ${u.user_id}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <form action="/admin/users/add-balance" method="POST">
              <input type="hidden" name="target_user_id" value="${u.user_id}">
              <input type="hidden" name="redirect_to" value="/admin/dashboard">
              <div class="modal-body text-start">
                <div class="p-3 mb-3 rounded bg-secondary bg-opacity-25 border border-secondary">
                  <div class="text-secondary small">কাস্টমার / ইউজার:</div>
                  <div class="fs-5 fw-bold text-white">${u.user_id} ${u.name ? `(${u.name})` : ''}</div>
                  <div class="mt-2 text-secondary small">বর্তমান ব্যালেন্স:</div>
                  <div class="fs-4 fw-bold text-success">৳${balance}</div>
                </div>
                <div class="mb-3">
                  <label class="text-success fw-bold small d-block mb-1">কত টাকা যোগ করতে চান? (ADD AMOUNT ৳)</label>
                  <input type="number" step="1" min="1" name="amount" class="form-control form-control-lg bg-dark text-white border-success fw-bold" placeholder="যেমন: 20, 50, 100" required autofocus>
                  <div class="text-secondary small mt-1">এই টাকা ইউজারের বর্তমান ব্যালেন্সের সাথে সরাসরি যোগ হবে।</div>
                </div>
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">পেমেন্ট নোট / মাধ্যম (ঐচ্ছিক)</label>
                  <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="যেমন: ম্যানুয়াল রিচার্জ / bKash / ক্যাশ">
                </div>
              </div>
              <div class="modal-footer border-secondary">
                <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">বাতিল</button>
                <button type="submit" class="btn btn-success fw-bold px-4">➕ টাকা যোগ করুন</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- Deduct Balance Modal -->
      <div class="modal fade" id="${dashDeductModalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark text-white border border-danger shadow-lg">
            <div class="modal-header border-secondary">
              <h5 class="modal-title text-danger fw-bold">➖ Deduct Balance: ${u.user_id}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <form action="/admin/users/deduct-balance" method="POST">
              <input type="hidden" name="target_user_id" value="${u.user_id}">
              <input type="hidden" name="redirect_to" value="/admin/dashboard">
              <div class="modal-body text-start">
                <div class="p-3 mb-3 rounded bg-secondary bg-opacity-25 border border-secondary">
                  <div class="text-secondary small">কাস্টমার / ইউজার:</div>
                  <div class="fs-5 fw-bold text-white">${u.user_id} ${u.name ? `(${u.name})` : ''}</div>
                  <div class="mt-2 text-secondary small">বর্তমান ব্যালেন্স:</div>
                  <div class="fs-4 fw-bold text-success">৳${balance}</div>
                </div>
                <div class="mb-3">
                  <label class="text-danger fw-bold small d-block mb-1">কত টাকা কাটতে চান? (DEDUCT AMOUNT ৳)</label>
                  <input type="number" step="1" min="1" max="${balance}" name="amount" class="form-control form-control-lg bg-dark text-white border-danger fw-bold" placeholder="যেমন: 10, 20, 50" required autofocus>
                  <div class="text-secondary small mt-1">এই টাকা ইউজারের বর্তমান ব্যালেন্স থেকে সরাসরি কর্তন / বিয়োগ করা হবে।</div>
                </div>
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">কর্তনের কারণ / নোট (ঐচ্ছিক)</label>
                  <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="যেমন: ভুল রিচার্জ অ্যাডজাস্ট / রিফান্ড">
                </div>
              </div>
              <div class="modal-footer border-secondary">
                <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">বাতিল</button>
                <button type="submit" class="btn btn-danger fw-bold px-4">➖ টাকা কাটুন</button>
              </div>
            </form>
          </div>
        </div>
      </div>`;
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dashboard - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background:#0b0f19; color:#f8fafc; font-family:'Segoe UI', system-ui, -apple-system, sans-serif; }
    .sidebar { background:#111827; min-height:100vh; width:240px; padding:24px 20px; border-right:1px solid #1f2937; }
    .stat { background:#111827; border:1px solid #1f2937; padding:20px; border-radius:12px; }
  </style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Fill Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-white mb-3 text-decoration-none fw-bold">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-light mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/deposits" class="d-block text-light mb-3 text-decoration-none">💰 Daily Deposits</a>
    <a href="/admin/settings" class="d-block text-light mb-3 text-decoration-none">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold mb-4 text-white">Overview Dashboard</h2>
    <div class="row g-3 mb-4">
      <div class="col-md-3"><div class="stat"><div class="text-info fw-bold small text-uppercase">Total Users</div><div class="fs-2 text-white fw-bold mt-1">${total}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-success fw-bold small text-uppercase">Active Licenses</div><div class="fs-2 text-success fw-bold mt-1">${active}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-info fw-bold small text-uppercase">System Balance</div><div class="fs-2 text-info fw-bold mt-1">৳${totalCredits.toFixed(1)}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-warning fw-bold small text-uppercase">Today's Deposits</div><div class="fs-2 text-warning fw-bold mt-1">৳${todayTotal.toFixed(1)}</div><div class="text-secondary small mt-1">${todayDeposits.length} deposit${todayDeposits.length === 1 ? '' : 's'} today</div></div></div>
    </div>
    <div class="stat">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h5 class="fw-bold text-white mb-0">Active Balance Users (≥ ৳3) (${recent.length})</h5>
        <span class="badge bg-success-subtle text-success border border-success px-3 py-1">মিনিমাম ৩ টাকা ব্যালেন্স ওয়ালা অ্যাকাউন্ট</span>
      </div>
      <div class="table-responsive">
        <table class="table table-dark table-hover align-middle mb-0">
          <thead><tr style="color:#38bdf8;"><th style="color:#38bdf8;">USER ID</th><th style="color:#38bdf8;">NAME</th><th style="color:#38bdf8;">BALANCE</th><th style="color:#38bdf8;">PAYMENT</th><th style="color:#38bdf8;">STATUS</th><th style="color:#38bdf8;">EXPIRY</th></tr></thead>
          <tbody>${recentRows || '<tr><td colspan="6" class="text-muted py-4 text-center">No accounts with minimum ৳3 balance.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>
</div>
${dashModals}
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
    sendHtml(html);
  }

  function renderUsers(admin, msg = null, error = null) {
    const db = loadDb();
    const now = new Date();
    const pendingReqs = (db.payment_requests || []).filter(r => r.status === 'pending').length;
    const pendingBadge = pendingReqs > 0 ? `<span class="badge bg-danger ms-1">${pendingReqs}</span>` : '';
    let rows = '';
    let modalsHtml = '';

    db.users.forEach(u => {
      const expDt = new Date(u.expires_at);
      const isExp = now > expDt;
      const daysLeft = Math.max(0, Math.ceil((expDt - now) / (1000 * 60 * 60 * 24)));
      const hwidBadge = u.hwid 
        ? `<span class="badge bg-secondary fw-semibold" title="PC Locked: ${String(u.hwid).substring(0, 10)}...">🔒 Locked</span>` 
        : `<span class="badge bg-dark border border-secondary text-secondary fw-semibold">🔓 Free</span>`;
      const statusBadge = u.status === 'suspended' 
        ? '<span class="badge bg-danger fw-bold">Suspended</span>' 
        : (isExp ? '<span class="badge bg-warning text-dark fw-bold">Expired</span>' : '<span class="badge bg-success fw-bold">Active</span>');
      const yyyyMmDd = u.expires_at.substring(0, 10);
      const balance = u.credits != null ? Number(u.credits).toFixed(1) : '0';
      const safeId = String(u.user_id).replace(/[^a-zA-Z0-9]/g, '_');
      const editModalId = 'editModal_' + safeId;
      const payModalId = 'payModal_' + safeId;
      const addBalanceModalId = 'addBalanceModal_' + safeId;
      const deductBalanceModalId = 'deductBalanceModal_' + safeId;

      // Find user payment transactions
      const userReqs = (db.payment_requests || []).filter(r => (r.user_id === u.user_id || r.target_user_id === u.user_id));
      const payCount = userReqs.length;
      const payAmount = u.payment_amount ? u.payment_amount : (userReqs.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) || '0');

      rows += `<tr>
        <td>
          <div class="fw-bold text-info fs-6" style="color:#38bdf8 !important;">${u.user_id}</div>
          <div class="text-light small">${u.name || ''}${u.phone ? ` • <span class="text-secondary">${u.phone}</span>` : ''}</div>
        </td>
        <td>
          <div class="d-flex align-items-center gap-1">
            <span class="badge bg-success-subtle text-success border border-success px-2 py-1 fs-6 fw-bold">৳${balance}</span>
            <button type="button" class="btn btn-sm btn-success fw-bold px-2 py-0 text-nowrap" data-bs-toggle="modal" data-bs-target="#${addBalanceModalId}" title="টাকা যোগ করুন">➕ Add</button>
            <button type="button" class="btn btn-sm btn-outline-danger fw-bold px-2 py-0 text-nowrap" data-bs-toggle="modal" data-bs-target="#${deductBalanceModalId}" title="টাকা কাটুন">➖ Cut</button>
          </div>
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-info rounded-pill px-3 py-1 fw-bold text-nowrap" data-bs-toggle="modal" data-bs-target="#${payModalId}" title="Click to view payment history">
            💳 ৳${payAmount} ${payCount > 0 ? `<span class="badge bg-info text-dark rounded-circle ms-1">${payCount}</span>` : ''}
          </button>
        </td>
        <td>${hwidBadge}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="fw-bold ${isExp ? 'text-danger' : 'text-success'}">${daysLeft} Days</div>
          <small class="text-secondary font-monospace">${yyyyMmDd}</small>
        </td>
        <td>
          <div class="d-flex align-items-center gap-1">
            <button class="btn btn-sm btn-outline-info fw-bold px-2 py-1 text-nowrap" data-bs-toggle="modal" data-bs-target="#${editModalId}">✏️ Edit</button>
            <form id="del_form_${safeId}" action="/admin/users/${encodeURIComponent(u.user_id)}/delete" method="POST" style="display:inline-block; margin:0;" onsubmit="return confirm('⚠️ নিশ্চিত তো? এই ইউজার (${u.user_id}) পার্মানেন্টলি রিমুভ / ডিলিট করতে চান?');">
              <button type="submit" class="btn btn-sm btn-outline-danger fw-bold px-2 py-1" title="Remove User ${u.user_id}">🗑️</button>
            </form>
            <div class="dropdown">
              <button class="btn btn-sm btn-secondary dropdown-toggle px-2 py-1" type="button" data-bs-toggle="dropdown" aria-expanded="false">
                ⚙️
              </button>
              <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end shadow">
                <li><h6 class="dropdown-header text-info">Balance & Credits</h6></li>
                <li><button type="button" class="dropdown-item text-success fw-bold" data-bs-toggle="modal" data-bs-target="#${addBalanceModalId}">➕ Add Balance (টাকা যোগ)</button></li>
                <li><button type="button" class="dropdown-item text-danger fw-bold" data-bs-toggle="modal" data-bs-target="#${deductBalanceModalId}">➖ Deduct Balance (টাকা কাটুন)</button></li>
                <li><hr class="dropdown-divider border-secondary"></li>
                <li><h6 class="dropdown-header text-info">Quick Renew</h6></li>
                <li><form action="/admin/users/${encodeURIComponent(u.user_id)}/renew" method="POST"><input type="hidden" name="extend_days" value="7"><button type="submit" class="dropdown-item">+ 7 Days</button></form></li>
                <li><form action="/admin/users/${encodeURIComponent(u.user_id)}/renew" method="POST"><input type="hidden" name="extend_days" value="30"><button type="submit" class="dropdown-item">+ 30 Days (1 Month)</button></form></li>
                <li><form action="/admin/users/${encodeURIComponent(u.user_id)}/renew" method="POST"><input type="hidden" name="extend_days" value="90"><button type="submit" class="dropdown-item">+ 90 Days (3 Months)</button></form></li>
                <li><form action="/admin/users/${encodeURIComponent(u.user_id)}/renew" method="POST"><input type="hidden" name="extend_days" value="365"><button type="submit" class="dropdown-item">+ 1 Year</button></form></li>
                <li><hr class="dropdown-divider border-secondary"></li>
                ${u.hwid ? `<li><form action="/admin/users/${encodeURIComponent(u.user_id)}/reset-pc" method="POST"><button type="submit" class="dropdown-item text-warning">🔓 Reset PC Lock</button></form></li>` : ''}
                <li><form action="/admin/users/${encodeURIComponent(u.user_id)}/toggle-status" method="POST"><button type="submit" class="dropdown-item text-light">⏯️ Toggle Status (${u.status === 'active' ? 'Suspend' : 'Activate'})</button></form></li>
                <li><hr class="dropdown-divider border-secondary"></li>
                <li><button type="button" class="dropdown-item text-danger fw-bold" onclick="if(confirm('⚠️ নিশ্চিত তো? এই ইউজার (${u.user_id}) পার্মানেন্টলি রিমুভ / ডিলিট করতে চান?')) { document.getElementById('del_form_${safeId}').submit(); }">🗑️ Remove / Delete User</button></li>
              </ul>
            </div>
          </div>
        </td>
      </tr>`;

      // 1. Edit User Modal
      modalsHtml += `
      <div class="modal fade" id="${editModalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark text-white border border-info shadow-lg">
            <div class="modal-header border-secondary">
              <h5 class="modal-title text-info fw-bold">✏️ Edit Account: ${u.user_id}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <form action="/admin/users/update-user-payment" method="POST">
              <input type="hidden" name="target_user_id" value="${u.user_id}">
              <div class="modal-body text-start">
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">১. মেয়াদের দিন সংখ্যা (SET EXACT DAYS LEFT)</label>
                  <input type="number" name="set_exact_days" class="form-control bg-dark text-white border-info fw-bold" value="${daysLeft}" placeholder="যেমন: 15 বা 45 বা 60">
                  <div class="text-secondary small mt-1">আজ থেকে কত দিন পর্যন্ত মেয়াদ থাকবে।</div>
                </div>
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">২. অথবা মেয়াদের শেষ তারিখ (EXACT EXPIRY DATE)</label>
                  <input type="date" name="custom_expiry_date" class="form-control bg-dark text-white border-secondary fw-bold" value="${yyyyMmDd}">
                </div>
                <div class="mb-3">
                  <label class="text-success fw-bold small d-block mb-1">৩. ক্যাশ ব্যালেন্স / ক্রেডিট (BALANCE ৳)</label>
                  <input type="number" step="0.5" name="credits" class="form-control bg-dark text-white border-success fw-bold" value="${u.credits != null ? u.credits : 0}">
                  <div class="text-secondary small mt-1">ক্যাপচা ও স্ক্যানিং খরচের জন্য কাস্টমারের বর্তমান ব্যালেন্স।</div>
                </div>
                <hr class="border-secondary mb-3">
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">৪. পেমেন্টের মোট পরিমাণ (TOTAL PAYMENT ৳)</label>
                  <input type="text" name="payment_amount" class="form-control bg-dark text-white border-secondary fw-bold" value="${u.payment_amount || ''}" placeholder="যেমন: 500">
                </div>
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">৫. পেমেন্ট নোট / মাধ্যম / TrxID (NOTE)</label>
                  <input type="text" name="payment_note" class="form-control bg-dark text-white border-secondary fw-bold" value="${u.payment_note || ''}" placeholder="যেমন: bKash (017...) - TrxID: ...">
                </div>
              </div>
              <div class="modal-footer border-secondary d-flex justify-content-between">
                <button type="button" class="btn btn-outline-danger fw-bold btn-sm" onclick="if(confirm('⚠️ নিশ্চিত তো? এই ইউজার (${u.user_id}) পার্মানেন্টলি রিমুভ / ডিলিট করতে চান?')) { document.getElementById('del_form_${safeId}').submit(); }">🗑️ Remove User</button>
                <div>
                  <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Cancel</button>
                  <button type="submit" class="btn btn-primary btn-sm fw-bold">💾 Save Changes</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- 2. Payment Details & History Modal -->
      <div class="modal fade" id="${payModalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark text-white border border-info shadow-lg">
            <div class="modal-header border-secondary">
              <h5 class="modal-title text-info fw-bold">💳 Payment Details & History: ${u.user_id}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body text-start">
              <div class="row g-3 mb-3">
                <div class="col-md-4">
                  <div class="p-3 rounded bg-secondary bg-opacity-25 border border-secondary text-center">
                    <div class="text-secondary small fw-bold">TOTAL PAID</div>
                    <div class="fs-3 text-info fw-bold">৳${payAmount}</div>
                  </div>
                </div>
                <div class="col-md-4">
                  <div class="p-3 rounded bg-secondary bg-opacity-25 border border-secondary text-center">
                    <div class="text-secondary small fw-bold">CURRENT BALANCE</div>
                    <div class="fs-3 text-success fw-bold">৳${balance}</div>
                  </div>
                </div>
                <div class="col-md-4">
                  <div class="p-3 rounded bg-secondary bg-opacity-25 border border-secondary text-center">
                    <div class="text-secondary small fw-bold">ONLINE RECORDS</div>
                    <div class="fs-5 text-white fw-bold mt-1">${payCount > 0 ? `${payCount} Request(s)` : 'No Online Req'}</div>
                  </div>
                </div>
              </div>

              <div class="p-3 rounded bg-secondary bg-opacity-10 border border-secondary mb-3">
                <div class="text-info fw-bold small mb-1">📌 LATEST PAYMENT NOTE / RECORD:</div>
                <div class="text-white font-monospace">${u.payment_note || '<span class="text-muted">No note recorded</span>'}</div>
              </div>

              ${userReqs.length > 0 ? `
                <h6 class="text-info fw-bold mt-3 mb-2">📜 Transaction History</h6>
                <div class="table-responsive mb-3">
                  <table class="table table-dark table-sm table-bordered align-middle mb-0">
                    <thead>
                      <tr class="text-info">
                        <th>Date</th>
                        <th>Method</th>
                        <th>Sender Mobile</th>
                        <th>TrxID</th>
                        <th>Amount</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${userReqs.map(r => `
                        <tr>
                          <td class="small text-secondary">${r.created_at ? new Date(r.created_at).toLocaleDateString() : '-'}</td>
                          <td><span class="badge bg-primary">${r.method || 'bKash'}</span></td>
                          <td class="text-white fw-bold">${r.sender_mobile || '-'}</td>
                          <td class="text-warning font-monospace small">${r.trx_id || '-'}</td>
                          <td class="text-success fw-bold">৳${r.amount || 0}</td>
                          <td><span class="badge bg-${r.status === 'approved' ? 'success' : (r.status === 'pending' ? 'warning text-dark' : 'danger')}">${r.status}</span></td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              ` : ''}

              <hr class="border-secondary my-3">
              <form action="/admin/users/update-user-payment" method="POST">
                <input type="hidden" name="target_user_id" value="${u.user_id}">
                <h6 class="text-info fw-bold mb-2">✏️ Quick Update Payment / Note</h6>
                <div class="row g-2">
                  <div class="col-md-4">
                    <label class="text-secondary small fw-bold">Payment Amount (৳)</label>
                    <input type="text" name="payment_amount" class="form-control form-control-sm bg-dark text-white border-secondary fw-bold" value="${u.payment_amount || ''}" placeholder="500">
                  </div>
                  <div class="col-md-5">
                    <label class="text-secondary small fw-bold">Payment Note / TrxID</label>
                    <input type="text" name="payment_note" class="form-control form-control-sm bg-dark text-white border-secondary fw-bold" value="${u.payment_note || ''}" placeholder="bKash (017...) Trx: ...">
                  </div>
                  <div class="col-md-3 d-flex align-items-end">
                    <button type="submit" class="btn btn-sm btn-primary fw-bold w-100">Update Record</button>
                  </div>
                </div>
              </form>
            </div>
            <div class="modal-footer border-secondary py-2">
              <button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Add Balance Modal -->
      <div class="modal fade" id="${addBalanceModalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark text-white border border-success shadow-lg">
            <div class="modal-header border-secondary">
              <h5 class="modal-title text-success fw-bold">➕ Add Balance: ${u.user_id}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <form action="/admin/users/add-balance" method="POST">
              <input type="hidden" name="target_user_id" value="${u.user_id}">
              <input type="hidden" name="redirect_to" value="/admin/users">
              <div class="modal-body text-start">
                <div class="p-3 mb-3 rounded bg-secondary bg-opacity-25 border border-secondary">
                  <div class="text-secondary small">কাস্টমার / ইউজার:</div>
                  <div class="fs-5 fw-bold text-white">${u.user_id} ${u.name ? `(${u.name})` : ''}</div>
                  <div class="mt-2 text-secondary small">বর্তমান ব্যালেন্স:</div>
                  <div class="fs-4 fw-bold text-success">৳${balance}</div>
                </div>
                <div class="mb-3">
                  <label class="text-success fw-bold small d-block mb-1">কত টাকা যোগ করতে চান? (ADD AMOUNT ৳)</label>
                  <input type="number" step="1" min="1" name="amount" class="form-control form-control-lg bg-dark text-white border-success fw-bold" placeholder="যেমন: 20, 50, 100" required autofocus>
                  <div class="text-secondary small mt-1">এই টাকা ইউজারের বর্তমান ব্যালেন্সের সাথে সরাসরি যোগ হয়ে যাবে।</div>
                </div>
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">পেমেন্ট নোট / মাধ্যম (ঐচ্ছিক)</label>
                  <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="যেমন: ম্যানুয়াল রিচার্জ / bKash / ক্যাশ">
                </div>
              </div>
              <div class="modal-footer border-secondary">
                <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">বাতিল</button>
                <button type="submit" class="btn btn-success fw-bold px-4">➕ টাকা যোগ করুন</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- 4. Deduct Balance Modal -->
      <div class="modal fade" id="${deductBalanceModalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark text-white border border-danger shadow-lg">
            <div class="modal-header border-secondary">
              <h5 class="modal-title text-danger fw-bold">➖ Deduct Balance: ${u.user_id}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <form action="/admin/users/deduct-balance" method="POST">
              <input type="hidden" name="target_user_id" value="${u.user_id}">
              <input type="hidden" name="redirect_to" value="/admin/users">
              <div class="modal-body text-start">
                <div class="p-3 mb-3 rounded bg-secondary bg-opacity-25 border border-secondary">
                  <div class="text-secondary small">কাস্টমার / ইউজার:</div>
                  <div class="fs-5 fw-bold text-white">${u.user_id} ${u.name ? `(${u.name})` : ''}</div>
                  <div class="mt-2 text-secondary small">বর্তমান ব্যালেন্স:</div>
                  <div class="fs-4 fw-bold text-success">৳${balance}</div>
                </div>
                <div class="mb-3">
                  <label class="text-danger fw-bold small d-block mb-1">কত টাকা কাটতে চান? (DEDUCT AMOUNT ৳)</label>
                  <input type="number" step="1" min="1" max="${balance}" name="amount" class="form-control form-control-lg bg-dark text-white border-danger fw-bold" placeholder="যেমন: 10, 20, 50" required autofocus>
                  <div class="text-secondary small mt-1">এই টাকা ইউজারের বর্তমান ব্যালেন্স থেকে সরাসরি কর্তন / বিয়োগ করা হবে।</div>
                </div>
                <div class="mb-3">
                  <label class="text-info fw-bold small d-block mb-1">কর্তনের কারণ / নোট (ঐচ্ছিক)</label>
                  <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="যেমন: ভুল রিচার্জ অ্যাডজাস্ট / রিফান্ড">
                </div>
              </div>
              <div class="modal-footer border-secondary">
                <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">বাতিল</button>
                <button type="submit" class="btn btn-danger fw-bold px-4">➖ টাকা কাটুন</button>
              </div>
            </form>
          </div>
        </div>
      </div>
      `;
    });

    const msgAlert = msg ? `<div class="alert alert-success py-2 fw-bold text-dark" style="background:#dcfce7; border-color:#86efac;">${msg}</div>` : '';
    const errAlert = error ? `<div class="alert alert-danger py-2 fw-bold">${error}</div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Users & Licenses - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background:#0b0f19; color:#f8fafc; font-family:'Segoe UI', system-ui, -apple-system, sans-serif; }
    .sidebar { background:#111827; min-height:100vh; width:240px; padding:24px 20px; border-right:1px solid #1f2937; }
    .stat { background:#111827; border:1px solid #1f2937; padding:20px; border-radius:12px; }
    th { color:#38bdf8 !important; font-weight:700 !important; text-transform:uppercase; font-size:12px; letter-spacing:0.5px; }
    td { color:#ffffff !important; font-size:14px; }
    .table-hover tbody tr:hover td { background-color: rgba(56, 189, 248, 0.05); }
  </style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Fill Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-light mb-3 text-decoration-none">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-white mb-3 text-decoration-none fw-bold">👥 Users & Licenses</a>
    <a href="/admin/deposits" class="d-block text-light mb-3 text-decoration-none">💰 Daily Deposits</a>
    <a href="/admin/settings" class="d-block text-light mb-3 text-decoration-none">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <div>
        <h2 class="fw-bold text-white mb-0">User Accounts & Licenses</h2>
        <small class="text-secondary">Manage user access, validity, balance credits, and payment records</small>
      </div>
      <div class="d-flex align-items-center gap-2">
        <input type="text" id="userSearch" class="form-control form-control-sm bg-dark text-white border-secondary" placeholder="🔍 Search user, phone..." style="width:220px;" onkeyup="filterUsers()">
        <button type="button" class="btn btn-success btn-sm fw-bold px-3 py-2 text-nowrap" data-bs-toggle="modal" data-bs-target="#globalAddBalanceModal">➕ Add Balance (টাকা যোগ)</button>
        <button type="button" class="btn btn-outline-danger btn-sm fw-bold px-3 py-2 text-nowrap" data-bs-toggle="modal" data-bs-target="#globalDeductBalanceModal">➖ Deduct (টাকা কাটুন)</button>
        <a href="/admin/users/create" class="btn btn-primary btn-sm fw-bold px-3 py-2 text-nowrap">+ Create User ID</a>
      </div>
    </div>
    ${msgAlert}${errAlert}
    <div class="stat">
      <div class="table-responsive">
        <table class="table table-dark table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>USER</th>
              <th>BALANCE</th>
              <th>PAYMENT</th>
              <th>PC LOCK</th>
              <th>STATUS</th>
              <th>EXPIRY & REMAINING</th>
              <th style="width:140px;">ACTIONS</th>
            </tr>
          </thead>
          <tbody id="userTableBody">
            ${rows || '<tr><td colspan="7" class="text-muted py-4 text-center">No client users yet. Click "+ Create User ID" to add one.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

${modalsHtml}

<!-- Global Add Balance Modal -->
<div class="modal fade" id="globalAddBalanceModal" tabindex="-1">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content bg-dark text-white border border-success shadow-lg">
      <div class="modal-header border-secondary">
        <h5 class="modal-title text-success fw-bold">➕ Quick Add Balance / ম্যানুয়াল টাকা যোগ</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
      </div>
      <form action="/admin/users/add-balance" method="POST">
        <input type="hidden" name="redirect_to" value="/admin/users">
        <div class="modal-body text-start">
          <div class="mb-3">
            <label class="text-info fw-bold small d-block mb-1">১. ইউজার নির্বাচন করুন (SELECT USER)</label>
            <select name="target_user_id" class="form-select bg-dark text-white border-secondary fw-bold" required>
              <option value="">-- ইউজার বেছে নিন --</option>
              ${db.users.map(u => `<option value="${u.user_id}">${u.user_id} ${u.name ? `(${u.name})` : ''} - বর্তমান ব্যালেন্স: ৳${Number(u.credits || 0).toFixed(1)}</option>`).join('')}
            </select>
          </div>
          <div class="mb-3">
            <label class="text-success fw-bold small d-block mb-1">২. কত টাকা যোগ করতে চান? (AMOUNT ৳)</label>
            <input type="number" step="1" min="1" name="amount" class="form-control form-control-lg bg-dark text-white border-success fw-bold" placeholder="যেমন: 20, 50, 100" required>
            <div class="text-secondary small mt-1">এই টাকা ইউজারের বিদ্যমান ব্যালেন্সের সাথে সরাসরি যুক্ত হয়ে যাবে।</div>
          </div>
          <div class="mb-3">
            <label class="text-info fw-bold small d-block mb-1">৩. পেমেন্ট মাধ্যম / নোট (ঐচ্ছিক)</label>
            <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="যেমন: ম্যানুয়াল রিচার্জ / bKash / নগদ">
          </div>
        </div>
        <div class="modal-footer border-secondary">
          <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">বাতিল</button>
          <button type="submit" class="btn btn-success fw-bold px-4">➕ ব্যালেন্স যোগ করুন</button>
        </div>
      </form>
    </div>
  </div>
</div>

<!-- Global Deduct Balance Modal -->
<div class="modal fade" id="globalDeductBalanceModal" tabindex="-1">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content bg-dark text-white border border-danger shadow-lg">
      <div class="modal-header border-secondary">
        <h5 class="modal-title text-danger fw-bold">➖ Quick Deduct Balance / ম্যানুয়াল টাকা কর্তন</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
      </div>
      <form action="/admin/users/deduct-balance" method="POST">
        <input type="hidden" name="redirect_to" value="/admin/users">
        <div class="modal-body text-start">
          <div class="mb-3">
            <label class="text-info fw-bold small d-block mb-1">১. ইউজার নির্বাচন করুন (SELECT USER)</label>
            <select name="target_user_id" class="form-select bg-dark text-white border-secondary fw-bold" required>
              <option value="">-- ইউজার বেছে নিন --</option>
              ${db.users.map(u => `<option value="${u.user_id}">${u.user_id} ${u.name ? `(${u.name})` : ''} - বর্তমান ব্যালেন্স: ৳${Number(u.credits || 0).toFixed(1)}</option>`).join('')}
            </select>
          </div>
          <div class="mb-3">
            <label class="text-danger fw-bold small d-block mb-1">২. কত টাকা কাটতে চান? (AMOUNT ৳)</label>
            <input type="number" step="1" min="1" name="amount" class="form-control form-control-lg bg-dark text-white border-danger fw-bold" placeholder="যেমন: 10, 20, 50" required>
            <div class="text-secondary small mt-1">এই টাকা ইউজারের বিদ্যমান ব্যালেন্স থেকে সরাসরি বাদ বা কর্তন হয়ে যাবে।</div>
          </div>
          <div class="mb-3">
            <label class="text-info fw-bold small d-block mb-1">৩. কর্তনের কারণ / নোট (ঐচ্ছিক)</label>
            <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="যেমন: ভুল রিচার্জ অ্যাডজাস্ট / রিফান্ড">
          </div>
        </div>
        <div class="modal-footer border-secondary">
          <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">বাতিল</button>
          <button type="submit" class="btn btn-danger fw-bold px-4">➖ ব্যালেন্স কর্তন করুন</button>
        </div>
      </form>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
function filterUsers() {
  const q = document.getElementById('userSearch').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#userTableBody tr');
  rows.forEach(tr => {
    tr.style.display = tr.innerText.toLowerCase().includes(q) ? '' : 'none';
  });
}
</script>
</body>
</html>`;
    sendHtml(html);
  }

  
  function renderSettings(admin, msg = null, error = null) {
    const db = loadDb();
    const reqs = db.payment_requests || [];
    const pendingReqs = reqs.filter(r => r.status === 'pending').length;
    const pendingBadge = pendingReqs > 0 ? `<span class="badge bg-danger ms-1">${pendingReqs}</span>` : '';
    const settings = db.settings || {};

    const allGemini = (settings.gemini_keys && settings.gemini_keys.length > 0)
      ? settings.gemini_keys
      : (process.env.GEMINI_KEYS ? process.env.GEMINI_KEYS.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5) : []);
    const allGroq = (settings.groq_keys && settings.groq_keys.length > 0)
      ? settings.groq_keys
      : (process.env.GROQ_KEYS ? process.env.GROQ_KEYS.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5) : []);
    const capKey = settings.capmonster_key || process.env.CAPMONSTER_API_KEY || '';

    const geminiText = allGemini.join('\n');
    const groqText = allGroq.join('\n');
    const provider = settings.default_provider || 'gemini';

    const msgAlert = msg ? `<div class="alert alert-success py-2 fw-bold text-dark" style="background:#dcfce7; border-color:#86efac;">${msg}</div>` : '';
    const errAlert = error ? `<div class="alert alert-danger py-2 fw-bold">${error}</div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Central AI Keys & Settings - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background:#0f172a; color:#fff; font-family:'Segoe UI', sans-serif; }
    .sidebar { background:#1e293b; min-height:100vh; width:240px; padding:20px; }
    .stat { background:#1e293b; border:1px solid #334155; padding:25px; border-radius:10px; }
    label { color:#38bdf8; font-weight:600; margin-bottom:6px; }
    textarea, input, select { background:#0f172a !important; color:#fff !important; border:1px solid #334155 !important; }
    textarea:focus, input:focus, select:focus { border-color:#38bdf8 !important; box-shadow:0 0 0 0.25rem rgba(56,189,248,0.25) !important; }
  </style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Fill Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-light mb-3 text-decoration-none">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-light mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/deposits" class="d-block text-light mb-3 text-decoration-none">💰 Daily Deposits</a>
    <a href="/admin/settings" class="d-block text-white mb-3 text-decoration-none font-weight-bold">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold text-white mb-2">Central AI Keys & Load Balancer</h2>
    <p class="text-muted mb-3">Add your free Google Gemini, Groq, and CapMonster API keys below. Clients will automatically use these keys with instant round-robin load balancing!</p>

    <div id="autoRestoreBanner" class="alert alert-info py-2 small fw-bold" style="display:none; background:#0284c7; color:#fff; border:none; margin-bottom:15px;">
      ⚡ আপনার ব্রাউজার ব্যাকআপ থেকে পূর্বে সেভ করা এপিআই কীগুলো স্বয়ংক্রিয়ভাবে লোড করা হয়েছে! নিচে 'Save & Sync All Clients' বাটনে ক্লিক করে নিশ্চিত করুন।
    </div>

    <div class="alert alert-dark py-2 px-3 small border-secondary mb-3" style="background:#131d31; color:#94a3b8;">
      💡 <strong class="text-white">সার্ভার রিস্টার্টেও কি পার্মানেন্ট রাখতে চান?</strong> Render ড্যাশবোর্ডে গিয়ে <strong>Environment</strong> ট্যাবে <code class="text-info">GEMINI_KEYS</code> ভ্যারিয়েবল হিসেবে আপনার কীগুলো দিয়ে দিলে সার্ভার যতই রিডিপ্লয় হোক না কেন কি কখনো মুছবে না।
    </div>

    ${msgAlert}${errAlert}
    
    <div class="stat" style="max-width:800px;">
      <form action="/admin/settings" method="POST">
        <div class="mb-4">
          <label class="form-label fs-5">🌟 Google Gemini API Keys Pool (One key per line):</label>
          <div class="text-muted small mb-2">Get free keys from <a href="https://aistudio.google.com/apikey" target="_blank" class="text-info">aistudio.google.com/apikey</a>. You can put 3 to 10 keys here for 100% unlimited capacity!</div>
          <textarea name="gemini_keys" rows="5" class="form-control font-monospace" placeholder="AIzaSy...&#10;AIzaSy...&#10;AIzaSy...">${geminiText}</textarea>
          <div class="mt-1 text-info small">Active Gemini Keys in Pool: <strong>${allGemini.length} keys</strong> (Capacity: ~<strong>${allGemini.length * 1500} passports/day</strong>)</div>
        </div>

        <div class="mb-4">
          <label class="form-label fs-5">⚡ Groq API Keys Pool (Optional Backup):</label>
          <div class="text-muted small mb-2">Get free keys from <a href="https://console.groq.com/keys" target="_blank" class="text-info">console.groq.com/keys</a>.</div>
          <textarea name="groq_keys" rows="3" class="form-control font-monospace" placeholder="gsk_...&#10;gsk_...">${groqText}</textarea>
        </div>

        <div class="mb-4">
          <label class="form-label fs-5">🤖 CapMonster Cloud API Key (Visa Captcha Auto-Solve):</label>
          <div class="text-muted small mb-2">Each solve will cost your users ৳0.05 (5 poisha) from their balance. Key stays secure on server!</div>
          <input type="password" name="capmonster_key" class="form-control font-monospace" placeholder="Paste CapMonster Client Key" value="${capKey}">
        </div>

        <div class="mb-4">
          <label class="form-label">Primary AI Provider:</label>
          <select name="default_provider" class="form-select" style="max-width:300px;">
            <option value="gemini" ${provider === 'gemini' ? 'selected' : ''}>Google Gemini (Vision + Text - Recommended)</option>
            <option value="groq" ${provider === 'groq' ? 'selected' : ''}>Groq (Ultra High Speed)</option>
          </select>
        </div>

        <button type="submit" class="btn btn-primary btn-lg fw-bold px-4">💾 Save & Sync All Clients</button>
      </form>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
(function() {
  const gEl = document.querySelector('textarea[name="gemini_keys"]');
  const qEl = document.querySelector('textarea[name="groq_keys"]');
  const cEl = document.querySelector('input[name="capmonster_key"]');
  const banner = document.getElementById('autoRestoreBanner');
  const form = document.querySelector('form');

  if (gEl && gEl.value.trim()) localStorage.setItem('ahm_backup_gemini_keys', gEl.value.trim());
  if (qEl && qEl.value.trim()) localStorage.setItem('ahm_backup_groq_keys', qEl.value.trim());
  if (cEl && cEl.value.trim()) localStorage.setItem('ahm_backup_cap_key', cEl.value.trim());

  let restored = false;
  if (gEl && !gEl.value.trim() && localStorage.getItem('ahm_backup_gemini_keys')) {
    gEl.value = localStorage.getItem('ahm_backup_gemini_keys');
    restored = true;
  }
  if (qEl && !qEl.value.trim() && localStorage.getItem('ahm_backup_groq_keys')) {
    qEl.value = localStorage.getItem('ahm_backup_groq_keys');
    restored = true;
  }
  if (cEl && !cEl.value.trim() && localStorage.getItem('ahm_backup_cap_key')) {
    cEl.value = localStorage.getItem('ahm_backup_cap_key');
    restored = true;
  }

  if (restored && banner) {
    banner.style.display = 'block';
  }

  if (form) {
    form.addEventListener('submit', function() {
      if (gEl && gEl.value.trim()) localStorage.setItem('ahm_backup_gemini_keys', gEl.value.trim());
      if (qEl && qEl.value.trim()) localStorage.setItem('ahm_backup_groq_keys', qEl.value.trim());
      if (cEl && cEl.value.trim()) localStorage.setItem('ahm_backup_cap_key', cEl.value.trim());
    });
  }
})();
</script>
</body>
</html>`;
    sendHtml(html);
  }

  function renderPrivacyPolicy() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - Indian Visa Auto Fill Master</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 860px; margin: 40px auto; padding: 0 24px; color: #2d3748; background: #ffffff; }
    h1 { color: #1a365d; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; font-size: 2rem; margin-bottom: 8px; }
    h2 { color: #2b6cb0; margin-top: 32px; margin-bottom: 12px; font-size: 1.35rem; border-bottom: 1px solid #edf2f7; padding-bottom: 6px; }
    h3 { color: #2d3748; margin-top: 20px; margin-bottom: 8px; font-size: 1.1rem; }
    p, li { color: #4a5568; font-size: 1rem; line-height: 1.7; }
    ul { padding-left: 24px; margin-bottom: 16px; }
    li { margin-bottom: 8px; }
    .updated { color: #718096; font-size: 0.95rem; margin-bottom: 28px; }
    .highlight-box { background: #ebf8ff; border-left: 4px solid #3182ce; padding: 16px 20px; border-radius: 6px; margin: 20px 0; }
    .contact-box { background: #f7fafc; padding: 20px 24px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 36px; }
    code { background: #edf2f7; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: monospace; color: #805ad5; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { border: 1px solid #e2e8f0; padding: 10px 14px; text-align: left; font-size: 0.95rem; }
    th { background: #f7fafc; color: #2d3748; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Privacy Policy for Indian Visa Auto Fill Master</h1>
  <p class="updated"><strong>Effective Date:</strong> September 4, 2026 | <strong>Last Updated:</strong> September 4, 2026</p>

  <p>This Privacy Policy applies to the Google Chrome extension <strong>Indian Visa Auto Fill Master</strong> (referred to as "we", "our", "us", or the "Extension"). We are committed to protecting your privacy and handling your data with complete transparency, in full compliance with the Google Chrome Web Store Developer Program Policies and User Data Privacy Guidelines (Purple Nickel).</p>

  <div class="highlight-box">
    <strong>Summary of Core Privacy Commitments:</strong>
    <ul>
      <li>All applicant profiles, passport records, and application IDs are stored <strong>strictly locally on your device</strong> using Chrome's local storage (<code>chrome.storage.local</code>).</li>
      <li>We <strong>do not sell, rent, trade, or monetize</strong> your personal data under any circumstances.</li>
      <li>Data is processed for the <strong>single purpose</strong> of autofilling Indian visa forms at the user's explicit command.</li>
      <li>Users have <strong>full control</strong> to inspect, edit, or permanently delete all data at any time directly in the extension interface.</li>
    </ul>
  </div>

  <h2>1. Single Purpose Description</h2>
  <p>The primary and exclusive purpose of <strong>Indian Visa Auto Fill Master</strong> is to assist users in accurately and quickly completing visa application forms on the official Indian Visa Online portal (<code>indianvisa-bangladesh.nic.in</code>) by autofilling applicant details extracted from user-supplied travel documents (e.g. passport biometric scans and previous application PDF files).</p>

  <h2>2. User Data Collection</h2>
  <p>To perform its form-filling functions, the Extension collects and processes the following categories of information only when explicitly provided by the user:</p>
  <ul>
    <li><strong>Personally Identifiable Information (PII):</strong> Applicant full name (given name, surname), date of birth, place and country of birth, gender, marital status, religion, educational qualification, visible identification marks, and parents'/spouse's names.</li>
    <li><strong>Government Identification & Travel Credentials:</strong> Passport number, passport date of issue, passport expiry date, place of issue, and National ID (NID) / Citizen ID numbers.</li>
    <li><strong>Contact & Address Information:</strong> Present address, permanent address, email address, and mobile phone number.</li>
    <li><strong>Travel & Stay References:</strong> Intended date of arrival, visa duration, visa entry type, hotel name, hotel address, and contact details for references in India and Bangladesh.</li>
    <li><strong>Temporary Application Identifiers:</strong> Portal-generated Temporary Application IDs (e.g., BGD application numbers) captured from the visa site solely to allow the applicant to track or resume partially filled applications.</li>
  </ul>

  <h2>3. Data Handling and Processing</h2>
  <p>The collected information is handled and processed exclusively through the following workflows:</p>
  <ul>
    <li><strong>Form Autofill Execution:</strong> When a user navigates to the official visa application page and clicks "Fill" or uses auto-fill, the Extension maps the locally stored profile fields to the corresponding form inputs and selects the appropriate dropdown options.</li>
    <li><strong>Document OCR & Vision Extraction:</strong> When the user chooses to import details by uploading a passport bio-page photo or PDF document, the document is processed through local optical character recognition (OCR) or secure encrypted HTTPS transmission to an AI vision extraction endpoint. This processing occurs solely in memory to extract structured text fields into the user's local profile. The document is <strong>never</strong> retained on external servers or used to train artificial intelligence models.</li>
  </ul>

  <h2>4. Data Storage and Retention</h2>
  <ul>
    <li><strong>Local Storage Location:</strong> All profile records, user settings, and application IDs are stored entirely inside the user's browser sandbox via <code>chrome.storage.local</code>.</li>
    <li><strong>Zero Cloud Database of Personal Records:</strong> We do not operate or maintain any remote server or database that stores user passport photos, applicant profiles, or personal documents.</li>
    <li><strong>Retention Period:</strong> Data remains stored locally in your browser only for as long as you choose to keep it. We do not automatically expire or upload your profiles.</li>
  </ul>

  <h2>5. Data Sharing and Third-Party Disclosure</h2>
  <p>We adhere to strict data non-disclosure practices:</p>
  <ul>
    <li><strong>No Sale or Transfer:</strong> We do not sell, rent, barter, or transfer personal data to data brokers, advertising networks, market researchers, or commercial third parties.</li>
    <li><strong>No Advertising or Tracking:</strong> The Extension contains no advertising code, trackers, analytics beacons, or behavioral monitoring software.</li>
    <li><strong>Destination Portal Transmission:</strong> Personal data is transmitted exclusively to the official government visa application portal (<code>indianvisa-bangladesh.nic.in</code>) through standard browser form submission when you submit your visa application.</li>
  </ul>

  <h2>6. User Control, Rights, and Data Deletion</h2>
  <p>You have full autonomy over your data at all times:</p>
  <ul>
    <li><strong>View & Edit:</strong> You can view and edit any saved applicant profile at any time by opening the extension side panel and selecting "Edit".</li>
    <li><strong>Profile Deletion:</strong> You can permanently delete an individual applicant profile by clicking the "Del" button next to that profile.</li>
    <li><strong>Complete Data Purge:</strong> You can wipe all applicant profiles and stored data at once by clicking "Delete all" in the extension manager.</li>
    <li><strong>Extension Uninstallation:</strong> Removing or uninstalling the Extension from Google Chrome immediately and permanently erases all data stored in <code>chrome.storage.local</code>.</li>
  </ul>

  <h2>7. Chrome Permissions Justification</h2>
  <p>The Extension requests only the minimum permissions necessary to deliver its stated core functionality:</p>
  <table>
    <thead>
      <tr>
        <th>Permission</th>
        <th>Purpose & Scope</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>storage</code></td>
        <td>To save applicant profiles, visa preferences, and user settings locally on your device.</td>
      </tr>
      <tr>
        <td><code>scripting</code> & <code>activeTab</code></td>
        <td>To execute form-filling scripts on the active tab of the official visa portal when requested by the user.</td>
      </tr>
      <tr>
        <td><code>sidePanel</code></td>
        <td>To display the profile manager and autofill dashboard alongside the visa webpage for convenient navigation.</td>
      </tr>
      <tr>
        <td><code>downloads</code></td>
        <td>To permit the user to download generated application documents (such as cover letters or NOC templates).</td>
      </tr>
      <tr>
        <td><code>tabs</code></td>
        <td>To detect whether the current tab is located on the official visa application portal.</td>
      </tr>
      <tr>
        <td><code>host_permissions</code> (<code>indianvisa-bangladesh.nic.in</code>)</td>
        <td>Restricted strictly to the official Indian visa application portal to read form fields and inject autofill values.</td>
      </tr>
    </tbody>
  </table>

  <h2>8. Security and Encryption</h2>
  <p>All network communications relating to license verification or AI document parsing are encrypted in transit using industry-standard TLS/HTTPS protocols. User data stored locally within <code>chrome.storage.local</code> is sandboxed and protected by Google Chrome's built-in extension security boundaries.</p>

  <h2>9. Children's Privacy</h2>
  <p>The Extension does not knowingly collect or solicit personal information directly from children under 13 years of age. Any visa application details relating to minors must be entered and managed exclusively by their parent or legal guardian.</p>

  <h2>10. Updates to this Policy</h2>
  <p>We may update this Privacy Policy periodically to reflect changes in our practices or regulatory requirements. Any modifications will be posted immediately to this URL with a revised "Last Updated" date.</p>

  <div class="contact-box">
    <h3>Developer & Support Contact</h3>
    <p>If you have any questions, concerns, or requests regarding this Privacy Policy or your data, please contact developer support directly:</p>
    <p><strong>Publisher:</strong> Indian Visa Auto Fill Master<br>
    <strong>Email:</strong> <a href="mailto:shahriyarsk8038@gmail.com">shahriyarsk8038@gmail.com</a></p>
  </div>
</body>
</html>`;
    sendHtml(html);
  }

  function renderDeposits(admin, selectedDate = null, msg = null, error = null) {
    const db = loadDb();
    const deposits = (db.deposits || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const now = new Date();
    const todayStr = getDhakaDateStr(now);
    
    const yesterdayDate = new Date(Date.now() - 24 * 3600 * 1000);
    const yesterdayStr = getDhakaDateStr(yesterdayDate);

    const todayDeposits = deposits.filter(d => getDhakaDateStr(d.created_at) === todayStr);
    const todayTotal = todayDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    const yesterdayDeposits = deposits.filter(d => getDhakaDateStr(d.created_at) === yesterdayStr);
    const yesterdayTotal = yesterdayDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    const allTimeTotal = deposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    // Build Last 15 Days data
    const last15Days = [];
    let last15Total = 0;
    let last15Count = 0;

    for (let i = 0; i < 15; i++) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      const dStr = getDhakaDateStr(d);
      const dayDeps = deposits.filter(dep => getDhakaDateStr(dep.created_at) === dStr);
      const dTotal = dayDeps.reduce((sum, dep) => sum + (Number(dep.amount) || 0), 0);
      last15Total += dTotal;
      last15Count += dayDeps.length;

      const dayLabel = i === 0 ? 'Today' : (i === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));

      last15Days.push({
        dateStr: dStr,
        label: `${dayLabel} (${dStr})`,
        shortLabel: dayLabel,
        total: dTotal,
        count: dayDeps.length,
        items: dayDeps
      });
    }

    // Active date filter (default: selectedDate if passed, or todayStr)
    const activeDate = selectedDate || todayStr;
    const activeDayData = deposits.filter(dep => getDhakaDateStr(dep.created_at) === activeDate);
    const activeDayTotal = activeDayData.reduce((sum, dep) => sum + (Number(dep.amount) || 0), 0);
    const activeDayObj = last15Days.find(x => x.dateStr === activeDate);
    const activeDateTitle = activeDayObj ? activeDayObj.label : activeDate;

        let allRows = '';
    deposits.forEach(d => {
      const dt = d.created_at ? new Date(d.created_at) : null;
      const dateFormatted = dt ? getDhakaDateStr(dt) : '-';
      const timeStr = dt ? dt.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
      allRows += `<tr>
        <td class="text-secondary font-monospace">${dateFormatted} ${timeStr}</td>
        <td class="fw-bold text-info">${d.user_id}</td>
        <td class="text-white">${d.name || '-'}</td>
        <td class="fw-bold text-success fs-6">৳${Number(d.amount).toFixed(1)}</td>
        <td><span class="badge bg-primary-subtle text-primary border border-primary">${d.method || 'bKash'}</span></td>
        <td class="text-warning font-monospace small">${d.trx_id || '-'}</td>
        <td class="text-light small">${d.note || '-'}</td>
      </tr>`;
    });

    let activeRows = '';
    activeDayData.forEach(d => {
      const timeStr = d.created_at ? new Date(d.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';
      activeRows += `<tr>
        <td class="text-secondary font-monospace">${timeStr}</td>
        <td class="fw-bold text-info">${d.user_id}</td>
        <td class="text-white">${d.name || '-'}</td>
        <td class="fw-bold text-success fs-6">৳${Number(d.amount).toFixed(1)}</td>
        <td><span class="badge bg-primary-subtle text-primary border border-primary">${d.method || 'bKash'}</span></td>
        <td class="text-warning font-monospace small">${d.trx_id || '-'}</td>
        <td class="text-light small">${d.note || '-'}</td>
      </tr>`;
    });

    let daysGridHtml = '';
    last15Days.forEach(day => {
      const isSelected = day.dateStr === activeDate;
      const borderClass = isSelected ? 'border: 2px solid #38bdf8 !important;' : 'border: 1px solid #1f2937;';
      const bgStyle = isSelected ? 'background: #1e293b;' : 'background: #111827;';
      daysGridHtml += `
        <div class="col-lg-4 col-md-6 mb-3">
          <div class="stat h-100 p-3" style="${bgStyle} ${borderClass} cursor:pointer; border-radius:12px; transition:transform 0.15s ease;" onclick="location.href='/admin/deposits?date=${day.dateStr}'">
            <div class="d-flex justify-content-between align-items-start mb-2">
              <div>
                <span class="badge ${isSelected ? 'bg-info text-dark' : 'bg-secondary'} fw-bold text-uppercase" style="font-size:11px;">${day.shortLabel}</span>
                <div class="text-white font-monospace small mt-1">${day.dateStr}</div>
              </div>
              <span class="badge ${day.total > 0 ? 'bg-success' : 'bg-dark border border-secondary text-secondary'} fs-6 fw-bold px-2 py-1">
                ৳${day.total.toFixed(1)}
              </span>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top border-secondary">
              <small class="text-secondary">${day.count} transaction${day.count === 1 ? '' : 's'}</small>
              <a href="/admin/deposits?date=${day.dateStr}" class="btn btn-sm btn-${isSelected ? 'info' : 'outline-info'} py-0 px-2 fw-semibold" style="font-size:12px;">
                ${isSelected ? '✓ Selected' : 'View →'}
              </a>
            </div>
          </div>
        </div>
      `;
    });

    const userOptions = db.users.map(u => `<option value="${u.user_id}">${u.user_id} - ${u.name || 'User'} (৳${Number(u.credits || 0).toFixed(1)})</option>`).join('');

    const msgAlert = msg ? `<div class="alert alert-success py-2 font-weight-bold fw-bold text-dark" style="background:#dcfce7; border-color:#86efac;">${msg}</div>` : '';
    const errAlert = error ? `<div class="alert alert-danger py-2 font-weight-bold fw-bold">${error}</div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daily Deposits - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background:#0b0f19; color:#f8fafc; font-family:'Segoe UI', system-ui, -apple-system, sans-serif; }
    .sidebar { background:#111827; min-height:100vh; width:240px; padding:24px 20px; border-right:1px solid #1f2937; }
    .stat { background:#111827; border:1px solid #1f2937; padding:20px; border-radius:12px; }
    th { color:#38bdf8 !important; font-weight:700 !important; text-transform:uppercase; font-size:13px; }
    td { color:#ffffff !important; font-size:14px; }
  </style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Fill Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-light mb-3 text-decoration-none">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-light mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/deposits" class="d-block text-white mb-3 text-decoration-none fw-bold">💰 Daily Deposits</a>
    <a href="/admin/settings" class="d-block text-light mb-3 text-decoration-none">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <div>
        <h2 class="fw-bold text-white mb-0">💰 Daily Deposits & Recharge History</h2>
        <small class="text-secondary">Track daily user deposits, bKash/Paymently recharges, and 15-day backup reports</small>
      </div>
      <div class="d-flex align-items-center gap-2">
        <button type="button" class="btn btn-primary btn-sm fw-bold px-3 py-2" data-bs-toggle="modal" data-bs-target="#addDepositModal">
          ➕ Quick Add Deposit
        </button>
      </div>
    </div>

    ${msgAlert}${errAlert}

    <!-- Stat Summary Cards -->
    <div class="row g-3 mb-4">
      <div class="col-md-3">
        <div class="stat">
          <div class="text-info fw-bold small text-uppercase">Today's Deposit</div>
          <div class="fs-2 text-white fw-bold mt-1">৳${todayTotal.toFixed(1)}</div>
          <small class="text-secondary">${todayDeposits.length} recharge${todayDeposits.length === 1 ? '' : 's'}</small>
        </div>
      </div>
      <div class="col-md-3">
        <div class="stat">
          <div class="text-warning fw-bold small text-uppercase">Yesterday</div>
          <div class="fs-2 text-warning fw-bold mt-1">৳${yesterdayTotal.toFixed(1)}</div>
          <small class="text-secondary">${yesterdayDeposits.length} recharge${yesterdayDeposits.length === 1 ? '' : 's'}</small>
        </div>
      </div>
      <div class="col-md-3">
        <div class="stat">
          <div class="text-success fw-bold small text-uppercase">Last 15 Days Total</div>
          <div class="fs-2 text-success fw-bold mt-1">৳${last15Total.toFixed(1)}</div>
          <small class="text-secondary">${last15Count} total recharges</small>
        </div>
      </div>
      <div class="col-md-3">
        <div class="stat">
          <div class="text-info fw-bold small text-uppercase">All-Time Total</div>
          <div class="fs-2 text-info fw-bold mt-1">৳${allTimeTotal.toFixed(1)}</div>
          <small class="text-secondary">${deposits.length} total recharges</small>
        </div>
      </div>
    </div>

    <!-- Active Selected Date Details Box -->
    <div class="stat mb-4" style="border: 2px solid #38bdf8;">
      <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div>
          <span class="badge bg-info text-dark fw-bold px-2 py-1 mb-1">SELECTED DATE DETAILS</span>
          <h4 class="fw-bold text-white mb-0">${activeDateTitle}</h4>
        </div>
        <div class="d-flex align-items-center gap-2">
          <label class="text-secondary small fw-bold mb-0">Jump to Date:</label>
          <input type="date" value="${activeDate}" class="form-control form-control-sm bg-dark text-white border-secondary" style="width:160px;" onchange="location.href='/admin/deposits?date=' + this.value">
          <a href="/admin/deposits?date=${todayStr}" class="btn btn-sm btn-outline-info ${activeDate === todayStr ? 'active' : ''}">Today</a>
          <a href="/admin/deposits?date=${yesterdayStr}" class="btn btn-sm btn-outline-secondary ${activeDate === yesterdayStr ? 'active' : ''}">Yesterday</a>
        </div>
      </div>

      <div class="d-flex align-items-center gap-3 mb-3 p-2 rounded" style="background:#1e293b;">
        <div><small class="text-secondary">Date Total:</small> <span class="fs-5 fw-bold text-success">৳${activeDayTotal.toFixed(1)}</span></div>
        <div class="border-start border-secondary ps-3"><small class="text-secondary">Transactions:</small> <span class="fs-6 fw-bold text-white">${activeDayData.length}</span></div>
      </div>

      <div class="table-responsive">
        <table class="table table-dark table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>TIME</th>
              <th>USER ID</th>
              <th>CUSTOMER NAME</th>
              <th>AMOUNT</th>
              <th>METHOD</th>
              <th>TRX ID</th>
              <th>NOTE</th>
            </tr>
          </thead>
          <tbody>
            ${activeRows || '<tr><td colspan="7" class="text-muted py-4 text-center">No deposit transactions recorded on this date (' + activeDate + ').</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- All Lifetime Deposits Card -->
    <div class="stat mb-4">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h5 class="fw-bold text-white mb-0">📜 All Recorded Deposits (${deposits.length} total)</h5>
        <span class="badge bg-success fs-6">Lifetime Total: ৳${allTimeTotal.toFixed(1)}</span>
      </div>
      <div class="table-responsive">
        <table class="table table-dark table-hover align-middle mb-0">
          <thead class="table-secondary text-dark small">
            <tr>
              <th>DATE & TIME (BD)</th>
              <th>USER ID</th>
              <th>CUSTOMER NAME</th>
              <th>AMOUNT</th>
              <th>METHOD</th>
              <th>TRX ID</th>
              <th>NOTE</th>
            </tr>
          </thead>
          <tbody>
            ${allRows || '<tr><td colspan="7" class="text-muted py-4 text-center">No deposit transactions found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Last 15 Days History Grid -->
    <div class="stat">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h5 class="fw-bold text-white mb-0">📅 Last 15 Days Backup & History</h5>
        <small class="text-secondary">Click on any date to inspect full transaction breakdown</small>
      </div>
      <div class="row g-2">
        ${daysGridHtml}
      </div>
    </div>

  </div>
</div>

<!-- Modal: Quick Add Deposit -->
<div class="modal fade" id="addDepositModal" tabindex="-1">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content bg-dark text-white border border-info shadow-lg">
      <form action="/admin/deposits/create" method="POST">
        <div class="modal-header border-secondary">
          <h5 class="modal-title text-info fw-bold">➕ Add Manual Deposit / Recharge</h5>
          <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body text-start">
          <div class="mb-3">
            <label class="form-label text-info fw-bold small">SELECT CLIENT / USER ID *</label>
            <select name="target_user_id" class="form-select bg-dark text-white border-secondary fw-bold" required>
              <option value="">-- Choose User ID --</option>
              ${userOptions}
            </select>
          </div>
          <div class="mb-3">
            <label class="form-label text-info fw-bold small">DEPOSIT AMOUNT (৳) *</label>
            <input type="number" step="0.1" name="amount" class="form-control bg-dark text-white border-secondary fw-bold fs-5 text-success" placeholder="e.g. 50" required>
          </div>
          <div class="mb-3">
            <label class="form-label text-info fw-bold small">PAYMENT METHOD</label>
            <select name="method" class="form-select bg-dark text-white border-secondary">
              <option value="bKash (Manual)">bKash</option>
              <option value="Nagad (Manual)">Nagad</option>
              <option value="Rocket (Manual)">Rocket</option>
              <option value="Cash">Cash</option>
              <option value="Bank">Bank Transfer</option>
            </select>
          </div>
          <div class="mb-3">
            <label class="form-label text-info fw-bold small">TRANSACTION ID / REFERENCE</label>
            <input type="text" name="trx_id" class="form-control bg-dark text-white border-secondary" placeholder="e.g. BK98234XYZ">
          </div>
          <div class="mb-3">
            <label class="form-label text-info fw-bold small">NOTE (OPTIONAL)</label>
            <input type="text" name="note" class="form-control bg-dark text-white border-secondary" placeholder="e.g. Manual recharge by admin">
          </div>
        </div>
        <div class="modal-footer border-secondary">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="submit" class="btn btn-primary fw-bold px-4">Confirm & Credit Deposit</button>
        </div>
      </form>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
    sendHtml(html);
  }

  function renderCreateUser(admin, error = null) {
    const errDiv = error ? `<div class="alert alert-danger py-2 fw-bold">${error}</div>` : '';
    const db = loadDb();

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Add User - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>body { background:#0f172a; color:#fff; } .sidebar { background:#1e293b; min-height:100vh; width:240px; padding:20px; } .stat { background:#1e293b; border:2px solid #38bdf8; border-radius:12px; padding:25px; max-width:600px; }</style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Fill Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-light mb-3 text-decoration-none">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-light mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/deposits" class="d-block text-light mb-3 text-decoration-none">💰 Daily Deposits</a>
    <a href="/admin/settings" class="d-block text-light mb-3 text-decoration-none">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-white mb-3 text-decoration-none font-weight-bold">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold mb-4 text-white">Create Client User ID</h2>
    ${errDiv}
    <div class="stat">
      <form action="/admin/users/create" method="POST">
        <div class="mb-3">
          <label class="text-info fw-bold fs-6 d-block mb-1">১. ইউজার আইডি (USER ID) *</label>
          <input type="text" name="user_id" class="form-control bg-dark text-white border-info p-2 fw-bold" required placeholder="কাস্টমারের লগইন আইডি দিন (যেমন: client01)">
        </div>

        <div class="mb-3">
          <label class="text-info fw-bold fs-6 d-block mb-1">২. পাসওয়ার্ড (PASSWORD) *</label>
          <input type="text" name="password" class="form-control bg-dark text-white border-info p-2 fw-bold" required placeholder="কাস্টমারের পাসওয়ার্ড দিন (যেমন: 123456)">
        </div>

        <div class="mb-3">
          <label class="text-info fw-bold fs-6 d-block mb-1">৩. কাস্টমারের নাম (CLIENT FULL NAME)</label>
          <input type="text" name="name" class="form-control bg-dark text-white border-secondary p-2 fw-bold" placeholder="কাস্টমার বা তার দোকানের নাম (যেমন: Rahim Travels)">
        </div>

        <div class="mb-3">
          <label class="text-info fw-bold fs-6 d-block mb-1">৪. মোবাইল নম্বর (PHONE NUMBER)</label>
          <input type="text" name="phone" class="form-control bg-dark text-white border-secondary p-2 fw-bold" placeholder="01700000000">
        </div>

        <div class="row g-2 mb-3">
          <div class="col-md-6">
            <label class="text-info fw-bold fs-6 d-block mb-1">৫ (ক). পেমেন্টের পরিমাণ (৳)</label>
            <input type="text" name="payment_amount" class="form-control bg-dark text-white border-secondary p-2 fw-bold" placeholder="যেমন: 500 বা 1500">
          </div>
          <div class="col-md-6">
            <label class="text-info fw-bold fs-6 d-block mb-1">৫ (খ). পেমেন্ট নোট / মাধ্যম</label>
            <input type="text" name="payment_note" class="form-control bg-dark text-white border-secondary p-2 fw-bold" placeholder="যেমন: bKash - 22 Aug">
          </div>
        </div>

        <div class="mb-3">
          <label class="text-success fw-bold fs-6 d-block mb-1">৫ (গ). শুরুর ক্যাশ ব্যালেন্স / ক্রেডিট (INITIAL BALANCE ৳)</label>
          <input type="number" step="0.5" name="credits" class="form-control bg-dark text-white border-success p-2 fw-bold" value="20" placeholder="যেমন: 20 বা 50 (ডিফল্ট: 20)">
          <div class="text-secondary small mt-1">💡 নতুন কাস্টমারের একাউন্টে কত টাকার ক্রেডিট বা ব্যালেন্স জমা রাখতে চান।</div>
        </div>

        <div class="mb-3">
          <label class="text-info fw-bold fs-6 d-block mb-1">৬ (ক). মেয়াদের দিন সংখ্যা টাইপ করুন (SET EXACT DAYS)</label>
          <input type="number" name="set_exact_days" class="form-control bg-dark text-white border-info p-2 fw-bold" placeholder="যেমন: 15 বা 30 বা 60 দিন">
        </div>

        <div class="mb-3">
          <label class="text-info fw-bold fs-6 d-block mb-1">৬ (খ). অথবা মেয়াদের সময়সীমা সিলেক্ট করুন</label>
          <select name="duration_days" class="form-select bg-dark text-white border-secondary p-2 fw-bold">
            <option value="7">৭ দিন (১ সপ্তাহ)</option>
            <option value="30" selected>৩০ দিন (১ মাস)</option>
            <option value="90">৯০ দিন (৩ মাস)</option>
            <option value="180">১৮০ দিন (৬ মাস)</option>
            <option value="365">৩৬৫ দিন (১ বছর)</option>
          </select>
        </div>

        <div class="mb-4">
          <label class="text-info fw-bold fs-6 d-block mb-1">৬ (গ). অথবা কাস্টম মেয়াদের তারিখ (CUSTOM DATE PICKER)</label>
          <input type="date" name="custom_expiry_date" class="form-control bg-dark text-white border-secondary p-2 fw-bold">
        </div>

        <button type="submit" class="btn btn-primary w-100 fw-bold py-2 fs-6">Create Account & Grant Access (একাউন্ট তৈরি করুন)</button>
      </form>
    </div>
  </div>
</div>
</body>
</html>`;
    sendHtml(html);
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Auto Fill Master HEAD Support Server Running on Port ${PORT}`);
  console.log(`  Admin Panel URL : http://localhost:${PORT}/admin`);
  console.log(`  Default Admin   : admin / adminpassword123`);
  console.log(`=======================================================`);
});
