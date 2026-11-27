// Google Apps Script: lets KinoQuiz send e-mail through YOUR Gmail over HTTPS.
// 1) script.google.com -> New project -> paste this file.
// 2) Change SECRET below to a long random string (same value goes to Render as MAIL_WEBHOOK_SECRET).
// 3) Deploy -> New deployment -> type "Web app" -> Execute as: Me, Who has access: Anyone -> Deploy -> allow permissions.
// 4) Copy the Web app URL to Render as MAIL_WEBHOOK_URL.
const SECRET = 'CHANGE-ME-to-a-long-random-string';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return out({ ok: false, error: 'bad secret' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.to || '')) return out({ ok: false, error: 'bad recipient' });
    MailApp.sendEmail({ to: d.to, subject: String(d.subject || '').slice(0, 200), body: String(d.text || ''), name: d.name || 'KinoQuiz' });
    return out({ ok: true });
  } catch (err) { return out({ ok: false, error: String(err) }); }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
