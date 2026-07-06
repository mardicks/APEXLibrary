const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');
const { db, q } = require('./db');

const PORT = process.env.PORT || 5000;

const app = express();

// ─── Admin Session Store ──────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'APEXed2026!';
const adminTokens    = new Set();

function isAdmin(req) {
  const tok = req.headers['x-admin-token'];
  return tok && adminTokens.has(tok);
}

// ─── On-Site IP Detection ─────────────────────────────────────────────────────
function isOnSite(req) {
  const raw = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress || '';
  const ip  = raw.replace(/^::ffff:/, '');
  return ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Patron portal at /patron, admin at /
app.use('/patron', express.static(path.join(__dirname, 'patron')));
app.use(express.static(path.join(__dirname, 'admin')));

// ─── Generic HTTP/HTTPS GET with redirect following ─────────────────────────────────────────
function httpGet(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('Too many redirects'));
    try {
      const u   = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 9000,
        headers: { 'User-Agent': 'APEXLibrary/1.0 (catalog enrichment)' }
      }, resp => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          const next = resp.headers.location.startsWith('http')
            ? resp.headers.location
            : `${u.protocol}//${u.host}${resp.headers.location}`;
          resp.resume();
          return httpGet(next, hops + 1).then(resolve).catch(reject);
        }
        let raw = '';
        resp.on('data', c => raw += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: raw }));
        resp.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

// ─── Source 1: Open Library Books API (metadata + cover) ──────────────────────────────
async function fetchOLBooksAPI(isbn) {
  const { status, body } = await httpGet(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
  );
  if (status !== 200) return null;
  const parsed = JSON.parse(body);
  const book   = parsed[`ISBN:${isbn}`];
  if (!book) return null;
  const notes = book.notes;
  const cover = (book.cover?.large || book.cover?.medium || '')
    .replace(/^http:\/\//i, 'https://');  // OL returns http:// — upgrade it
  return {
    title:       book.title || '',
    author:      (book.authors || []).map(a => a.name).join(', '),
    publisher:   (book.publishers || [{}])[0]?.name || '',
    year:        book.publish_date || '',
    description: (typeof notes === 'object' ? notes?.value : notes) || '',
    cover_url:   cover
  };
}

// ─── Source 2: Open Library ISBN JSON + Works API (reliable covers + full descriptions) ───────
async function fetchOLIsbnJSON(isbn) {
  const { status, body } = await httpGet(`https://openlibrary.org/isbn/${isbn}.json`);
  if (status !== 200) return null;
  const data = JSON.parse(body);

  // `covers` is an array of positive integers when real covers exist
  let cover_url = '';
  if (Array.isArray(data.covers) && data.covers[0] > 0) {
    cover_url = `https://covers.openlibrary.org/b/id/${data.covers[0]}-L.jpg`;
  }

  // Edition-level notes (often empty)
  let description = (typeof data.notes === 'string' ? data.notes : data.notes?.value) || '';

  // Chain to the Works API — work-level descriptions are much richer
  const workKey = data.works?.[0]?.key;  // e.g. '/works/OL12345W'
  if (workKey) {
    try {
      const { status: ws, body: wb } = await httpGet(`https://openlibrary.org${workKey}.json`);
      if (ws === 200) {
        const work = JSON.parse(wb);
        if (!description) {
          const wd = work.description;
          description = (typeof wd === 'string' ? wd : wd?.value) || '';
        }
        // Work-level covers as additional fallback
        if (!cover_url && Array.isArray(work.covers) && work.covers[0] > 0) {
          cover_url = `https://covers.openlibrary.org/b/id/${work.covers[0]}-L.jpg`;
        }
      }
    } catch(_) { /* don't let work fetch block edition data */ }
  }

  return {
    title:       data.title || '',
    author:      '',  // Author keys require extra fetches; covered by other sources
    publisher:   Array.isArray(data.publishers) ? data.publishers[0] || '' : '',
    year:        data.publish_date || '',
    description,
    cover_url
  };
}

// ─── Source 3: Google Books API (descriptions + high-res covers via volumeId) ────────────
async function fetchGoogleBooks(isbn) {
  const { status, body } = await httpGet(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`
  );
  if (status !== 200) return null;
  const parsed = JSON.parse(body);
  if (!parsed.items?.length) return null;
  const item = parsed.items[0];
  const vi   = item.volumeInfo;
  const imgs = vi.imageLinks || {};

  // Build a direct high-res cover from the volumeId (often better quality than imageLinks)
  const volumeId = item.id;
  let cover = volumeId
    ? `https://books.google.com/books/content?id=${volumeId}&printsec=frontcover&img=1&zoom=0&source=gbs_api`
    : (imgs.extraLarge || imgs.large || imgs.medium || imgs.thumbnail || imgs.smallThumbnail || '')
        .replace(/^http:\/\//i, 'https://')
        .replace('&edge=curl', '')
        .replace(/([?&]zoom)=\d+/, '$1=0');

  return {
    title:       vi.title || '',
    author:      (vi.authors || []).join(', '),
    publisher:   vi.publisher || '',
    year:        (vi.publishedDate || '').split('-')[0],
    description: vi.description || '',
    cover_url:   cover
  };
}

// ─── Source 4: Open Library Search API (catches books other endpoints miss) ────────────
async function fetchOLSearchAPI(isbn) {
  // /search.json finds books by ISBN even when direct /isbn/ lookup returns 404
  const { status, body } = await httpGet(
    `https://openlibrary.org/search.json?isbn=${isbn}&fields=title,author_name,publisher,first_publish_year,cover_i&limit=1`
  );
  if (status !== 200) return null;
  const parsed = JSON.parse(body);
  const doc = parsed.docs?.[0];
  if (!doc) return null;
  const cover_url = (doc.cover_i > 0) ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '';
  return {
    title:       doc.title || '',
    author:      (doc.author_name || []).join(', '),
    // Use the most-recent publisher from the list (last element = most recent edition's publisher)
    publisher:   Array.isArray(doc.publisher) ? (doc.publisher.slice(-1)[0] || '') : '',
    year:        String(doc.first_publish_year || ''),
    description: '',   // search endpoint doesn't return descriptions; other sources cover this
    cover_url
  };
}

// ─── Multi-source ISBN Fetch (4 parallel fetches, OL ISBN also chains to Works API) ───────
async function fetchISBNData(isbn) {
  const clean = isbn.replace(/[- ]/g, '');
  if (!clean) return null;

  // Sources 1, 3, 4 run in parallel; Source 2 also internally chains to Works API
  const [olBooks, olJSON, googleBooks, olSearch] = await Promise.allSettled([
    fetchOLBooksAPI(clean),    // OL Books API (metadata + cover)
    fetchOLIsbnJSON(clean),    // OL ISBN JSON  → Works API (reliable covers + descriptions)
    fetchGoogleBooks(clean),   // Google Books (descriptions + high-res cover via volumeId)
    fetchOLSearchAPI(clean)    // OL Search API (finds books other endpoints miss)
  ]);

  const result = { title:'', author:'', publisher:'', year:'', description:'', cover_url:'', isbn:clean };
  const fill   = (field, src) => { if (src?.[field] && !result[field]) result[field] = src[field]; };

  // Priority: OL Books > OL ISBN+Works > Google Books > OL Search
  for (const settled of [olBooks, olJSON, googleBooks, olSearch]) {
    if (settled.status === 'fulfilled' && settled.value) {
      const src = settled.value;
      fill('title', src); fill('author', src); fill('publisher', src);
      fill('year',  src); fill('description', src); fill('cover_url', src);
    }
  }

  if (!result.title && !result.description && !result.cover_url) return null;
  return result;
}

// ─── BGG (BoardGameGeek) Helpers ─────────────────────────────────────────────────────────────
function xmlAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`));
  return m ? m[1] : '';
}
function xmlBody(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`));
  return m ? m[1].trim() : '';
}
function xmlEntities(s) {
  return s.replace(/&#10;/g, ' ').replace(/&#13;/g, '').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&apos;/g, "'").replace(/&#\d+;/g, '').trim();
}

// ─── Shared API Routes ────────────────────────────────────────────────────────
function mountAPI(app) {

  // --- Admin Auth ---
  app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
      const token = crypto.randomBytes(32).toString('hex');
      adminTokens.add(token);
      setTimeout(() => adminTokens.delete(token), 8 * 60 * 60 * 1000); // 8h TTL
      res.json({ success: true, token });
    } else {
      res.status(401).json({ success: false, error: 'Invalid password' });
    }
  });
  app.post('/api/admin/logout', (req, res) => {
    const tok = req.headers['x-admin-token'];
    if (tok) adminTokens.delete(tok);
    res.json({ success: true });
  });
  app.get('/api/admin/check', (req, res) => {
    res.json({ authenticated: isAdmin(req) });
  });

  // --- On-Site Check ---
  app.get('/api/is-onsite', (req, res) => {
    res.json({ onsite: isOnSite(req) });
  });

  // --- Archives (on-site only) ---
  app.get('/api/archives', (req, res) => {
    if (!isOnSite(req)) return res.status(403).json({ success:false, error:'On-site access only' });
    try { res.json({ success:true, archives: q.archiveAll.all() }); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
  });
  app.post('/api/archives', (req, res) => {
    try {
      const b = sanitizeArchive(req.body);
      const r = q.archiveIns.run(b);
      res.json({ success:true, id: r.lastInsertRowid });
    } catch(e) { res.status(400).json({ success:false, error:e.message }); }
  });
  app.put('/api/archives/:id', (req, res) => {
    try {
      q.archiveUpd.run({ ...sanitizeArchive(req.body), id: req.params.id });
      res.json({ success:true });
    } catch(e) { res.status(400).json({ success:false, error:e.message }); }
  });
  app.delete('/api/archives/:id', (req, res) => {
    try { q.archiveDel.run(req.params.id); res.json({ success:true }); }
    catch(e) { res.status(400).json({ success:false, error:e.message }); }
  });

  // --- Items ---

  app.get('/api/items', (req, res) => {
    try {
      const { search, type, status } = req.query;
      let items = search
        ? q.search.all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
        : q.getAll.all();
      if (type)   items = items.filter(i => i.type === type);
      if (status) items = items.filter(i => i.status === status);
      res.json({ success: true, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ── Must be defined BEFORE /api/items/:id ─────────────────────────────────
  app.get('/api/items/enrichable', (req, res) => {
    try {
      const all        = q.getAll.all();
      const hasIsbn    = all.filter(i => i.isbn);
      const enrichable = hasIsbn.filter(i => !i.cover_url || !i.description);
      const complete   = hasIsbn.filter(i => i.cover_url && i.description);
      res.json({
        success: true,
        enrichable: enrichable.map(i => ({
          id: i.id, title: i.title, isbn: i.isbn,
          has_cover: !!i.cover_url, has_desc: !!i.description
        })),
        complete_count: complete.length
      });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/items/:id', (req, res) => {
    try {
      const item = q.getById.get(req.params.id);
      if (!item) return res.status(404).json({ success: false, error: 'Item not found' });
      const history = db.prepare(`
        SELECT * FROM checkouts WHERE item_id=? ORDER BY checkout_date DESC
      `).all(req.params.id);
      res.json({ success: true, item, history });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/items', (req, res) => {
    try {
      const body = sanitizeItem(req.body);
      const r = q.insert.run(body);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.put('/api/items/:id', (req, res) => {
    try {
      const body = sanitizeItem(req.body);
      q.update.run({ ...body, id: req.params.id });
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/items/:id', (req, res) => {
    try {
      const active = q.activeByItem.get(req.params.id);
      if (active) return res.status(400).json({ success: false, error: 'Item is currently checked out' });
      q.delete.run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // --- Enrich single item from Open Library ---
  app.post('/api/items/:id/enrich', async (req, res) => {
    try {
      const item = q.getById.get(req.params.id);
      if (!item)    return res.status(404).json({ success: false, error: 'Item not found' });
      if (!item.isbn) return res.status(400).json({ success: false, error: 'Item has no ISBN' });

      const data = await fetchISBNData(item.isbn);
      if (!data) return res.json({ success: false, error: 'Not found in Open Library' });

      const force   = req.body?.force === true;
      const changed = [];
      const patched = {
        title: item.title, type: item.type, author: item.author,
        publisher: item.publisher, year: item.year, description: item.description,
        isbn: item.isbn, barcode: item.barcode, apex_id: item.apex_id || '',
        condition: item.condition, cover_url: item.cover_url, location: item.location, notes: item.notes
      };

      const fill = (field, src) => {
        if (src && (force || !patched[field])) { patched[field] = src; changed.push(field); }
      };
      fill('cover_url',   data.cover_url);
      fill('description', data.description);
      fill('author',      data.author);
      fill('publisher',   data.publisher);
      fill('year',        data.year);

      if (changed.length) q.update.run({ ...patched, id: req.params.id });

      res.json({ success: true, changed, cover_url: patched.cover_url });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/stats', (req, res) => {
    try {
      const stats   = q.stats.get();
      const overdue = q.overdue.all().length;
      res.json({ success: true, stats: { ...stats, overdue } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // --- Checkouts ---

  app.get('/api/checkouts', (req, res) => {
    try {
      const { type, member } = req.query;
      let checkouts;
      if (member)           checkouts = q.byMember.all(`%${member}%`);
      else if (type === 'active')   checkouts = q.activeAll.all();
      else if (type === 'overdue')  checkouts = q.overdue.all();
      else                          checkouts = q.historyAll.all();
      res.json({ success: true, checkouts });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/checkouts', (req, res) => {
    try {
      const { item_id, member_name, member_id, notes } = req.body;
      if (!member_name?.trim()) return res.status(400).json({ success: false, error: 'Member name required' });
      const item = q.getById.get(item_id);
      if (!item) return res.status(404).json({ success: false, error: 'Item not found' });
      if (item.status !== 'Available') return res.status(400).json({ success: false, error: 'Item is not available for checkout' });

      const due = new Date();
      due.setDate(due.getDate() + 14);
      const dueStr = due.toISOString().replace('T', ' ').slice(0, 19);

      const r = q.checkout.run({
        item_id,
        member_name: member_name.trim(),
        member_id:   (member_id || '').trim(),
        due_date:    dueStr,
        notes:       (notes || '').trim()
      });
      q.setStatus.run('Checked Out', item_id);

      res.json({ success: true, id: r.lastInsertRowid, due_date: dueStr });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.post('/api/checkouts/:id/return', (req, res) => {
    try {
      const co = q.getCheckout.get(req.params.id);
      if (!co) return res.status(404).json({ success: false, error: 'Checkout not found' });
      if (co.return_date) return res.status(400).json({ success: false, error: 'Item already returned' });
      q.doReturn.run(req.params.id);
      q.setStatus.run('Available', co.item_id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // --- ISBN Lookup (Open Library) — now uses shared helper ---
  app.get('/api/isbn/:isbn', async (req, res) => {
    try {
      const data = await fetchISBNData(req.params.isbn);
      if (!data) return res.json({ success: false, error: 'ISBN not found in Open Library' });
      res.json({ success: true, data });
    } catch(e) { res.status(500).json({ success: false, error: `ISBN lookup failed: ${e.message}` }); }
  });

  // --- BoardGameGeek Lookup ---

  // Search BGG by game name — must be before /api/bgg/:id
  app.get('/api/bgg/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ success: false, error: 'Query required' });
    try {
      const { status, body } = await httpGet(
        `https://api.geekdo.com/xmlapi2/search?query=${encodeURIComponent(q)}&type=boardgame`
      );
      if (status !== 200) return res.json({ success: false, error: 'BGG search failed' });
      const items = [];
      // Extract all boardgame items from search XML
      const itemRx = /<item[^>]+type="boardgame"[^>]+id="(\d+)"[\s\S]*?<\/item>/g;
      let m;
      while ((m = itemRx.exec(body)) !== null && items.length < 12) {
        const block = m[0];
        const name  = xmlAttr(block, 'name', 'value');
        const year  = xmlAttr(block, 'yearpublished', 'value');
        if (name) items.push({ id: m[1], name: xmlEntities(name), year });
      }
      res.json({ success: true, items });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Get BGG game details by ID
  app.get('/api/bgg/:id', async (req, res) => {
    try {
      const { status, body } = await httpGet(
        `https://api.geekdo.com/xmlapi2/thing?id=${req.params.id}`
      );
      if (status !== 200) return res.json({ success: false, error: 'BGG lookup failed' });
      const name  = xmlEntities(xmlAttr(body, 'name[^>]+type="primary"', 'value'));
      const year  = xmlAttr(body, 'yearpublished', 'value');
      const desc  = xmlEntities(xmlBody(body, 'description'));
      // Protocol-relative URLs from BGG (//cf.geekdo-images.com/...)
      const imgRaw  = xmlBody(body, 'image');
      const thumbRaw= xmlBody(body, 'thumbnail');
      const toHttps = s => s.startsWith('//') ? 'https:' + s : s.replace(/^http:\/\//i,'https://');
      const cover   = imgRaw ? toHttps(imgRaw) : (thumbRaw ? toHttps(thumbRaw) : '');
      // Publisher and designer from link elements
      const pubMatch  = body.match(/<link[^>]+type="boardgamepublisher"[^>]+value="([^"]+)"/);
      const authMatch = body.match(/<link[^>]+type="boardgamedesigner"[^>]+value="([^"]+)"/);
      res.json({
        success: true,
        data: { title: name, year, description: desc, cover_url: cover,
                publisher: pubMatch?.[1] || '', author: authMatch?.[1] || '',
                bgg_id: req.params.id }
      });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

function sanitizeItem(body) {
  return {
    title:       (body.title       || '').trim(),
    type:        (body.type        || 'book').trim(),
    author:      (body.author      || '').trim(),
    publisher:   (body.publisher   || '').trim(),
    year:        (body.year        || '').trim(),
    description: (body.description || '').trim(),
    isbn:        (body.isbn        || '').trim(),
    barcode:     (body.barcode     || '').trim(),
    apex_id:     (body.apex_id     || '').trim(),
    condition:   (body.condition   || 'Good').trim(),
    cover_url:   (body.cover_url   || '').trim(),
    location:    (body.location    || '').trim(),
    notes:       (body.notes       || '').trim(),
  };
}

function sanitizeArchive(b) {
  return {
    title:       (b.title       || '').trim(),
    type:        (b.type        || 'photo').trim(),
    category:    (b.category    || '').trim(),
    description: (b.description || '').trim(),
    file_url:    (b.file_url    || '').trim(),
    thumb_url:   (b.thumb_url   || '').trim(),
    date_label:  (b.date_label  || '').trim(),
  };
}

// ─── Mount & Start ────────────────────────────────────────────────────────────
mountAPI(app);

// /member alias for /patron
app.use('/member', express.static(path.join(__dirname, 'patron')));

app.listen(PORT, () => {
  console.log(`\n  📚  APEX Library Admin   →  http://localhost:${PORT}`);
  console.log(`  🏛️  APEX Library Member  →  http://localhost:${PORT}/member`);
  console.log(`  🔒  Admin password: [configured]\n`);
  console.log('  Press Ctrl+C to stop.\n');
});
