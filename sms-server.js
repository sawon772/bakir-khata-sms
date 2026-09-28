// ============================================
// 📱 বাকির খাতা - SMS Auto Server
// Version: 6.0.0 (Advanced)
// Features:
//   ✅ Due SMS + Payment SMS
//   ✅ SMS Parts Count (Bangla 70 chars)
//   ✅ Balance Check + Deduct
//   ✅ BulkSMS BD Balance Monitor
//   ✅ Duplicate Prevention
// ============================================

const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================
// 🔧 কনফিগারেশন
// ============================================
const CONFIG = {
  API_KEY: process.env.API_KEY || 'uYhBuYuxGyqbipbEEjMu',
  SENDER_ID: process.env.SENDER_ID || '8809617634878',
  SMS_API_URL: 'http://bulksmsbd.net/api/smsapi',
  SMS_RATE: 0.35,
  SERVER_START_TIME: Date.now()
};

// ============================================
// 📁 Service Account Load (Render + Local Support)
// ============================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Render-এর জন্য
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // আপনার কম্পিউটারে লোকালি টেস্ট করার জন্য
  const folderPath = __dirname;
  const files = fs.readdirSync(folderPath);
  const jsonFile = files.find(file => file.includes('firebase-adminsdk') && file.endsWith('.json'));
  serviceAccount = require(path.join(folderPath, jsonFile));
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://bakir-khara-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db = admin.database();
// ============================================
// 📊 SMS Parts Count (Bangla 70 chars/SMS)
// ============================================
function calculateSMSParts(message) {
  if (!message) return 0;
  const length = message.length;
  
  // Bangla (Unicode):
  // 1-70 chars = 1 SMS
  // 71+ chars = multipart (প্রতি part 67 chars, 7 chars header)
  
  if (length <= 70) return 1;
  return 1 + Math.ceil((length - 70) / 67);
}

// ============================================
// 📱 SMS পাঠানোর Function
// ============================================
async function sendSMS(phoneNumber, message) {
  try {
    let cleanNumber = phoneNumber.toString().replace(/[^0-9]/g, '');
    if (!cleanNumber.startsWith('880') && cleanNumber.startsWith('0')) {
      cleanNumber = '88' + cleanNumber;
    }
    if (cleanNumber.length !== 13) {
      return { success: false, error: 'Invalid number' };
    }
    
    const response = await axios.get(CONFIG.SMS_API_URL, {
      params: {
        api_key: CONFIG.API_KEY,
        type: 'text',
        number: cleanNumber,
        senderid: CONFIG.SENDER_ID,
        message: message
      },
      timeout: 10000
    });
    
    if (response.data && response.data.response_code === 202) {
      console.log('✅ SMS sent to', cleanNumber);
      return { success: true };
    } else {
      console.log('❌ SMS failed:', response.data.error_message);
      return { success: false, error: response.data.error_message };
    }
  } catch (error) {
    console.error('❌ SMS Error:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// 💬 SMS Template তৈরি
// ============================================
function buildSMSMessage(template, data) {
  let message = template || '';
  Object.keys(data).forEach(key => {
    const placeholder = new RegExp(`{${key}}`, 'g');
    message = message.replace(placeholder, data[key] || '');
  });
  return message.trim();
}

// ============================================
// 💰 BulkSMS BD Balance Fetch
// ============================================
async function fetchBulkSMSBalance() {
  try {
    const url = `${CONFIG.BALANCE_API_URL}?api_key=${CONFIG.API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data && response.data.balance !== undefined) {
      const balance = parseFloat(response.data.balance) || 0;
      console.log('💰 BulkSMS BD Balance:', balance);
      
      // Firebase এ সেভ করুন
      await db.ref('admin/bulksms_balance').set({
        balance: balance,
        lastChecked: admin.database.ServerValue.TIMESTAMP,
        apiKey: CONFIG.API_KEY.substring(0, 8) + '...',
        senderId: CONFIG.SENDER_ID,
        serverStartTime: CONFIG.SERVER_START_TIME
      });
      
      return balance;
    } else {
      console.log('⚠️ Balance response unexpected:', response.data);
      await db.ref('admin/bulksms_balance').update({
        error: 'Unexpected response',
        lastChecked: admin.database.ServerValue.TIMESTAMP
      });
      return null;
    }
  } catch (error) {
    console.error('❌ Balance fetch error:', error.message);
    await db.ref('admin/bulksms_balance').update({
      error: error.message,
      lastChecked: admin.database.ServerValue.TIMESTAMP
    });
    return null;
  }
}

// ============================================
// 📉 SMS Balance কমান (Parts সহ)
// ============================================
async function deductSMSBalance(userId, smsParts = 1) {
  try {
    const smsBalanceRef = db.ref(`users/${userId}/sms_balance`);
    
    const result = await smsBalanceRef.transaction((currentData) => {
      if (currentData && currentData.balance >= smsParts) {
        currentData.balance = currentData.balance - smsParts;
        currentData.totalUsed = (currentData.totalUsed || 0) + smsParts;
        currentData.lastUsedAt = Date.now();
      }
      return currentData;
    });
    
    if (result.committed) {
      console.log(`📉 ${smsParts}টি SMS ব্যালেন্স থেকে কমানো হয়েছে`);
      console.log(`   নতুন ব্যালেন্স: ${result.snapshot.val().balance}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Balance deduct error:', error.message);
    return false;
  }
}

// ============================================
// 🛑 SMS পাঠানোর আগের Common Check
// ============================================
async function canSendSMS(userId, dataRef, smsParts = 1) {
  try {
    const balanceSnapshot = await db.ref(`users/${userId}/sms_balance/balance`).once('value');
    const currentBalance = balanceSnapshot.val() || 0;
    
    if (currentBalance < smsParts) {
      console.log(`⚠️ Balance কম! দরকার: ${smsParts}, আছে: ${currentBalance}`);
      await dataRef.update({ 
        sms_sent: true, 
        sms_skipped_reason: 'insufficient_balance',
        sms_required: smsParts,
        sms_available: currentBalance
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error('❌ Balance check error:', error.message);
    return false;
  }
}

// ============================================
// 🎯 নতুন Due Entry প্রসেস
// ============================================
async function processNewDue(userId, dueId, dueData, dataRef) {
  try {
    // ১. Already SMS পাঠানো হয়েছে?
    if (dueData.sms_sent === true) return;
    
    // ২. পুরনো entry?
    const dueCreatedTime = new Date(dueData.created_at || dueData.date).getTime();
    if (dueCreatedTime < CONFIG.SERVER_START_TIME - 60000) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'old_entry' });
      return;
    }
    
    console.log('\n🔔 New Due Entry!');
    console.log('   Customer:', dueData.customer_name);
    console.log('   Amount: ৳', dueData.amount);
    
    // ৩. SMS Settings চেক
    const settingsSnapshot = await db.ref(`users/${userId}/sms_settings`).once('value');
    const smsSettings = settingsSnapshot.val();
    if (!smsSettings || !smsSettings.enabled || !smsSettings.autoSend) {
      console.log('⚠️ SMS disabled by user');
      return;
    }
    
    // ৪. কাস্টমার তথ্য খুঁজুন
    const dataSnapshot = await db.ref(`users/${userId}/data`).once('value');
    const allData = dataSnapshot.val();
    if (!allData) return;
    
    let customerMobile = null;
    let customerName = dueData.customer_name;
    
    Object.values(allData).forEach(item => {
      if (item.type === 'customer' && item.customer_id === dueData.customer_id) {
        customerMobile = item.mobile;
        customerName = item.customer_name || customerName;
      }
    });
    
    if (!customerMobile) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'no_mobile' });
      return;
    }
    
    // ৫. Balance Calculation
    let previousBalance = 0;
    Object.values(allData).forEach(item => {
      if (item.customer_id === dueData.customer_id) {
        if (item.type === 'due') previousBalance += item.amount || 0;
        if (item.type === 'payment') previousBalance -= item.amount || 0;
      }
    });
    previousBalance = previousBalance - dueData.amount;
    
    // ৬. Shop Name
    const shopNameSnapshot = await db.ref(`users/${userId}/shop_name`).once('value');
    const shopName = shopNameSnapshot.val() || 'আমার দোকান';
    
    // ৭. SMS Data তৈরি
    const smsData = {
      customerName: customerName,
      previousDue: Math.max(0, previousBalance).toLocaleString('bn-BD'),
      newDue: dueData.amount.toLocaleString('bn-BD'),
      totalDue: Math.max(0, previousBalance + dueData.amount).toLocaleString('bn-BD'),
      dueDate: dueData.due_date || dueData.date || 'শীঘ্রই',
      shopName: shopName
    };
    
    // ৮. Message তৈরি
    const template = smsSettings.template || 
      `নাম: {customerName}\nবাকি: ৳{newDue}\nমোট: ৳{totalDue}\n- {shopName}`;
    const message = buildSMSMessage(template, smsData);
    
    // ৯. SMS Parts Count
    const smsParts = calculateSMSParts(message);
    console.log(`📊 Message: ${message.length} chars = ${smsParts} SMS`);
    
    // ১০. Balance Check (Parts সহ)
    if (!(await canSendSMS(userId, dataRef, smsParts))) return;
    
    // ১১. SMS পাঠান
    console.log('📱 Sending Due SMS to', customerMobile);
    const result = await sendSMS(customerMobile, message);
    
    // ১২. Status Update
    await dataRef.update({
      sms_sent: true,
      sms_sent_at: admin.database.ServerValue.TIMESTAMP,
      sms_status: result.success ? 'sent' : 'failed',
      sms_parts: smsParts
    });
    
    // ১৩. Balance কমান (শুধু সফল হলে)
    if (result.success) await deductSMSBalance(userId, smsParts);
    
    // ১৪. History সেভ
    await db.ref(`users/${userId}/sms_history`).push({
      to: customerMobile,
      customerName: customerName,
      message: message,
      status: result.success ? 'sent' : 'failed',
      type: 'due',
      dueId: dueId,
      smsParts: smsParts,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    
    console.log(result.success ? '✅ Due SMS Complete!' : '❌ Due SMS Failed');
    
  } catch (error) {
    console.error('❌ Due Process error:', error.message);
  }
}

// ============================================
// 💰 নতুন Payment Entry প্রসেস
// ============================================
async function processNewPayment(userId, paymentId, paymentData, dataRef) {
  try {
    // ১. Already পাঠানো?
    if (paymentData.sms_sent === true) return;
    
    // ২. পুরনো entry?
    const paymentCreatedTime = new Date(paymentData.created_at || paymentData.date).getTime();
    if (paymentCreatedTime < CONFIG.SERVER_START_TIME - 60000) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'old_entry' });
      return;
    }
    
    console.log('\n💰 New Payment Entry!');
    console.log('   Customer:', paymentData.customer_name);
    console.log('   Amount: ৳', paymentData.amount);
    
    // ৩. SMS Settings চেক
    const settingsSnapshot = await db.ref(`users/${userId}/sms_settings`).once('value');
    const smsSettings = settingsSnapshot.val();
    if (!smsSettings || !smsSettings.enabled || !smsSettings.autoSend) {
      console.log('⚠️ SMS disabled by user');
      return;
    }
    
    // ৪. কাস্টমার তথ্য
    const dataSnapshot = await db.ref(`users/${userId}/data`).once('value');
    const allData = dataSnapshot.val();
    if (!allData) return;
    
    let customerMobile = null;
    let customerName = paymentData.customer_name;
    
    Object.values(allData).forEach(item => {
      if (item.type === 'customer' && item.customer_id === paymentData.customer_id) {
        customerMobile = item.mobile;
        customerName = item.customer_name || customerName;
      }
    });
    
    if (!customerMobile) {
      await dataRef.update({ sms_sent: true, sms_skipped_reason: 'no_mobile' });
      return;
    }
    
    // ৫. Balance Calculation
    let currentDue = 0;
    Object.values(allData).forEach(item => {
      if (item.customer_id === paymentData.customer_id) {
        if (item.type === 'due') currentDue += item.amount || 0;
        if (item.type === 'payment') currentDue -= item.amount || 0;
      }
    });
    
    const previousDue = currentDue + paymentData.amount;
    
    // ৬. Shop Name
    const shopNameSnapshot = await db.ref(`users/${userId}/shop_name`).once('value');
    const shopName = shopNameSnapshot.val() || 'আমার দোকান';
    
    // ৭. SMS Data
    const smsData = {
      customerName: customerName,
      previousDue: previousDue > 0 ? previousDue.toLocaleString('bn-BD') : '০',
      paidAmount: paymentData.amount.toLocaleString('bn-BD'),
      currentDue: currentDue > 0 ? currentDue.toLocaleString('bn-BD') : '০',
      shopName: shopName
    };
    
    // ৮. Message তৈরি (ছোট Template)
    const paymentTemplate = smsSettings.paymentTemplate || 
      `{customerName}\nপেমেন্ট: ৳{paidAmount}\nবাকি: ৳{currentDue}\n- {shopName}`;
    const message = buildSMSMessage(paymentTemplate, smsData);
    
    // ৯. Parts Count
    const smsParts = calculateSMSParts(message);
    console.log(`📊 Message: ${message.length} chars = ${smsParts} SMS`);
    
    // ১০. Balance Check
    if (!(await canSendSMS(userId, dataRef, smsParts))) return;
    
    // ১১. Send SMS
    console.log('📱 Sending Payment SMS to', customerMobile);
    const result = await sendSMS(customerMobile, message);
    
    // ১২. Status Update
    await dataRef.update({
      sms_sent: true,
      sms_sent_at: admin.database.ServerValue.TIMESTAMP,
      sms_status: result.success ? 'sent' : 'failed',
      sms_parts: smsParts
    });
    
    // ১৩. Balance কমান
    if (result.success) await deductSMSBalance(userId, smsParts);
    
    // ১৪. History
    await db.ref(`users/${userId}/sms_history`).push({
      to: customerMobile,
      customerName: customerName,
      message: message,
      status: result.success ? 'sent' : 'failed',
      type: 'payment',
      paymentId: paymentId,
      smsParts: smsParts,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    
    console.log(result.success ? '✅ Payment SMS Complete!' : '❌ Payment SMS Failed');
    
  } catch (error) {
    console.error('❌ Payment Process error:', error.message);
  }
}

// ============================================
// 🚀 Server Startup
// ============================================
console.log('\n╔════════════════════════════════════════╗');
console.log('║  📱 বাকির খাতা - SMS Server v6.0      ║');
console.log('║  ✅ Due + Payment SMS                  ║');
console.log('║  ✅ SMS Parts Counter (Bangla)         ║');
console.log('║  ✅ Balance Monitor                    ║');
console.log('╚════════════════════════════════════════╝\n');

console.log('🔧 Configuration:');
console.log('   API Key:', CONFIG.API_KEY.substring(0, 8) + '...');
console.log('   Sender ID:', CONFIG.SENDER_ID);
console.log('   Started:', new Date().toLocaleString('bn-BD'));
console.log('');

console.log('🔥 Connecting to Firebase...');
console.log('👀 Watching for NEW Due & Payment entries...\n');

// ============================================
// 👀 Firebase Listener
// ============================================
const usersRef = db.ref('users');

usersRef.on('child_added', (userSnapshot) => {
  const userId = userSnapshot.key;
  console.log('👤 User found:', userId);
  
  const dataRef = db.ref(`users/${userId}/data`);
  
  dataRef.on('child_added', async (dataSnapshot) => {
    const data = dataSnapshot.val();
    
    if (data && data.type === 'due') {
      await processNewDue(userId, dataSnapshot.key, data, dataSnapshot.ref);
    } 
    else if (data && data.type === 'payment') {
      await processNewPayment(userId, dataSnapshot.key, data, dataSnapshot.ref);
    }
  });
  
  console.log('✅ Watching user:', userId);
});

// ============================================
// 🌐 Web Server (Health Check)
// ============================================
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'running', 
      version: '6.0.0',
      features: ['Due SMS', 'Payment SMS', 'Parts Counter', 'Balance Monitor']
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>বাকির খাতা SMS Server v6.0</title>
          <style>
            body { font-family: Arial; padding: 40px; background: #f0fdf4; }
            .card { max-width: 500px; margin: auto; background: white; padding: 30px; border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
            h1 { color: #059669; }
            .status { color: green; font-weight: bold; font-size: 18px; }
            .badge { background: #059669; color: white; padding: 4px 10px; border-radius: 20px; font-size: 12px; margin: 2px; display: inline-block; }
            .info { background: #f0fdf4; padding: 15px; border-radius: 8px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>📱 বাকির খাতা SMS Server</h1>
            <p class="status">✅ Server is running</p>
            <p>
              <span class="badge">v6.0.0</span>
              <span class="badge" style="background:#16a34a">Due SMS</span>
              <span class="badge" style="background:#3b82f6">Payment SMS</span>
              <span class="badge" style="background:#f59e0b">Parts Counter</span>
            </p>
            <div class="info">
              <strong>Port:</strong> 3000<br>
              <strong>Status:</strong> Active<br>
              <strong>Started:</strong> ${new Date(CONFIG.SERVER_START_TIME).toLocaleString('bn-BD')}<br>
              <strong>Balance Check:</strong> Every 5 minutes
            </div>
            <p style="font-size: 13px; color: #6b7280;">অটো SMS সিস্টেম সক্রিয়। Due ও Payment উভয়ের জন্য আলাদা SMS যাবে।</p>
          </div>
        </body>
      </html>
    `);
  }
});

// ============================================
// 🎯 Server Ready + Balance Monitor
// ============================================
server.listen(PORT, () => {
  console.log(`🌐 Web Server: http://localhost:${PORT}`);
  console.log(`💊 Health Check: http://localhost:${PORT}/health\n`);
  
  // 💰 Startup এ Balance চেক
  console.log('💰 Fetching BulkSMS BD Balance...');
  fetchBulkSMSBalance();
  
  // 🔄 প্রতি ৫ মিনিটে Balance আপডেট
  setInterval(fetchBulkSMSBalance, CONFIG.BALANCE_CHECK_INTERVAL);
  console.log('✅ Balance Monitor: প্রতি ৫ মিনিটে আপডেট\n');
  
  console.log('✨ Server ready! Waiting for Due & Payment entries...\n');
  console.log('════════════════════════════════════════\n');
});

// ============================================
// ⚠️ Error Handling
// ============================================
process.on('uncaughtException', (error) => {
  console.error('\n❌ Uncaught Error:', error.message);
});

process.on('unhandledRejection', (error) => {
  console.error('\n❌ Unhandled Rejection:', error);
});

process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down server...');
  console.log('✅ Server closed cleanly\n');
  process.exit(0);
});
