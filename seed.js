// One-time: node seed.js <ownerEmail> <password>   (run once per owner; password is typed, never stored in code)
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const [email, pw] = process.argv.slice(2);
if (!email || !pw || pw.length < 8) { console.log('usage: node seed.js email password(8+)'); process.exit(1); }
if (!process.env.OWNER_EMAILS.split(',').map(s=>s.trim().toLowerCase()).includes(email.toLowerCase())) { console.log('Email not in OWNER_EMAILS'); process.exit(1); }
let u; try { u = await admin.auth().getUserByEmail(email); await admin.auth().updateUser(u.uid, { password: pw }); }
catch { u = await admin.auth().createUser({ email, password: pw, emailVerified: true }); }
await admin.auth().setCustomUserClaims(u.uid, { role: 'owner' });
const db = admin.firestore(), uname = email.split('@')[0].replace(/[^\w.-]/g,'').slice(0,24);
await db.doc('users/'+u.uid).set({ email: email.toLowerCase(), username: uname, role: 'owner', mustChange: true }, { merge: true });
await db.doc('usernames/'+uname.toLowerCase()).set({ uid: u.uid }, { merge: true });
console.log('Owner ready:', email, '- must change password at first login.'); process.exit(0);
