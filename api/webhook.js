// api/webhook.js
// Receives purchase events from paw-house.shop
// Validates webhook secret, creates order record in Upstash Redis.
//
// Required env vars (Vercel dashboard — NEVER in frontend):
//   UPSTASH_REDIS_REST_URL    e.g. https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  Upstash REST token
//   WEBHOOK_SECRET            secret from paw-house.shop webhook settings
//   PRODUCT_IMAGE_DEFAULT     fallback product image URL
//   PRODUCT_IMAGE_DM_C53ZV3U7ET   image URL for the cookware product

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET      = process.env.WEBHOOK_SECRET;

// Upstash REST helper — no SDK, just fetch
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

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Determines if a payment event represents a confirmed/paid transaction.
// ONLY inspects explicit payment status fields — NOT the event name.
// Reason: event="purchase" or event="order_paid" may fire for pending/unpaid orders too.
// The actual payment confirmation must come from status, payment_status, or order.status.
function isPaymentConfirmed(payload) {
  // Collect only explicit payment-status fields — NOT event or event_type
  const statusCandidates = [
    payload.status,
    payload.payment_status,
    payload.order && payload.order.status,
    payload.payment && payload.payment.status,
  ].filter(Boolean).map(s => String(s).trim().toLowerCase());

  if (statusCandidates.length === 0) return false;

  // Accepted values that unambiguously mean "payment received"
  const PAID_VALUES = new Set(['paid','pago','approved','aprovado','completed','confirmed']);

  return statusCandidates.some(s => PAID_VALUES.has(s));
}

module.exports = async function handler(req, res) {
  // Webhook endpoint: server-to-server only — no browser CORS needed
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // ── Secret validation ──────────────────────────────────────────────────
  // Always required — fail closed if SECRET is not configured
  if (!SECRET) {
    console.error('[webhook] WEBHOOK_SECRET env var is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  const provided = (req.headers['x-webhook-secret'] || '').trim();
  // Exact comparison only — no substring/includes check
  if (provided !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body || {};

  if (!isPaymentConfirmed(payload)) {
    return res.status(200).json({ received: true, processed: false, reason: 'Not a confirmed payment event' });
  }

  const orderId = payload.orderId || payload.order_id || payload.reference || null;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const cust          = payload.customer || {};
  const customerName  = cust.name || cust.fullName || payload.name || payload.full_name || '';
  const customerEmail = cust.email || payload.email || '';
  const customerPhone = cust.phone || payload.phone || '';

  const item         = Array.isArray(payload.items) ? payload.items[0] : {};
  const productId    = item.productId || (payload.product && payload.product.id) || payload.productId || '';
  const productName  = item.title || item.name || item.productName
                    || (payload.product && payload.product.name)
                    || payload.productTitle
                    || 'Berlinger Haus 15-Piece Titan Pro Non-Stick Cookware Set';
  const productPrice = item.totalPrice != null ? item.totalPrice : (item.price != null ? item.price : (payload.amount != null ? payload.amount : 97));
  const currency     = item.currency || payload.currency || 'ZAR';

  // Product image: per-product env var or default
  const envKey       = productId ? 'PRODUCT_IMAGE_' + productId.replace(/[^A-Z0-9]/gi, '_').toUpperCase() : '';
  const productImage = (envKey && process.env[envKey]) || process.env.PRODUCT_IMAGE_DEFAULT || '';

  const receivedAt  = payload.createdAt || new Date().toISOString();
  const deliveredAt = addDays(receivedAt, 7);
  const now         = new Date().toISOString();

  const order = {
    order_id:       orderId,
    // PII — stored securely, never exposed via public API
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
    // Status: RECEIVED -> PAID -> PROCESSING (set immediately on payment)
    status: 'PROCESSING',
    status_history: [
      { status: 'RECEIVED',   timestamp: receivedAt },
      { status: 'PAID',       timestamp: receivedAt },
      { status: 'PROCESSING', timestamp: now },
    ],
    created_at: now,
  };

  try {
    await kv_set('order:' + orderId, order);
  } catch (err) {
    console.error('[webhook] Redis error:', err.message);
    return res.status(500).json({ error: 'Storage error' });
  }

  console.log('[webhook] saved order:', orderId, '|', customerName);
  return res.status(200).json({ received: true, processed: true, order_id: orderId });
};
