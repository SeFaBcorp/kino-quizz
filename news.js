/* news.js - automatic, translated movie news.
   Every NEWS_REFRESH_MIN minutes (default 60) the server
     1. downloads the RSS feeds below (Variety, Deadline, The Hollywood Reporter, IMDb News, Screen Daily),
     2. asks the same AI you already use for the bot to translate each new headline + short summary into
        Uzbek (Latin), Russian and English and to pick a category,
     3. saves it in Firestore `news` (the site already listens to that collection),
     4. links back to the original story (only headline + short summary are stored, never the full article).
   Stories an admin deletes never come back (their ids are remembered in newsMeta/seen). */
import crypto from 'crypto';

const CATS = ['premieres', 'actors', 'awards', 'casting', 'festivals'];
const gnews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:3d')}&hl=en-US&gl=US&ceid=US:en`;
// IMDb has no public RSS feed, so IMDb News and Screen Daily are read through Google News' RSS search.
// You can replace the whole list with the NEWS_FEEDS environment variable: [{"name":"..","url":"..","site":".."}]
const DEFAULT_FEEDS = [
  { name: 'Variety', site: 'https://variety.com', url: 'https://variety.com/feed/' },
  { name: 'Deadline', site: 'https://deadline.com', url: 'https://deadline.com/feed/' },
  { name: 'The Hollywood Reporter', site: 'https://www.hollywoodreporter.com', url: 'https://www.hollywoodreporter.com/feed/' },
  { name: 'IMDb News', site: 'https://www.imdb.com/news/', url: gnews('site:imdb.com/news') },
  { name: 'Screen Daily', site: 'https://www.screendaily.com', url: gnews('site:screendaily.com') },
];

/* ---------- tiny RSS / Atom parser (no dependencies) ---------- */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(c); } catch { return ''; } }
  return NAMED[e.toLowerCase()] ?? m;
});
const clean = s => decodeEntities(decodeEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' '))
  .replace(/The post .{0,300}? appeared first on .{0,100}$/i, '').replace(/\[…\]|\[\.\.\.\]|Read more.*$/i, '').replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*?[^/])?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? m[1] : ''; };

function parseFeed(xml) {
  const out = [];
  for (const b of xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []) {
    let link = clean(tag(b, 'link'));
    if (!link) { const m = /<link[^>]+href=["']([^"']+)["']/i.exec(b); link = m ? decodeEntities(m[1]) : ''; }
    if (!/^https?:\/\//i.test(link)) continue;
    const title = clean(tag(b, 'title')).slice(0, 300);
    if (!title) continue;
    const d = new Date(clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    const date = isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    let about = clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content')).slice(0, 600);
    if (about.toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) about = '';   // Google News repeats the headline
    out.push({ title, about, url: link, date });
  }
  return out;
}

export function setupNews({ app, db, needUser, wrap, allow, provider, key, model, openaiModel, env }) {
  let FEEDS = DEFAULT_FEEDS;
  if (env.NEWS_FEEDS) {
    try {
      const f = JSON.parse(env.NEWS_FEEDS);
      if (Array.isArray(f) && f.length) FEEDS = f.filter(x => x && x.name && /^https?:\/\//.test(x.url))
        .map(x => ({ name: String(x.name), url: x.url, site: x.site || new URL(x.url).origin }));
    } catch { console.error('NEWS_FEEDS is not valid JSON - using the default feeds'); }
  }
  const REFRESH_MIN = Math.max(15, Number(env.NEWS_REFRESH_MIN || 60));
  const MAX_PER_SOURCE = Math.min(20, Math.max(1, Number(env.NEWS_MAX_PER_SOURCE || 8)));
  const KEEP_DAYS = Math.max(3, Number(env.NEWS_KEEP_DAYS || 30));
  const ENABLED = env.NEWS_ENABLED !== '0';

  let running = false, status = { lastRun: 0, running: false, sources: [] };

  /* ---------- AI (same provider/key as the Telegram bot) ---------- */
  async function callAI(system, user) {
    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: openaiModel, max_completion_tokens: 5000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(90000),
      }).then(r => r.json());
      const t = r.choices?.[0]?.message?.content?.trim();
      if (!t) throw new Error('openai: ' + (r.error?.message || 'empty answer'));
      return t;
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-sonnet-5-5', max_tokens: 5000, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(90000),
    }).then(r => r.json());
    const t = r.content?.find(c => c.type === 'text')?.text?.trim();
    if (!t) throw new Error('anthropic: ' + (r.error?.message || 'empty answer'));
    return t;
  }

  const SYSTEM = `You translate movie and TV news for KinoQuiz, a cinema website. The input is a JSON array of {i, title, summary}.
Return ONLY a JSON array (no markdown, no commentary) with one object per input item:
{"i":<same i>,"relevant":true|false,"cat":"premieres|actors|awards|casting|festivals","uz":{"title":"","about":""},"ru":{"title":"","about":""},"en":{"title":"","about":""}}
Rules:
- relevant=false only if the story has nothing to do with film, TV, streaming or the people who make them.
- cat: premieres (releases, trailers, box office, greenlights, deals, TV), actors (people, interviews, obituaries, personal news), awards (Oscars, Emmys, Golden Globes, nominations, wins), casting (casting announcements, new roles, directors attached), festivals (Cannes, Venice, Sundance, Toronto, Berlin, etc.). Pick the closest one.
- title: a natural, fluent headline in each language. about: one or two short sentences summarising ONLY what the given summary says; never add facts. If summary is empty, use "" for about.
- uz = Uzbek in LATIN script (use o‘ g‘ sh ch), ru = Russian, en = clean English (fix odd casing, drop site names and tags).
- Keep film, show and person names in their original Latin spelling in uz; in ru use the usual Russian form only if it is well known, otherwise keep the Latin spelling.
- Keep titles under 140 characters and about under 300 characters.`;

  async function translate(batch) {
    const txt = await callAI(SYSTEM, JSON.stringify(batch.map((x, i) => ({ i, title: x.title, summary: x.about }))));
    const a = txt.indexOf('['), b = txt.lastIndexOf(']');
    if (a < 0 || b < a) throw new Error('translation was not JSON');
    const arr = JSON.parse(txt.slice(a, b + 1)), res = new Map();
    const ok = o => o && typeof o.title === 'string' && o.title.trim() && typeof o.about === 'string';
    for (const r of Array.isArray(arr) ? arr : []) {
      if (!r || !Number.isInteger(r.i) || !batch[r.i]) continue;
      if (r.relevant === false) { res.set(r.i, { skip: true }); continue; }
      if (!ok(r.uz) || !ok(r.ru) || !ok(r.en)) continue;
      const cut = (o, n, m) => ({ title: o.title.trim().slice(0, n), about: o.about.trim().slice(0, m) });
      res.set(r.i, { cat: CATS.includes(r.cat) ? r.cat : 'premieres', tr: { uz: cut(r.uz, 200, 400), ru: cut(r.ru, 200, 400), en: cut(r.en, 200, 400) } });
    }
    return res;
  }

  /* ---------- feeds ---------- */
  async function getFeed(f) {
    const r = await fetch(f.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; KinoQuizBot/1.0)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(20000), redirect: 'follow',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = parseFeed((await r.text()).slice(0, 3e6));
    if (!items.length) throw new Error('no stories found in feed');
    return items;
  }
  const idOf = u => 'rss_' + crypto.createHash('sha1').update(u.replace(/[?#].*$/, '') + (u.includes('news.google.com') ? u : '')).digest('hex').slice(0, 24);

  async function run() {
    if (running) return false;
    running = true; status.running = true;
    const started = Date.now(), sources = [];
    try {
      const seenDoc = (await db.doc('newsMeta/seen').get()).data() || {};
      const seen = new Set(Array.isArray(seenDoc.ids) ? seenDoc.ids : []);
      const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
      for (const f of FEEDS) {
        const st = { name: f.name, site: f.site, ok: false, added: 0, at: Date.now() };
        sources.push(st);
        try {
          if (!key) throw new Error('AI key is not set (ANTHROPIC_API_KEY / OPENAI_API_KEY)');
          const fresh = (await getFeed(f)).filter(x => x.date >= cutoff && !seen.has(idOf(x.url)))
            .sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PER_SOURCE);
          let failed = '';
          for (let i = 0; i < fresh.length; i += 4) {
            const batch = fresh.slice(i, i + 4);
            let res;
            try { res = await translate(batch); } catch (e) { failed = String(e.message || e).slice(0, 90); continue; }
            const wb = db.batch();
            batch.forEach((x, j) => {
              const r = res.get(j), id = idOf(x.url);
              if (!r) return;                                   // not translated -> tried again next time
              seen.add(id);
              if (r.skip) return;
              wb.set(db.collection('news').doc(id), {
                cat: r.cat, date: x.date, title: r.tr.en.title, about: r.tr.en.about, source: f.name, url: x.url,
                sample: false, auto: true, tr: r.tr, at: Date.now(),
              });
              st.added++;
            });
            await wb.commit();
          }
          st.ok = !failed || st.added > 0;
          if (failed) st.error = failed;
        } catch (e) { st.error = String(e.message || e).slice(0, 90); }
        console.log(`news: ${f.name} -> ${st.ok ? 'ok' : 'FAILED'} (+${st.added})${st.error ? ' ' + st.error : ''}`);
      }
      // forget very old ids, drop old automatic stories
      await db.doc('newsMeta/seen').set({ ids: [...seen].slice(-1500), at: Date.now() });
      const old = (await db.collection('news').where('auto', '==', true).get()).docs.filter(d => String(d.data().date || '') < cutoff);
      for (let i = 0; i < old.length; i += 400) { const wb = db.batch(); old.slice(i, i + 400).forEach(d => wb.delete(d.ref)); await wb.commit(); }
    } catch (e) {
      console.error('news run failed:', e.message);
      for (const f of FEEDS) if (!sources.find(s => s.name === f.name)) sources.push({ name: f.name, site: f.site, ok: false, added: 0, at: Date.now(), error: String(e.message).slice(0, 90) });
    } finally {
      status = { lastRun: Date.now(), running: false, ms: Date.now() - started, sources };
      db.doc('newsMeta/status').set(status).catch(() => {});
      running = false;
    }
    return true;
  }

  /* ---------- API ---------- */
  // Public: which sources are connected (used by the "News sources" box on the site).
  app.get('/api/news/status', wrap(async (_, res) => {
    if (!status.lastRun && !running) { const d = (await db.doc('newsMeta/status').get()).data(); if (d) status = d; }
    res.json({ enabled: ENABLED, ai: !!key, every: REFRESH_MIN, ...status, running });
  }));
  // Admins and owners: "Refresh now" button.
  app.post('/api/news/refresh', needUser, wrap(async (req, res) => {
    const u = (await db.doc('users/' + req.user.uid).get()).data() || {};
    if (!['admin', 'owner'].includes(u.role)) return res.status(403).json({ error: 'admins only' });
    if (!allow('nr:' + req.user.uid, 6, 600e3)) return res.status(429).json({ code: 'rate', error: 'Too many requests' });
    if (running) return res.json({ running: true });
    run().catch(e => console.error('news refresh', e));
    res.json({ started: true });
  }));

  return {
    start() {
      if (!ENABLED) return console.log('news: disabled (NEWS_ENABLED=0)');
      console.log(`news: ${FEEDS.length} sources, refresh every ${REFRESH_MIN} min, AI ${key ? 'on' : 'OFF - translation needs an AI key'}`);
      setTimeout(() => run().catch(e => console.error('news', e)), 20000);
      setInterval(() => run().catch(e => console.error('news', e)), REFRESH_MIN * 60e3);
    },
  };
}
