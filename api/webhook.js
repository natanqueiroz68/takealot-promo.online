// api/webhook.js
// Receives purchase events from paw-house.shop
// Validates Paw House HMAC-SHA256 signature, creates order record in Upstash Redis.
//
// Required env vars (Vercel dashboard — NEVER in frontend):
//   UPSTASH_REDIS_REST_URL    e.g. https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  Upstash REST token
//   WEBHOOK_SECRET            signing secret from paw-house.shop webhook settings
//   PRODUCT_IMAGE_DEFAULT     fallback product image URL
//   PRODUCT_IMAGE_DM_C53ZV3U7ET   image URL for the cookware product
//
// Paw House sends:  X-Paw-House-Signature: <hmac-sha256-hex>
// Signature is computed by Paw House as:  HMAC-SHA256(rawBody, signingSecret)
// We verify by computing the same and comparing with timingSafeEqual.

'use strict';

const crypto = require('crypto');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET      = process.env.WEBHOOK_SECRET;

// ── Vercel config: MUST disable body parser to access raw bytes for HMAC ──────
// If bodyParser is enabled (default), req loses the original byte stream and
// HMAC verification becomes impossible.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

// ── Raw body reader ────────────────────────────────────────────────────────────
// Reads the request stream into a Buffer, respecting a 1 MB size limit.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const MAX_BYTES = 1_048_576; // 1 MB
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// ── Upstash Redis REST helper ──────────────────────────────────────────────────
async function kv_set(key, value) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  if (!res.ok) throw new Error('Redis SET failed: ' + res.status);
  return true;
}

// ── Date helper ────────────────────────────────────────────────────────────────
function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── Payment confirmation check ─────────────────────────────────────────────────
// Only explicit payment-status fields are checked — NOT the event name alone.
// event="purchase" alone is NOT sufficient; status must confirm payment.
function isPaymentConfirmed(payload) {
  const statusCandidates = [
    payload.status,
    payload.payment_status,
    payload.order && payload.order.status,
    payload.payment && payload.payment.status,
  ].filter(Boolean).map(s => String(s).trim().toLowerCase());

  if (statusCandidates.length === 0) return false;

  const PAID_VALUES = new Set(['paid', 'pago', 'approved', 'aprovado', 'completed', 'confirmed']);
  return statusCandidates.some(s => PAID_VALUES.has(s));
}

// ── Main handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── Step 1: fail closed if signing secret is not configured ─────────────────
  if (!SECRET) {
    console.error('[webhook] WEBHOOK_SECRET env var is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  // ── Step 2: read raw body BEFORE any parsing ─────────────────────────────────
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Bad request body' });
  }

  // ── Step 3: verify Paw House HMAC-SHA256 signature ──────────────────────────
  // Header: X-Paw-House-Signature (hex-encoded HMAC-SHA256 of raw body)
  // No fallback headers accepted.
  const receivedSig = (req.headers['x-paw-house-signature'] || '').trim();

  if (!receivedSig) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let expectedSigBuf;
  let receivedSigBuf;

  try {
    const expectedHex = crypto
      .createHmac('sha256', SECRET)
      .update(rawBody)
      .digest('hex');

    // timingSafeEqual requires equal-length Buffers
    expectedSigBuf = Buffer.from(expectedHex, 'hex');
    receivedSigBuf = Buffer.from(receivedSig, 'hex');
  } catch {
    // Malformed signature header (not valid hex, etc.)
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Constant-time comparison — prevents timing-based secret extraction
  if (
    expectedSigBuf.length !== receivedSigBuf.length ||
    !crypto.timingSafeEqual(expectedSigBuf, receivedSigBuf)
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Step 4: parse JSON body (signature is valid at this point) ───────────────
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // ── Step 5: confirm payment status ──────────────────────────────────────────
  if (!isPaymentConfirmed(payload)) {
    return res.status(200).json({
      received: true,
      processed: false,
      reason: 'Not a confirmed payment event',
    });
  }

  // ── Step 6: extract order fields ─────────────────────────────────────────────
  // Supports all known field aliases sent by Paw House / zenofyetsembasms webhook
  const orderId = payload.orderId || payload.order_id || payload.reference || null;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const cust          = payload.customer || {};
  const customerName  = cust.name || cust.fullName || payload.name || payload.full_name || '';
  const customerEmail = cust.email || payload.email || '';
  const customerPhone = cust.phone || payload.phone || '';

  const item         = Array.isArray(payload.items) ? payload.items[0] : {};
  const productId    = item.productId  || item.product_id
                    || (payload.product && payload.product.id)
                    || payload.productId || payload.product_id || '';
  const productName  = item.title || item.name || item.productName || item.product_title
                    || (payload.product && payload.product.name)
                    || payload.productTitle || payload.product_title
                    || 'Berlinger Haus 15-Piece Titan Pro Non-Stick Cookware Set';
  const productPrice = item.totalPrice != null
                    ? item.totalPrice
                    : (item.price != null ? item.price : (payload.amount != null ? payload.amount : 97));
  const currency     = item.currency || payload.currency || 'ZAR';

  // Product image: per-product env var or default
  const envKey       = productId
                    ? 'PRODUCT_IMAGE_' + productId.replace(/[^A-Z0-9]/gi, '_').toUpperCase()
                    : '';
  const productImage = (envKey && process.env[envKey]) || process.env.PRODUCT_IMAGE_DEFAULT || '';

  const receivedAt  = payload.createdAt || new Date().toISOString();
  const deliveredAt = addDays(receivedAt, 7);
  const now         = new Date().toISOString();

  // ── Step 7: build order record ───────────────────────────────────────────────
  const order = {
    order_id:       orderId,
    // PII — stored server-side only, never exposed via GET /api/order
    customer_name:  customerName,
    customer_email: customerEmail,
    customer_phone: customerPhone,
    // Product
    product_id:     productId,
    product_name:   productName,
    product_price:  productPrice,
    currency,
    product_image:  productImage,
    // Dates
    received_date:  receivedAt,
    delivery_date:  deliveredAt,
    // Tracking
    tracking_url:   'https://www.takealot-promo.online/track.html?order=' + encodeURIComponent(orderId),
    // Status: RECEIVED → PAID → PROCESSING (set immediately on confirmed payment)
    status: 'PROCESSING',
    status_history: [
      { status: 'RECEIVED',   timestamp: receivedAt },
      { status: 'PAID',       timestamp: receivedAt },
      { status: 'PROCESSING', timestamp: now },
    ],
    created_at: now,
  };

  // ── Step 8: persist to Redis ──────────────────────────────────────────────────
  try {
    await kv_set('order:' + orderId, order);
  } catch (err) {
    console.error('[webhook] Redis error:', err.message);
    return res.status(500).json({ error: 'Storage error' });
  }

  console.log('[webhook] saved order:', orderId);
  return res.status(200).json({ received: true, processed: true, order_id: orderId });
};
