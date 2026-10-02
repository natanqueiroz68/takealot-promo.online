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
const fs = require('fs');
const path = require('path');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET      = process.env.WEBHOOK_SECRET;

// ── Vercel config: MUST disable body parser to access raw bytes for HMAC ──────
// If bodyParser is enabled (default), req loses the original byte stream and
// HMAC verification becomes impossible.
const config = {
  api: {
    bodyParser: false,
  },
};

// ── Raw body reader ────────────────────────────────────────────────────────────
// Reads the request stream into a Buffer, respecting a 1 MB size limit.
function readRawBody(req) {
  // If raw body is already provided on req (e.g. by runtime or middleware)
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (typeof req.rawBody === 'string') return Promise.resolve(Buffer.from(req.rawBody, 'utf8'));
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);

  // If stream has already finished or ended
  if (req.readableEnded || req.complete) {
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));
    if (req.body && typeof req.body === 'object') return Promise.resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
    return Promise.resolve(Buffer.alloc(0));
  }

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

// ── Upstash Redis REST helpers ─────────────────────────────────────────────────
async function kv_get(key) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) throw new Error('Redis GET failed: ' + res.status);
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

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

// ── Email template renderer & sender ───────────────────────────────────────────
function renderOrderEmail(order) {
  let template = '';
  try {
    template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
  } catch (err) {
    console.error('[email] Error loading email.index template:', err.message);
    return null;
  }

  const d = new Date(order.received_date || Date.now());
  const del = new Date(order.delivery_date || (Date.now() + 7 * 86400000));

  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  const deliveryDateIso = del.toISOString().slice(0, 10);
  const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;

  return template
    .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
    .replace(/\{\{order_number\}\}/g, order.order_id)
    .replace(/\{\{order_date\}\}/g, orderDateShort)
    .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
    .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
    .replace(/\{\{variant\}\}/g, 'Titan Pro');
}

async function sendOrderConfirmationEmail(order) {
  if (!order.customer_email) {
    return { skipped: true, reason: 'No customer email' };
  }

  const visionSpyKey = process.env.VISIONSPY_API_KEY;
  const resendKey    = process.env.RESEND_API_KEY;
  const sendgridKey  = process.env.SENDGRID_API_KEY;

  if (!visionSpyKey && !resendKey && !sendgridKey) {
    console.log('[email] No email service configured (VISIONSPY_API_KEY / RESEND_API_KEY / SENDGRID_API_KEY not set).');
    return { notConfigured: true };
  }

  const html = renderOrderEmail(order);
  if (!html) return { failed: true, reason: 'Failed to render template' };

  const subject = `Payment Confirmation — Order #${order.order_id}`;

  // ── VisionSpy Ads API (Primary) ─────────────────────────────────────────────
  if (visionSpyKey) {
    const senderId = process.env.VISIONSPY_SENDER_ID || '8ce5156d-4eb9-49c6-af46-fea894020b74';
    try {
      const res = await fetch('https://visionspyads.com/api/public/v1/email/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${visionSpyKey.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Takealot-Order-Notification/1.0',
        },
        body: JSON.stringify({
          sender_id: senderId,
          to: order.customer_email,
          subject,
          html,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || (data && (data.ok === false || data.success === false))) {
        console.error('[email] VisionSpy error:', res.status, data ? (data.error || data.message || data) : 'empty response');
        return { failed: true };
      }
      return { sent: true, messageId: (data && data.id) || null };
    } catch (err) {
      console.error('[email] VisionSpy network error:', err.message);
      return { failed: true };
    }
  }

  // ── Fallback: Resend ────────────────────────────────────────────────────────
  if (resendKey) {
    const fromEmail = process.env.EMAIL_FROM || 'Takealot <orders@takealot-promo.online>';
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [order.customer_email],
          subject,
          html,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.error('[email] Resend error:', res.status, data);
        return { failed: true };
      }
      return { sent: true, messageId: (data && data.id) || null };
    } catch (err) {
      console.error('[email] Resend network error:', err.message);
      return { failed: true };
    }
  }

  // ── Fallback: SendGrid ──────────────────────────────────────────────────────
  if (sendgridKey) {
    const fromEmail = process.env.EMAIL_FROM || 'Takealot <orders@takealot-promo.online>';
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: order.customer_email }] }],
          from: { email: fromEmail.replace(/^.*<([^>]+)>.*$/, '$1') || 'orders@takealot-promo.online', name: 'Takealot' },
          subject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[email] SendGrid error:', res.status, text);
        return { failed: true };
      }
      const messageId = res.headers.get('x-message-id') || null;
      return { sent: true, messageId };
    } catch (err) {
      console.error('[email] SendGrid network error:', err.message);
      return { failed: true };
    }
  }

  return { notConfigured: true };
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
async function handler(req, res) {
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
  // Paw House header: X-Paw-House-Signature (or X-Paw House-Signature)
  const headerKeys = ['x-paw-house-signature', 'x-paw house-signature', 'x-pawhouse-signature'];
  let rawSig = '';
  for (const k of headerKeys) {
    if (req.headers[k]) {
      rawSig = String(req.headers[k]).trim();
      break;
    }
  }

  const hasSignature = !!rawSig;

  if (!hasSignature) {
    console.log('[webhook diagnostic]', {
      hasSecret: !!SECRET,
      hasSignatureHeader: false,
      algorithm: 'HMAC-SHA256',
      rawBodyLength: rawBody ? rawBody.length : 0,
      match: false,
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cleanSecret = SECRET.trim();
  const cleanSig = rawSig.replace(/^sha256[=:]/i, '').trim();

  let isValid = false;

  // Format A: Hexadecimal (64 hex characters -> 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(cleanSig)) {
    try {
      const expectedHex = crypto.createHmac('sha256', cleanSecret).update(rawBody).digest('hex');
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const receivedBuf = Buffer.from(cleanSig, 'hex');
      if (expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        isValid = true;
      }
    } catch {
      isValid = false;
    }
  }

  // Format B: Base64 (44 characters, ending with = or alphanumeric)
  if (!isValid && /^[A-Za-z0-9+/]{43}=*$/.test(cleanSig)) {
    try {
      const expectedB64 = crypto.createHmac('sha256', cleanSecret).update(rawBody).digest('base64');
      const expectedBuf = Buffer.from(expectedB64, 'utf8');
      const receivedBuf = Buffer.from(cleanSig, 'utf8');
      if (expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        isValid = true;
      }
    } catch {
      isValid = false;
    }
  }

  // Safe diagnostic log — strictly boolean / length metrics, NEVER reveals secret, signature or payload
  console.log('[webhook diagnostic]', {
    hasSecret: !!SECRET,
    hasSignatureHeader: true,
    algorithm: 'HMAC-SHA256',
    rawBodyLength: rawBody ? rawBody.length : 0,
    match: isValid,
  });

  if (!isValid) {
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

  // ── Step 7: build order record & apply idempotency ───────────────────────────
  let existing = null;
  try {
    existing = await kv_get('order:' + orderId);
  } catch (err) {
    console.error('[webhook] Redis get error:', err.message);
  }

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
    received_date:  (existing && existing.received_date) || receivedAt,
    delivery_date:  (existing && existing.delivery_date) || deliveredAt,
    // Tracking URL: dynamic with real ID
    tracking_url:   'https://www.takealot-promo.online/tracking.html?order=' + encodeURIComponent(orderId),
    // Status
    status: (existing && existing.status) || 'PROCESSING',
    status_history: (existing && existing.status_history) || [
      { status: 'RECEIVED',   timestamp: receivedAt },
      { status: 'PAID',       timestamp: receivedAt },
      { status: 'PROCESSING', timestamp: now },
    ],
    // Email tracking fields
    email_status:     (existing && existing.email_status) || 'PENDING',
    email_sent_at:    (existing && existing.email_sent_at) || null,
    email_message_id: (existing && existing.email_message_id) || null,
    created_at:       (existing && existing.created_at) || now,
    updated_at:       now,
  };

  // ── Step 8: send post-purchase email (idempotent: only if !== 'SENT') ────────
  if (order.email_status !== 'SENT') {
    const emailRes = await sendOrderConfirmationEmail(order);
    if (emailRes.sent) {
      order.email_status = 'SENT';
      order.email_sent_at = new Date().toISOString();
      order.email_message_id = emailRes.messageId || null;
    } else if (emailRes.failed) {
      order.email_status = 'FAILED';
    } else if (emailRes.notConfigured) {
      order.email_status = 'NOT_CONFIGURED';
    }
  }

  // ── Step 9: persist to Redis ──────────────────────────────────────────────────
  try {
    await kv_set('order:' + orderId, order);
  } catch (err) {
    console.error('[webhook] Redis error:', err.message);
    return res.status(500).json({ error: 'Storage error' });
  }

  console.log('[webhook] saved order:', orderId, '| email_status:', order.email_status);
  return res.status(200).json({ received: true, processed: true, order_id: orderId });
}

handler.config = config;
module.exports = handler;
module.exports.config = config;

