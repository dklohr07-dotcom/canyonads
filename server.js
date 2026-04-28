const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const sqlite3  = require('sqlite3').verbose();
const Stripe   = require('stripe');
const OpenAI   = require('openai');
const crypto   = require('crypto');
require('dotenv').config();

const app      = express();
const PORT     = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD        = process.env.ADMIN_PASSWORD || 'change-this-password';
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function getPriceId() {
  return STRIPE_PRICE_ID;
}

// PATHS
const publicDir  = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname, 'uploads');
const dbPath     = path.join(__dirname, 'data.sqlite');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// DATABASE
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`
    CREATE TABLE IF NOT EXISTS advertisers (
      id                         TEXT PRIMARY KEY,
      business_name              TEXT NOT NULL,
      contact_name               TEXT NOT NULL,
      email                      TEXT NOT NULL,
      phone                      TEXT,
      business_address           TEXT,
      website                    TEXT,
      offer_text                 TEXT,
      ad_style                   TEXT,
      plan_name                  TEXT DEFAULT 'Standard',
      include_qr                 INTEGER DEFAULT 1,
      content_rights_accepted    INTEGER DEFAULT 0,
      ai_generate_ad             INTEGER DEFAULT 0,
      logo_path                  TEXT,
      image_path                 TEXT,
      generated_ad_path          TEXT,
      status                     TEXT DEFAULT 'draft',
      payment_status             TEXT DEFAULT 'pending',
      stripe_customer_id         TEXT,
      stripe_checkout_session_id TEXT,
      stripe_subscription_id     TEXT,
      start_date                 TEXT,
      end_date                   TEXT,
      notes                      TEXT,
      created_at                 TEXT NOT NULL,
      updated_at                 TEXT NOT NULL
    )
  `);
  ['business_address TEXT','website TEXT','plan_name TEXT DEFAULT \'Standard\'',
   'ai_generate_ad INTEGER DEFAULT 0','generated_ad_path TEXT'].forEach(col => {
    db.run(`ALTER TABLE advertisers ADD COLUMN ${col}`, () => {});
  });
});

// Promisified DB helpers
const dbRun = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function(err) { err ? rej(err) : res(this); })
);
const dbGet = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => err ? rej(err) : res(row))
);
const dbAll = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
);

const nowIso = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

// FILE UPLOADS
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed.'));
    cb(null, true);
  }
});

// MIDDLEWARE
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  express.urlencoded({ extended: true })(req, res, () => express.json()(req, res, next));
});
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

// API: PUBLIC slot count — no auth required
app.get('/api/slots', async (req, res) => {
  try {
    const row = await dbGet(
      "SELECT COUNT(*) as count FROM advertisers WHERE status IN ('active','draft') AND payment_status != 'canceled'"
    );
    const filled    = row?.count || 0;
    const total     = 24;
    const remaining = Math.max(0, total - filled);
    return res.json({ filled, total, remaining });
  } catch (error) {
    return res.json({ filled: 0, total: 24, remaining: 24 });
  }
});

// API: CONFIG
app.get('/api/config', (_req, res) => {
  res.json({
    stripeEnabled: Boolean(stripe && STRIPE_PRICE_ID),
    plan: { name: 'Starter', price: 99 },
    limitedSpots: 24,
  });
});

// API: CREATE ADVERTISER
app.post('/api/advertisers', upload.fields([
  { name: 'logo',  maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const {
      businessName, contactName, email, phone, businessAddress,
      website, offerText, adStyle, planName, includeQr, contentRightsAccepted, aiGenerateAd
    } = req.body;

    if (!businessName || !contactName || !email)
      return res.status(400).json({ error: 'Business name, contact name, and email are required.' });
    if (contentRightsAccepted !== 'true')
      return res.status(400).json({ error: 'Please confirm content rights before continuing.' });

    const id        = makeId();
    const createdAt = nowIso();
    const logoPath  = req.files?.logo?.[0]  ? `/uploads/${req.files.logo[0].filename}`  : null;
    const imagePath = req.files?.image?.[0] ? `/uploads/${req.files.image[0].filename}` : null;

    await dbRun(`
      INSERT INTO advertisers (
        id, business_name, contact_name, email, phone, business_address, website,
        offer_text, ad_style, plan_name, include_qr, content_rights_accepted, ai_generate_ad,
        logo_path, image_path, generated_ad_path, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, businessName, contactName, email, phone||null, businessAddress||null,
      website||null, offerText||null, adStyle||'Premium Modern',
      'Starter', includeQr==='true'?1:0, 1,
      aiGenerateAd==='true'?1:0, logoPath, imagePath,
      req.body.previewPath||null, createdAt, createdAt
    ]);

    const advertiser = await dbGet('SELECT * FROM advertisers WHERE id = ?', [id]);
    return res.status(201).json({ advertiser });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not save advertiser.' });
  }
});

// API: STRIPE CHECKOUT
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.json({ stripeNotConfigured: true });

    const { advertiserId } = req.body;
    if (!advertiserId) return res.status(400).json({ error: 'Advertiser ID is required.' });

    const advertiser = await dbGet('SELECT * FROM advertisers WHERE id = ?', [advertiserId]);
    if (!advertiser) return res.status(404).json({ error: 'Advertiser not found.' });

    const priceId = getPriceId();
    if (!priceId) return res.json({ stripeNotConfigured: true });

    const session = await stripe.checkout.sessions.create({
      mode:           'subscription',
      customer_email: advertiser.email,
      line_items:     [{ price: priceId, quantity: 1 }],
      success_url:    `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:     `${BASE_URL}/?payment=cancelled`,
      metadata: { advertiserId: advertiser.id, businessName: advertiser.business_name, planName: advertiser.plan_name },
    });

    await dbRun('UPDATE advertisers SET stripe_checkout_session_id=?, updated_at=? WHERE id=?',
      [session.id, nowIso(), advertiser.id]);

    return res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// API: STRIPE WEBHOOK
app.post('/webhooks/stripe', async (req, res) => {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhook not configured');
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.metadata?.advertiserId) {
        await dbRun(
          `UPDATE advertisers SET status='active', payment_status='active', stripe_customer_id=?, start_date=COALESCE(start_date,?), updated_at=? WHERE id=?`,
          [s.customer||null, nowIso(), nowIso(), s.metadata.advertiserId]
        );
      }
    }
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      await dbRun('UPDATE advertisers SET stripe_subscription_id=?, payment_status=?, updated_at=? WHERE stripe_customer_id=?',
        [sub.id, sub.status, nowIso(), String(sub.customer)]);
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await dbRun('UPDATE advertisers SET status=\'canceled\', payment_status=\'canceled\', end_date=?, updated_at=? WHERE stripe_customer_id=?',
        [nowIso(), nowIso(), String(sub.customer)]);
    }
    return res.json({ received: true });
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// API: ADMIN
app.get('/api/advertisers', async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const advertisers = await dbAll('SELECT * FROM advertisers ORDER BY datetime(created_at) DESC');
  return res.json({ advertisers });
});

app.patch('/api/advertisers/:id', async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { status, payment_status, notes } = req.body;
  await dbRun(
    'UPDATE advertisers SET status=COALESCE(?,status), payment_status=COALESCE(?,payment_status), notes=COALESCE(?,notes), updated_at=? WHERE id=?',
    [status||null, payment_status||null, notes||null, nowIso(), req.params.id]
  );
  return res.json({ advertiser: await dbGet('SELECT * FROM advertisers WHERE id=?', [req.params.id]) });
});

// API: GENERATE AD COPY (Claude via server — avoids browser CORS)
// API: DALL-E IMAGE AD GENERATION
app.post('/api/generate-image-ad', upload.fields([
  { name: 'logo',  maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(400).json({ error: 'OPENAI_API_KEY not configured. Add it in Railway → Variables.' });
    }
    const { businessName, tagline, offerText, adStyle, website } = req.body;
    if (!businessName) return res.status(400).json({ error: 'businessName is required.' });

    const openai = new OpenAI({ apiKey: openaiKey });
    let imageAnalysis = '';
    const uploads = [];
    if (req.files?.logo?.[0])  uploads.push(req.files.logo[0]);
    if (req.files?.image?.[0]) uploads.push(req.files.image[0]);

    if (uploads.length > 0) {
      try {
        const visionContent = [
          { type: 'text', text: 'Analyse these brand assets for a TV advertisement. In 2-3 sentences describe: primary colours and palette, overall style and mood, key visual characteristics. Be concise and design-focused.' },
          ...uploads.map(f => ({ type: 'image_url', image_url: { url: `data:${f.mimetype};base64,${require('fs').readFileSync(f.path).toString('base64')}` } }))
        ];
        const visionRes = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: visionContent }], max_tokens: 150 });
        imageAnalysis = visionRes.choices[0].message.content.trim();
      } catch(e) { console.warn('Vision analysis failed:', e.message); }
    }

    const styles = {
      premium:   `Professional elegant widescreen 16:9 TV ad. Cream background. Business name "${businessName}" large dark serif left side. Right soft photo area. Navy footer bar. Navy, gold, cream palette. Luxury flat design. No people. No watermarks.`,
      cinematic: `Cinematic widescreen 16:9 TV ad. Deep teal gradient background. Business name "${businessName}" large white serif centred. Frosted glass footer strip. Teal, amber, white palette. Film-title aesthetic. No people. No watermarks.`,
      bold:      `Bold high-contrast widescreen 16:9 TV ad. Black background. Business name "${businessName}" enormous white bold sans-serif. Thin teal left accent stripe. Amber underline. Minimal, powerful, modern. No people. No watermarks.`,
      neon:      `Neon widescreen 16:9 TV ad. Very dark background with subtle grid. Business name "${businessName}" glowing teal neon. Radial teal glow orb. Futuristic. No people. No watermarks.`,
      editorial: `Editorial magazine widescreen 16:9 TV ad. Warm cream background two-column. Left: business name "${businessName}" large serif. Right: photo area. Black rule top, orange accents. Magazine style. No people. No watermarks.`,
      retro:     `Vintage retro widescreen 16:9 TV ad. Deep amber-brown background. Double border frame, diamond corners. Business name "${businessName}" serif uppercase centred. 1920s poster. No people. No watermarks.`,
    };

    const key = (adStyle||'premium').toLowerCase();
    const basePrompt = styles[key] || styles.premium;
    const offerClause = offerText ? ` Offer: "${offerText}".` : '';
    const analysisClause = imageAnalysis ? ` Brand style: ${imageAnalysis}` : '';
    const prompt = basePrompt + offerClause + analysisClause;

    const aiRes = await openai.images.generate({ model: 'dall-e-3', prompt, size: '1792x1024', quality: 'hd', n: 1 });
    const imgRes = await fetch(aiRes.data[0].url);
    const buf = await imgRes.arrayBuffer();
    const filename = `dalle-${Date.now()}.png`;
    require('fs').writeFileSync(require('path').join(__dirname, 'uploads', filename), Buffer.from(buf));

    return res.json({ imageUrl: `/uploads/${filename}` });
  } catch (error) {
    console.error('DALL-E error:', error.message);
    return res.status(500).json({ error: error.message || 'Could not generate image ad.' });
  }
});


app.post('/api/generate-copy', async (req, res) => {
  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured.' });
    }

    const { businessName, description, offer, website, adStyle } = req.body;
    if (!businessName) return res.status(400).json({ error: 'businessName is required.' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            anthropicKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Write a punchy, professional 15-second TV ad for a local business advertising inside a dental office. The audience is local families in Gilbert, Arizona.

Business: ${businessName}
Description: ${description || 'A local business in Gilbert, AZ'}
Special offer: ${offer || 'None'}
Website: ${website || 'Not provided'}
Ad style: ${adStyle || 'Premium Modern'}

Respond in JSON only, no markdown, no code fences:
{"tagline":"catchy line max 7 words","body":"one sentence max 15 words","callToAction":"short phrase max 5 words"}`
        }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text   = (data.content || []).map(b => b.text || '').join('');
    const clean  = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.json(parsed);
  } catch (error) {
    console.error('generate-copy error:', error);
    return res.status(500).json({ error: 'Could not generate ad copy.' });
  }
});

// API: FETCH LOGO + TAGLINE FROM WEBSITE
// API: FETCH LOGO + TAGLINE FROM WEBSITE
// Returns logo as base64 to avoid browser CORS on external images
app.get('/api/fetch-logo', async (req, res) => {
  const siteUrl = req.query.url;
  if (!siteUrl) return res.status(400).json({ error: 'url parameter required' });

  const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; CanyonAds/1.0)' };

  const fetchWithTimeout = (url, opts = {}, ms = 6000) => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  const imageToBase64 = async (imgUrl) => {
    try {
      const r = await fetchWithTimeout(imgUrl, { headers: ua }, 5000);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || 'image/png';
      if (!ct.startsWith('image/') && ct !== 'image/x-icon') return null;
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 500) return null;
      return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) { return null; }
  };

  try {
    const parsed = new URL(siteUrl);
    const origin = parsed.origin;
    const domain = parsed.hostname;

    // Fetch HTML for meta tag scanning
    let html = '';
    try {
      const htmlRes = await fetchWithTimeout(origin, { headers: ua });
      if (htmlRes.ok) html = await htmlRes.text();
    } catch(e) { /* continue without HTML */ }

    // ── LOGO: Best-to-worst priority ──────────────────────────────────────────

    // Strategy 1: apple-touch-icon in HTML (high-res, actual brand icon)
    let rawLogoUrl = null;
    if (html) {
      const apple = html.match(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
                 || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon[^"']*["']/i);
      if (apple?.[1]) rawLogoUrl = apple[1].startsWith('http') ? apple[1] : origin + apple[1];
    }

    // Strategy 2: PNG favicon from HTML
    if (!rawLogoUrl && html) {
      const favPng = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+\.png[^"']*)["']/i)
                  || html.match(/<link[^>]+href=["']([^"']+\.png[^"']*)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
      if (favPng?.[1]) rawLogoUrl = favPng[1].startsWith('http') ? favPng[1] : origin + favPng[1];
    }

    // Strategy 3: any icon link tag
    if (!rawLogoUrl && html) {
      const fav = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
               || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
      if (fav?.[1]) rawLogoUrl = fav[1].startsWith('http') ? fav[1] : origin + fav[1];
    }

    // Strategy 4: img tag with "logo" in src/alt/class/id
    if (!rawLogoUrl && html) {
      const logoImg = html.match(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i)
                   || html.match(/<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["']/i);
      if (logoImg?.[1]) {
        const s = logoImg[1];
        rawLogoUrl = s.startsWith('http') ? s : (s.startsWith('/') ? origin + s : origin + '/' + s);
      }
    }

    // Strategy 5: /favicon.ico directly
    if (!rawLogoUrl) rawLogoUrl = origin + '/favicon.ico';

    // Try to convert logo to base64
    let logoUrl = await imageToBase64(rawLogoUrl);

    // Strategy 6: Google's public favicon service (very reliable fallback)
    if (!logoUrl) {
      const googleFaviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
      logoUrl = await imageToBase64(googleFaviconUrl);
    }

    // Strategy 7: DuckDuckGo favicon (second reliable fallback)
    if (!logoUrl) {
      const ddgUrl = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
      logoUrl = await imageToBase64(ddgUrl);
    }

    // ── TAGLINE: Short punchy text ────────────────────────────────────────────
    let siteTagline = null;

    if (html) {
      // 1. twitter:description — usually shorter/punchier
      const twDesc = html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{5,120})["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']{5,120})["'][^>]+name=["']twitter:description["']/i);
      if (twDesc?.[1]) siteTagline = twDesc[1].trim();

      // 2. og:description — trim to first sentence
      if (!siteTagline) {
        const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{5,200})["']/i)
                    || html.match(/<meta[^>]+content=["']([^"']{5,200})["'][^>]+property=["']og:description["']/i);
        if (ogDesc?.[1]) {
          const d = ogDesc[1].trim();
          const first = d.match(/^([^.!?]{10,80}[.!?])/);
          siteTagline = first ? first[1].trim() : d.slice(0, 80).trim();
        }
      }

      // 3. meta description — trim to first sentence
      if (!siteTagline) {
        const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{5,200})["']/i)
                      || html.match(/<meta[^>]+content=["']([^"']{5,200})["'][^>]+name=["']description["']/i);
        if (metaDesc?.[1]) {
          const d = metaDesc[1].trim();
          const first = d.match(/^([^.!?]{10,80}[.!?])/);
          siteTagline = first ? first[1].trim() : d.slice(0, 80).trim();
        }
      }
    }

    return res.json({ logoUrl, rawLogoUrl, siteDescription: siteTagline });

  } catch (error) {
    console.error('fetch-logo error:', error.message);
    return res.status(500).json({ error: 'Could not fetch from that URL. Make sure it starts with https://' });
  }
});






// API: FETCH IMAGES FROM WEBSITE for slideshow ads
// Scrapes og:image, then all meaningful <img> tags, returns as base64 array
app.get('/api/fetch-images', async (req, res) => {
  const siteUrl = req.query.url;
  if (!siteUrl) return res.status(400).json({ error: 'url parameter required' });

  const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; CanyonAds/1.0)' };

  const fetchWithTimeout = (url, opts = {}, ms = 6000) => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  const imageToBase64 = async (imgUrl) => {
    try {
      const r = await fetchWithTimeout(imgUrl, { headers: ua }, 4000);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || 'image/jpeg';
      if (!ct.startsWith('image/')) return null;
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 5000) return null; // skip tiny icons
      return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) { return null; }
  };

  try {
    const parsed = new URL(siteUrl);
    const origin = parsed.origin;

    const htmlRes = await fetchWithTimeout(origin, { headers: ua });
    if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`);
    const html = await htmlRes.text();

    // Collect candidate image URLs — priority order
    const candidates = new Set();

    // 1. og:image (highest quality, usually the hero image)
    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogImg?.[1]) {
      const u = ogImg[1].startsWith('http') ? ogImg[1] : origin + ogImg[1];
      candidates.add(u);
    }

    // 2. twitter:image
    const twImg = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twImg?.[1]) {
      const u = twImg[1].startsWith('http') ? twImg[1] : origin + twImg[1];
      candidates.add(u);
    }

    // 3. All <img src="..."> tags that look like real photos (not icons/logos)
    const imgTags = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
    for (const match of imgTags) {
      const src = match[1];
      // Skip tiny images, icons, base64, and SVGs
      if (!src || src.startsWith('data:') || src.endsWith('.svg')) continue;
      if (src.includes('icon') || src.includes('logo') || src.includes('sprite')) continue;
      const u = src.startsWith('http') ? src : (src.startsWith('/') ? origin + src : origin + '/' + src);
      candidates.add(u);
      if (candidates.size >= 12) break; // enough candidates
    }

    // Download up to 5 images that are real photos (>5KB)
    const results = [];
    for (const url of candidates) {
      if (results.length >= 5) break;
      const b64 = await imageToBase64(url);
      if (b64) results.push(b64);
    }

    return res.json({ images: results, count: results.length });
  } catch (error) {
    console.error('fetch-images error:', error.message);
    return res.status(500).json({ images: [], error: error.message });
  }
});

// ERROR HANDLER
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Request failed.' });
});

app.listen(PORT, () => {
  console.log(`CanyonAds running at ${BASE_URL}`);
  console.log(`Stripe : ${stripe ? 'connected' : 'not configured (payments skipped until added)'}`);
  console.log(`OpenAI : ${process.env.OPENAI_API_KEY ? 'connected' : 'not configured'}`);
});
