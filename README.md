# KinoQuiz v10

One Node server (`index.js`) does everything: it serves the website (`public/`), the account API, the Telegram bot,
and on every start it automatically
- registers the Telegram webhook (uses Render's own URL),
- creates/claims the owner accounts from `OWNER_EMAILS`,
- publishes `firestore.rules` and `storage.rules`,
- pings itself every 10 minutes so the free Render instance stays awake.

## What changed in v10
- **Sign in with e-mail OR username.** Both are unique (checked by the server when someone signs up).
- **Roles are decided by the server** after every sign-in. `OWNER_EMAILS` = owners (full power, can add admins, cannot be removed).
  Owners are created by the server, so nobody can sign up with an owner's e-mail and steal the role.
  An account that was self-registered with an owner e-mail **before** is claimed on the next start: its old password stops working
  and the owner sets a new one (Forgot password, or `OWNER_INITIAL_PASSWORD`). This is what fixes "I log in with my gmail and see Guest".
- **Forgot password, two ways**
  1. *By e-mail* — the site asks for e-mail or username; the server e-mails a **temporary password** (valid 24 h). At sign-in the site forces a new password.
  2. *By Telegram bot* — send `/forgot` to the bot → it asks for your **e-mail** → it e-mails a **6-digit code** to that address → you type the code in the bot → the bot sends the **temporary password**. (Code: 10 min, 5 tries.)
- New sign-in / recovery screens. The built-in `admin / admin123` login was removed.
- The bot also understands `/unlink`, `/help`, `/cancel` and answers in Uzbek, Russian or English.

## E-mail setup (needed for e-mail recovery and for the bot's verification code)
**Render's FREE plan blocks SMTP (Gmail SMTP will not work there), so use an HTTPS e-mail API. Brevo is free (300 e-mails/day):**
1. Create an account at https://www.brevo.com
2. *Senders, Domains & Dedicated IPs → Senders → Add a sender*: add the Gmail you want mail to come from and confirm the e-mail Brevo sends you.
3. *SMTP & API → API keys → Generate a new API key*.
4. Render → Environment: `BREVO_API_KEY` = that key, `MAIL_FROM` = the verified sender address. Save → Render redeploys.
5. In the Render logs you should see `e-mail: brevo`.

(Resend works too: `RESEND_API_KEY` + `MAIL_FROM`. Plain SMTP with `SMTP_*` only works on a paid Render plan or another host.)
Tip: mails from a free Gmail sender can land in Spam at first — tell people to check Spam. A domain of your own fixes that later.

## Deploy
1. Upload this folder's contents to the GitHub repo (index.js and package.json at the repo root, site in `public/`).
2. Render → Environment: `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT`, `OWNER_EMAILS`, `BREVO_API_KEY`, `MAIL_FROM` (see `.env.example`).
3. Firebase Console → Authentication → Sign-in method: **Email/Password** must be enabled.
4. Open https://kino-quizz.onrender.com → **Sign in → Forgot password** with an owner e-mail → temporary password arrives by e-mail → set your own password.
   (No e-mail yet? Set `OWNER_INITIAL_PASSWORD` (8+ chars) once, sign in with it, you are forced to change it.)
5. Owners/admins: Profile → Telegram → Connect, to receive new-order alerts in the bot.

`seed.js` is optional (manual owner creation from a PC).
