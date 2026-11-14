import crypto from 'node:crypto';
import { env } from '../../config/env';
import type { AuthUser } from '../../middleware/auth';
import { AppError, unauthorized } from '../../utils/errors';

/** payment-service's status set is fixed: refunds show up in refundedAmount, never here. */
export type PaymentServiceStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface PaymentIntent {
  id: string;
  status: PaymentServiceStatus;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  referenceType: string;
  referenceId: string;
  payerId: string;
  amount: number;
  currency: string;
  refundedAmount: number;
  failureReason: string | null;
}

/** How the patient is identified to payment-service: there is no service-to-service credential. */
export interface PayerCredentials {
  user: AuthUser;
  /** The patient's `Authorization: Bearer ...` header, forwarded by the gateway. */
  authorization?: string;
}

export const idempotencyKey = (bookingId: string) => `hbc-booking-${bookingId}`;

function identityHeaders(payer: PayerCredentials): Record<string, string> {
  if (env.PAYMENT_SEND_IDENTITY_HEADERS) {
    return { 'X-User-Id': payer.user.id, 'X-User-Role': payer.user.role };
  }
  if (!payer.authorization?.toLowerCase().startsWith('bearer ')) {
    throw unauthorized("Payment requires the patient's bearer token (Authorization header) to be forwarded");
  }
  return { Authorization: payer.authorization };
}

/** Problem-details errors from payment-service, mapped to what the app should do. */
async function toAppError(res: Response): Promise<AppError> {
  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    detail = undefined;
  }
  const message =
    (detail && typeof detail === 'object' && 'detail' in detail && typeof detail.detail === 'string' && detail.detail) ||
    `payment-service answered ${res.status}`;

  if (res.status === 503) {
    return new AppError(503, 'PAYMENT_UNAVAILABLE', 'Payments are temporarily unavailable, try again shortly', {
      retryAfter: res.headers.get('retry-after'),
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new AppError(502, 'PAYMENT_AUTH_FAILED', `payment-service rejected the patient's identity: ${message}`);
  }
  console.error(`[payments] payment-service ${res.status}:`, detail);
  return new AppError(502, 'PAYMENT_REJECTED', `The payment could not be started: ${message}`);
}

/**
 * Creates the payment for a booking, or returns the existing one: the key is derived from the booking id,
 * so calling again is always safe (same checkout while it is valid, a fresh one after it expired or failed).
 */
export async function createPaymentIntent(
  payer: PayerCredentials,
  booking: { id: string; amount: number; description: string },
): Promise<PaymentIntent> {
  if (env.PAYMENT_PROVIDER === 'mock') return mockIntent(payer, booking);
  if (!env.PAYMENT_SERVICE_URL) {
    throw new AppError(503, 'PAYMENT_UNAVAILABLE', 'Payments are not configured (PAYMENT_SERVICE_URL)');
  }

  let res: Response;
  try {
    res = await fetch(`${env.PAYMENT_SERVICE_URL}/api/payments/intents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': idempotencyKey(booking.id),
        ...identityHeaders(payer),
      },
      body: JSON.stringify({
        referenceType: env.PAYMENT_REFERENCE_TYPE,
        referenceId: booking.id,
        payerId: payer.user.id,
        amount: booking.amount,
        currency: 'INR',
        description: booking.description.slice(0, 500),
      }),
      signal: AbortSignal.timeout(env.PAYMENT_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[payments] payment-service unreachable:', (err as Error).message);
    throw new AppError(503, 'PAYMENT_UNAVAILABLE', 'Payments are temporarily unavailable, try again shortly');
  }

  if (!res.ok) throw await toAppError(res);
  const intent = (await res.json()) as PaymentIntent;

  // Never trust a payment that is not for this booking and amount.
  if (
    intent.referenceType !== env.PAYMENT_REFERENCE_TYPE ||
    intent.referenceId !== booking.id ||
    toPaise(intent.amount) !== toPaise(booking.amount)
  ) {
    console.error('[payments] intent does not match the booking', { bookingId: booking.id, intent });
    throw new AppError(502, 'PAYMENT_MISMATCH', 'payment-service returned a payment for a different booking or amount');
  }
  return intent;
}

if (env.PAYMENT_PROVIDER === 'mock') {
  console.warn('[payments] PAYMENT_PROVIDER=mock: every booking payment is PAID at once. Never enable this in production.');
}

/** LOCAL TESTING ONLY (PAYMENT_PROVIDER=mock): paid immediately, no payment-service, no token needed. */
function mockIntent(payer: PayerCredentials, booking: { id: string; amount: number }): PaymentIntent {
  // Deterministic per booking, so paying twice settles the same payment (like the real Idempotency-Key).
  const h = crypto.createHash('sha256').update(idempotencyKey(booking.id)).digest('hex');
  return {
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
    status: 'PAID',
    checkoutUrl: null,
    checkoutExpiresAt: null,
    referenceType: env.PAYMENT_REFERENCE_TYPE,
    referenceId: booking.id,
    payerId: payer.user.id,
    amount: Number(booking.amount),
    currency: 'INR',
    refundedAmount: 0,
    failureReason: null,
  };
}

/** Exact for amounts with at most 2 decimals. */
export const toPaise = (amount: number) => Math.round(Number(amount) * 100);
