import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  // ---- Who is calling (see src/middleware/auth.ts) ----
  // Optional: once the api-gateway is in front, it sends this as X-Gateway-Secret with X-User-Id / X-User-Role.
  GATEWAY_SHARED_SECRET: z.string().min(16).optional(),
  // authservice JWKS, e.g. http://auth-service:4000/.well-known/jwks.json. Verifies `Authorization: Bearer` tokens
  // sent straight to this service. Unset = tokens are only decoded (development only; required in production).
  AUTH_JWKS_URL: z.string().url().optional(),
  // Enforced only when set (authservice tokens carry no fixed issuer).
  JWT_ISSUER: z.string().min(1).optional(),
  // Comma-separated allowed `aud` (portal clientIds). Empty = any audience.
  JWT_AUDIENCE: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  // Without a gateway secret: believe X-User-Id / X-User-Role with no token (local testing, like hospitalservice).
  // Defaults to true outside production; production refuses to start with it.
  TRUST_IDENTITY_HEADERS: z.enum(['true', 'false']).optional(),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Providers see bookings in their own pincode, or within this many km of their coordinates.
  SERVICE_RADIUS_KM: z.coerce.number().positive().default(10),

  // ---- Uyir payment-service (docs/IMPLEMENTATION_GUIDE.md in payment-service) ----
  // Base URL, e.g. http://payment-service:8083 (direct) or http://api-gateway:8080 (through the gateway).
  PAYMENT_SERVICE_URL: z
    .string()
    .url()
    .optional()
    .transform((u) => u?.replace(/\/+$/, '')),
  // Signs payment-service's callbacks; equals payment-service's HOMECARE_PAYMENT_WEBHOOK_SECRET.
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Must be registered in payment-service as payment.consumers[<this>].
  PAYMENT_REFERENCE_TYPE: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('HOME_CARE_BOOKING'),
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // http = payment-service (Razorpay); mock = every booking payment is PAID at once (local testing only).
  PAYMENT_PROVIDER: z.enum(['http', 'mock']).default('http'),
  // Local development only: send X-User-Id / X-User-Role instead of forwarding the patient's bearer token
  // (payment-service's `local` profile trusts those headers).
  PAYMENT_SEND_IDENTITY_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const isProduction = parsed.data.NODE_ENV === 'production';
const trustIdentityHeaders = (parsed.data.TRUST_IDENTITY_HEADERS ?? (isProduction ? 'false' : 'true')) === 'true';

if (isProduction) {
  const fail = (msg: string) => {
    console.error(`Invalid environment configuration: ${msg}`);
    process.exit(1);
  };
  if (trustIdentityHeaders) fail('TRUST_IDENTITY_HEADERS is for local development only');
  if (!parsed.data.AUTH_JWKS_URL) fail('AUTH_JWKS_URL is required in production (bearer tokens must be verified)');
  if (parsed.data.PAYMENT_PROVIDER === 'mock') fail('PAYMENT_PROVIDER=mock is for local development only');
  const missing = (['PAYMENT_SERVICE_URL', 'PAYMENT_WEBHOOK_SECRET'] as const).filter((k) => !parsed.data[k]);
  if (missing.length) {
    console.error(`Invalid environment configuration: ${missing.join(', ')} required in production`);
    process.exit(1);
  }
  if (parsed.data.PAYMENT_SEND_IDENTITY_HEADERS) {
    console.error('Invalid environment configuration: PAYMENT_SEND_IDENTITY_HEADERS is for local development only');
    process.exit(1);
  }
}

export const env = { ...parsed.data, TRUST_IDENTITY_HEADERS: trustIdentityHeaders };
