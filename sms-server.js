// ============================================
// 📱 বাকির খাতা - Master Server v8.0.0 (Modular + Push Notification)
// Supports: Due, Payment, Fund-Receive, Fund-Payment, Manual SMS & Push Notification
// ============================================

const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ============================================
// 🔧 CONFIG
// ============================================
const CONFIG = {
  API_KEY: 'uYhBuYuxGyqbipbEEjMu',
  SENDER_ID: '8809617634878',
  SMS_API_URL: 'http://bulksmsbd.net/api/smsapi',
  BALANCE_API_URL: 'http://bulksmsbd.net/api/getBalanceApi',
  SERVER_START_TIME: Date.now(),
  BALANCE_CHECK_INTERVAL: 5 * 60 * 1000, // ৫ মিনিট
  PORT: process.env.PORT || 3000
};

// ============================================
// 🔥 FIREBASE INIT (Environment Variable এর মাধ্যমে)
// ============================================
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase Service Account loaded from Environment Variable');
  } catch (e) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', e.message);
    process.exit(1);
  }
} else {
  try {
    const folder = __dirname;
    const jsonFile = fs.readdirSync(folder).find(f =>
      f.includes('firebase-adminsdk') && f.endsWith('.json')
    );
    if (jsonFile) {
      serviceAccount = require(path.join(folder, jsonFile));
      console.log('✅ Firebase Service Account loaded from local file');
    } else {
      console.error('❌ Service Account JSON not found! Please set FIREBASE_SERVICE_ACCOUNT env variable.');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Error loading Service Account:', e.message);
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://bakir-khara-default-rtdb.asia-southeast1.firebasedatabase.app'
});
const db = admin.database();

// ============================================
// 📊 UTILITIES (সাধারণ হেল্পার ফাংশন)
// ============================================
function calculateSMSParts(msg) {
  if (!msg) return 0;
  const len = msg.length;
  if (len <= 70) return 1;
  return 1 + Math.ceil((len - 70) / 67);
}

function toBn(num) {
  try { return Number(num || 0).toLocaleString('bn-BD'); }
  catch { return String(num || 0); }
}

function buildMessage(template, data) {
  let msg = template || '';
  Object.keys(data).forEach(k => {
    msg = msg.replace(new RegExp(`{${k}}`, 'g'), data[k] ?? '');
  });
  return msg.trim();
}

function cleanPhone(phone) {
  let n = String(phone || '').replace(/[^0-9]/g, '');
  if (!n.startsWith('880') && n.startsWith('0')) n = '88' + n;
  return n;
}

// ============================================
// 🚀 CORE PUSH NOTIFICATION SENDER
// ============================================
async function sendPushNotification(userId, title, body, extraData = {}) {
  try {
    const snap = await db.ref(`users/${userId}/fcm_token`).once('value');
    const fcmToken = snap.val();

    if (!fcmToken) {
      console.log(`⚠️ No FCM token found for user: ${userId}`);
      return false;
    }

    const message = {
      notification: {
        title: title,
        body: body,
        // ❌ icon এখান থেকে সরিয়ে দেওয়া হয়েছে
      },
      data: {
        ...extraData,
        click_action: '/products.html'
      },
      // ✅ webpush কনফিগারেশনে icon যুক্ত করা হলো
      webpush: {
        notification: {
          icon: 'https://bakirkhata.pages.dev/icon-192.png' // আপনার অ্যাপের সম্পূর্ণ আইকন URL দিন
        },
        fcmOptions: {
          link: 'https://bakirkhata.pages.dev/products.html' // ক্লিক করলে যেখানে যাবে
        }
      },
      token: fcmToken
    };

    const response = await admin.messaging().send(message);
    console.log(`🔔 Push Notification Sent to ${userId}:`, response);
    return true;

  } catch (error) {
    console.error(`❌ Push Notification Error for ${userId}:`, error.message);
    if (error.code === 'messaging/registration-token-not-registered') {
      await db.ref(`users/${userId}/fcm_token`).remove();
      console.log(`🗑️ Removed invalid FCM token for user: ${userId}`);
    }
    return false;
  }
}

// ============================================
// 📱 CORE SMS SENDER
// ============================================
async function sendSMS(phone, message) {
  try {
    const cleanNumber = cleanPhone(phone);
    if (cleanNumber.length !== 13) {
      return { success: false, error: 'Invalid number' };
    }
    const res = await axios.get(CONFIG.SMS_API_URL, {
      params: {
        api_key: CONFIG.API_KEY,
        type: 'text',
        number: cleanNumber,
        senderid: CONFIG.SENDER_ID,
        message
      },
      timeout: 10000
    });
    if (res.data && res.data.response_code === 202) {
      console.log('✅ SMS sent →', cleanNumber);
      return { success: true };
    }
    console.log('❌ SMS failed:', res.data?.error_message);
    return { success: false, error: res.data?.error_message || 'Unknown' };
  } catch (e) {
    console.error('❌ SMS Error:', e.message);
    return { success: false, error: e.message };
  }
}

async function deductSMSBalance(userId, parts = 1) {
  try {
    const ref = db.ref(`users/${userId}/sms_balance`);
    const result = await ref.transaction(cur => {
      if (cur && cur.balance >= parts) {
        cur.balance -= parts;
        cur.totalUsed = (cur.totalUsed || 0) + parts;
        cur.lastUsedAt = Date.now();
      }
      return cur;
    });
    if (result.committed) {
      console.log(`📉 ${parts} SMS deducted. New: ${result.snapshot.val().balance}`);
      return true;
    }
    return false;
  } catch (e) {
    console.error('❌ Deduct error:', e.message);
    return false;
  }
}

async function fetchBulkSMSBalance() {
  try {
    const res = await axios.get(`${CONFIG.BALANCE_API_URL}?api_key=${CONFIG.API_KEY}`, { timeout: 10000 });
    if (res.data && res.data.balance !== undefined) {
      const balance = parseFloat(res.data.balance) || 0;
      await db.ref('admin/bulksms_balance').set({
        balance,
        lastChecked: admin.database.ServerValue.TIMESTAMP,
        apiKey: CONFIG.API_KEY.substring(0, 8) + '...',
        senderId: CONFIG.SENDER_ID
      });
      console.log('💰 BulkSMS Balance:', balance);
      return balance;
    }
  } catch (e) { console.error('❌ Balance fetch:', e.message); }
  return null;
}

// ============================================
// 🧩 SHARED SMS HELPERS
// ============================================
async function canSendSMS(userId, dataRef, parts) {
  const snap = await db.ref(`users/${userId}/sms_balance/balance`).once('value');
  const bal = snap.val() || 0;
  if (bal < parts) {
    await dataRef.update({
      sms_sent: true,
      sms_skipped_reason: 'insufficient_balance',
      sms_required: parts,
      sms_available: bal
    });
    return false;
  }
  return true;
}

async function logSMSHistory(userId, payload) {
  await db.ref(`users/${userId}/sms_history`).push(payload);
}

// ============================================
// 📱 MASTER SMS PROCESSOR
// ============================================
async function processSMS(userId, dataId, data, dataRef, cfg) {
  try {
    if (data.sms_sent === true) return;

    const createdTime = new Date(data.created_at || data.date).getTime();
    if (createdTime < CONFIG.SERVER_START_TIME - 60000) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'old_entry' });
      return;
    }

    console.log(`\n🔔 New ${cfg.type} → ${data.customer_name || data.provider_name}`);

    const sSnap = await db.ref(`users/${userId}/sms_settings`).once('value');
    const s = sSnap.val() || {};

    if (!s.enabled) { console.log('⚠️ SMS globally disabled'); return; }
    if (s.autoSend === false) { console.log('⚠️ Master autoSend off'); return; }
    if (s[cfg.settingsKey] === false) {
      console.log(`⚠️ ${cfg.type} SMS disabled`);
      return;
    }

    const dSnap = await db.ref(`users/${userId}/data`).once('value');
    const allData = dSnap.val() || {};
    const list = Object.values(allData);

    let mobile = null;
    let name = data.customer_name || data.provider_name || '';

    if (cfg.party === 'customer') {
      list.forEach(it => {
        if (it.type === 'customer' && it.customer_id === data.customer_id) {
          mobile = it.mobile;
          name = it.customer_name || name;
        }
      });
    } else if (cfg.party === 'provider') {
      list.forEach(it => {
        if (it.type === 'fund-provider' && it.provider_id === data.provider_id) {
          mobile = it.mobile;
          name = it.provider_name || name;
        }
      });
    }

    if (!mobile) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'no_mobile' });
      return;
    }

    const shopSnap = await db.ref(`users/${userId}/shop_name`).once('value');
    const shopName = shopSnap.val() || 'আমার দোকান';

    const vars = await cfg.dataBuilder({ allData: list, data, customerName: name, shopName });
    const template = s[cfg.templateKey] || cfg.defaultTemplate;
    const message = buildMessage(template, vars);
    const parts = calculateSMSParts(message);

    if (!message) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'empty_message' });
      return;
    }

    if (!(await canSendSMS(userId, dataRef, parts))) return;

    const result = await sendSMS(mobile, message);

    await dataRef.update({
      sms_sent: true,
      sms_sent_at: admin.database.ServerValue.TIMESTAMP,
      sms_status: result.success ? 'sent' : 'failed',
      sms_parts: parts,
      sms_type: cfg.type
    });

    if (result.success) await deductSMSBalance(userId, parts);

    await logSMSHistory(userId, {
      to: cleanPhone(mobile),
      customerName: name,
      message,
      status: result.success ? 'sent' : 'failed',
      type: cfg.type,
      smsParts: parts,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });

    console.log(result.success ? `✅ ${cfg.type} SMS Complete` : `❌ ${cfg.type} SMS Failed`);
  } catch (e) {
    console.error(`❌ ${cfg.type} process error:`, e.message);
  }
}

// ============================================
// 🎯 SMS CONFIGS
// ============================================
const SMS_CONFIGS = {
  'due': { /* ... আপনার আগের Due SMS কনফিগ ... */ 
    type: 'due', party: 'customer', templateKey: 'template', settingsKey: 'sendOnDue',
    defaultTemplate: `নাম: {customerName}\nবাকি: ৳{newDue}\nমোট: ৳{totalDue}\n- {shopName}`,
    dataBuilder: async ({ allData, data, customerName, shopName }) => {
      let prev = 0;
      allData.forEach(it => {
        if (it.customer_id === data.customer_id) {
          if (it.type === 'due') prev += it.amount || 0;
          if (it.type === 'payment') prev -= it.amount || 0;
        }
      });
      const previous = prev - (data.amount || 0);
      return { customerName, previousDue: toBn(Math.max(0, previous)), newDue: toBn(data.amount), totalDue: toBn(Math.max(0, previous + data.amount)), dueDate: data.due_date || data.date || 'শীঘ্রই', shopName };
    }
  },
  'payment': { /* ... আপনার আগের Payment SMS কনফিগ ... */ 
    type: 'payment', party: 'customer', templateKey: 'paymentTemplate', settingsKey: 'sendOnPayment',
    defaultTemplate: `{customerName}\nপেমেন্ট: ৳{paidAmount}\nবাকি: ৳{currentDue}\n- {shopName}`,
    dataBuilder: async ({ allData, data, customerName, shopName }) => {
      let cur = 0;
      allData.forEach(it => {
        if (it.customer_id === data.customer_id) {
          if (it.type === 'due') cur += it.amount || 0;
          if (it.type === 'payment') cur -= it.amount || 0;
        }
      });
      return { customerName, previousDue: toBn(Math.max(0, cur + (data.amount || 0))), paidAmount: toBn(data.amount), currentDue: toBn(Math.max(0, cur)), shopName };
    }
  },
  'fund-receive': { /* ... আপনার আগের Fund Receive SMS কনফিগ ... */ 
    type: 'fund-receive', party: 'provider', templateKey: 'fundReceiveTemplate', settingsKey: 'sendOnFundReceive',
    defaultTemplate: `{providerName}\nফান্ড গ্রহণ: ৳{amount}\nমোট ফান্ড: ৳{balance}\n- {shopName}`,
    dataBuilder: async ({ allData, data, customerName, shopName }) => {
      let balance = 0;
      allData.forEach(it => {
        if (it.provider_id === data.provider_id) {
          if (it.type === 'fund-receive') balance += it.amount || 0;
          if (it.type === 'fund-payment') balance -= it.amount || 0;
        }
      });
      return { providerName: customerName, amount: toBn(data.amount), balance: toBn(Math.max(0, balance)), date: data.date || '', shopName };
    }
  },
  'fund-payment': { /* ... আপনার আগের Fund Payment SMS কনফিগ ... */ 
    type: 'fund-payment', party: 'provider', templateKey: 'fundPaymentTemplate', settingsKey: 'sendOnFundPayment',
    defaultTemplate: `{providerName}\nফান্ড পরিশোধ: ৳{amount}\nঅবশিষ্ট: ৳{balance}\n- {shopName}`,
    dataBuilder: async ({ allData, data, customerName, shopName }) => {
      let balance = 0;
      allData.forEach(it => {
        if (it.provider_id === data.provider_id) {
          if (it.type === 'fund-receive') balance += it.amount || 0;
          if (it.type === 'fund-payment') balance -= it.amount || 0;
        }
      });
      return { providerName: customerName, amount: toBn(data.amount), balance: toBn(Math.max(0, balance)), date: data.date || '', shopName };
    }
  }
};

// ============================================
// 📱 MANUAL SMS QUEUE PROCESSOR
// ============================================
async function processManualSMS(userId, queueId, q, qRef) {
  try {
    if (q.status && q.status !== 'pending') return;
    console.log(`\n📱 Manual SMS → ${q.customerName} (${q.mobile})`);

    if (!q.mobile || !q.message) {
      await qRef.update({ status: 'failed', error: 'missing_fields', processedAt: admin.database.ServerValue.TIMESTAMP });
      return;
    }

    const sSnap = await db.ref(`users/${userId}/sms_settings`).once('value');
    const s = sSnap.val() || {};
    if (!s.enabled || s.sendOnManual === false) {
      await qRef.update({ status: 'failed', error: 'sms_disabled', processedAt: admin.database.ServerValue.TIMESTAMP });
      return;
    }

    const clean = cleanPhone(q.mobile);
    if (clean.length !== 13) {
      await qRef.update({ status: 'failed', error: 'invalid_number', processedAt: admin.database.ServerValue.TIMESTAMP });
      return;
    }

    const parts = calculateSMSParts(q.message);
    const balSnap = await db.ref(`users/${userId}/sms_balance/balance`).once('value');
    const bal = balSnap.val() || 0;

    if (bal < parts) {
      await qRef.update({ status: 'failed', error: 'insufficient_balance', required: parts, available: bal, processedAt: admin.database.ServerValue.TIMESTAMP });
      return;
    }

    const result = await sendSMS(q.mobile, q.message);
    if (result.success) await deductSMSBalance(userId, parts);

    await qRef.update({
      status: result.success ? 'sent' : 'failed',
      sentAt: admin.database.ServerValue.TIMESTAMP,
      processedAt: admin.database.ServerValue.TIMESTAMP,
      error: result.success ? null : (result.error || 'failed'),
      smsParts: parts
    });

    await logSMSHistory(userId, {
      to: clean, customerName: q.customerName || '', customerId: q.customerId || '', message: q.message,
      status: result.success ? 'sent' : 'failed', type: 'manual', smsParts: parts, timestamp: admin.database.ServerValue.TIMESTAMP
    });

    console.log(result.success ? '✅ Manual SMS Sent' : '❌ Manual SMS Failed');
  } catch (e) {
    console.error('❌ Manual SMS error:', e.message);
    try { await qRef.update({ status: 'failed', error: e.message }); } catch {}
  }
}

// ============================================
// 🔔 NEW ORDER PUSH NOTIFICATION
// ============================================
async function processOrderNotification(orderId, orderData) {
  try {
    if (orderData.notification_sent === true) return;
    
    // যদি অর্ডার বাতিল করা থাকে, নোটিফিকেশন যাবে না
    if (orderData.status === 'cancelled') return;

    const ownerUid = orderData.owner_uid;
    if (!ownerUid) return;

    console.log(`\n🛒 New Order (#${orderId.slice(-6)}) for user: ${ownerUid}`);

    const title = '🛒 নতুন অর্ডার এসেছে!';
    const body = `${orderData.customer_name || 'কাস্টমার'} — ৳${toBn(orderData.total_price)} (${orderData.quantity}টি)`;

    const success = await sendPushNotification(ownerUid, title, body, {
      orderId: orderId,
      type: 'new_order'
    });

    if (success) {
      await db.ref(`orders/${orderId}`).update({
        notification_sent: true,
        notification_sent_at: admin.database.ServerValue.TIMESTAMP
      });
    }

  } catch (e) {
    console.error(`❌ Order Notification Error (${orderId}):`, e.message);
  }
}

// ============================================
// 👀 MASTER LISTENERS (এখানেই সব লিসেনার সেট হবে)
// ============================================
const usersRef = db.ref('users');

// ১. ইউজার রেজিস্ট্রেশন লিসেনার
usersRef.on('child_added', (userSnap) => {
  const userId = userSnap.key;
  console.log('👤 Watching user:', userId);

  // ট্রানজেকশন ডাটা (Due, Payment, Fund)
  db.ref(`users/${userId}/data`).on('child_added', async (snap) => {
    const d = snap.val();
    if (!d || !d.type) return;
    const cfg = SMS_CONFIGS[d.type];
    if (cfg) await processSMS(userId, snap.key, d, snap.ref, cfg);
  });

  // ম্যানুয়াল SMS কিউ
  db.ref(`users/${userId}/sms_queue`).on('child_added', async (snap) => {
    const q = snap.val();
    if (q && (!q.status || q.status === 'pending')) {
      await processManualSMS(userId, snap.key, q, snap.ref);
    }
  });
});

// ২. নতুন অর্ডার লিসেনার (পুশ নোটিফিকেশনের জন্য)
console.log('👀 Watching orders node for new orders...'); // নতুন লাইন
db.ref('orders').on('child_added', async (snap) => {
  console.log('🔥 Order event fired! Checking data...'); // নতুন লাইন
  const orderData = snap.val();
  
  if (orderData) {
    console.log('📦 Order Data Received:', orderData); // নতুন লাইন
    if (!orderData.owner_uid) {
       console.log('⚠️ Order rejected: owner_uid is missing!');
       return;
    }
    await processOrderNotification(snap.key, orderData);
  } else {
    console.log('⚠️ Order data is empty.');
  }
});

// ============================================
// 🌐 HEALTH SERVER
// ============================================
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      version: '8.0.0',
      features: Object.keys(SMS_CONFIGS).concat(['manual', 'push_notification']),
      uptime: Math.floor((Date.now() - CONFIG.SERVER_START_TIME) / 1000)
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><head><title>Master Server v8</title>
      <style>body{font-family:sans-serif;background:#f0fdf4;padding:40px;text-align:center}
      h1{color:#059669}ul{list-style:none;padding:0}li{background:white;margin:8px auto;padding:12px;
      border-radius:8px;max-width:300px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}</style></head>
      <body>
        <h1>📱 Master Server v8.0.0 ✅</h1>
        <p>SMS + Push Notification</p>
        <ul>
          <li>📝 Due SMS</li><li>💰 Payment SMS</li>
          <li>💵 Fund SMS</li><li>📱 Manual SMS</li>
          <li style="background:#dcfce7; font-weight:bold;">🔔 Push Notification</li>
        </ul>
      </body></html>
    `);
  }
});

server.listen(CONFIG.PORT, async () => {
  console.log(`\n🌐 Server: http://localhost:${CONFIG.PORT}`);
  console.log(`🚀 Master Server v8.0.0 Ready\n`);
  await fetchBulkSMSBalance();
  setInterval(fetchBulkSMSBalance, CONFIG.BALANCE_CHECK_INTERVAL);
});

// Error handlers
process.on('uncaughtException', e => console.error('❌ Uncaught:', e.message));
process.on('unhandledRejection', e => console.error('❌ Unhandled:', e));
process.on('SIGINT', () => { console.log('🛑 Shutdown'); process.exit(0); });
