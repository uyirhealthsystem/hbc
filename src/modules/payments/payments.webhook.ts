import crypto from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { applyPaymentCallback } from '../bookings/bookings.service';

/** Reject callbacks signed more than this far from our clock. Retries are re-signed, so this never blocks them. */
const MAX_SKEW_SECONDS = 300;

const callbackSchema = z.object({
  eventId: z.string().min(1).max(128).optional(),
  paymentId: z.string().uuid(),
  referenceType: z.string(),
  referenceId: z.string(),
  payerId: z.string(),
  status: z.enum(['PAID', 'FAILED']),
  amount: z.number().nonnegative(),
  currency: z.string(),
  refundedAmount: z.number().optional(),
  failureReason: z.string().nullable().optional(),
  occurredAt: z.string(),
});
export type PaymentCallback = z.infer<typeof callbackSchema> & { eventId: string };

/** hex(HMAC-SHA256(secret, timestamp + "." + rawBody)), compared in constant time. */
export function signatureValid(secret: string, timestamp: string, rawBody: Buffer, signature: string) {
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const given = signature.trim().toLowerCase();
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * payment-service → HBC: POST /api/v1/hbc/payments/webhook.
 * Not behind the gateway's user auth: the HMAC signature is what authenticates it. Mounted before
 * express.json() because the signature covers the raw bytes.
 */
export const paymentWebhookRouter = Router();

paymentWebhookRouter.post('/webhook', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
  const secret = env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[payments] callback received but PAYMENT_WEBHOOK_SECRET is not set');
    res.status(503).json({ error: { code: 'PAYMENT_WEBHOOK_DISABLED', message: 'Payment callbacks are not configured' } });
    return;
  }

  const timestamp = req.get('X-Payment-Timestamp') ?? '';
  const signature = req.get('X-Payment-Signature') ?? '';
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const ts = Number(timestamp);
  if (!/^[0-9]+$/.test(timestamp) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Missing or stale X-Payment-Timestamp' } });
    return;
  }
  if (!signatureValid(secret, timestamp, raw, signature)) {
    res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'X-Payment-Signature does not match' } });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
    return;
  }
  const parsed = callbackSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[payments] unreadable callback', parsed.error.flatten());
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid callback', details: parsed.error.flatten() } });
    return;
  }
  const event = parsed.data;
  if (event.referenceType !== env.PAYMENT_REFERENCE_TYPE) {
    console.error(`[payments] callback for referenceType ${event.referenceType}, expected ${env.PAYMENT_REFERENCE_TYPE}`);
    res.status(400).json({ error: { code: 'WRONG_REFERENCE_TYPE', message: 'Not a home care payment' } });
    return;
  }

  // Callbacks queued before eventId existed: dedupe on paymentId + status + occurredAt instead.
  const eventId = event.eventId ?? `${event.paymentId}:${event.status}:${event.occurredAt}`;
  const outcome = await applyPaymentCallback({ ...event, eventId });
  if (outcome === 'UNKNOWN_BOOKING') {
    // 4xx makes payment-service retry, which covers a booking write that has not committed yet.
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    return;
  }
  res.json({ received: true, outcome });
});
