/**
 * End-to-end smoke test of the full booking flow for NURSE, PHYSIO and CARETAKER.
 * Requires a running server (npm run dev). Requests carry X-User-Id / X-Role exactly as the gateway would
 * forward them after validating the access token (set GATEWAY_SHARED_SECRET in .env to also send X-Gateway-Secret).
 *   BASE_URL=http://localhost:4000/api/v1/hbc npm run test:e2e
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}/api/v1/hbc`;
const run = Date.now().toString().slice(-8);
let passed = 0;

interface Identity {
  id: string;
  role: string;
}

/** What the gateway attaches after validating the caller's token. */
function gatewayHeaders(user: Identity): Record<string, string> {
  return {
    'x-user-id': user.id,
    'x-role': user.role,
    ...(process.env.GATEWAY_SHARED_SECRET ? { 'x-gateway-secret': process.env.GATEWAY_SHARED_SECRET } : {}),
  };
}

async function call(method: string, path: string, opts: { as?: Identity; body?: unknown; expect?: number | number[] } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.as ? gatewayHeaders(opts.as) : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  const expected = opts.expect ?? (method === 'POST' ? [200, 201] : [200]);
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  assert.ok(ok, `${method} ${path} -> ${res.status} (expected ${expected}): ${text}`);
  passed++;
  return data;
}

// ---- payment-service ----
// The pay step needs payment-service running (`local` profile = mock provider) with
// HOMECARE_PAYMENT_WEBHOOK_URL pointing at this server. The webhook checks only need PAYMENT_WEBHOOK_SECRET.
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET;

/** POSTs a payment-service callback, signed the way payment-service signs it. */
async function sendCallback(event: Record<string, unknown>, opts: { expect: number; secret?: string; skewSeconds?: number }) {
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000) - (opts.skewSeconds ?? 0));
  const sig = crypto
    .createHmac('sha256', opts.secret ?? WEBHOOK_SECRET ?? '')
    .update(`${ts}.${raw}`)
    .digest('hex');
  const res = await fetch(`${BASE}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-timestamp': ts, 'x-payment-signature': sig },
    body: raw,
  });
  const text = await res.text();
  assert.equal(res.status, opts.expect, `POST /payments/webhook -> ${res.status} (expected ${opts.expect}): ${text}`);
  passed++;
  return text ? JSON.parse(text) : undefined;
}

const callback = (bookingId: string, payerId: string, extra: Record<string, unknown> = {}) => ({
  eventId: crypto.randomUUID(),
  paymentId: crypto.randomUUID(),
  referenceType: process.env.PAYMENT_REFERENCE_TYPE ?? 'HOME_CARE_BOOKING',
  referenceId: bookingId,
  bookingId,
  payerId,
  status: 'PAID',
  amount: 750.0,
  currency: 'INR',
  refundedAmount: 0.0,
  failureReason: null,
  occurredAt: new Date().toISOString(),
  ...extra,
});

/** The booking turns PAID on payment-service's callback, which follows the intent within a few seconds. */
async function waitForStatus(id: string, as: Identity, status: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const b = await call('GET', `/patient/bookings/${id}`, { as });
    if (b.status === status || Date.now() > until) return b;
    await new Promise((r) => setTimeout(r, 500));
  }
}

let seq = 0;
const uniquePhone = () => `+91${run}${String(++seq).padStart(2, '0')}`;

// Real places, so the distance rule is exercised with real numbers.
const T_NAGAR = { pincode: '600017', latitude: 13.0418, longitude: 80.2341 }; // provider base + main booking
const ADYAR = { pincode: '600020', latitude: 13.0012, longitude: 80.2565 }; // ~5 km away, other pincode
const COIMBATORE = { pincode: '641001', latitude: 11.0168, longitude: 76.9558 }; // ~430 km away

/** Users come from the external auth service; here they are just ids + roles, as the gateway forwards them. */
const identity = (role: string): Identity => ({ id: crypto.randomUUID(), role });

async function main() {
  // ---- gateway identity / super admin (lives in a separate service) ----
  const admin = identity('SUPER_ADMIN');
  await call('POST', '/admin/catalog/services', { body: {}, expect: 401 });
  await call('POST', '/admin/catalog/services', { as: { id: 'not-a-uuid', role: 'SUPER_ADMIN' }, body: {}, expect: 401 });
  await call('POST', '/admin/catalog/services', { as: { id: admin.id, role: 'ROOT' }, body: {}, expect: 401 });

  const pTok = identity('PATIENT');
  await call('POST', '/admin/catalog/services', { as: pTok, body: {}, expect: 403 });
  await call('POST', '/provider/profile', { as: pTok, body: {}, expect: 403 });
  const contact = {
    patientName: 'Test Patient',
    patientPhone: uniquePhone(),
    address: '12 Gandhi Street, T Nagar',
    city: 'Chennai',
    ...T_NAGAR,
  };
  const book = (serviceId: string, extra: Record<string, unknown> = {}, expect = 201) =>
    call('POST', '/patient/bookings', {
      as: pTok,
      body: { serviceId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), ...contact, ...extra },
      expect,
    });

  for (const careType of ['NURSE', 'PHYSIO', 'CARETAKER'] as const) {
    // ---- super admin creates the catalog ----
    const service = await call('POST', '/admin/catalog/services', {
      as: admin,
      body: { careType, name: `${careType} visit ${run}`, description: 'Home visit', price: 750, durationMinutes: 60 },
      expect: 201,
    });
    const catalog = await call('GET', `/catalog/services?careType=${careType}`);
    assert.ok(catalog.some((s: { id: string }) => s.id === service.id));

    // ---- providers (X-Role: HBC) register their profile with a care type and location; no verification ----
    const register = async (n: number, type: string = careType, place = T_NAGAR) => {
      const who = identity('HBC');
      const profile = await call('POST', '/provider/profile', {
        as: who,
        body: {
          careType: type,
          fullName: `${type} Provider ${n}`,
          phone: uniquePhone(),
          ...place,
          licenseNo: `LIC-${run}-${n}`,
          experienceYears: 3,
        },
        expect: 201,
      });
      assert.equal(profile.id, who.id);
      assert.equal(profile.careType, type);
      assert.equal(profile.pincode, place.pincode);
      assert.equal(profile.latitude, place.latitude);
      assert.equal(profile.isVerified, undefined, 'no verification step');
      assert.equal(profile.email, undefined, 'profile has no email');
      return who;
    };
    const provider = await register(1);
    const rival = await register(2);
    const vTok = provider;
    await call('POST', '/provider/profile', { as: provider, body: { careType, fullName: 'Again', phone: uniquePhone(), ...T_NAGAR }, expect: 409 });
    await call('POST', '/provider/profile', { as: identity('HBC'), body: { fullName: 'No Type', phone: uniquePhone(), ...T_NAGAR }, expect: 400 });
    await call('POST', '/provider/profile', { as: identity('HBC'), body: { careType, fullName: 'No Place', phone: uniquePhone() }, expect: 400 });
    await call('POST', '/provider/profile', {
      as: identity('HBC'),
      body: { careType, fullName: 'Bad Lat', phone: uniquePhone(), ...T_NAGAR, latitude: 123 },
      expect: 400,
    });
    await call('POST', '/provider/profile', { as: identity(careType), body: { careType, fullName: 'Old Role', phone: uniquePhone(), ...T_NAGAR }, expect: 401 });
    await call('PATCH', '/provider/profile', { as: provider, body: { latitude: 13.05 }, expect: 400 }); // lat + lng together
    await call('PATCH', '/provider/profile', { as: provider, body: { careType: 'CARETAKER' }, expect: 400 }); // care type is fixed
    const patched = await call('PATCH', '/provider/profile', { as: provider, body: { city: 'Chennai' } });
    assert.equal(patched.city, 'Chennai');
    await call('GET', '/provider/bookings/pool', { as: identity('HBC'), expect: 403 }); // no profile yet
    await call('GET', '/provider/bookings/pool', { as: vTok }); // registered = ready, no verification
    await call('PATCH', `/admin/providers/${provider.id}/verify`, { as: admin, body: { verified: true }, expect: 404 }); // route removed
    const listed = await call('GET', `/admin/providers?careType=${careType}&pincode=${T_NAGAR.pincode}`, { as: admin });
    assert.ok(listed.some((p: { id: string }) => p.id === provider.id));

    // ---- 1. patient books care with prescriptions ----
    await call('POST', '/patient/bookings', {
      as: pTok,
      body: { serviceId: service.id, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
      expect: 400,
    });
    await book(service.id, { latitude: undefined, longitude: undefined }, 400); // coordinates are required
    const booking = await call('POST', '/patient/bookings', {
      as: pTok,
      body: {
        serviceId: service.id,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...contact,
        notes: 'Ring the bell twice',
        prescriptions: [{ medicineName: 'Paracetamol', dosage: '500mg', frequency: 'TID', duration: '5 days' }],
      },
      expect: 201,
    });
    assert.equal(booking.status, 'PENDING');
    assert.equal(booking.prescriptions.length, 1);
    assert.equal(booking.amount, 750);

    // ---- 2. booking is in the pool, without patient contact ----
    const pool = await call('GET', '/provider/bookings/pool', { as: vTok });
    const pooled = pool.find((b: { id: string }) => b.id === booking.id);
    assert.ok(pooled, 'booking should be in pool');
    assert.equal(pooled.patient, undefined, 'pool must not reveal patient contact');
    assert.equal(pooled.address, undefined, 'pool must not reveal address');
    assert.equal(pooled.latitude, undefined, 'pool must not reveal exact location');
    assert.ok(pooled.distanceKm < 0.01, `same spot should be ~0 km, got ${pooled.distanceKm}`);

    // ---- location matching ----
    // nearby in another pincode: matched by distance
    const nearby = await book(service.id, ADYAR);
    // same pincode but coordinates far away: still matched by pincode
    const samePin = await book(service.id, { latitude: COIMBATORE.latitude, longitude: COIMBATORE.longitude });
    // far away in another pincode: not matched
    const far = await book(service.id, COIMBATORE);
    const pool2 = await call('GET', '/provider/bookings/pool', { as: vTok });
    const inPool = (id: string) => pool2.find((b: { id: string }) => b.id === id);
    assert.ok(inPool(nearby.id), 'nearby booking (other pincode) should match by distance');
    const km = inPool(nearby.id).distanceKm;
    assert.ok(km > 3 && km < 8, `T Nagar to Adyar is about 5 km, got ${km}`);
    assert.ok(inPool(samePin.id), 'same-pincode booking should match even when far');
    assert.ok(!inPool(far.id), 'far booking in another pincode must not match');
    await call('POST', `/provider/bookings/${far.id}/accept`, { as: vTok, expect: 404 });
    // a provider based in Coimbatore sees the far one but not T Nagar
    const remote = await register(4, careType, COIMBATORE);
    const remotePool = await call('GET', '/provider/bookings/pool', { as: remote });
    assert.ok(remotePool.some((b: { id: string }) => b.id === far.id), 'Coimbatore provider sees the Coimbatore booking');
    assert.ok(!remotePool.some((b: { id: string }) => b.id === booking.id), 'Coimbatore provider must not see T Nagar');
    // moving a provider changes what they match
    await call('PATCH', '/provider/profile', { as: remote, body: T_NAGAR });
    const movedPool = await call('GET', '/provider/bookings/pool', { as: remote });
    assert.ok(movedPool.some((b: { id: string }) => b.id === booking.id), 'after moving to T Nagar the booking matches');
    for (const b of [nearby, samePin, far]) {
      await call('POST', `/patient/bookings/${b.id}/cancel`, { as: pTok, body: { reason: 'location test' } });
    }

    // a provider of another care type at the same place neither sees nor can pick it
    const outsider = await register(3, careType === 'NURSE' ? 'PHYSIO' : 'NURSE');
    const outsiderPool = await call('GET', '/provider/bookings/pool', { as: outsider });
    assert.ok(!outsiderPool.some((b: { id: string }) => b.id === booking.id), 'other care type must not see it');
    await call('POST', `/provider/bookings/${booking.id}/accept`, { as: outsider, expect: 404 });

    // ---- 3. provider picks it -> contact revealed; rival loses the race ----
    const accepted = await call('POST', `/provider/bookings/${booking.id}/accept`, { as: vTok });
    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(accepted.patient.phone, contact.patientPhone, 'patient phone revealed after accept');
    assert.equal(accepted.prescriptions.length, 1);
    assert.equal(accepted.visitOtp, undefined);
    await call('POST', `/provider/bookings/${booking.id}/accept`, { as: rival, expect: 409 });
    await call('GET', `/provider/bookings/${booking.id}`, { as: rival, expect: 404 });

    // patient cannot pay before nurse confirms
    await call('POST', `/patient/bookings/${booking.id}/pay`, { as: pTok, expect: 409 });

    // ---- 4. provider calls patient and confirms ----
    const confirmed = await call('POST', `/provider/bookings/${booking.id}/confirm`, { as: vTok, body: { note: 'Spoke to patient' } });
    assert.equal(confirmed.status, 'CONFIRMED');

    // ---- 5. patient pays through payment-service -> callback -> OTP issued ----
    const intent = await call('POST', `/patient/bookings/${booking.id}/pay`, { as: pTok });
    assert.match(intent.payment.id, /^[0-9a-f-]{36}$/);
    assert.equal(intent.payment.amount, 750);
    assert.ok(['PENDING', 'PAID'].includes(intent.payment.status));
    if (intent.payment.status === 'PENDING') assert.ok(intent.payment.checkoutUrl, 'pending payment has a checkout URL');
    const again = await call('POST', `/patient/bookings/${booking.id}/pay`, { as: pTok, expect: [200, 409] });
    if (again?.payment) assert.equal(again.payment.id, intent.payment.id, 'same booking -> same payment');

    const paidBooking = await waitForStatus(booking.id, pTok, 'PAID');
    assert.equal(paidBooking.status, 'PAID', 'booking turns PAID after payment-service reports the payment');
    assert.equal(paidBooking.payment.id, intent.payment.id);
    assert.equal(paidBooking.payment.status, 'PAID');
    assert.match(paidBooking.visitOtp, /^[0-9]{6}$/);
    const paid = { booking: paidBooking };
    await call('POST', `/patient/bookings/${booking.id}/pay`, { as: pTok, expect: 409 });
    const providerView = await call('GET', `/provider/bookings/${booking.id}`, { as: vTok });
    assert.equal(providerView.visitOtp, undefined, 'provider must never see the OTP');

    // ---- 6. provider enters OTP at home -> start ----
    const wrongOtp = paid.booking.visitOtp === '000000' ? '111111' : '000000';
    await call('POST', `/provider/bookings/${booking.id}/start`, { as: vTok, body: { otp: wrongOtp }, expect: 400 });
    await call('POST', `/provider/bookings/${booking.id}/complete`, { as: vTok, expect: 409 });
    const started = await call('POST', `/provider/bookings/${booking.id}/start`, { as: vTok, body: { otp: paid.booking.visitOtp } });
    assert.equal(started.status, 'IN_PROGRESS');

    // ---- 7. complete ----
    const done = await call('POST', `/provider/bookings/${booking.id}/complete`, { as: vTok, body: { note: 'All good' } });
    assert.equal(done.status, 'COMPLETED');
    const patientView = await call('GET', `/patient/bookings/${booking.id}`, { as: pTok });
    assert.equal(patientView.status, 'COMPLETED');
    assert.equal(patientView.provider.id, provider.id);
    assert.equal(patientView.visitOtp, null);

    // ---- release + cancel paths ----
    const b2 = await call('POST', '/patient/bookings', {
      as: pTok,
      body: { serviceId: service.id, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), ...contact },
      expect: 201,
    });
    await call('POST', `/provider/bookings/${b2.id}/accept`, { as: vTok });
    const released = await call('POST', `/provider/bookings/${b2.id}/release`, { as: vTok, body: { reason: 'Patient unreachable' } });
    assert.equal(released.status, 'PENDING');
    await call('POST', `/provider/bookings/${b2.id}/accept`, { as: rival });
    const cancelled = await call('POST', `/patient/bookings/${b2.id}/cancel`, { as: pTok, body: { reason: 'Plans changed' } });
    assert.equal(cancelled.status, 'CANCELLED');
    const rivalView = await call('GET', `/provider/bookings/${b2.id}`, { as: rival });
    assert.equal(rivalView.patient, undefined, 'contact hidden once cancelled');

    // ---- payment callbacks (signed like payment-service) ----
    const b3 = await book(service.id);
    await call('POST', `/provider/bookings/${b3.id}/accept`, { as: vTok });
    await call('POST', `/provider/bookings/${b3.id}/confirm`, { as: vTok });
    const good = callback(b3.id, pTok.id);
    await sendCallback(good, { expect: 401, secret: 'not-the-shared-secret-at-all' });
    await sendCallback(good, { expect: 401, skewSeconds: 600 });
    await sendCallback({ ...good, referenceId: crypto.randomUUID() }, { expect: 404 });
    // underpaid: never marked paid, answered 200 so it is not retried
    const short = await sendCallback(callback(b3.id, pTok.id, { amount: 1.0 }), { expect: 200 });
    assert.equal(short.outcome, 'AMOUNT_MISMATCH');
    const failed = await sendCallback(callback(b3.id, pTok.id, { paymentId: good.paymentId, status: 'FAILED', failureReason: 'Card declined' }), { expect: 200 });
    assert.equal(failed.outcome, 'FAILED_RECORDED');
    let b3View = await call('GET', `/patient/bookings/${b3.id}`, { as: pTok });
    assert.equal(b3View.status, 'CONFIRMED', 'FAILED does not cancel the booking');
    assert.equal(b3View.payment.status, 'FAILED');
    assert.equal(b3View.payment.failureReason, 'Card declined');
    assert.equal((await sendCallback(good, { expect: 200 })).outcome, 'PAID');
    assert.equal((await sendCallback(good, { expect: 200 })).outcome, 'DUPLICATE', 'same eventId processed once');
    const late = await sendCallback(callback(b3.id, pTok.id, { paymentId: good.paymentId, status: 'FAILED' }), { expect: 200 });
    assert.equal(late.outcome, 'FAILED_IGNORED', 'a late FAILED never undoes PAID');
    b3View = await call('GET', `/patient/bookings/${b3.id}`, { as: pTok });
    assert.equal(b3View.status, 'PAID');
    assert.equal(b3View.payment.status, 'PAID');
    assert.match(b3View.visitOtp, /^[0-9]{6}$/);
    await call('POST', `/patient/bookings/${b3.id}/cancel`, { as: pTok, expect: 409 });

    // paid on a checkout that was still open after the patient cancelled -> flagged for refund
    const b4 = await book(service.id);
    await call('POST', `/patient/bookings/${b4.id}/cancel`, { as: pTok });
    assert.equal((await sendCallback(callback(b4.id, pTok.id), { expect: 200 })).outcome, 'REFUND_REQUIRED');
    const b4View = await call('GET', `/patient/bookings/${b4.id}`, { as: pTok });
    assert.equal(b4View.status, 'CANCELLED');
    assert.equal(b4View.payment.refundRequired, true);

    console.log(`  ✓ ${careType} flow`);
  }

  const all = await call('GET', '/admin/bookings?status=COMPLETED', { as: admin });
  assert.ok(all.length >= 3);
  console.log(`\nAll checks passed (${passed} requests).`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
