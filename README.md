# KinoQuiz v15

One Node server (`index.js`) does everything: it serves the website (`public/`), the account API, the Telegram bot,
and on every start it automatically
- registers the Telegram webhook (uses Render's own URL),
- creates/claims the owner accounts from `OWNER_EMAILS`,
- publishes `firestore.rules` and `storage.rules`,
- pings itself every 10 minutes so the free Render instance stays awake.

## What changed in v15: automatic, translated news
`news.js` connects **Variety, Deadline, The Hollywood Reporter, IMDb News and Screen Daily**. Every `NEWS_REFRESH_MIN` minutes (default 60) the server
downloads their RSS feeds, has the AI (the same `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` the bot uses) translate each new headline and short summary
into **Uzbek, Russian and English**, picks the category, and saves it in Firestore `news`. The site shows the story in the language chosen with UZ / EN / RU.
- Only the headline and a short summary are stored; every story links to the original article.
- Admins/owners can press **Refresh now** under *News sources*. The chips there show Connected / Error per source.
- A story an admin deletes does not come back (ids are remembered in `newsMeta/seen`).
- IMDb has no public RSS, so IMDb News and Screen Daily are read through Google News' RSS search. Replace any feed with `NEWS_FEEDS` (see `.env.example`).
- Cost: only NEW stories are translated (about 4 per AI request). Set `NEWS_AI_MODEL` to a cheaper model if you want.

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
**Option A (no Brevo, no domain): send through your own Gmail with Google Apps Script.** Steps are at the top of `gmail-relay.gs`. Render env: `MAIL_WEBHOOK_URL` + `MAIL_WEBHOOK_SECRET`. Logs should show `e-mail: gmail-relay`. (Gmail limit ~100 mails/day.)

**Option B: Render's FREE plan blocks SMTP (Gmail SMTP will not work there), so use an HTTPS e-mail API. Brevo is free (300 e-mails/day):**
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


## Orders and payment (in the Telegram bot)
1. The customer places an order on the site. The server checks the stock, takes the prices from the database and saves the order with a 6-letter code.
2. The site shows a **Pay in Telegram** button. It opens the bot, which sends the order, the total (and UZS if `USD_TO_UZS` is set) and the card from `PAY_CARD`.
3. The customer pays and sends a photo/screenshot of the receipt to the bot.
4. Every owner/admin whose Telegram is connected (Profile -> Telegram) gets the receipt with **Confirm paid / Reject** buttons. The customer is told the result in the bot, and the order shows Awaiting payment / Receipt under review / Paid on the site.
Set `PAY_CARD`, `PAY_CARD_HOLDER` (and optionally `PAY_NOTE`, `USD_TO_UZS`) in Render -> Environment. Without `PAY_CARD` the bot tells the customer that the team will send the details.
