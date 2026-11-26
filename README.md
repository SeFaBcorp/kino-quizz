# KinoQuiz

One Node server (`index.js`) does everything: it serves the website (`public/`), the admin API, the Telegram bot,
and on every start it automatically
- registers the Telegram webhook (uses Render's own URL),
- creates/repairs the owner accounts from `OWNER_EMAILS`,
- publishes `firestore.rules` and `storage.rules`,
- pings itself every 10 minutes so the free Render instance stays awake.

## Deploy
1. Upload this folder's contents to the GitHub repo (index.js and package.json at the repo root).
2. Render -> Environment: `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT`, `OWNER_EMAILS` (see `.env.example`).
3. Firebase Console -> Authentication -> Sign-in method: **Email/Password** must be enabled.
4. Open https://kino-quizz.onrender.com , press **Forgot password** with an owner email, set your password.

`seed.js` is optional now (manual owner creation from a PC).
