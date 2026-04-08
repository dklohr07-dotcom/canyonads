const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const OpenAI = require('openai');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';

// ── STRIPE CONFIG (3 tiers) ──────────────────────────────────────────────────
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_BASIC     = process.env.STRIPE_PRICE_BASIC || '';     // $99/mo
const STRIPE_PRICE_STANDARD  = process.env.STRIPE_PRICE_STANDARD || '';  // $199/mo
const STRIPE_PRICE_PREMIUM   = process.env.STRIPE_PRICE_PREMIUM || '';   // $249/mo
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Map plan names to Stripe price IDs
function getPriceId(planName) {
  const map = {
    'Basic':    STRIPE_PRICE_BASIC,
    'Standard': STRIPE_PRICE_STANDARD,
    'Premium':  STRIPE_PRICE_PREMIUM,
  };
  return map[planName] || STRIPE_PRICE_STANDARD;
}

// ── PATHS ─────────────────────────────────────────────────────────────────────
const rootDir    = __dirname;
const publicDir  = path.join(rootDir, 'public');
const uploadsDir = path.join(rootDir, 'uploads');
const dbPath     = path.join(rootDir, 'data.sqlite');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS advertisers (
    id                        TEXT PRIMARY KEY,
    business_name             TEXT NOT NULL,
    contact_name              TEXT NOT NULL,
    email                     TEXT NOT NULL,
    phone                     TEXT,
    business_address          TEXT,
    website                   TEXT,
    offer_text                TEXT,
    ad_style                  TEXT,
    plan_name                 TEXT DEFAULT 'Standard',
    include_qr                INTEGER DEFAULT 1,
    content_rights_accepted   INTEGER DEFAULT 0,
    ai_generate_ad            INTEGER DEFAULT 0,
    logo_path                 TEXT,
    image_path                TEXT,
    generated_ad_path         TEXT,
    status                    TEXT DEFAULT 'draft',
    payment_status            TEXT DEFAULT 'pending',
    stripe_customer_id        TEXT,
    stripe_checkout_session_id TEXT,
    stripe_subscription_id    TEXT,
    start_date                TEXT,
    end_date                  TEXT,
    notes                     TEXT,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  )
`);

// Safe column additions for existing databases
const safeAlter = (sql) => { try { db.exec(sql); } catch (_) {} };
safeAlter('ALTER TABLE advertisers ADD COLUMN business_address TEXT');
safeAlter('ALTER TABLE advertisers ADD COLUMN website TEXT');
safeAlter('ALTER TABLE advertisers ADD COLUMN ai_generate_ad INTEGER DEFAULT 0');
safeAlter('ALTER TABLE advertisers ADD COLUMN generated_ad_path TEXT');
safeAlter('ALTER TABLE advertisers ADD COLUMN plan_name TEXT DEFAULT \'Standard\'');

// ── FILE UPLOADS ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
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

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  express.urlencoded({ extended: true })(req, res, () => {
    express.json()(req, res, next);
  });
});
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

// ── HELPERS ───────────────────────────────────────────────────────────────────
const nowIso  = () => new Date().toISOString();
const makeId  = () => crypto.randomUUID();
const getAdv  = (id) => db.prepare('SELECT * FROM advertisers WHERE id = ?').get(id);

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Config endpoint — lets the front-end know what's available
app.get('/api/config', (_req, res) => {
  res.json({
    stripeEnabled: Boolean(stripe && (STRIPE_PRICE_BASIC || STRIPE_PRICE_STANDARD)),
    plans: {
      Basic:    { price: 99,  priceId: STRIPE_PRICE_BASIC },
      Standard: { price: 199, priceId: STRIPE_PRICE_STANDARD },
      Premium:  { price: 249, priceId: STRIPE_PRICE_PREMIUM },
    },
    limitedSpots: 24,
  });
});

// Create advertiser record
app.post('/api/advertisers', upload.fields([
  { name: 'logo',  maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), (req, res) => {
  try {
    const {
      businessName, contactName, email, phone, businessAddress,
      website, offerText, adStyle, planName, includeQr, contentRightsAccepted, aiGenerateAd
    } = req.body;

    if (!businessName || !contactName || !email) {
      return res.status(400).json({ error: 'Business name, contact name, and email are required.' });
    }
    if (contentRightsAccepted !== 'true') {
      return res.status(400).json({ error: 'Please confirm content rights before continuing.' });
    }

    const id        = makeId();
    const createdAt = nowIso();
    const logoPath  = req.files?.logo?.[0]  ? `/uploads/${req.files.logo[0].filename}`  : null;
    const imagePath = req.files?.image?.[0] ? `/uploads/${req.files.image[0].filename}` : null;

    db.prepare(`
      INSERT INTO advertisers (
        id, business_name, contact_name, email, phone, business_address, website,
        offer_text, ad_style, plan_name, include_qr, content_rights_accepted, ai_generate_ad,
        logo_path, image_path, generated_ad_path, created_at, updated_at
      ) VALUES (
        @id, @business_name, @contact_name, @email, @phone, @business_address, @website,
        @offer_text, @ad_style, @plan_name, @include_qr, @content_rights_accepted, @ai_generate_ad,
        @logo_path, @image_path, @generated_ad_path, @created_at, @updated_at
      )
    `).run({
      id,
      business_name:           businessName,
      contact_name:            contactName,
      email,
      phone:                   phone || null,
      business_address:        businessAddress || null,
      website:                 website || null,
      offer_text:              offerText || null,
      ad_style:                adStyle || 'Premium Modern',
      plan_name:               planName || 'Standard',
      include_qr:              includeQr === 'true' ? 1 : 0,
      content_rights_accepted: 1,
      ai_generate_ad:          aiGenerateAd === 'true' ? 1 : 0,
      logo_path:               logoPath,
      image_path:              imagePath,
      generated_ad_path:       req.body.previewPath || null,
      created_at:              createdAt,
      updated_at:              createdAt,
    });

    return res.status(201).json({ advertiser: getAdv(id) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not save advertiser.' });
  }
});

// Create Stripe checkout session — uses the correct price ID for each plan
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      // Stripe not yet configured — sign-up is saved, just skip payment
      return res.json({ stripeNotConfigured: true });
    }

    const { advertiserId } = req.body;
    if (!advertiserId) return res.status(400).json({ error: 'Advertiser ID is required.' });

    const advertiser = getAdv(advertiserId);
    if (!advertiser) return res.status(404).json({ error: 'Advertiser not found.' });

    const priceId = getPriceId(advertiser.plan_name);
    if (!priceId) {
      return res.status(400).json({
        error: `No Stripe price configured for the "${advertiser.plan_name}" plan. Add STRIPE_PRICE_${advertiser.plan_name.toUpperCase()} to your environment variables.`
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode:           'subscription',
      customer_email: advertiser.email,
      line_items:     [{ price: priceId, quantity: 1 }],
      success_url:    `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:     `${BASE_URL}/?payment=cancelled`,
      metadata: {
        advertiserId: advertiser.id,
        businessName: advertiser.business_name,
        planName:     advertiser.plan_name,
      },
    });

    db.prepare(`UPDATE advertisers SET stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?`)
      .run(session.id, nowIso(), advertiser.id);

    return res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not create Stripe checkout session.' });
  }
});

// Stripe webhook handler
app.post('/webhooks/stripe', (req, res) => {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(400).send('Stripe webhook not configured');
    }

    const sig   = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session      = event.data.object;
      const advertiserId = session.metadata?.advertiserId;
      if (advertiserId) {
        db.prepare(`
          UPDATE advertisers
          SET status = 'active', payment_status = 'active',
              stripe_customer_id = ?, start_date = COALESCE(start_date, ?), updated_at = ?
          WHERE id = ?
        `).run(session.customer || null, nowIso(), nowIso(), advertiserId);
      }
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub        = event.data.object;
      const customerId = String(sub.customer || '');
      db.prepare(`UPDATE advertisers SET stripe_subscription_id = ?, payment_status = ?, updated_at = ? WHERE stripe_customer_id = ?`)
        .run(sub.id, sub.status, nowIso(), customerId);
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub        = event.data.object;
      const customerId = String(sub.customer || '');
      db.prepare(`UPDATE advertisers SET status = 'canceled', payment_status = 'canceled', end_date = ?, updated_at = ? WHERE stripe_customer_id = ?`)
        .run(nowIso(), nowIso(), customerId);
    }

    return res.json({ received: true });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// AI ad preview generation (OpenAI DALL-E)
app.post('/api/preview-ad', upload.fields([
  { name: 'logo',  maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(400).json({ error: 'AI image generation requires an OPENAI_API_KEY environment variable.' });
    }

    const { businessName, adStyle, offerText, website } = req.body;
    const openai = new OpenAI({ apiKey: openaiKey });

    // Vision analysis of uploaded brand assets
    const uploadedFiles = [];
    if (req.files?.logo?.[0])  uploadedFiles.push(req.files.logo[0]);
    if (req.files?.image?.[0]) uploadedFiles.push(req.files.image[0]);

    let imageAnalysis = '';
    if (uploadedFiles.length > 0) {
      const visionContent = [
        {
          type: 'text',
          text: 'Analyze these brand assets for a TV advertisement. In 2-3 sentences describe: the primary colors and palette, the overall style and mood, and any key visual characteristics that should carry into a professional TV ad layout. Be concise and design-focused.'
        },
        ...uploadedFiles.map(file => ({
          type: 'image_url',
          image_url: { url: `data:${file.mimetype};base64,${fs.readFileSync(file.path).toString('base64')}` }
        }))
      ];
      const visionRes = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: visionContent }],
        max_tokens: 150,
      });
      imageAnalysis = visionRes.choices[0].message.content.trim();
    }

    const websiteClause = website ? ` This business's website is ${website} — use it as brand style reference.` : '';
    const offerClause   = offerText ? `Feature this special offer prominently: "${offerText}".` : 'No promotional offer — focus on brand presence.';
    const analysisClause = imageAnalysis ? ` Brand asset analysis: ${imageAnalysis} Reflect these colors and aesthetic throughout.` : '';

    const styleBase = {
      'Premium Modern': `Professional, elegant widescreen TV advertisement. Warm cream background. Business name "${businessName || 'Your Business'}" in large sophisticated dark sans-serif on the left. ${offerClause} Right side has a soft light photo placeholder. Dark navy footer bar at bottom with a small QR code. Color palette: navy, gold accents, cream, white. Style: luxury, understated elegance. Flat graphic design, no people. No watermarks.`,
      'Clean Minimal':  `Clean, minimal widescreen TV advertisement. Pure white background. Business name "${businessName || 'Your Business'}" in bold modern sans-serif, left-aligned with a teal underline. ${offerClause} Right panel in soft sage green with geometric shapes. Small QR code lower right. Color palette: white, sage green, teal, charcoal. Flat design, no photos. No watermarks.`,
      'Classic Bold':   `Bold, high-impact widescreen TV advertisement. Deep navy left half, white right half. Business name "${businessName || 'Your Business'}" in very large bold white sans-serif. ${offerClause} Right side: large pale photo area. Bright accent star-burst shape lower center. QR code lower right. Color palette: deep navy, bright orange accent, white. No watermarks.`,
    };

    const prompt = (styleBase[adStyle] || styleBase['Premium Modern']) + websiteClause + analysisClause;

    const aiResponse = await openai.images.generate({ model: 'dall-e-3', prompt, size: '1792x1024', quality: 'hd', n: 1 });
    const imageUrl   = aiResponse.data[0].url;
    const imageRes   = await fetch(imageUrl);
    const buffer     = await imageRes.arrayBuffer();
    const filename   = `preview-${Date.now()}.png`;
    fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(buffer));

    return res.json({ previewPath: `/uploads/${filename}` });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not generate preview: ' + (error.message || 'Unknown error') });
  }
});

// Admin: list all advertisers (password protected)
app.get('/api/advertisers', (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const advertisers = db.prepare('SELECT * FROM advertisers ORDER BY datetime(created_at) DESC').all();
  return res.json({ advertisers });
});

// Admin: update advertiser status
app.patch('/api/advertisers/:id', (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { status, payment_status, notes } = req.body;
  db.prepare(`UPDATE advertisers SET status = COALESCE(?, status), payment_status = COALESCE(?, payment_status), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`)
    .run(status || null, payment_status || null, notes || null, nowIso(), req.params.id);
  return res.json({ advertiser: getAdv(req.params.id) });
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Request failed.' });
});

app.listen(PORT, () => {
  console.log(`✅ CanyonAds running at ${BASE_URL}`);
  console.log(`   Stripe: ${stripe ? '✓ connected' : '✗ not configured (add STRIPE_SECRET_KEY)'}`);
  console.log(`   OpenAI: ${process.env.OPENAI_API_KEY ? '✓ connected' : '✗ not configured (add OPENAI_API_KEY)'}`);
});
