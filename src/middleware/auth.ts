import crypto from 'node:crypto';
import { RequestHandler } from 'express';
import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { env } from '../config/env';
import { AppError, forbidden, unauthorized } from '../utils/errors';

/** Roles this service serves (the authservice `role` claim). Every care provider is `HBC`; their care type lives on their profile. */
export const ROLES = ['SUPER_ADMIN', 'PATIENT', 'HBC'] as const;
export type Role = (typeof ROLES)[number];

export const CARE_TYPES = ['NURSE', 'PHYSIO', 'CARETAKER'] as const;
export type CareType = (typeof CARE_TYPES)[number];

export interface AuthUser {
  id: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const userId = z.string().uuid();
const role = z.enum(ROLES);

function secretMatches(expected: string, given: unknown) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const jwks = env.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)) : undefined;
if (!jwks) {
  console.warn(
    '[auth] AUTH_JWKS_URL is not set: bearer tokens are decoded WITHOUT signature verification (development only). ' +
      'payment-service still verifies the token on every payment.',
  );
}

/** authservice access token: RS256, `sub` = user id, `role` = the account's single role. */
async function fromBearer(token: string): Promise<AuthUser> {
  let payload: JWTPayload;
  try {
    if (jwks) {
      ({ payload } = await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        ...(env.JWT_ISSUER ? { issuer: env.JWT_ISSUER } : {}),
        ...(env.JWT_AUDIENCE.length ? { audience: env.JWT_AUDIENCE } : {}),
      }));
    } else {
      payload = decodeJwt(token);
      if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) throw new joseErrors.JWTExpired('expired', payload);
    }
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired');
    if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new AppError(401, 'INVALID_TOKEN', 'Access token signature is not valid');
    }
    if (err instanceof joseErrors.JOSEError || err instanceof TypeError) {
      throw new AppError(401, 'INVALID_TOKEN', `Access token rejected: ${(err as Error).message}`);
    }
    console.error('[auth] JWKS unavailable:', (err as Error).message);
    throw new AppError(503, 'AUTH_UNAVAILABLE', 'Cannot verify access tokens right now, try again shortly');
  }

  const id = userId.safeParse(payload.sub);
  if (!id.success) throw new AppError(401, 'INVALID_TOKEN', 'Access token `sub` is not a user id');
  const r = role.safeParse(payload.role);
  if (!r.success) throw forbidden(`Role '${String(payload.role)}' cannot use the home care service`);
  return { id: id.data, role: r.data };
}

/** X-User-Id + X-User-Role (what the api-gateway forwards; X-Role is accepted as the older name). */
function fromHeaders(headers: Record<string, unknown>): AuthUser | undefined {
  const rawId = headers['x-user-id'];
  const rawRole = headers['x-user-role'] ?? headers['x-role'];
  if (rawId === undefined && rawRole === undefined) return undefined;

  const id = userId.safeParse(rawId);
  const r = role.safeParse(typeof rawRole === 'string' ? rawRole.trim().toUpperCase() : rawRole);
  if (id.success && r.success) return { id: id.data, role: r.data };

  // Say which header failed and what arrived; an unresolved Postman variable shows up as "{{name}}".
  const details: Record<string, { received: string | null; expected: string }> = {};
  if (!id.success) details['X-User-Id'] = { received: typeof rawId === 'string' ? rawId : null, expected: 'a UUID' };
  if (!r.success) {
    details['X-User-Role'] = { received: typeof rawRole === 'string' ? rawRole : null, expected: `one of ${ROLES.join(', ')}` };
  }
  throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid X-User-Id / X-User-Role headers', details);
}

const bearer = (authorization: string | undefined) =>
  authorization && /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, '').trim() : undefined;

/**
 * Works with or without the api-gateway:
 *  1. Through the gateway (GATEWAY_SHARED_SECRET set and X-Gateway-Secret matches): trust X-User-Id / X-User-Role.
 *  2. Direct call with `Authorization: Bearer <authservice JWT>`: identity comes from the token (verified against
 *     AUTH_JWKS_URL). This is how the apps call HBC today, and the token is forwarded to payment-service on /pay.
 *  3. No GATEWAY_SHARED_SECRET configured: X-User-Id / X-User-Role headers alone are trusted (local testing,
 *     same as hospitalservice). Never in production.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const viaGateway = !!env.GATEWAY_SHARED_SECRET && secretMatches(env.GATEWAY_SHARED_SECRET, req.headers['x-gateway-secret']);
  const token = bearer(req.get('authorization'));
  const headerUser = viaGateway || !env.GATEWAY_SHARED_SECRET ? fromHeaders(req.headers) : undefined;

  let user: AuthUser | undefined;
  if (viaGateway && headerUser) {
    user = headerUser;
  } else if (token) {
    user = await fromBearer(token);
    // A token and headers that disagree mean someone is trying to act as another user.
    if (headerUser && (headerUser.id !== user.id || headerUser.role !== user.role)) {
      throw new AppError(401, 'IDENTITY_MISMATCH', 'X-User-Id / X-User-Role do not match the bearer token');
    }
  } else if (headerUser && env.TRUST_IDENTITY_HEADERS) {
    user = headerUser;
  }

  if (!user) {
    throw unauthorized(
      env.GATEWAY_SHARED_SECRET
        ? 'Send Authorization: Bearer <access token> (or call through the gateway)'
        : 'Send Authorization: Bearer <access token>, or X-User-Id + X-User-Role headers',
    );
  }
  req.user = user;
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };

/** Narrowing helper for handlers mounted behind `authenticate`. */
export function currentUser(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
