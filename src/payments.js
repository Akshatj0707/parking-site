'use strict';

const crypto = require('crypto');

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Compare two strings without leaking, through timing, how many characters matched.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Razorpay Checkout returns razorpay_signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret), as hex.
function verifyPaymentSignature(keySecret, orderId, paymentId, signature) {
  return safeEqual(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

// Webhooks send X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook secret), as hex.
function verifyWebhookSignature(webhookSecret, rawBody, signature) {
  return typeof signature === 'string' && signature.length > 0 && safeEqual(hmacHex(webhookSecret, rawBody), signature);
}

function createRazorpayClient(config) {
  if (!config.razorpay.configured) return null;
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
}

module.exports = { hmacHex, safeEqual, verifyPaymentSignature, verifyWebhookSignature, createRazorpayClient };
