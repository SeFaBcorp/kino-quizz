# KinoQuiz v10 setup (about 20 minutes)

## 0. Security first
Revoke and replace: Telegram token (@BotFather -> /revoke), Firebase service-account key (delete it in Firebase Console -> Service accounts, generate a new one), owner password. Never put them in the HTML or share them in chat.

## 1. Firebase Console (project kino-quizz)
1. Authentication -> Sign-in method -> enable **Email/Password**. (Optional: Templates -> customise the password-reset email.)
2. Firestore Database -> Create -> Rules tab -> paste `firestore.rules` -> Publish.
3. Storage -> Rules: allow write only if `request.auth != null` and path starts with `uploads/{uid}/`.
4. Authentication -> Settings -> Authorized domains: add the domain where you host the HTML.

## 2. Deploy the server (Render.com, free)
1. Put the `server` folder in a GitHub repo -> Render -> New Web Service -> Build `npm install`, Start `npm start`.
2. Environment: fill every value from `.env.example` (service account JSON on ONE line).
3. After the first deploy set `PUBLIC_URL` to your Render URL and redeploy: the Telegram webhook is registered automatically.
4. Free Render sleeps after 15 min; add a free UptimeRobot ping to the URL every 5 min so the bot always answers.

## 3. Create the two owners (once, from the server shell or your PC with the env vars set)
    node seed.js egabehru0@gmail.com "<password you choose>"
    node seed.js dilshodabdurahimov12@gmail.com "<password you choose>"
Both become `owner` (equal rights) and are forced to change the password on first login.

## 4. Site
Put `KinoQuiz_Cinema_Studio_v10.html` and `firebase-config.js` together on Firebase Hosting (or any host). Edit `KQ_SERVER` in `firebase-config.js` to your Render URL.

## How it works
- Sign up: email + username; clear messages for "email already has an account" and "username taken". Everyone starts as guest.
- Owners (Profile area -> Support page -> Admins): add an admin by email. The server makes a random temporary password and sends it ONCE by the bot (if the person linked Telegram) or email (if SMTP is set); otherwise it is shown once to the owner. The admin must set a new password at first login. Owners cannot be created or removed from the site.
- Forgot password: email link, or bot `/reset` (temporary password, forced change).
- Orders: buyer gets a bot message and/or email; every admin gets a bot message with the product list and total.
- Bot AI: free-text messages are answered by Claude with your product list; payments, orders and complaints are handed off to admins.
