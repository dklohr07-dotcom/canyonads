# CanyonAds — Copper Canyon Dental Advertising Platform

In-office TV advertising sign-up platform. Businesses sign up, AI generates their ad, Stripe handles recurring payments.

---

## Deploy to Railway (step-by-step)

### 1. Create a GitHub account & repo
1. Go to [github.com](https://github.com) and sign up (free)
2. Click **New repository** → name it `canyonads` → click **Create repository**
3. Upload all these project files to the repo (drag & drop in the GitHub UI, or use GitHub Desktop)

### 2. Create a Railway account
1. Go to [railway.app](https://railway.app) and sign up with your GitHub account (free tier available)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `canyonads` repo → Railway will detect Node.js automatically and deploy

### 3. Set environment variables in Railway
In your Railway project dashboard, click **Variables** and add:

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | A strong password you'll use to access the admin panel |
| `STRIPE_SECRET_KEY` | From Stripe Dashboard (use `sk_test_...` to start) |
| `STRIPE_WEBHOOK_SECRET` | From Stripe Dashboard > Webhooks (after step 4) |
| `STRIPE_PRICE_BASIC` | Stripe price ID for $99/mo plan |
| `STRIPE_PRICE_STANDARD` | Stripe price ID for $199/mo plan |
| `STRIPE_PRICE_PREMIUM` | Stripe price ID for $249/mo plan |
| `OPENAI_API_KEY` | Optional — enables DALL-E ad image generation |

Railway sets `BASE_URL` and `PORT` automatically — don't add those.

### 4. Set up Stripe
1. Go to [dashboard.stripe.com](https://dashboard.stripe.com) and create a free account
2. Create **3 products** (Products > Add Product):
   - **CanyonAds Basic** — Recurring, $99/month
   - **CanyonAds Standard** — Recurring, $199/month
   - **CanyonAds Premium** — Recurring, $249/month
3. Copy the `price_...` ID from each product into Railway's environment variables
4. Go to **Developers > Webhooks** → Add endpoint:
   - URL: `https://your-railway-url.railway.app/webhooks/stripe`
   - Events to listen for: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
5. Copy the **Signing secret** (`whsec_...`) into Railway as `STRIPE_WEBHOOK_SECRET`

### 5. Get your live URL
Railway gives you a URL like `https://canyonads-production.up.railway.app`. That's your live site — share it with businesses or use it on a tablet during pitches.

---

## Admin Panel

View all advertisers by visiting:
```
https://your-url.railway.app/api/advertisers?password=YOUR_ADMIN_PASSWORD
```

Returns JSON with every sign-up, their plan, payment status, and Stripe IDs.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy env file and fill in your values
cp .env.example .env

# Start the server
npm start

# Open in browser
open http://localhost:5000
```

---

## Project Structure

```
canyonads/
├── public/
│   ├── index.html      ← Main landing + sign-up page
│   └── success.html    ← Post-payment confirmation page
├── uploads/            ← Auto-created, stores logo/photo uploads
├── server.js           ← Express backend
├── package.json
├── .env.example        ← Copy to .env and fill in values
├── .gitignore
└── README.md
```
