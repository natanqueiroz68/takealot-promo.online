// api/order.js
// Public order lookup — returns ONLY tracking-safe fields.
// PII (email, phone, address) is NEVER returned.
//
// Usage: GET /api/order?id=T273493929180165
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Upstash REST helper
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

// Only alphanumeric + dash + underscore, 4-80 chars
const ORDER_ID_RE = /^[A-Za-z0-9_\-]{4,80}$/;

// Public projection — no PII
function publicView(order) {
  return {
    order_id:       order.order_id,
    product_name:   order.product_name,
    product_price:  order.product_price,
    currency:       order.currency,
    product_image:  order.product_image,
    received_date:  order.received_date,
    delivery_date:  order.delivery_date,
    tracking_url:   order.tracking_url,
    status:         order.status,
    status_history: (order.status_history || []).map(function(e) {
      return { status: e.status, timestamp: e.timestamp };
    }),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const orderId = (req.query.order || req.query.id || req.query.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Missing ?order= parameter' });
  if (!ORDER_ID_RE.test(orderId)) return res.status(400).json({ error: 'Invalid order id format' });

  let order;
  try {
    order = await kv_get('order:' + orderId);
  } catch (err) {
    console.error('[order] Redis error:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  if (!order) {
    return res.status(404).json({ error: 'Order not found', order_id: orderId });
  }

  return res.status(200).json(publicView(order));
};
