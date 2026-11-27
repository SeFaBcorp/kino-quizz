import express from 'express';
import admin from 'firebase-admin';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'url';
import { setupNews } from './news.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const E = process.env;
const missing = ['TELEGRAM_BOT_TOKEN','WEBHOOK_SECRET','OWNER_EMAILS','FIREBASE_SERVICE_ACCOUNT'].filter(k => !E[k]);
if (missing.length) { console.error('Missing environment variables:', missing.join(', '), '\nAdd them in Render -> your service -> Environment, then redeploy.'); process.exit(1); }
if (E.WEBHOOK_SECRET.length < 16) { console.error('WEBHOOK_SECRET must be at least 16 characters'); process.exit(1); }
if ((E.AI_PROVIDER || '').toLowerCase() === 'openai' && E.OPENAI_API_KEY && !E.OPENAI_MODEL) { console.error('OPENAI_MODEL is required when AI_PROVIDER=openai'); process.exit(1); }
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
let serviceAccount;
try { serviceAccount = JSON.parse(E.FIREBASE_SERVICE_ACCOUNT.trim()); }
catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account JSON on ONE line, without extra quotes.'); process.exit(1); }
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
const PUBLIC = (E.PUBLIC_URL || E.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');   // Render sets RENDER_EXTERNAL_URL by itself
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), storageBucket: serviceAccount.project_id + '.firebasestorage.app' });
const db = admin.firestore(), auth = admin.auth(), FV = admin.firestore.FieldValue;
const OWNERS = (E.OWNER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const TG = `https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}`;
// The web API key is public by design (it is also inside public/firebase-config.js).
let WEB_KEY = E.FIREBASE_API_KEY || '';
if (!WEB_KEY) { try { WEB_KEY = (fs.readFileSync(path.join(__dir, 'public', 'firebase-config.js'), 'utf8').match(/apiKey\s*:\s*"([^"]+)"/) || [])[1] || ''; } catch {} }

/* ---------- e-mail ----------
   Render's FREE plan blocks SMTP ports (25/465/587), so the default is an HTTPS e-mail API (Brevo or Resend, port 443).
   Plain SMTP still works on a paid Render plan or any other host. */
const BREVO = E.BREVO_API_KEY || '', RESEND = E.RESEND_API_KEY || '';
const GAS_URL = E.MAIL_WEBHOOK_URL || '', GAS_SECRET = E.MAIL_WEBHOOK_SECRET || '';   // Google Apps Script relay: sends from your own Gmail, no domain needed
const SMTP_PORT = Number(E.SMTP_PORT || 465);
const mailer = E.SMTP_HOST ? nodemailer.createTransport({
  host: E.SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: E.SMTP_USER, pass: (E.SMTP_PASS || '').replace(/\s+/g, '') }   // Gmail app passwords are shown with spaces
}) : null;
const FROM_EMAIL = E.MAIL_FROM || E.SMTP_USER || '';
const FROM_NAME = E.MAIL_FROM_NAME || 'KinoQuiz';
const mailOn = !!(GAS_URL && GAS_SECRET || (BREVO || RESEND) && FROM_EMAIL || mailer);
const mailKind = GAS_URL && GAS_SECRET ? 'gmail-relay' : BREVO && FROM_EMAIL ? 'brevo' : RESEND && FROM_EMAIL ? 'resend' : mailer ? 'smtp' : 'OFF';
async function mail(to, subject, text) {
  if (!mailOn) return false;
  try {
    if (mailKind === 'gmail-relay') {
      const r = await fetch(GAS_URL, { method: 'POST', redirect: 'follow', headers: { 'content-type': 'text/plain' },   // Apps Script answers with a 302; fetch follows it
        body: JSON.stringify({ secret: GAS_SECRET, name: FROM_NAME, to, subject, text }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error('gmail-relay ' + r.status + ' ' + (j.error || ''));
    } else if (mailKind === 'brevo') {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': BREVO, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: FROM_NAME, email: FROM_EMAIL }, to: [{ email: to }], subject, textContent: text }) });
      if (!r.ok) throw new Error('brevo ' + r.status + ' ' + (await r.text()).slice(0, 300));
    } else if (mailKind === 'resend') {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + RESEND, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [to], subject, text }) });
      if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()).slice(0, 300));
    } else await mailer.sendMail({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to, subject, text });
    return true;
  } catch (e) { console.error('mail failed:', e.message); return false; }
}

/* ---------- small helpers ---------- */
const tg = (method, body) => fetch(`${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const say = (chat_id, text) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const lower = s => String(s || '').trim().toLowerCase();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120;
const SAFE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const randomPw = (n = 10) => Array.from({ length: n }, () => SAFE[crypto.randomInt(SAFE.length)]).join('');
const tempPw = () => randomPw(10);
const sha = s => crypto.createHash('sha256').update('kq:' + s).digest('hex');
const sameHash = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const RESERVED = ['admin', 'administrator', 'owner', 'kinoquiz', 'support', 'root', 'moderator', 'system', 'null', 'undefined'];
const USERNAME_RE = /^[A-Za-z0-9._-]{3,24}$/;
const TEMP_TTL = 24 * 3600 * 1000;   // a temporary password stops working after 24 hours

const buckets = new Map();   // simple in-memory rate limiter (one Render instance)
function allow(key, max, windowMs) {
  const now = Date.now(), a = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (a.length >= max) { buckets.set(key, a); return false; }
  a.push(now); buckets.set(key, a); if (buckets.size > 20000) buckets.clear(); return true;
}
const ipOf = req => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

async function chatOf(uid) { const s = await db.doc('tgLinks/' + uid).get(); return s.exists ? s.data().chatId : null; }
async function adminChats() {
  const snap = await db.collection('users').where('role', 'in', ['admin', 'owner']).get();
  return (await Promise.all(snap.docs.map(d => chatOf(d.id)))).filter(Boolean);
}
async function claimUsername(name, uid) {
  const ref = db.doc('usernames/' + name.toLowerCase());
  try { await ref.create({ uid }); return true; }
  catch { const s = await ref.get(); return s.exists && s.data().uid === uid; }
}
async function pickUsername(base, uid) {
  base = String(base || 'user').replace(/[^\w.-]/g, '').slice(0, 20);
  if (base.length < 3) base = (base + 'user').slice(0, 20);
  for (let i = 0; i < 30; i++) {
    const n = i ? base + (1000 + crypto.randomInt(9000)) : base;
    if (RESERVED.includes(n.toLowerCase())) continue;
    if (await claimUsername(n, uid)) return n;
  }
  throw new Error('could not pick a username');
}
// Login name OR e-mail -> Firebase user (or null).
async function findUser(identifier) {
  const id = lower(identifier); if (!id) return null;
  try {
    if (id.includes('@')) return await auth.getUserByEmail(id);
    const s = await db.doc('usernames/' + id).get();
    return s.exists ? await auth.getUser(s.data().uid) : null;
  } catch { return null; }
}
// Gives the person a one-time temporary password; they MUST change it at the next login.
async function issueTemp(uid) {
  const pw = tempPw();
  await auth.updateUser(uid, { password: pw });
  await db.doc('users/' + uid).set({ mustChange: true, tempAt: Date.now() }, { merge: true });
  return pw;
}

/* ---------- owner accounts ---------- */
// Owner = an e-mail listed in OWNER_EMAILS. Owners are created/claimed by the SERVER, never by public sign-up,
// so nobody can register with an owner's address and steal the role.
async function ensureOwner(email) {
  const initial = E.OWNER_INITIAL_PASSWORD && E.OWNER_INITIAL_PASSWORD.length >= 8 ? E.OWNER_INITIAL_PASSWORD : null;
  let u, created = false, usedInitial = false, claimed = false;
  try { u = await auth.getUserByEmail(email); }
  catch {
    usedInitial = !!initial;
    u = await auth.createUser({ email, password: initial || randomPw(24), emailVerified: true }); created = true;
  }
  const ref = db.doc('users/' + u.uid), d = (await ref.get()).data() || {};
  if (!created && d.role !== 'owner' && !d.seeded) {
    // The account existed before the server claimed it (e.g. self-registered on the site, which only gave "member").
    // Reset its password so only the real mailbox owner can get in (via "Forgot password"), and sign out old sessions.
    usedInitial = !!initial;
    await auth.updateUser(u.uid, { password: initial || randomPw(24), emailVerified: true });
    await auth.revokeRefreshTokens(u.uid); claimed = true;
    console.log('owner account claimed:', email, usedInitial ? '-> sign in with OWNER_INITIAL_PASSWORD' : '-> use "Forgot password" to set a password');
  }
  if ((u.customClaims || {}).role !== 'owner') await auth.setCustomUserClaims(u.uid, { ...(u.customClaims || {}), role: 'owner' });
  const username = d.username && await claimUsername(d.username, u.uid) ? d.username : await pickUsername(email.split('@')[0], u.uid);
  const patch = { email, username, role: 'owner', seeded: true };
  if (created || claimed) patch.mustChange = usedInitial;
  await ref.set(patch, { merge: true });
  return { uid: u.uid, created, usedInitial, claimed };
}

/* ---------- HTTP API ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
const ORIGINS = [...(E.SITE_ORIGIN || '').split(','), PUBLIC, 'https://' + serviceAccount.project_id + '.web.app', 'https://' + serviceAccount.project_id + '.firebaseapp.com']
  .map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const o = req.headers.origin;
  res.set({ 'Access-Control-Allow-Origin': o && ORIGINS.includes(o) ? o : ORIGINS[0] || '*', 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204); next();
});
app.use(express.static(path.join(__dir, 'public')));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: 'server error', code: 'server/error' }); });
const needUser = async (req, res, next) => {
  try { req.user = await auth.verifyIdToken((req.headers.authorization || '').replace('Bearer ', '')); next(); }
  catch { res.status(401).json({ error: 'unauthorized', code: 'auth/unauthorized' }); }
};
// The role is read from the database (not from the token), so a promotion works immediately.
const needOwner = async (req, res, next) => {
  const d = (await db.doc('users/' + req.user.uid).get()).data() || {};
  d.role === 'owner' ? next() : res.status(403).json({ error: 'owners only' });
};

app.get('/healthz', (_, res) => res.send('KinoQuiz server OK'));
app.get('/api/status', (_, res) => res.json({ mail: mailOn, bot: true, ai: !!AI_KEY }));

// Public sign-up. The server guarantees BOTH the e-mail and the username are unique.
app.post('/api/register', wrap(async (req, res) => {
  if (!allow('reg:' + ipOf(req), 10, 3600e3)) return res.status(429).json({ code: 'rate', error: 'Too many attempts, try later.' });
  const email = lower(req.body.email), username = String(req.body.username || '').trim(), pw = String(req.body.password || '');
  if (!isEmail(email)) return res.status(400).json({ code: 'bad-email', error: 'Invalid email' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ code: 'bad-username', error: 'Invalid username' });
  if (pw.length < 6 || pw.length > 128) return res.status(400).json({ code: 'bad-password', error: 'Invalid password' });
  if (OWNERS.includes(email)) { await ensureOwner(email).catch(() => {}); return res.status(409).json({ code: 'email-taken', error: 'Email taken' }); }
  if (RESERVED.includes(username.toLowerCase())) return res.status(409).json({ code: 'username-taken', error: 'Username taken' });
  const uref = db.doc('usernames/' + username.toLowerCase());
  if ((await uref.get()).exists) return res.status(409).json({ code: 'username-taken', error: 'Username taken' });
  let u;
  try { u = await auth.createUser({ email, password: pw }); }
  catch (e) { if (e.code === 'auth/email-already-exists') return res.status(409).json({ code: 'email-taken', error: 'Email taken' }); throw e; }
  try { await uref.create({ uid: u.uid }); }
  catch { await auth.deleteUser(u.uid).catch(() => {}); return res.status(409).json({ code: 'username-taken', error: 'Username taken' }); }
  await db.doc('users/' + u.uid).set({ email, username, role: 'user', mustChange: false, createdAt: FV.serverTimestamp() });
  res.json({ ok: true });
}));

// Sign-in by USERNAME: checks the password and hands back the e-mail so the site can sign in with Firebase.
app.post('/api/resolve-login', wrap(async (req, res) => {
  const id = lower(req.body.identifier), pw = String(req.body.password || '');
  if (!allow('rl:' + ipOf(req), 30, 600e3) || !allow('rl:' + id, 10, 600e3)) return res.status(429).json({ code: 'rate', error: 'Too many attempts' });
  const u = await findUser(id), bad = () => res.status(401).json({ code: 'auth/invalid-credential', error: 'Wrong login or password' });
  if (!u || !u.email || !pw || !WEB_KEY) return bad();
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: pw, returnSecureToken: false })
  });
  return r.ok ? res.json({ email: u.email }) : bad();
}));

// Forgot password BY E-MAIL: we e-mail a temporary password. The old password is only replaced if the e-mail was really sent.
app.post('/api/forgot', wrap(async (req, res) => {
  const id = lower(req.body.identifier);
  if (!id) return res.status(400).json({ code: 'bad-request', error: 'Missing e-mail or username' });
  if (!mailOn) return res.status(503).json({ code: 'mail-off', error: 'E-mail is not set up on the server yet.' });
  if (!allow('fg:' + ipOf(req), 8, 3600e3)) return res.status(429).json({ code: 'rate', error: 'Too many attempts' });
  let u = await findUser(id);
  if (!u && OWNERS.includes(id)) { await ensureOwner(id).catch(() => {}); u = await findUser(id); }
  if (u && u.email && allow('fg:' + u.uid, 3, 3600e3)) {
    const d = (await db.doc('users/' + u.uid).get()).data() || {};
    const pw = tempPw();
    const sent = await mail(u.email, 'KinoQuiz: your temporary password',
      `Hello${d.username ? ' ' + d.username : ''},\n\nSomeone (hopefully you) asked to recover access to KinoQuiz.\n\nLogin: ${u.email}  (or your username: ${d.username || '-'})\nTemporary password: ${pw}\n\nSign in with it — KinoQuiz will ask you to choose a new password right away. It stops working after 24 hours.\nIf this was not you, you can ignore this e-mail, but we recommend changing your password.\n\n— KinoQuiz`);
    if (!sent) return res.status(502).json({ code: 'mail-failed', error: 'Could not send the e-mail.' });
    await auth.updateUser(u.uid, { password: pw });
    await db.doc('users/' + u.uid).set({ mustChange: true, tempAt: Date.now() }, { merge: true });
  }
  res.json({ ok: true });   // same answer whether or not the account exists
}));

// Called by the site right after every sign-in: the SERVER decides the role (owner/admin/member).
app.post('/api/session', needUser, wrap(async (req, res) => {
  const u = await auth.getUser(req.user.uid), email = lower(u.email), ref = db.doc('users/' + u.uid);
  let d = (await ref.get()).data();
  if (OWNERS.includes(email) && (!d || d.role !== 'owner')) {
    const r = await ensureOwner(email);
    // A self-registered account with an owner's e-mail was just reset: the real owner must use "Forgot password".
    if (r.claimed) return res.status(403).json({ code: 'owner-claimed', error: 'Owner account was reset. Use Forgot password.' });
    d = (await ref.get()).data();
  }
  if (!d) {   // account without a profile document (older sign-ups)
    d = { email, username: await pickUsername(email.split('@')[0], u.uid), role: 'user', mustChange: false, createdAt: FV.serverTimestamp() };
    await ref.set(d);
  }
  if (d.mustChange === true && d.tempAt && Date.now() - d.tempAt > TEMP_TTL) {
    await auth.updateUser(u.uid, { password: randomPw(24) }); await auth.revokeRefreshTokens(u.uid);
    await ref.set({ mustChange: false }, { merge: true });
    return res.status(403).json({ code: 'temp-expired', error: 'Temporary password expired' });
  }
  if ((u.customClaims || {}).role !== d.role) await auth.setCustomUserClaims(u.uid, { ...(u.customClaims || {}), role: d.role });
  res.json({ role: d.role, username: d.username, email });
}));

// A signed-in member changes their own login name (the e-mail stays as it is).
app.post('/api/username', needUser, wrap(async (req, res) => {
  const uid = req.user.uid, name = String(req.body.username || '').trim();
  if (!allow('un:' + uid, 10, 3600e3)) return res.status(429).json({ code: 'rate', error: 'Too many attempts, try later.' });
  if (!USERNAME_RE.test(name)) return res.status(400).json({ code: 'bad-username', error: 'Invalid username' });
  if (RESERVED.includes(name.toLowerCase())) return res.status(409).json({ code: 'username-taken', error: 'Username taken' });
  const uref = db.doc('users/' + uid), old = String(((await uref.get()).data() || {}).username || '');
  if (old.toLowerCase() === name.toLowerCase()) { await uref.set({ username: name }, { merge: true }); return res.json({ ok: true, username: name }); }   // only the letter case changed
  try { await db.doc('usernames/' + name.toLowerCase()).create({ uid }); }
  catch { return res.status(409).json({ code: 'username-taken', error: 'Username taken' }); }
  await uref.set({ username: name }, { merge: true });
  if (old) { const oref = db.doc('usernames/' + old.toLowerCase()), os = await oref.get(); if (os.exists && os.data().uid === uid) await oref.delete(); }
  res.json({ ok: true, username: name });
}));

// "Read any link": for a web page (IMDb, Pinterest, a blog...) find its preview picture. Only the picture address is returned.
const privateIp = ip => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  const x = ip.toLowerCase(); return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || (x.startsWith('::ffff:') && privateIp(x.slice(7)));
};
async function safeFetch(url) {
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port))) throw new Error('bad url');
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('blocked address');
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; KinoQuizBot/1.0)', accept: 'text/html,image/*;q=0.8,*/*;q=0.5' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).href; continue; }
    return r;
  }
  throw new Error('too many redirects');
}
app.get('/api/media-info', needUser, wrap(async (req, res) => {
  if (!allow('mi:' + req.user.uid, 60, 600e3)) return res.status(429).json({ code: 'rate', error: 'Too many requests' });
  const url = String(req.query.url || '').slice(0, 2000);
  try {
    const r = await safeFetch(url), ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (/^(image|video|audio)\//.test(ct)) { r.body && r.body.cancel().catch(() => {}); return res.json({ image: ct.startsWith('image/') ? url : '', media: url, type: ct }); }
    if (!ct.includes('html') || !r.body) return res.json({});
    let html = ''; const rd = r.body.getReader(), dec = new TextDecoder();
    while (html.length < 600000) { const { done, value } = await rd.read(); if (done) break; html += dec.decode(value, { stream: true }); }
    rd.cancel().catch(() => {});
    let img = '';
    for (const m of html.match(/<meta[^>]+>/gi) || []) {
      const k = /(?:property|name)=["'](og:image(?::secure_url)?|twitter:image(?::src)?)["']/i.exec(m), c = /content=["']([^"']+)["']/i.exec(m);
      if (k && c) { img = c[1].replace(/&amp;/g, '&'); break; }
    }
    if (img) { try { img = new URL(img, url).href; } catch { img = ''; } if (!/^https?:\/\//i.test(img)) img = ''; }
    res.json(img ? { image: img, type: 'image/*' } : {});
  } catch { res.json({}); }
}));

// Owner or co-owner adds an admin. Owners cannot be created here.
app.post('/api/admins', needUser, needOwner, wrap(async (req, res) => {
  const email = lower(req.body.email);
  if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (OWNERS.includes(email)) return res.status(400).json({ error: 'That email is already an owner' });
  let u, created = false, pw = null;
  try { u = await auth.getUserByEmail(email); }
  catch { pw = tempPw(); u = await auth.createUser({ email, password: pw }); created = true; }
  await auth.setCustomUserClaims(u.uid, { ...(u.customClaims || {}), role: 'admin' });
  const ref = db.doc('users/' + u.uid), d = (await ref.get()).data() || {};
  const username = d.username || await pickUsername(email.split('@')[0], u.uid);
  await ref.set({ email, username, role: 'admin', ...(created ? { mustChange: true, tempAt: Date.now() } : {}) }, { merge: true });
  const chat = await chatOf(u.uid);
  const text = created
    ? `KinoQuiz: you were made an admin.\nLogin: ${email}\nTemporary password: ${pw}\nYou must set a new password at first login.`
    : 'KinoQuiz: you are now an admin. Sign in with your usual password.';
  let sent = 'none';
  if (chat) { await say(chat, created ? `🔐 <b>You are now a KinoQuiz admin</b>\nLogin: <code>${esc(email)}</code>\nTemporary password: <code>${pw}</code>\nChange it right after you sign in.` : '🔐 <b>You are now a KinoQuiz admin.</b> Sign in with your usual password.'); sent = 'telegram'; }
  else if (await mail(email, 'KinoQuiz admin access', text)) sent = 'email';
  // Nobody could be messaged: show the temporary password ONCE to the owner who is adding them.
  res.json({ ok: true, sent, created, tempPassword: sent === 'none' && created ? pw : undefined });
}));

app.get('/api/admins', needUser, needOwner, wrap(async (_, res) => {
  const snap = await db.collection('users').where('role', 'in', ['admin', 'owner']).get();
  res.json({ admins: snap.docs.map(d => ({ uid: d.id, email: d.data().email, username: d.data().username, role: d.data().role })) });
}));

app.post('/api/admins/remove', needUser, needOwner, wrap(async (req, res) => {
  const u = await auth.getUser(String(req.body.uid));
  if (OWNERS.includes(lower(u.email)) || u.customClaims?.role === 'owner') return res.status(400).json({ error: 'Owners cannot be removed' });
  await auth.setCustomUserClaims(u.uid, { ...(u.customClaims || {}), role: 'user' });
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
  if (buyerChat) await say(buyerChat, esc(thanks));
  const buyer = await auth.getUser(o.uid).catch(() => null);
  if (buyer?.email) await mail(buyer.email, 'Your KinoQuiz order', thanks);
  res.json({ ok: true });
}));

/* ---------- orders + payment (card transfer, confirmed inside the Telegram bot) ---------- */
const PAY_CARD = E.PAY_CARD || '', PAY_HOLDER = E.PAY_CARD_HOLDER || '', PAY_NOTE = E.PAY_NOTE || '', USD_UZS = Number(E.USD_TO_UZS || 0);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const orderCode = () => Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
let botUser = E.BOT_USERNAME || '';
async function botName() { if (!botUser) { try { botUser = (await tg('getMe', {})).result?.username || ''; } catch {} } return botUser; }
const money = o => `$${Number(o.total).toFixed(2)}` + (USD_UZS > 0 ? ` ≈ ${Math.round(o.total * USD_UZS).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} UZS` : '');
const PAYT = {
  en: { order: 'Order', total: 'Total', how: '💳 <b>How to pay</b>\nTransfer the total to this card:', after: 'Then send a screenshot of the receipt (as a photo) right here. Our team will confirm it and reply.', wait: 'Our team will send the payment details here shortly.' },
  ru: { order: 'Заказ', total: 'Итого', how: '💳 <b>Как оплатить</b>\nПереведите сумму на эту карту:', after: 'Затем отправьте сюда скриншот чека (фото). Команда проверит и ответит.', wait: 'Команда скоро пришлёт реквизиты для оплаты.' },
  uz: { order: 'Buyurtma', total: 'Jami', how: '💳 <b>To‘lov qilish</b>\nJami summani shu kartaga o‘tkazing:', after: 'So‘ng to‘lov chekining skrinshotini (rasm sifatida) shu yerga yuboring. Jamoamiz tekshirib, javob beradi.', wait: 'Jamoamiz tez orada to‘lov rekvizitlarini shu yerga yuboradi.' }
};
function payInstructions(lang, o) {
  const T = PAYT[lang] || PAYT.en;
  const head = `🛍 <b>${T.order} ${esc(o.code)}</b>\n${esc(o.lines)}\n${T.total}: <b>${esc(money(o))}</b>\n\n`;
  if (!PAY_CARD) return head + T.wait;
  return head + `${T.how}\n<code>${esc(PAY_CARD)}</code>${PAY_HOLDER ? '\n' + esc(PAY_HOLDER) : ''}${PAY_NOTE ? '\n' + esc(PAY_NOTE) : ''}\n\n${T.after}`;
}

// The site sends the cart; the SERVER checks stock, takes the prices from the database, saves the order and notifies everyone.
app.post('/api/place-order', needUser, wrap(async (req, res) => {
  const uid = req.user.uid;
  if (!allow('po:' + uid, 10, 3600e3)) return res.status(429).json({ code: 'rate', error: 'Too many orders, try later.' });
  const name = String(req.body.name || '').trim().slice(0, 60), contact = String(req.body.contact || '').trim().slice(0, 80);
  const lang = ['uz', 'ru'].includes(req.body.lang) ? req.body.lang : 'en';
  const want = new Map();
  for (const it of (Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [])) {
    const id = String(it?.id || ''), q = Math.floor(Number(it?.qty));
    if (id && !id.includes('/') && q >= 1 && q <= 99) want.set(id, (want.get(id) || 0) + q);
  }
  if (!name || !contact || !want.size) return res.status(400).json({ code: 'bad-request', error: 'Missing fields' });
  const id = 'o' + Date.now(), code = orderCode();
  let order;
  try {
    order = await db.runTransaction(async t => {
      const refs = [...want.keys()].map(k => db.doc('products/' + k)), snaps = await t.getAll(...refs), items = [];
      let total = 0;
      snaps.forEach((snap, i) => {
        const q = want.get(refs[i].id);
        if (!snap.exists) throw Object.assign(new Error('not found'), { biz: 'not_found' });
        const p = snap.data(), price = Number(p.price) || 0, stock = Number(p.stock) || 0;
        if (stock < q) throw Object.assign(new Error('stock'), { biz: 'stock', product: p.name });
        items.push({ id: snap.id, name: String(p.name || ''), qty: q, price, left: stock - q }); total += price * q;
      });
      items.forEach(it => t.update(db.doc('products/' + it.id), { stock: it.left }));
      const o = { uid, name, contact, lang, code, status: 'New', pay: 'unpaid', notified: true, createdAt: Date.now(), total: Math.round(total * 100) / 100,
        items: items.map(({ left, ...r }) => r), lines: items.map(i => `${i.name} × ${i.qty}`).join(', ') };
      t.set(db.doc('orders/' + id), o);
      return o;
    });
  } catch (e) {
    if (e.biz === 'stock') return res.status(409).json({ code: 'stock', error: 'Not enough stock', product: e.product });
    if (e.biz === 'not_found') return res.status(404).json({ code: 'not_found', error: 'Product not found' });
    throw e;
  }
  const bn = await botName(), payUrl = bn ? `https://t.me/${bn}?start=pay_${code}` : '';
  res.json({ ok: true, id, code, total: order.total, payUrl, card: !!PAY_CARD });
  // Notifications are best-effort and never block the order.
  try {
    const buyer = await auth.getUser(uid).catch(() => null), buyerChat = await chatOf(uid);
    if (buyerChat) { await db.doc('orders/' + id).update({ chatId: buyerChat }); await say(buyerChat, payInstructions(lang, order)); }
    const note = `🛍 <b>New order ${code}</b>\n${esc(name)} · ${esc(contact)}${buyer?.email ? '\n' + esc(buyer.email) : ''}\n${esc(order.lines)}\nTotal: <b>${esc(money(order))}</b>\n⏳ Waiting for payment` + (buyerChat ? '' : '\n(the customer has not connected Telegram yet, they will pay via the link on the site)');
    for (const c of await adminChats()) await say(c, note);
    if (buyer?.email) await mail(buyer.email, `Your KinoQuiz order ${code}`, `Thank you! We received your order ${code}:\n${order.lines}\nTotal: ${money(order)}\n\n` + (payUrl ? `Pay and send the receipt in Telegram: ${payUrl}\n` : '') + `\n— KinoQuiz`);
  } catch (e) { console.error('order notify failed:', e.message); }
}));

// The customer sends a receipt photo to the bot: forward it to the owners with Confirm / Reject buttons.
async function openOrderFor(chat) {
  const found = new Map();
  for (const d of (await db.collection('orders').where('chatId', '==', chat).get()).docs) found.set(d.id, d);
  for (const l of (await db.collection('tgLinks').where('chatId', '==', chat).get()).docs)
    for (const d of (await db.collection('orders').where('uid', '==', l.id).get()).docs) found.set(d.id, d);
  return [...found.values()].filter(d => ['unpaid', 'rejected'].includes(d.data().pay)).sort((a, b) => b.data().createdAt - a.data().createdAt)[0] || null;
}
async function handleReceipt(m) {
  const chat = m.chat.id, lang = langOf(m);
  if (limited(chat)) return;
  if (!(m.photo || (m.document && /^image\/|pdf/.test(m.document.mime_type || '')))) return;
  const od = await openOrderFor(chat);
  if (!od) return say(chat, tx(lang, 'noOpenOrder'));
  const o = od.data(), ol = o.lang || lang;
  await od.ref.update({ pay: 'review', receiptAt: Date.now(), chatId: chat });
  const cap = `🧾 <b>Payment receipt</b>\nOrder <b>${esc(o.code)}</b> · ${esc(o.name)} · ${esc(o.contact)}\n${esc(o.lines)}\nTotal: <b>${esc(money(o))}</b>`;
  const kb = { inline_keyboard: [[{ text: '✅ Confirm paid', callback_data: 'pay:ok:' + od.id }, { text: '❌ Reject', callback_data: 'pay:no:' + od.id }]] };
  let delivered = 0;
  for (const c of await adminChats()) { const r = await tg('copyMessage', { chat_id: c, from_chat_id: chat, message_id: m.message_id, caption: cap, parse_mode: 'HTML', reply_markup: kb }).catch(() => null); if (r?.ok) delivered++; }
  if (!delivered) console.error('receipt for order', o.code, 'reached NO owner: connect Telegram in Profile on an owner/admin account');
  return say(chat, tx(ol, 'receiptGot'));
}
async function handleCallback(cb) {
  const chat = cb.message?.chat?.id, [ns, act, oid] = String(cb.data || '').split(':');
  const reply = (text, alert) => tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: !!alert }).catch(() => {});
  if (ns !== 'pay' || !oid || !['ok', 'no'].includes(act)) return reply('?');
  if (!(await adminChats()).includes(chat)) return reply('Not allowed', true);
  const ref = db.doc('orders/' + oid), s = await ref.get();
  if (!s.exists) return reply('Order not found', true);
  const o = s.data();
  if (o.pay !== 'review') return reply('Already handled: ' + o.pay, true);
  const buyerChat = o.chatId || await chatOf(o.uid), ol = o.lang || 'en';
  if (act === 'ok') { await ref.update({ pay: 'paid', status: 'Confirmed', paidAt: Date.now() }); if (buyerChat) await say(buyerChat, esc(tx(ol, 'payOk').replace('{code}', o.code))); }
  else { await ref.update({ pay: 'rejected' }); if (buyerChat) await say(buyerChat, esc(tx(ol, 'payNo').replace('{code}', o.code))); }
  await reply(act === 'ok' ? 'Marked as paid ✅' : 'Rejected ❌');
  await tg('editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await say(chat, `${act === 'ok' ? '✅ Paid' : '❌ Rejected'}: order <b>${esc(o.code)}</b> · ${esc(o.name)}`);
}

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
  const system = `You are the support assistant of KinoQuiz (movie quizzes + a small store). Reply in the user's language (Uzbek, Russian or English), briefly and politely. Store products:\n${prods}\nPassword help: tell people to send /forgot to this bot (it asks for their e-mail, sends a code to that e-mail, then gives a temporary password). Payment: customers order on the site, then open the \"Pay in Telegram\" link (it opens this bot), transfer the total by bank card${PAY_CARD ? ' to the card ' + PAY_CARD + (PAY_HOLDER ? ' (' + PAY_HOLDER + ')' : '') : ''} and send a screenshot of the receipt here as a photo; the team confirms it and the bot replies. Never ask for or reveal passwords. Do not invent prices, policies or order status. If you cannot help, or the user wants a human, or it is about payment/orders/complaints, answer with exactly [[HANDOFF]] and nothing else.`;
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

// Automatic, translated movie news (Variety, Deadline, THR, IMDb News, Screen Daily) - see news.js
const news = setupNews({ app, db, needUser, wrap, allow, provider: PROVIDER, key: AI_KEY, model: E.NEWS_AI_MODEL || E.AI_MODEL, openaiModel: E.NEWS_AI_MODEL || E.OPENAI_MODEL, env: E });

// Bot texts (uz / ru / en, picked from the person's Telegram language).
const TX = {
  welcome: { en: '🎬 Welcome to KinoQuiz support! Ask me anything about quizzes or the store.\n\n/forgot — recover your password\n/unlink — disconnect this chat from your account\n/help — this message', ru: '🎬 Добро пожаловать в поддержку KinoQuiz! Спрашивайте о викторинах и магазине.\n\n/forgot — восстановить пароль\n/unlink — отключить этот чат от аккаунта\n/help — эта справка', uz: '🎬 KinoQuiz yordam botiga xush kelibsiz! Viktorinalar va do‘kon haqida so‘rang.\n\n/forgot — parolni tiklash\n/unlink — bu chatni hisobdan uzish\n/help — shu yordam' },
  askEmail: { en: '🔑 Password recovery.\nSend me the <b>e-mail</b> you registered with.\n(/cancel to stop)', ru: '🔑 Восстановление пароля.\nПришлите <b>email</b>, с которым вы регистрировались.\n(/cancel — отмена)', uz: '🔑 Parolni tiklash.\nRo‘yxatdan o‘tgan <b>email</b> manzilingizni yuboring.\n(/cancel — bekor qilish)' },
  badEmail: { en: 'That does not look like an e-mail. Send the e-mail of your account, or /cancel.', ru: 'Это не похоже на email. Пришлите email аккаунта или /cancel.', uz: 'Bu email emasga o‘xshaydi. Hisob emailini yuboring yoki /cancel.' },
  codeSent: { en: '📧 If that e-mail is registered, I sent a 6-digit code to it. Type the code here (valid 10 minutes).', ru: '📧 Если этот email зарегистрирован, я отправил на него 6-значный код. Введите код здесь (действует 10 минут).', uz: '📧 Agar bu email ro‘yxatdan o‘tgan bo‘lsa, unga 6 xonali kod yubordim. Kodni shu yerga yozing (10 daqiqa amal qiladi).' },
  askCode: { en: 'Send the 6-digit code from the e-mail, or /cancel.', ru: 'Пришлите 6-значный код из письма или /cancel.', uz: 'Emaildagi 6 xonali kodni yuboring yoki /cancel.' },
  badCode: { en: '❌ Wrong code.', ru: '❌ Неверный код.', uz: '❌ Kod noto‘g‘ri.' },
  expired: { en: '⌛ That request expired. Send /forgot to start again.', ru: '⌛ Запрос устарел. Отправьте /forgot, чтобы начать заново.', uz: '⌛ So‘rov muddati tugadi. Qayta boshlash uchun /forgot yuboring.' },
  cancel: { en: 'Cancelled.', ru: 'Отменено.', uz: 'Bekor qilindi.' },
  rate: { en: '⏳ Too many requests. Please try again later.', ru: '⏳ Слишком много запросов. Попробуйте позже.', uz: '⏳ So‘rovlar juda ko‘p. Keyinroq urinib ko‘ring.' },
  noMail: { en: 'E-mail sending is not set up yet, so I cannot verify you. Our team was notified.', ru: 'Отправка email ещё не настроена, поэтому я не могу вас проверить. Команда уведомлена.', uz: 'Email yuborish hali sozlanmagan, shuning uchun tasdiqlay olmayman. Jamoa xabardor qilindi.' },
  linked: { en: '✅ Telegram connected to your KinoQuiz account.', ru: '✅ Telegram подключён к вашему аккаунту KinoQuiz.', uz: '✅ Telegram KinoQuiz hisobingizga ulandi.' },
  linkExpired: { en: '⚠️ This code expired. Press Connect again on the site.', ru: '⚠️ Код устарел. Нажмите «Подключить» на сайте ещё раз.', uz: '⚠️ Kod eskirgan. Saytda “Ulash” tugmasini qayta bosing.' },
  unlinked: { en: '🔌 This chat is no longer connected to a KinoQuiz account.', ru: '🔌 Этот чат больше не подключён к аккаунту KinoQuiz.', uz: '🔌 Bu chat endi KinoQuiz hisobiga ulanmagan.' },
  notLinked: { en: 'This chat is not connected to any account.', ru: 'Этот чат не подключён ни к какому аккаунту.', uz: 'Bu chat hech qanday hisobga ulanmagan.' },
  handoff: { en: 'I passed this to our team, they will reply soon. 🙏', ru: 'Я передал это команде, скоро ответят. 🙏', uz: 'Buni jamoamizga uzatdim, tez orada javob berishadi. 🙏' }
};
Object.assign(TX, {
  noOrder: { en: 'I could not find that order. Please place it again on the site.', ru: 'Заказ не найден. Оформите его на сайте ещё раз.', uz: 'Buyurtma topilmadi. Saytda qaytadan buyurtma bering.' },
  alreadyPaid: { en: '✅ This order is already paid. Thank you!', ru: '✅ Этот заказ уже оплачен. Спасибо!', uz: '✅ Bu buyurtma allaqachon to‘langan. Rahmat!' },
  noOpenOrder: { en: 'I do not see an unpaid order for you. Place an order on the site first, then open the “Pay in Telegram” link.', ru: 'Неоплаченных заказов не вижу. Сначала оформите заказ на сайте и откройте ссылку «Оплатить в Telegram».', uz: 'To‘lanmagan buyurtmangiz ko‘rinmayapti. Avval saytda buyurtma bering, so‘ng “Telegramda to‘lash” havolasini oching.' },
  receiptGot: { en: '🧾 Receipt received. We are checking it and will reply here soon.', ru: '🧾 Чек получен. Проверяем и скоро ответим здесь.', uz: '🧾 Chek qabul qilindi. Tekshirib, tez orada shu yerda javob beramiz.' },
  payOk: { en: '✅ Payment for order {code} is confirmed. Thank you! We will prepare your order.', ru: '✅ Оплата заказа {code} подтверждена. Спасибо! Готовим ваш заказ.', uz: '✅ {code} buyurtma to‘lovi tasdiqlandi. Rahmat! Buyurtmangizni tayyorlaymiz.' },
  payNo: { en: '❌ We could not confirm the payment for order {code}. Please send a clear receipt photo again, or write to us here.', ru: '❌ Не удалось подтвердить оплату заказа {code}. Отправьте чёткое фото чека ещё раз или напишите нам здесь.', uz: '❌ {code} buyurtma to‘lovini tasdiqlab bo‘lmadi. Chek rasmini aniqroq qilib qayta yuboring yoki shu yerga yozing.' }
});
const tx = (lang, k) => (TX[k][lang] || TX[k].en);
const langOf = m => { const c = String(m.from?.language_code || '').slice(0, 2).toLowerCase(); return ['uz', 'ru'].includes(c) ? c : 'en'; };

const recovery = new Map();   // chatId -> { step:'email'|'code', uid, hash, exp, tries }
const tempMessage = (u, d, pw) => `🔑 <b>Temporary password</b>\nLogin: <code>${esc(u.email)}</code>${d.username ? `  or  <code>${esc(d.username)}</code>` : ''}\nPassword: <code>${esc(pw)}</code>\nYou will be asked to set a new password immediately after you sign in.`;

async function recoveryEmail(chat, text, lang, from) {
  const email = lower(text);
  if (!isEmail(email)) return say(chat, tx(lang, 'badEmail'));
  if (!allow('botfg:' + email, 3, 3600e3) || !allow('botfg:' + chat, 6, 3600e3)) { recovery.delete(chat); return say(chat, tx(lang, 'rate')); }
  const u = await findUser(email), d = u ? ((await db.doc('users/' + u.uid).get()).data() || {}) : {};
  if (u && !mailOn) {
    // No e-mail service: the only proof we have is that this Telegram chat is already linked to that account.
    if ((await chatOf(u.uid)) === chat) { recovery.delete(chat); return say(chat, tempMessage(u, d, await issueTemp(u.uid))); }
    recovery.delete(chat);
    for (const c of await adminChats()) await say(c, `🆘 Password help for ${esc(email)} requested from Telegram @${esc(from)} (chat ${chat}). E-mail is not configured, could not verify.`);
    return say(chat, tx(lang, 'noMail'));
  }
  let hash = null;
  if (u) {
    const code = String(crypto.randomInt(100000, 1000000));
    const sent = await mail(u.email, 'KinoQuiz: your verification code', `Your KinoQuiz Telegram verification code: ${code}\n\nType it in the bot within 10 minutes. If you did not ask for it, ignore this e-mail.\n\n— KinoQuiz`);
    if (sent) hash = sha(code);
  }
  if (u && !hash) for (const c of await adminChats()) await say(c, `⚠️ Could not e-mail a recovery code to ${esc(email)} (check SMTP settings on Render).`);
  // Same reply whether or not the e-mail exists (no account guessing).
  recovery.set(chat, { step: 'code', uid: hash ? u.uid : null, hash, exp: Date.now() + 600000, tries: 0 });
  if (recovery.size > 2000) recovery.clear();
  return say(chat, tx(lang, 'codeSent'));
}
async function recoveryCode(chat, text, lang) {
  const st = recovery.get(chat);
  if (!st || st.exp < Date.now()) { recovery.delete(chat); return say(chat, tx(lang, 'expired')); }
  if (!/^\d{6}$/.test(text)) return say(chat, tx(lang, 'askCode'));
  if (++st.tries > 5) { recovery.delete(chat); return say(chat, tx(lang, 'rate')); }
  if (!st.uid || !st.hash || !sameHash(st.hash, sha(text))) return say(chat, tx(lang, 'badCode'));
  recovery.delete(chat);
  const u = await auth.getUser(st.uid), d = (await db.doc('users/' + st.uid).get()).data() || {};
  return say(chat, tempMessage(u, d, await issueTemp(st.uid)));
}

app.post('/telegram/' + E.WEBHOOK_SECRET, async (req, res) => {
  res.sendStatus(200);
  if (req.body.callback_query) return handleCallback(req.body.callback_query).catch(e => console.error(e));
  const m = req.body.message; if (!m || m.chat?.type !== 'private') return;
  if (!m.text) return (m.photo || m.document) ? handleReceipt(m).catch(e => console.error(e)) : undefined;
  const chat = m.chat.id, text = m.text.trim(), from = m.from?.username || '', lang = langOf(m);
  try {
    if (/^\/start pay_[A-Za-z0-9]{6}$/.test(text)) {            // "Pay in Telegram" link from the site
      if (limited(chat)) return;
      const q = await db.collection('orders').where('code', '==', text.slice(-6).toUpperCase()).limit(1).get();
      if (q.empty) return say(chat, tx(lang, 'noOrder'));
      const o = q.docs[0].data();
      await q.docs[0].ref.update({ chatId: chat, tgUser: from });
      return say(chat, o.pay === 'paid' ? tx(lang, 'alreadyPaid') : payInstructions(o.lang || lang, o));
    }
    if (text.startsWith('/start link_')) {                       // account linking
      const code = text.split('link_')[1].trim().toUpperCase(), s = await db.doc('tgCodes/' + code).get();
      if (!s.exists || s.data().exp < Date.now()) return say(chat, tx(lang, 'linkExpired'));
      const old = await db.collection('tgLinks').where('chatId', '==', chat).get();
      await Promise.all(old.docs.filter(d => d.id !== s.data().uid).map(d => d.ref.delete()));
      await db.doc('tgLinks/' + s.data().uid).set({ chatId: chat, username: from, at: Date.now() });
      await s.ref.delete(); return say(chat, tx(lang, 'linked'));
    }
    const cmd = (text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/s) || [])[1]?.toLowerCase();
    const arg = (text.match(/^\/\w+(?:@\w+)?\s+(.*)$/s) || [])[1] || '';
    if (cmd === 'cancel') { recovery.delete(chat); return say(chat, tx(lang, 'cancel')); }
    if (cmd === 'forgot' || cmd === 'reset' || (cmd === 'start' && arg.trim() === 'forgot')) {   // password recovery by bot
      recovery.set(chat, { step: 'email', exp: Date.now() + 600000 });
      return say(chat, tx(lang, 'askEmail'));
    }
    if (cmd === 'unlink') {
      const q = await db.collection('tgLinks').where('chatId', '==', chat).get();
      if (q.empty) return say(chat, tx(lang, 'notLinked'));
      await Promise.all(q.docs.map(d => d.ref.delete())); return say(chat, tx(lang, 'unlinked'));
    }
    if (cmd === 'start' || cmd === 'help') return say(chat, esc(tx(lang, 'welcome')));
    const st = recovery.get(chat);
    if (st && st.exp > Date.now()) return st.step === 'email' ? recoveryEmail(chat, text, lang, from) : recoveryCode(chat, text, lang);
    if (/^\d{6}$/.test(text) && !st) return say(chat, tx(lang, 'expired'));
    if (cmd) return say(chat, esc(tx(lang, 'welcome')));
    if (limited(chat)) return;
    const answer = await ai(chat, text);
    if (!answer || answer.includes('[[HANDOFF]]')) {
      for (const c of await adminChats()) await say(c, `💬 <b>Support request</b> from @${esc(from)} (chat ${chat}):\n${esc(text)}`);
      return say(chat, tx(lang, 'handoff'));
    }
    say(chat, esc(answer));
  } catch (e) { console.error(e); }
});

/* ---------- automatic setup on every start ---------- */
async function ensureOwners() {
  for (const email of OWNERS) {
    try {
      const r = await ensureOwner(email);
      console.log(r.created ? `owner created: ${email}` + (r.usedInitial ? ' (sign in with OWNER_INITIAL_PASSWORD, you must change it)' : ' -> open the site, press "Forgot password" to set your password') : `owner ok: ${email}`);
    } catch (e) { console.error('owner setup failed for', email, '-', e.message); }
  }
}
async function publishRules() {
  if (E.DISABLE_RULES_SYNC) return;
  try { await admin.securityRules().releaseFirestoreRulesetFromSource(fs.readFileSync(path.join(__dir, 'firestore.rules'), 'utf8')); console.log('firestore rules published'); }
  catch (e) { console.error('firestore rules NOT published (paste firestore.rules in the Firebase console):', e.message); }
  try { await admin.securityRules().releaseStorageRulesetFromSource(fs.readFileSync(path.join(__dir, 'storage.rules'), 'utf8')); console.log('storage rules published'); }
  catch (e) { console.error('storage rules NOT published (paste storage.rules in the Firebase console):', e.message); }
}

app.listen(E.PORT || 3000, async () => {
  console.log('server up', '| e-mail:', mailKind === 'OFF' ? 'OFF (set MAIL_WEBHOOK_URL + MAIL_WEBHOOK_SECRET)' : mailKind, '| AI:', AI_KEY ? 'on' : 'off');
  if (!(GAS_URL && GAS_SECRET) && (BREVO || RESEND) && !FROM_EMAIL) console.error('MAIL_FROM is missing: set it to the sender address you verified at your e-mail provider.');
  if (mailKind === 'smtp') mailer.verify().then(() => console.log('smtp ok')).catch(e => console.error('smtp NOT working (Render free plan blocks SMTP ports):', e.message));
  if (PUBLIC) {
    console.log('webhook:', (await tg('setWebhook', { url: `${PUBLIC}/telegram/${E.WEBHOOK_SECRET}`, allowed_updates: ['message', 'callback_query'] }).catch(e => ({ description: String(e) }))).description);
    // Free Render sleeps after 15 min without traffic; pinging ourselves keeps the bot awake.
    setInterval(() => fetch(PUBLIC + '/healthz').catch(() => {}), 10 * 60 * 1000);
  } else console.log('PUBLIC_URL / RENDER_EXTERNAL_URL not set: Telegram webhook not registered');
  await ensureOwners();
  await publishRules();
  news.start();
});
