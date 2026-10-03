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

const fs = require('fs');
const path = require('path');

// Upstash REST helpers
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

// Self-healing email sender: if order exists but email wasn't sent yet, send it now
async function ensureEmailSent(order) {
  if (!order || order.email_status === 'SENT' || !order.customer_email) return;

  const visionSpyKey = process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY
    || 'vs_live_931aac3659e6c3f0197a5e292333f126c117b2f699d3cea4';
  const senderId = process.env.VISIONSPY_SENDER_ID || '8ce5156d-4eb9-49c6-af46-fea894020b74';

  let html = '';
  try {
    const template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
    const d = new Date(order.received_date || Date.now());
    const del = new Date(order.delivery_date || (Date.now() + 7 * 86400000));
    const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
    const deliveryDateIso = del.toISOString().slice(0, 10);
    const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;

    html = template
      .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
      .replace(/\{\{order_number\}\}/g, order.order_id)
      .replace(/\{\{order_date\}\}/g, orderDateShort)
      .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
      .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
      .replace(/\{\{variant\}\}/g, 'Titan Pro');
  } catch (err) {
    return;
  }

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
        subject: `Payment Confirmation — Order #${order.order_id}`,
        html,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && (data.ok !== false && data.success !== false)) {
      order.email_status = 'SENT';
      order.email_sent_at = new Date().toISOString();
      order.email_message_id = (data && data.id) || null;
      await kv_set('order:' + order.order_id, order).catch(() => {});
    }
  } catch (err) {
    console.error('[order-email] error:', err.message);
  }
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
    email_status:   order.email_status || null,
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

  if (order.email_status !== 'SENT' || req.query.resend === '1') {
    await ensureEmailSent(order);
  }

  return res.status(200).json(publicView(order));
};
