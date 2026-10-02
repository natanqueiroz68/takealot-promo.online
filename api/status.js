// api/status.js
// Protected status update endpoint.
// Requires header: x-webhook-secret matching STATUS_UPDATE_SECRET env var.
// Secret is NEVER in frontend code.
//
// Usage: POST /api/status
// Headers: x-webhook-secret: YOUR_SECRET
// Body: { "order_id": "T273493929180165", "status": "IN_TRANSIT" }
//
// Allowed statuses: RECEIVED, PAID, PROCESSING, IN_TRANSIT, DELIVERED, CANCELLED
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   STATUS_UPDATE_SECRET

'use strict';

const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPDATE_SECRET = process.env.STATUS_UPDATE_SECRET;

const ALLOWED_STATUSES = ['RECEIVED','PAID','PROCESSING','IN_TRANSIT','DELIVERED','CANCELLED'];
const ORDER_ID_RE = /^[A-Za-z0-9_\-]{4,80}$/;

async function kv_get(key) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
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
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  if (!res.ok) throw new Error('Redis SET failed: ' + res.status);
  return true;
}

module.exports = async function handler(req, res) {
  // Status endpoint: server-to-server only — no browser CORS
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Must have UPDATE_SECRET configured — fail closed with opaque error
  if (!UPDATE_SECRET) {
    console.error('[status] STATUS_UPDATE_SECRET env var is not set');
    return res.status(500).json({ error: 'Internal configuration error' });
  }

  // Validate secret
  const provided = req.headers['x-webhook-secret'] || '';
  if (!provided || provided !== UPDATE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body     = req.body || {};
  const orderId  = (body.order_id || '').trim();
  const newStatus = (body.status || '').trim().toUpperCase();

  if (!orderId)    return res.status(400).json({ error: 'Missing order_id' });
  if (!newStatus)  return res.status(400).json({ error: 'Missing status' });
  if (!ORDER_ID_RE.test(orderId))           return res.status(400).json({ error: 'Invalid order_id format' });
  if (!ALLOWED_STATUSES.includes(newStatus)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  let order;
  try {
    order = await kv_get('order:' + orderId);
  } catch (err) {
    return res.status(503).json({ error: 'Storage read error' });
  }

  if (!order) return res.status(404).json({ error: 'Order not found', order_id: orderId });

  const previousStatus = order.status;
  order.status = newStatus;
  order.status_history = (order.status_history || []).concat([{
    status:    newStatus,
    timestamp: new Date().toISOString(),
  }]);

  try {
    await kv_set('order:' + orderId, order);
  } catch (err) {
    return res.status(500).json({ error: 'Storage write error' });
  }

  console.log('[status] updated:', orderId, previousStatus, '->', newStatus);
  return res.status(200).json({
    updated:          true,
    order_id:         orderId,
    previous_status:  previousStatus,
    current_status:   newStatus,
  });
};
