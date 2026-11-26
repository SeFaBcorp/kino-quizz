import express from 'express';
import admin from 'firebase-admin';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

const E = process.env;
const missing = ['TELEGRAM_BOT_TOKEN','WEBHOOK_SECRET','SITE_ORIGIN','OWNER_EMAILS','FIREBASE_SERVICE_ACCOUNT'].filter(k => !E[k]);
if (missing.length) { console.error('Missing environment variables:', missing.join(', '), '\nAdd them in Render -> your service -> Environment, then redeploy.'); process.exit(1); }
if (E.WEBHOOK_SECRET.length < 16) { console.error('WEBHOOK_SECRET must be at least 16 characters'); process.exit(1); }
if ((E.AI_PROVIDER || '').toLowerCase() === 'openai' && E.OPENAI_API_KEY && !E.OPENAI_MODEL) { console.error('OPENAI_MODEL is required when AI_PROVIDER=openai'); process.exit(1); }
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
let serviceAccount;
try { serviceAccount = JSON.parse(E.FIREBASE_SERVICE_ACCOUNT.trim()); }
catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account JSON on ONE line, without extra quotes.'); process.exit(1); }
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore(), auth = admin.auth();
const OWNERS = (E.OWNER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const TG = `https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}`;
const mailer = E.SMTP_HOST ? nodemailer.createTransport({ host: E.SMTP_HOST, port: 465, secure: true, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } }) : null;

const tg = (method, body) => fetch(`${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const say = (chat_id, text) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tempPw = () => crypto.randomBytes(9).toString('base64url');   // ~12 chars, random
async function mail(to, subject, text) { if (!mailer) return false; try { await mailer.sendMail({ from: E.SMTP_USER, to, subject, text }); return true; } catch { return false; } }
async function chatOf(uid) { const s = await db.doc('tgLinks/' + uid).get(); return s.exists ? s.data().chatId : null; }
async function adminChats() {
  const snap = await db.collection('users').where('role', 'in', ['admin', 'owner']).get();
  return (await Promise.all(snap.docs.map(d => chatOf(d.id)))).filter(Boolean);
}

/* ---------- HTTP API ---------- */
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': E.SITE_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204); next();
});
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: 'server error' }); });
const needUser = async (req, res, next) => {
  try { req.user = await auth.verifyIdToken((req.headers.authorization || '').replace('Bearer ', '')); next(); }
  catch { res.status(401).json({ error: 'unauthorized' }); }
};
const needOwner = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'owners only' });

app.get('/', (_, res) => res.send('KinoQuiz server OK'));

// Owner or co-owner adds an admin. Owners cannot be created here.
app.post('/api/admins', needUser, needOwner, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (OWNERS.includes(email)) return res.status(400).json({ error: 'That email is already an owner' });
  const pw = tempPw();
  let u, created = false;
  try { u = await auth.getUserByEmail(email); await auth.updateUser(u.uid, { password: pw }); }
  catch { u = await auth.createUser({ email, password: pw }); created = true; }
  await auth.setCustomUserClaims(u.uid, { role: 'admin' });
  const uname = email.split('@')[0].replace(/[^\w.-]/g, '').slice(0, 24);
  await db.doc('users/' + u.uid).set({ email, username: uname, role: 'admin', mustChange: true }, { merge: true });
  await db.doc('usernames/' + uname.toLowerCase()).set({ uid: u.uid }, { merge: true });
  const msg = `KinoQuiz: you were made an admin.\nLogin: ${email}\nTemporary password: ${pw}\nYou must set a new password at first login.`;
  let sent = 'none';
  const chat = await chatOf(u.uid);
  if (chat) { await say(chat, `🔐 <b>You are now a KinoQuiz admin</b>\nLogin: <code>${esc(email)}</code>\nTemporary password: <code>${pw}</code>\nChange it right after you sign in.`); sent = 'telegram'; }
  else if (await mail(email, 'KinoQuiz admin access', msg)) sent = 'email';
  // Fallback: nobody could be messaged, show it ONCE to the owner who is adding them.
  res.json({ ok: true, sent, created, tempPassword: sent === 'none' ? pw : undefined });
}));

app.get('/api/admins', needUser, needOwner, wrap(async (_, res) => {
  const snap = await db.collection('users').where('role', 'in', ['admin', 'owner']).get();
  res.json({ admins: snap.docs.map(d => ({ uid: d.id, email: d.data().email, role: d.data().role })) });
}));

app.post('/api/admins/remove', needUser, needOwner, wrap(async (req, res) => {
  const u = await auth.getUser(String(req.body.uid)); 
  if (OWNERS.includes((u.email || '').toLowerCase()) || u.customClaims?.role === 'owner') return res.status(400).json({ error: 'Owners cannot be removed' });
  await auth.setCustomUserClaims(u.uid, { role: 'user' });
  await db.doc('users/' + u.uid).set({ role: 'user' }, { merge: true });
  res.json({ ok: true });
}));

// Called by the site right after an order is saved (also wakes a sleeping free server).
app.post('/api/order-created', needUser, wrap(async (req, res) => {
  const ref = db.doc('orders/' + String(req.body.orderId)), s = await ref.get();
  if (!s.exists || s.data().uid !== req.user.uid || s.data().notified) return res.json({ ok: true });
  const o = s.data();
  await ref.update({ notified: true });
  const line = `🛍 <b>New order</b>\n${esc(o.name)} · ${esc(o.contact)}\n${esc(o.lines)}\nTotal: <b>$${Number(o.total).toFixed(2)}</b>`;
  for (const c of await adminChats()) await say(c, line);
  const buyerChat = await chatOf(o.uid);
  const thanks = `✅ Thank you! Your KinoQuiz order was received.\n${o.lines}\nTotal: $${Number(o.total).toFixed(2)}`;
  if (buyerChat) await say(buyerChat, thanks.replace(/\n/g, '\n'));
  const buyer = await auth.getUser(o.uid).catch(() => null);
  if (buyer?.email) await mail(buyer.email, 'Your KinoQuiz order', thanks);
  res.json({ ok: true });
}));

/* ---------- Telegram bot (webhook) ---------- */
const hits = new Map();   // chatId -> recent message times (anti-spam, protects your API bill)
const limited = id => { const now = Date.now(), a = (hits.get(id) || []).filter(t => now - t < 60000); a.push(now); hits.set(id, a); if (hits.size > 5000) hits.clear(); return a.length > 8; };
const history = new Map();   // chatId -> last messages for AI context
const PROVIDER = (E.AI_PROVIDER || 'anthropic').toLowerCase();   // 'anthropic' or 'openai'
const AI_KEY = PROVIDER === 'openai' ? E.OPENAI_API_KEY : E.ANTHROPIC_API_KEY;
async function ai(chatId, text) {
  if (!AI_KEY) return null;
  const prods = (await db.collection('products').get()).docs.map(d => d.data()).map(p => `${p.name} - $${p.price} - stock ${p.stock}`).join('\n') || 'no products yet';
  const h = history.get(chatId) || []; h.push({ role: 'user', content: text });
  const system = `You are the support assistant of KinoQuiz (movie quizzes + a small store). Reply in the user's language (Uzbek, Russian or English), briefly and politely. Store products:\n${prods}\nDo not invent prices, policies or order status. If you cannot help, or the user wants a human, or it is about payment/orders/complaints, answer with exactly [[HANDOFF]] and nothing else.`;
  let out;
  if (PROVIDER === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AI_KEY },
      body: JSON.stringify({ model: E.OPENAI_MODEL, max_completion_tokens: 500, messages: [{ role: 'system', content: system }, ...h.slice(-10)] })
    }).then(r => r.json());
    out = r.choices?.[0]?.message?.content?.trim();
    if (!out && r.error) console.error('openai error:', r.error.message);
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: E.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 500, system, messages: h.slice(-10) })
    }).then(r => r.json());
    out = r.content?.[0]?.text?.trim();
    if (!out && r.error) console.error('anthropic error:', r.error.message);
  }
  if (!out) return null;
  h.push({ role: 'assistant', content: out }); history.set(chatId, h.slice(-10)); if (history.size > 2000) history.clear(); return out;
}

app.post('/telegram/' + E.WEBHOOK_SECRET, async (req, res) => {
  res.sendStatus(200);
  const m = req.body.message; if (!m?.text) return;
  const chat = m.chat.id, text = m.text.trim(), from = m.from?.username || '';
  try {
    if (text.startsWith('/start link_')) {                       // account linking
      const code = text.split('link_')[1].toUpperCase(), s = await db.doc('tgCodes/' + code).get();
      if (!s.exists || s.data().exp < Date.now()) return say(chat, '⚠️ This code expired. Press Connect again on the site.');
      await db.doc('tgLinks/' + s.data().uid).set({ chatId: chat, username: from, at: Date.now() });
      await s.ref.delete(); return say(chat, '✅ Telegram connected to your KinoQuiz account.');
    }
    if (text === '/start forgot' || text === '/reset') {         // password recovery by bot
      const q = await db.collection('tgLinks').where('chatId', '==', chat).limit(1).get();
      if (q.empty) { for (const c of await adminChats()) await say(c, `🆘 Password help requested by Telegram @${esc(from)} (not linked).`); return say(chat, 'I could not find a linked account. Connect Telegram in Profile first. Our team has been notified.'); }
      const uid = q.docs[0].id, u = await auth.getUser(uid), pw = tempPw();
      await auth.updateUser(uid, { password: pw }); await db.doc('users/' + uid).set({ mustChange: true }, { merge: true });
      return say(chat, `🔑 Login: <code>${esc(u.email)}</code>\nTemporary password: <code>${pw}</code>\nYou will be asked to set a new password immediately.`);
    }
    if (text.startsWith('/start')) return say(chat, '🎬 Welcome to KinoQuiz support! Ask me anything about quizzes or the store. Use /reset to recover your password.');
    if (limited(chat)) return;
    const answer = await ai(chat, text);
    if (!answer || answer.includes('[[HANDOFF]]')) {
      for (const c of await adminChats()) await say(c, `💬 <b>Support request</b> from @${esc(from)} (chat ${chat}):\n${esc(text)}`);
      return say(chat, 'I passed this to our team, they will reply soon. 🙏');
    }
    say(chat, esc(answer));
  } catch (e) { console.error(e); }
});

app.listen(E.PORT || 3000, async () => {
  console.log('server up');
  if (E.PUBLIC_URL) console.log('webhook:', (await tg('setWebhook', { url: `${E.PUBLIC_URL}/telegram/${E.WEBHOOK_SECRET}` })).description);
});
