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
const STRIPE_PRICE_BASIC    = process.env.STRIPE_PRICE_BASIC || '';
const STRIPE_PRICE_STANDARD = process.env.STRIPE_PRICE_STANDARD || '';
const STRIPE_PRICE_PREMIUM  = process.env.STRIPE_PRICE_PREMIUM || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function getPriceId(planName) {
  return { Basic: STRIPE_PRICE_BASIC, Standard: STRIPE_PRICE_STANDARD, Premium: STRIPE_PRICE_PREMIUM }[planName] || STRIPE_PRICE_STANDARD;
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

// API: CONFIG
app.get('/api/config', (_req, res) => {
  res.json({
    stripeEnabled: Boolean(stripe && STRIPE_PRICE_STANDARD),
    plans: { Basic: { price: 99 }, Standard: { price: 199 }, Premium: { price: 249 } },
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
      planName||'Standard', includeQr==='true'?1:0, 1,
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

    const priceId = getPriceId(advertiser.plan_name);
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

  const fetchWithTimeout = (url, opts = {}, ms = 7000) => {
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
      return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
    } catch (e) { return null; }
  };

  try {
    const parsed = new URL(siteUrl);
    const origin = parsed.origin;

    const htmlRes = await fetchWithTimeout(origin, { headers: ua });
    if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`);
    const html = await htmlRes.text();

    let rawLogoUrl = null;

    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogImg?.[1]) rawLogoUrl = ogImg[1].startsWith('http') ? ogImg[1] : origin + ogImg[1];

    if (!rawLogoUrl) {
      const apple = html.match(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
                 || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon[^"']*["']/i);
      if (apple?.[1]) rawLogoUrl = apple[1].startsWith('http') ? apple[1] : origin + apple[1];
    }

    if (!rawLogoUrl) {
      const fav = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
               || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
      if (fav?.[1]) rawLogoUrl = fav[1].startsWith('http') ? fav[1] : origin + fav[1];
    }

    if (!rawLogoUrl) rawLogoUrl = origin + '/favicon.ico';

    const logoUrl = await imageToBase64(rawLogoUrl);

    let siteDescription = null;
    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{5,160})["']/i)
                || html.match(/<meta[^>]+content=["']([^"']{5,160})["'][^>]+property=["']og:description["']/i);
    if (ogDesc?.[1]) siteDescription = ogDesc[1].trim();

    if (!siteDescription) {
      const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{5,160})["']/i)
                    || html.match(/<meta[^>]+content=["']([^"']{5,160})["'][^>]+name=["']description["']/i);
      if (metaDesc?.[1]) siteDescription = metaDesc[1].trim();
    }

    return res.json({ logoUrl, rawLogoUrl, siteDescription });
  } catch (error) {
    console.error('fetch-logo error:', error.message);
    return res.status(500).json({ error: 'Could not fetch from that URL. Make sure it starts with https://' });
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
