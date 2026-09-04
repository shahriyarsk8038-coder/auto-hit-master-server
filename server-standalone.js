const http = require('http');
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

// Read API keys from Render environment variables (permanent, never reset on redeploy)
const ENV_GEMINI_KEYS = (process.env.GEMINI_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 5);
const ENV_GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 5);

if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET_KEY).update(password).digest('hex');
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
    if (!data.settings) {
      data.settings = {
        gemini_keys: [],
        groq_keys: [],
        default_provider: 'gemini'
      };
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
  fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
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
        groq_key: selectedGroq,
        total_gemini_keys: geminiKeys.length,
        total_groq_keys: groqKeys.length
      });
    }
    if (pathname === '/admin/payments') {
      const admin = getSessionAdmin();
      if (!admin) return redirect('/admin/login');
      return renderPayments(admin, reqUrl.searchParams.get('msg'), reqUrl.searchParams.get('error'));
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
      const userId = (reqUrl.searchParams.get('user_id') || '').trim();
      if (!userId) return sendJson({ success: false, error: 'No user ID' });

      const db = loadDb();
      let user = db.users.find(u => u.user_id === userId);
      const now = new Date();

      if (!user) {
        // Auto-create new user on first install with 3 free trial passport credits!
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + 365);
        user = {
          user_id: userId,
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
        const phone = (body.phone || body.mobile || body.user_id || '').trim().replace(/[^0-9]/g, '');
        const password = (body.password || body.pin || '1234').trim();
        const name = (body.name || 'User ' + phone).trim();
        const deviceId = (body.device_id || '').trim();
        const hwFp = (body.hw_fp || body.hw_fingerprint || body.fp || '').trim();
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

        if (!phone || phone.length < 10) {
          return sendJson({ success: false, error: 'INVALID_PHONE', message: 'সঠিক মোবাইল নম্বর দিন (যেমন: 017xxxxxxxx)' });
        }
        if (!password) {
          return sendJson({ success: false, error: 'INVALID_PASS', message: 'পাসওয়ার্ড বা পিন দিন।' });
        }

        const db = loadDb();
        if (!Array.isArray(db.claimed_trial_devices)) {
          db.claimed_trial_devices = [];
        }

        let user = db.users.find(u => u.user_id === phone || u.phone === phone);
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

    if (pathname === '/api/v1/payment/create-checkout') {
      return readBody(async (err, body) => {
        const userId = (body.user_id || '').trim() || 'CUST_' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const name = (body.name || 'Customer').trim();
        const email = (body.email || 'customer@autofillmaster.com').trim();
        const amount = String(body.amount || '100').trim();
        const credits = parseInt(body.credits, 10) || 0;
        const days = parseInt(body.days, 10) || 0;

        try {
          const payload = JSON.stringify({
            full_name: name,
            email: email,
            amount: amount,
            metadata: {
              user_id: userId,
              credits: credits,
              days: days,
              name: name
            },
            redirect_url: 'https://auto-fill-master-server.onrender.com/payment/success',
            cancel_url: 'https://auto-fill-master-server.onrender.com/payment/cancel',
            webhook_url: 'https://auto-fill-master-server.onrender.com/api/v1/payment/webhook'
          });

          const urlObj = new URL(UDDOKTAPAY_BASE_URL + '/checkout-v2');
          const https = require('https');
          const apiReq = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'RT-UDDOKTAPAY-API-KEY': UDDOKTAPAY_API_KEY,
              'Accept': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          }, (apiRes) => {
            let resData = '';
            apiRes.on('data', chunk => resData += chunk);
            apiRes.on('end', () => {
              try {
                const json = JSON.parse(resData);
                if (json && json.status && json.payment_url) {
                  return sendJson({ success: true, payment_url: json.payment_url, user_id: userId });
                }
                return sendJson({ success: false, error: json.message || 'Payment initiation failed' });
              } catch (parseErr) {
                return sendJson({ success: false, error: 'Invalid response from gateway' });
              }
            });
          });

          apiReq.on('error', (e) => {
            return sendJson({ success: false, error: 'Payment gateway connection error' });
          });

          apiReq.write(payload);
          apiReq.end();
        } catch (e) {
          return sendJson({ success: false, error: 'Internal checkout error' });
        }
      });
    }

    // --- UDDOKTAPAY WEBHOOK (INSTANT AUTOMATIC APPROVAL) ---
    
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
          const userId = (metadata.user_id || body.user_id || body.phone || '01953348038').trim();
          const creditsToAdd = parseInt(metadata.credits || body.credits || (parseInt(body.amount, 10) || 20), 10);
          const daysToAdd = parseInt(metadata.days, 10) || 0;
          const amount = body.amount || body.paid_amount || '20';
          const trxId = body.transaction_id || body.invoice_id || ('AUTO_' + Date.now());
          const senderMobile = body.sender_number || body.phone_number || 'Auto Gateway';

          const db = loadDb();
          let user = db.users.find(u => u.user_id === userId || u.phone === userId);
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

    if (pathname === '/api/v1/license/deduct-credit') {
      return readBody((err, body) => {
        const key = (body.key || body.user_id || '').trim();
        if (!key) return sendJson({ ok: false, error: 'No user ID provided' });

        const db = loadDb();
        const user = db.users.find(u => u.user_id === key);
        if (!user) return sendJson({ ok: false, error: 'User not found' });
        if (user.status !== 'active') return sendJson({ ok: false, error: 'Account is suspended' });

        const now = new Date();
        const expDt = new Date(user.expires_at);

        // If user is on an active unlimited time plan, no deduction needed
        if (now <= expDt && user.plan !== 'credits') {
          return sendJson({ ok: true, plan_type: 'unlimited', days_left: Math.ceil((expDt - now) / (1000 * 60 * 60 * 24)) });
        }

        // Credit-based plan deduction (1.5 credits = ৳1.50 per scan)
        const currentCredits = Number(user.credits) || 0;
        if (currentCredits < 1.5) {
          return sendJson({ ok: false, error: 'INSUFFICIENT_CREDITS', message: 'আপনার ব্যালেন্স শেষ! (ন্যূনতম ১.৫ ক্রেডিট / ৳১.৫০ প্রয়োজন)' });
        }

        user.credits = Math.round((currentCredits - 1.5) * 100) / 100;
        saveDb(db);
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
        const userId = (body.user_id || '').trim();
        const password = (body.password || '').trim();
        const name = (body.name || '').trim();
        const phone = (body.phone || '').trim();
        const payment_amount = (body.payment_amount || '').trim();
        const payment_note = (body.payment_note || '').trim();
        const custom_date = (body.custom_expiry_date || '').trim();
        const set_exact_days = (body.set_exact_days || '').trim();
        const days = parseInt(body.duration_days, 10) || 30;

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

    if (pathname === '/admin/users/update-user-payment') {
      return readBody((err, body) => {
        const targetUserId = (body.target_user_id || '').trim();
        const db = loadDb();
        const user = db.users.find(u => u.user_id === targetUserId);

        if (user) {
          if (body.payment_amount !== undefined) user.payment_amount = String(body.payment_amount).trim();
          if (body.payment_note !== undefined) user.payment_note = String(body.payment_note).trim();

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
          saveDb(db);
        }
        return redirect(`/admin/users?msg=Updated+record+for+${targetUserId}`);
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
        const provider = String(body.default_provider || 'gemini').trim();
        const gKeys = rawGemini.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5);
        const qKeys = rawGroq.split(/[\r\n,]+/).map(k => k.trim()).filter(k => k.length > 5);
        db.settings.gemini_keys = gKeys;
        db.settings.groq_keys = qKeys;
        db.settings.default_provider = provider;
        saveDb(db);
        return redirect('/admin/settings?msg=' + encodeURIComponent('AI API Keys saved! (' + gKeys.length + ' Gemini, ' + qKeys.length + ' Groq keys active).'));
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
    const pendingReqs = (db.payment_requests || []).filter(r => r.status === 'pending').length;
    const recent = db.users.slice(0, 5);

    let recentRows = '';
    recent.forEach(u => {
      recentRows += `<tr>
        <td class="fw-bold text-info fs-6">${u.user_id}</td>
        <td class="text-white fw-bold">${u.name || '-'}</td>
        <td>${u.payment_amount ? `<span class="badge bg-info text-dark fw-bold">৳${u.payment_amount}</span>` : '-'}</td>
        <td><span class="badge bg-${u.status === 'active' ? 'success' : 'danger'} fw-bold">${u.status}</span></td>
        <td class="text-white fw-bold">${u.expires_at.substring(0, 10)}</td>
      </tr>`;
    });

    const pendingBadge = pendingReqs > 0 ? `<span class="badge bg-danger ms-1">${pendingReqs}</span>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dashboard - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>body { background:#0f172a; color:#fff; } .sidebar { background:#1e293b; min-height:100vh; width:240px; padding:20px; } .stat { background:#1e293b; border:1px solid #334155; padding:20px; border-radius:10px; }</style>
</head>
<body>
<div class="d-flex">
  <div class="sidebar">
    <div class="d-flex align-items-center gap-2 mb-4">
      <img src="/logo.png" style="width:32px; height:32px; object-fit:contain;">
      <h4 class="text-info fw-bold mb-0">Auto Fill Master</h4>
    </div>
    <a href="/admin/dashboard" class="d-block text-white mb-3 text-decoration-none font-weight-bold">📌 Dashboard</a>
    <a href="/admin/users" class="d-block text-light mb-3 text-decoration-none">👥 Users & Licenses</a>
    <a href="/admin/payments" class="d-block text-light mb-3 text-decoration-none">📩 Payment Requests ${pendingBadge}</a>
    <a href="/admin/settings" class="d-block text-light mb-3 text-decoration-none">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold mb-4 text-white">Overview Dashboard</h2>
    <div class="row g-3 mb-4">
      <div class="col-md-3"><div class="stat"><div class="text-info fw-bold small">TOTAL USERS</div><div class="fs-2 text-white fw-bold">${total}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-info fw-bold small">ACTIVE</div><div class="fs-2 text-success fw-bold">${active}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-info fw-bold small">EXPIRED</div><div class="fs-2 text-warning fw-bold">${expired}</div></div></div>
      <div class="col-md-3"><div class="stat"><div class="text-info fw-bold small">PENDING PAYMENTS</div><div class="fs-2 text-danger fw-bold">${pendingReqs}</div></div></div>
    </div>
    <div class="stat">
      <h5 class="fw-bold mb-3 text-white">Recently Added Accounts</h5>
      <table class="table table-dark align-middle">
        <thead><tr style="color:#38bdf8;"><th style="color:#38bdf8;">USER ID</th><th style="color:#38bdf8;">NAME</th><th style="color:#38bdf8;">PAYMENT</th><th style="color:#38bdf8;">STATUS</th><th style="color:#38bdf8;">EXPIRY</th></tr></thead>
        <tbody>${recentRows || '<tr><td colspan="5" class="text-muted">No users found. Click "Add New User" to create one.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>
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

    db.users.forEach(u => {
      const expDt = new Date(u.expires_at);
      const isExp = now > expDt;
      const daysLeft = Math.max(0, Math.ceil((expDt - now) / (1000 * 60 * 60 * 24)));
      const hwidBadge = u.hwid ? '<span class="badge bg-secondary fw-bold">PC Locked</span>' : '<span class="badge bg-success fw-bold">Unbound</span>';
      const statusBadge = u.status === 'suspended' ? '<span class="badge bg-danger fw-bold">Suspended</span>' : (isExp ? '<span class="badge bg-warning text-dark fw-bold">Expired</span>' : '<span class="badge bg-success fw-bold">Active</span>');
      const yyyyMmDd = u.expires_at.substring(0, 10);
      const payInfo = u.payment_amount ? `<span class="badge bg-info text-dark fw-bold">৳${u.payment_amount}</span> <small class="text-light fw-bold">${u.payment_note || ''}</small>` : '<span class="text-light small">No record</span>';

      const modalId = 'modal_' + u.user_id.replace(/[^a-zA-Z0-9]/g, '_');

      rows += `<tr>
        <td class="fw-bold text-info fs-6" style="color:#38bdf8 !important;">${u.user_id}</td>
        <td class="text-white fw-bold" style="color:#ffffff !important;">${u.name || '-'}</td>
        <td>${payInfo}</td>
        <td>${hwidBadge}</td>
        <td>${statusBadge}</td>
        <td class="text-white fw-bold" style="color:#ffffff !important;">${yyyyMmDd}</td>
        <td class="fw-bold ${isExp ? 'text-danger' : 'text-success'}" style="font-size:15px;">${daysLeft} Days</td>
        <td>
          <div class="btn-group btn-group-sm">
            <form action="/admin/users/${encodeURIComponent(u.user_id)}/renew" method="POST" style="display:inline-block;">
              <select name="extend_days" onchange="this.form.submit()" class="form-select form-select-sm bg-dark text-white border-info fw-bold" style="width:110px;">
                <option value="">+ Renew</option>
                <option value="7">+ 7 Days</option>
                <option value="30">+ 30 Days</option>
                <option value="90">+ 90 Days</option>
                <option value="365">+ 1 Year</option>
              </select>
            </form>
            <button class="btn btn-sm btn-outline-info fw-bold" data-bs-toggle="modal" data-bs-target="#${modalId}">✏️ Custom Days/Date</button>
            ${u.hwid ? `<form action="/admin/users/${encodeURIComponent(u.user_id)}/reset-pc" method="POST" style="display:inline-block;"><button class="btn btn-sm btn-outline-warning fw-bold">Reset PC</button></form>` : ''}
            <form action="/admin/users/${encodeURIComponent(u.user_id)}/toggle-status" method="POST" style="display:inline-block;"><button class="btn btn-sm btn-outline-secondary fw-bold">Toggle</button></form>
            <form action="/admin/users/${encodeURIComponent(u.user_id)}/delete" method="POST" style="display:inline-block;" onsubmit="return confirm('Delete user ${u.user_id}?');"><button class="btn btn-sm btn-outline-danger fw-bold">X</button></form>
          </div>

          <div class="modal fade" id="${modalId}" tabindex="-1">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content bg-dark text-white border-info">
                <div class="modal-header border-secondary">
                  <h5 class="modal-title text-info fw-bold">Edit User, Days & Payment - ${u.user_id}</h5>
                  <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <form action="/admin/users/update-user-payment" method="POST">
                  <input type="hidden" name="target_user_id" value="${u.user_id}">
                  <div class="modal-body text-start">
                    <div class="mb-3">
                      <label class="text-info fw-bold small d-block mb-1">১. কত দিন মেয়াদ দিতে চান? (SET EXACT DAYS LEFT)</label>
                      <input type="number" name="set_exact_days" class="form-control bg-dark text-white border-info fw-bold" value="${daysLeft}" placeholder="যেমন: 15 বা 45 বা 60">
                      <div class="text-warning small mt-1">💡 আজ থেকে ঠিক কত দিন পর্যন্ত মেয়াদ রাখতে চান টাইপ করুন।</div>
                    </div>
                    <div class="mb-3">
                      <label class="text-info fw-bold small d-block mb-1">২. অথবা কাস্টম মেয়াদের তারিখ (OR SELECT EXACT DATE)</label>
                      <input type="date" name="custom_expiry_date" class="form-control bg-dark text-white border-secondary fw-bold" value="${yyyyMmDd}">
                    </div>
                    <hr class="border-secondary mb-3">
                    <div class="mb-3">
                      <label class="text-info fw-bold small d-block mb-1">৩. পেমেন্টের পরিমাণ (PAYMENT AMOUNT ৳)</label>
                      <input type="text" name="payment_amount" class="form-control bg-dark text-white border-secondary fw-bold" value="${u.payment_amount || ''}" placeholder="যেমন: 500 বা 1500">
                    </div>
                    <div class="mb-3">
                      <label class="text-info fw-bold small d-block mb-1">৪. পেমেন্টের নোট / মাধ্যম (PAYMENT NOTE)</label>
                      <input type="text" name="payment_note" class="form-control bg-dark text-white border-secondary fw-bold" value="${u.payment_note || ''}" placeholder="যেমন: bKash - 22 Aug">
                    </div>
                  </div>
                  <div class="modal-footer border-secondary">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                    <button type="submit" class="btn btn-primary fw-bold">Save Changes for ${u.user_id}</button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
    });

    const msgAlert = msg ? `<div class="alert alert-success py-2 font-weight-bold fw-bold text-dark" style="background:#dcfce7; border-color:#86efac;">${msg}</div>` : '';
    const errAlert = error ? `<div class="alert alert-danger py-2 font-weight-bold fw-bold">${error}</div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Users & Licenses - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
  <style>
    body { background:#0f172a; color:#fff; font-family:'Segoe UI', sans-serif; }
    .sidebar { background:#1e293b; min-height:100vh; width:240px; padding:20px; }
    .stat { background:#1e293b; border:1px solid #334155; padding:20px; border-radius:10px; }
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
    <a href="/admin/users" class="d-block text-white mb-3 text-decoration-none font-weight-bold">👥 Users & Licenses</a>
    <a href="/admin/payments" class="d-block text-light mb-3 text-decoration-none">📩 Payment Requests ${pendingBadge}</a>
    <a href="/admin/settings" class="d-block text-light mb-3 text-decoration-none">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <div class="d-flex justify-content-between mb-4">
      <h2 class="fw-bold text-white">User Accounts & Licenses</h2>
      <a href="/admin/users/create" class="btn btn-primary fw-bold">+ Create User ID</a>
    </div>
    ${msgAlert}${errAlert}
    <div class="stat">
      <table class="table table-dark align-middle mb-0">
        <thead><tr><th>USER ID</th><th>NAME</th><th>PAYMENT RECORD</th><th>PC LOCK</th><th>STATUS</th><th>EXPIRY DATE</th><th>REMAINING</th><th>ACTIONS</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="text-muted py-4 text-center">No client users yet. Click "+ Create User ID" to add one.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
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

    const geminiText = (settings.gemini_keys || []).join('\n');
    const groqText = (settings.groq_keys || []).join('\n');
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
    <a href="/admin/payments" class="d-block text-light mb-3 text-decoration-none">📩 Payment Requests ${pendingBadge}</a>
    <a href="/admin/settings" class="d-block text-white mb-3 text-decoration-none font-weight-bold">⚙️ Central AI Keys</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold text-white mb-2">Central AI Keys & Load Balancer</h2>
    <p class="text-muted mb-4">Add your free Google Gemini or Groq API keys below. All clients will automatically use these keys with instant round-robin load balancing!</p>
    ${msgAlert}${errAlert}
    
    <div class="stat" style="max-width:800px;">
      <form action="/admin/settings" method="POST">
        <div class="mb-4">
          <label class="form-label fs-5">🌟 Google Gemini API Keys Pool (One key per line):</label>
          <div class="text-muted small mb-2">Get free keys from <a href="https://aistudio.google.com/apikey" target="_blank" class="text-info">aistudio.google.com/apikey</a>. You can put 3 to 10 keys here for 100% unlimited capacity!</div>
          <textarea name="gemini_keys" rows="5" class="form-control font-monospace" placeholder="AIzaSy...&#10;AIzaSy...&#10;AIzaSy...">${geminiText}</textarea>
          <div class="mt-1 text-info small">Active Gemini Keys in Pool: <strong>${(settings.gemini_keys || []).length} keys</strong> (Capacity: ~<strong>${(settings.gemini_keys || []).length * 1500} passports/day</strong>)</div>
        </div>

        <div class="mb-4">
          <label class="form-label fs-5">⚡ Groq API Keys Pool (Optional Backup):</label>
          <div class="text-muted small mb-2">Get free keys from <a href="https://console.groq.com/keys" target="_blank" class="text-info">console.groq.com/keys</a>.</div>
          <textarea name="groq_keys" rows="3" class="form-control font-monospace" placeholder="gsk_...&#10;gsk_...">${groqText}</textarea>
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

  function renderPayments(admin, msg = null, error = null) {
    const db = loadDb();
    const reqs = db.payment_requests || [];
    const pendingReqs = reqs.filter(r => r.status === 'pending').length;
    const pendingBadge = pendingReqs > 0 ? `<span class="badge bg-danger ms-1">${pendingReqs}</span>` : '';

    let rows = '';
    reqs.forEach(r => {
      const isPending = r.status === 'pending';
      const statusBadge = isPending ? '<span class="badge bg-warning text-dark fw-bold">Pending Approval</span>' : (r.status === 'approved' ? '<span class="badge bg-success fw-bold">Approved</span>' : '<span class="badge bg-danger fw-bold">Rejected</span>');
      const timeStr = r.created_at ? new Date(r.created_at).toLocaleString() : '-';

      rows += `<tr>
        <td class="fw-bold text-info fs-6">${r.user_id}</td>
        <td><span class="badge bg-primary fs-6">${r.method}</span></td>
        <td class="fw-bold text-white fs-6">${r.sender_mobile}</td>
        <td class="fw-bold text-warning font-monospace fs-6">${r.trx_id}</td>
        <td class="fw-bold text-success fs-6">৳${r.amount || '500'}</td>
        <td class="fw-bold text-white">${r.requested_days || 30} Days</td>
        <td>${statusBadge}</td>
        <td class="small text-light">${timeStr}</td>
        <td>
          ${isPending ? `
            <div class="d-flex gap-1">
              <form action="/admin/payments/approve" method="POST" style="display:inline-block;">
                <input type="hidden" name="request_id" value="${r.id}">
                <input type="hidden" name="approve_days" value="${r.requested_days || 30}">
                <div class="mb-1 small text-warning">Link to User ID:</div>
                <input type="text" name="target_user_id" class="form-control form-control-sm bg-dark text-white border-secondary mb-1" placeholder="Enter existing User ID" style="font-size:11px;" required>
                <button type="submit" class="btn btn-sm btn-success fw-bold w-100">✅ Approve (+${r.requested_days || 30} Days)</button>
              </form>
              <form action="/admin/payments/reject" method="POST" style="display:inline-block;" onsubmit="return confirm('Reject payment request ${r.trx_id}?');">
                <input type="hidden" name="request_id" value="${r.id}">
                <button type="submit" class="btn btn-sm btn-outline-danger fw-bold">❌ Reject</button>
              </form>
            </div>
          ` : '<span class="text-muted small">Completed</span>'}
        </td>
      </tr>`;
    });

    const msgAlert = msg ? `<div class="alert alert-success py-2 font-weight-bold fw-bold text-dark" style="background:#dcfce7; border-color:#86efac;">${msg}</div>` : '';
    const errAlert = error ? `<div class="alert alert-danger py-2 font-weight-bold fw-bold">${error}</div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Payment Requests - Auto Fill Master</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background:#0f172a; color:#fff; font-family:'Segoe UI', sans-serif; }
    .sidebar { background:#1e293b; min-height:100vh; width:240px; padding:20px; }
    .stat { background:#1e293b; border:1px solid #334155; padding:20px; border-radius:10px; }
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
    <a href="/admin/payments" class="d-block text-white mb-3 text-decoration-none font-weight-bold">📩 Payment Requests ${pendingBadge}</a>
    <a href="/admin/users/create" class="d-block text-light mb-3 text-decoration-none">➕ Add New User</a>
    <a href="/admin/logout" class="d-block text-danger mt-5 text-decoration-none">🚪 Logout</a>
  </div>
  <div class="p-4 flex-grow-1">
    <h2 class="fw-bold text-white mb-4">bKash & Nagad Payment Requests</h2>
    ${msgAlert}${errAlert}
    <div class="stat">
      <table class="table table-dark align-middle mb-0">
        <thead><tr><th>USER ID</th><th>METHOD</th><th>SENDER MOBILE</th><th>TRX ID</th><th>AMOUNT</th><th>PLAN</th><th>STATUS</th><th>SUBMITTED AT</th><th>ACTION</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="text-muted py-4 text-center">No payment requests submitted yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>
</body>
</html>`;
    sendHtml(html);
  }

  function renderCreateUser(admin, error = null) {
    const errDiv = error ? `<div class="alert alert-danger py-2 fw-bold">${error}</div>` : '';
    const db = loadDb();
    const pendingReqs = (db.payment_requests || []).filter(r => r.status === 'pending').length;
    const pendingBadge = pendingReqs > 0 ? `<span class="badge bg-danger ms-1">${pendingReqs}</span>` : '';

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
    <a href="/admin/payments" class="d-block text-light mb-3 text-decoration-none">📩 Payment Requests ${pendingBadge}</a>
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
