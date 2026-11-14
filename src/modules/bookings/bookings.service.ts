import crypto from 'node:crypto';
import { PoolClient } from 'pg';
import { env } from '../../config/env';
import { query, Queryable, withTransaction } from '../../db/pool';
import type { AuthUser, CareType } from '../../middleware/auth';
import { AppError, badRequest, conflict, notFound } from '../../utils/errors';
import {
  createPaymentIntent,
  type PayerCredentials,
  type PaymentServiceStatus,
  toPaise,
} from '../payments/payment.client';
import type { PaymentCallback } from '../payments/payments.webhook';

export const BOOKING_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'CONFIRMED',
  'PAID',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses in which the assigned provider may see the patient's contact, address and prescriptions. */
const CONTACT_REVEALED: BookingStatus[] = ['ACCEPTED', 'CONFIRMED', 'PAID', 'IN_PROGRESS', 'COMPLETED'];
const PATIENT_CANCELLABLE: BookingStatus[] = ['PENDING', 'ACCEPTED', 'CONFIRMED'];

interface BookingRow {
  id: string;
  patient_id: string;
  service_id: string;
  care_type: CareType;
  status: BookingStatus;
  amount: number;
  scheduled_at: Date;
  address: string;
  city: string;
  pincode: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  patient_name: string;
  patient_phone: string;
  provider_id: string | null;
  visit_otp: string | null;
  otp_attempts: number;
  accepted_at: Date | null;
  confirmed_at: Date | null;
  paid_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  payment_id: string | null;
  payment_status: PaymentServiceStatus | null;
  payment_failure_reason: string | null;
  created_at: Date;
}

interface BookingDetailRow extends BookingRow {
  service_name: string;
  service_duration: number;
  provider_name: string | null;
  provider_phone: string | null;
  /** Only selected for the pool: km from the provider, null when the booking has no coordinates. */
  distance_km?: number | null;
}

interface PrescriptionRow {
  id: string;
  booking_id: string;
  medicine_name: string;
  dosage: string | null;
  frequency: string | null;
  duration: string | null;
  instructions: string | null;
  document_url: string | null;
}

export interface PrescriptionInput {
  medicineName: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
  documentUrl?: string;
}

/** HBC keeps no patient profile; the patient's contact details are captured on each booking. */
export interface CreateBookingInput {
  serviceId: string;
  scheduledAt: Date;
  patientName: string;
  patientPhone: string;
  address: string;
  city: string;
  pincode: string;
  latitude: number;
  longitude: number;
  notes?: string;
  prescriptions: PrescriptionInput[];
}

/** Who is looking at a booking decides which fields are exposed. */
type Viewer = 'PATIENT' | 'PROVIDER' | 'POOL' | 'ADMIN';

const detailSelect = (extraColumns = '') => `
  SELECT b.*,
         s.name AS service_name, s.duration_minutes AS service_duration,
         vp.full_name AS provider_name, vp.phone AS provider_phone${extraColumns}
  FROM bookings b
  JOIN care_services s ON s.id = b.service_id
  LEFT JOIN provider_profiles vp ON vp.user_id = b.provider_id`;
const DETAIL_SELECT = detailSelect();

// ---------- location matching ----------

/** Where a provider works from, read from their profile. */
interface ProviderMatch {
  careType: CareType;
  pincode: string;
  latitude: number;
  longitude: number;
}

/**
 * Great-circle (haversine) distance in km from booking `b` to the point ($lat, $lng).
 * NULL when the booking has no coordinates. least(1, …) guards asin against float rounding.
 */
const distanceSql = (lat: string, lng: string) => `(6371 * 2 * asin(least(1, sqrt(
    power(sin(radians(b.latitude - ${lat}::float8) / 2), 2) +
    cos(radians(${lat}::float8)) * cos(radians(b.latitude)) *
    power(sin(radians(b.longitude - ${lng}::float8) / 2), 2)))))`;

/**
 * A booking matches a provider when the care type is the same and it is either in the provider's
 * pincode or within SERVICE_RADIUS_KM of them. The latitude band is a cheap pre-filter for the index
 * (1° of latitude ≈ 111 km) before the exact distance check.
 * Placeholders: $1 care type, $2 pincode, $3 latitude, $4 longitude, $5 radius km.
 */
const MATCH_SQL = `b.care_type = $1 AND (
    b.pincode = $2
    OR (b.latitude BETWEEN $3::float8 - $5::float8 / 111 AND $3::float8 + $5::float8 / 111
        AND ${distanceSql('$3', '$4')} <= $5::float8)
  )`;

const matchParams = (m: ProviderMatch) => [m.careType, m.pincode, m.latitude, m.longitude, env.SERVICE_RADIUS_KM];

/** payment-service payment for the booking. Paid after the booking was cancelled = money to give back. */
function paymentDto(b: BookingRow) {
  if (!b.payment_id) return null;
  return {
    id: b.payment_id,
    status: b.payment_status,
    failureReason: b.payment_failure_reason,
    refundRequired: b.payment_status === 'PAID' && b.status === 'CANCELLED',
  };
}

function toDto(b: BookingDetailRow, viewer: Viewer, prescriptions: PrescriptionRow[] = []) {
  const base = {
    id: b.id,
    status: b.status,
    careType: b.care_type,
    service: { id: b.service_id, name: b.service_name, durationMinutes: b.service_duration },
    amount: b.amount,
    scheduledAt: b.scheduled_at,
    city: b.city,
    pincode: b.pincode,
    createdAt: b.created_at,
  };
  // The pool shows how far away a booking is, never its exact coordinates.
  if (viewer === 'POOL') return { ...base, distanceKm: b.distance_km ?? null };

  if (viewer === 'PROVIDER' && !CONTACT_REVEALED.includes(b.status)) {
    return { ...base, cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason };
  }

  return {
    ...base,
    address: b.address,
    latitude: b.latitude,
    longitude: b.longitude,
    notes: b.notes,
    patient: { id: b.patient_id, fullName: b.patient_name, phone: b.patient_phone },
    provider: b.provider_id ? { id: b.provider_id, fullName: b.provider_name, phone: b.provider_phone } : null,
    prescriptions: prescriptions.map((p) => ({
      id: p.id,
      medicineName: p.medicine_name,
      dosage: p.dosage,
      frequency: p.frequency,
      duration: p.duration,
      instructions: p.instructions,
      documentUrl: p.document_url,
    })),
    // The OTP is handed to the patient only; the provider must obtain it in person.
    ...(viewer === 'PATIENT' ? { visitOtp: b.status === 'PAID' ? b.visit_otp : null } : {}),
    ...(viewer === 'PATIENT' || viewer === 'ADMIN' ? { payment: paymentDto(b) } : {}),
    acceptedAt: b.accepted_at,
    confirmedAt: b.confirmed_at,
    paidAt: b.paid_at,
    startedAt: b.started_at,
    completedAt: b.completed_at,
    cancelledAt: b.cancelled_at,
    cancelReason: b.cancel_reason,
  };
}

async function loadDetail(id: string, viewer: Viewer, db?: Queryable) {
  const [row] = await query<BookingDetailRow>(`${DETAIL_SELECT} WHERE b.id = $1`, [id], db);
  if (!row) throw notFound('Booking');
  const prescriptions = await query<PrescriptionRow>(
    'SELECT * FROM prescriptions WHERE booking_id = $1 ORDER BY created_at',
    [id],
    db,
  );
  return toDto(row, viewer, prescriptions);
}

async function listDetails(
  where: string,
  params: unknown[],
  viewer: Viewer,
  orderBy = 'b.created_at DESC',
  extraColumns = '',
) {
  const rows = await query<BookingDetailRow>(`${detailSelect(extraColumns)} WHERE ${where} ORDER BY ${orderBy}`, params);
  if (viewer === 'POOL' || !rows.length) return rows.map((r) => toDto(r, viewer));

  const prescriptions = await query<PrescriptionRow>(
    'SELECT * FROM prescriptions WHERE booking_id = ANY($1::uuid[]) ORDER BY created_at',
    [rows.map((r) => r.id)],
  );
  return rows.map((r) =>
    toDto(
      r,
      viewer,
      prescriptions.filter((p) => p.booking_id === r.id),
    ),
  );
}

// ---------- state machine helpers ----------

async function lockBooking(client: PoolClient, id: string): Promise<BookingRow> {
  const [row] = await query<BookingRow>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id], client);
  if (!row) throw notFound('Booking');
  return row;
}

function assertStatus(row: BookingRow, allowed: BookingStatus[]) {
  if (!allowed.includes(row.status)) {
    throw conflict('INVALID_STATE', `Booking is ${row.status}; this action requires ${allowed.join(' or ')}`);
  }
}

function assertPatientOwns(row: BookingRow, user: AuthUser) {
  if (row.patient_id !== user.id) throw notFound('Booking');
}

function assertProviderOwns(row: BookingRow, user: AuthUser) {
  if (row.provider_id !== user.id) throw notFound('Booking');
}

async function recordEvent(
  client: PoolClient,
  bookingId: string,
  from: BookingStatus | null,
  to: BookingStatus,
  actorId: string,
  note?: string,
) {
  await query(
    'INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)',
    [bookingId, from, to, actorId, note ?? null],
    client,
  );
}

const generateOtp = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

function otpMatches(expected: string, given: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- patient ----------

export async function createBooking(patient: AuthUser, input: CreateBookingInput) {
  if (input.scheduledAt.getTime() <= Date.now()) throw badRequest('scheduledAt must be in the future');

  const id = await withTransaction(async (client) => {
    const [service] = await query<{ id: string; care_type: CareType; price: number; is_active: boolean }>(
      'SELECT id, care_type, price, is_active FROM care_services WHERE id = $1',
      [input.serviceId],
      client,
    );
    if (!service?.is_active) throw notFound('Service');

    const [booking] = await query<{ id: string }>(
      `INSERT INTO bookings
         (patient_id, patient_name, patient_phone, service_id, care_type, amount, scheduled_at,
          address, city, pincode, latitude, longitude, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        patient.id,
        input.patientName,
        input.patientPhone,
        service.id,
        service.care_type,
        service.price,
        input.scheduledAt,
        input.address,
        input.city,
        input.pincode,
        input.latitude,
        input.longitude,
        input.notes ?? null,
      ],
      client,
    );

    for (const p of input.prescriptions) {
      await query(
        `INSERT INTO prescriptions (booking_id, medicine_name, dosage, frequency, duration, instructions, document_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [booking.id, p.medicineName, p.dosage ?? null, p.frequency ?? null, p.duration ?? null, p.instructions ?? null, p.documentUrl ?? null],
        client,
      );
    }
    await recordEvent(client, booking.id, null, 'PENDING', patient.id);
    return booking.id;
  });

  return loadDetail(id, 'PATIENT');
}

export function listPatientBookings(patient: AuthUser, status?: BookingStatus) {
  return listDetails('b.patient_id = $1 AND ($2::booking_status IS NULL OR b.status = $2)', [patient.id, status ?? null], 'PATIENT');
}

export async function getPatientBooking(patient: AuthUser, id: string) {
  const [row] = await query<{ patient_id: string }>('SELECT patient_id FROM bookings WHERE id = $1', [id]);
  if (row?.patient_id !== patient.id) throw notFound('Booking');
  return loadDetail(id, 'PATIENT');
}

/**
 * Starts (or resumes) the online payment for a CONFIRMED booking through payment-service and returns the
 * hosted checkout URL. The booking becomes PAID, and the visit OTP is issued, only when payment-service
 * reports the payment PAID: in its signed callback, or right here if it is already paid.
 */
export async function payBooking(patient: AuthUser, id: string, payer: PayerCredentials) {
  const [row] = await query<BookingRow & { service_name: string }>(
    `SELECT b.*, s.name AS service_name FROM bookings b JOIN care_services s ON s.id = b.service_id WHERE b.id = $1`,
    [id],
  );
  if (!row) throw notFound('Booking');
  assertPatientOwns(row, patient);
  assertStatus(row, ['CONFIRMED']);

  // The external call happens outside any transaction; the amount always comes from the booking.
  const intent = await createPaymentIntent(payer, {
    id,
    amount: row.amount,
    description: `Home care: ${row.service_name}`,
  });

  if (intent.status === 'PAID') {
    // Already settled (e.g. the callback is still on its way): settle now, idempotently.
    await settlePayment({
      eventId: `intent:${intent.id}:PAID`,
      paymentId: intent.id,
      referenceType: intent.referenceType,
      referenceId: id,
      payerId: intent.payerId,
      status: 'PAID',
      amount: intent.amount,
      currency: intent.currency,
      failureReason: null,
      occurredAt: new Date().toISOString(),
    });
  } else {
    await withTransaction(async (client) => {
      const locked = await lockBooking(client, id);
      // Only track the attempt on a booking still waiting for payment; never overwrite a PAID result.
      if (locked.status === 'CONFIRMED' && locked.payment_status !== 'PAID') {
        await query(
          `UPDATE bookings SET payment_id = $2, payment_status = $3, payment_failure_reason = $4, updated_at = now()
           WHERE id = $1`,
          [id, intent.id, intent.status, intent.status === 'FAILED' ? intent.failureReason : null],
          client,
        );
      }
    });
  }

  return {
    booking: await loadDetail(id, 'PATIENT'),
    payment: {
      id: intent.id,
      status: intent.status,
      checkoutUrl: intent.status === 'PAID' ? null : intent.checkoutUrl,
      checkoutExpiresAt: intent.status === 'PAID' ? null : intent.checkoutExpiresAt,
      amount: intent.amount,
      currency: intent.currency,
    },
  };
}

export type PaymentCallbackOutcome =
  | 'DUPLICATE'
  | 'UNKNOWN_BOOKING'
  | 'PAID'
  | 'ALREADY_PAID'
  | 'AMOUNT_MISMATCH'
  | 'REFUND_REQUIRED'
  | 'FAILED_RECORDED'
  | 'FAILED_IGNORED';

/** Signed callback from payment-service. At-least-once and possibly out of order, so fully idempotent. */
export function applyPaymentCallback(event: PaymentCallback): Promise<PaymentCallbackOutcome> {
  return settlePayment(event);
}

const PAID_OR_LATER: BookingStatus[] = ['PAID', 'IN_PROGRESS', 'COMPLETED'];

async function settlePayment(event: PaymentCallback): Promise<PaymentCallbackOutcome> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.referenceId);
  if (!isUuid) return 'UNKNOWN_BOOKING';

  return withTransaction(async (client) => {
    const [row] = await query<BookingRow>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [event.referenceId], client);
    if (!row) return 'UNKNOWN_BOOKING';

    const outcome = decide(row, event);
    // The eventId is recorded in the same transaction as the booking change: a duplicate stops here.
    const inserted = await query(
      `INSERT INTO payment_callbacks (event_id, payment_id, booking_id, status, amount, outcome)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.eventId, event.paymentId, row.id, event.status, event.amount, outcome],
      client,
    );
    if (!inserted.length) return 'DUPLICATE';

    switch (outcome) {
      case 'PAID':
        await insertPayment(client, row, event);
        await query(
          `UPDATE bookings SET status = 'PAID', paid_at = now(), visit_otp = $2, otp_attempts = 0,
                  payment_id = $3, payment_status = 'PAID', payment_failure_reason = NULL, updated_at = now()
           WHERE id = $1`,
          [row.id, generateOtp(), event.paymentId],
          client,
        );
        await recordEvent(client, row.id, row.status, 'PAID', row.patient_id, `payment ${event.paymentId}`);
        break;
      case 'REFUND_REQUIRED':
        // Paid on a checkout that was still open when the booking was cancelled: keep the money traceable.
        console.warn(`[payments] REFUND REQUIRED: payment ${event.paymentId} PAID for ${row.status} booking ${row.id}`);
        await insertPayment(client, row, event, `REFUND_REQUIRED: booking was ${row.status} when paid`);
        await query(
          `UPDATE bookings SET payment_id = $2, payment_status = 'PAID', payment_failure_reason = NULL, updated_at = now()
           WHERE id = $1`,
          [row.id, event.paymentId],
          client,
        );
        break;
      case 'AMOUNT_MISMATCH':
        // Do not mark it paid. Answer 200 so it is not retried for hours; a person must look at it.
        console.error(
          `[payments] AMOUNT MISMATCH on booking ${row.id}: payment ${event.paymentId} ${event.amount} ${event.currency}, expected ${row.amount} INR`,
        );
        break;
      case 'ALREADY_PAID':
        if (row.payment_id && row.payment_id !== event.paymentId) {
          console.error(`[payments] DOUBLE PAYMENT on booking ${row.id}: ${row.payment_id} and ${event.paymentId}`);
          await insertPayment(client, row, event, `REFUND_REQUIRED: second payment, booking already paid by ${row.payment_id}`);
        }
        break;
      case 'FAILED_RECORDED':
        // Not a cancellation: the patient can retry on the same payment and a PAID may still follow.
        await query(
          `UPDATE bookings SET payment_id = $2, payment_status = 'FAILED', payment_failure_reason = $3, updated_at = now()
           WHERE id = $1`,
          [row.id, event.paymentId, event.failureReason ?? null],
          client,
        );
        break;
      case 'FAILED_IGNORED':
        break;
    }
    return outcome;
  });
}

function decide(row: BookingRow, event: PaymentCallback): Exclude<PaymentCallbackOutcome, 'DUPLICATE' | 'UNKNOWN_BOOKING'> {
  if (event.status === 'FAILED') {
    // A late FAILED can arrive after PAID: PAID is final.
    return row.status === 'CONFIRMED' && row.payment_status !== 'PAID' ? 'FAILED_RECORDED' : 'FAILED_IGNORED';
  }
  if (event.currency !== 'INR' || toPaise(event.amount) < toPaise(row.amount)) return 'AMOUNT_MISMATCH';
  if (PAID_OR_LATER.includes(row.status)) return 'ALREADY_PAID';
  if (row.status === 'CONFIRMED') return 'PAID';
  return 'REFUND_REQUIRED';
}

async function insertPayment(client: PoolClient, row: BookingRow, event: PaymentCallback, note?: string) {
  await query(
    `INSERT INTO payments (booking_id, amount, currency, method, status, transaction_ref, external_payment_id, note)
     VALUES ($1, $2, $3, 'ONLINE', 'SUCCESS', $4::text, $4::uuid, $5)
     ON CONFLICT (external_payment_id) WHERE external_payment_id IS NOT NULL DO NOTHING`,
    [row.id, event.amount, event.currency, event.paymentId, note ?? null],
    client,
  );
}

export async function cancelBooking(patient: AuthUser, id: string, reason?: string) {
  await withTransaction(async (client) => {
    const row = await lockBooking(client, id);
    assertPatientOwns(row, patient);
    assertStatus(row, PATIENT_CANCELLABLE);
    await query(
      `UPDATE bookings SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2, updated_at = now()
       WHERE id = $1`,
      [id, reason ?? null],
      client,
    );
    await recordEvent(client, id, row.status, 'CANCELLED', patient.id, reason);
  });
  return loadDetail(id, 'PATIENT');
}

// ---------- provider ----------

/**
 * Every provider shares the HBC role, so the care type and location they are matched on come from
 * their profile. There is no admin verification step.
 */
async function providerMatch(provider: AuthUser, db?: Queryable): Promise<ProviderMatch> {
  const [profile] = await query<{
    care_type: CareType;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
  }>('SELECT care_type, pincode, latitude, longitude FROM provider_profiles WHERE user_id = $1', [provider.id], db);
  if (!profile) {
    throw new AppError(403, 'PROVIDER_PROFILE_REQUIRED', 'Register your provider profile (POST /provider/profile) first');
  }
  // Only profiles registered before location matching can lack these.
  if (profile.pincode === null || profile.latitude === null || profile.longitude === null) {
    throw new AppError(
      403,
      'PROVIDER_LOCATION_REQUIRED',
      'Add your pincode, latitude and longitude (PATCH /provider/profile) to be matched with bookings',
    );
  }
  return { careType: profile.care_type, pincode: profile.pincode, latitude: profile.latitude, longitude: profile.longitude };
}

/** Open bookings of the provider's care type in their pincode or within SERVICE_RADIUS_KM, nearest first. */
export async function listPool(provider: AuthUser) {
  const match = await providerMatch(provider);
  return listDetails(
    `b.status = 'PENDING' AND b.scheduled_at > now() AND ${MATCH_SQL}`,
    matchParams(match),
    'POOL',
    'distance_km ASC NULLS LAST, b.scheduled_at ASC',
    `,\n         round(${distanceSql('$3', '$4')}::numeric, 2)::float8 AS distance_km`,
  );
}

export function listProviderBookings(provider: AuthUser, status?: BookingStatus) {
  return listDetails(
    'b.provider_id = $1 AND ($2::booking_status IS NULL OR b.status = $2)',
    [provider.id, status ?? null],
    'PROVIDER',
    'b.scheduled_at ASC',
  );
}

export async function getProviderBooking(provider: AuthUser, id: string) {
  const [row] = await query<{ provider_id: string | null }>('SELECT provider_id FROM bookings WHERE id = $1', [id]);
  if (row?.provider_id !== provider.id) throw notFound('Booking');
  return loadDetail(id, 'PROVIDER');
}

/** Pick a booking from the pool. Row lock guarantees only one provider wins. */
export async function acceptBooking(provider: AuthUser, id: string) {
  await withTransaction(async (client) => {
    const match = await providerMatch(provider, client);
    const row = await lockBooking(client, id);
    // Same rule as the pool: a provider can only pick bookings they are matched with.
    const matched = await query(`SELECT 1 FROM bookings b WHERE b.id = $6 AND ${MATCH_SQL}`, [...matchParams(match), id], client);
    if (!matched.length) throw notFound('Booking');
    if (row.status !== 'PENDING') throw conflict('BOOKING_UNAVAILABLE', 'This booking has already been taken or is no longer open');
    await query(
      `UPDATE bookings SET status = 'ACCEPTED', provider_id = $2, accepted_at = now(), updated_at = now() WHERE id = $1`,
      [id, provider.id],
      client,
    );
    await recordEvent(client, id, 'PENDING', 'ACCEPTED', provider.id);
  });
  return loadDetail(id, 'PROVIDER');
}

/** Provider could not reach / agree with the patient: return the booking to the pool. */
export async function releaseBooking(provider: AuthUser, id: string, reason?: string) {
  await withTransaction(async (client) => {
    const row = await lockBooking(client, id);
    assertProviderOwns(row, provider);
    assertStatus(row, ['ACCEPTED']);
    await query(
      `UPDATE bookings SET status = 'PENDING', provider_id = NULL, accepted_at = NULL, updated_at = now() WHERE id = $1`,
      [id],
      client,
    );
    await recordEvent(client, id, 'ACCEPTED', 'PENDING', provider.id, reason);
  });
  return { id, status: 'PENDING' as const };
}

export async function confirmBooking(provider: AuthUser, id: string, note?: string) {
  await withTransaction(async (client) => {
    const row = await lockBooking(client, id);
    assertProviderOwns(row, provider);
    assertStatus(row, ['ACCEPTED']);
    await query(`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now() WHERE id = $1`, [id], client);
    await recordEvent(client, id, 'ACCEPTED', 'CONFIRMED', provider.id, note);
  });
  return loadDetail(id, 'PROVIDER');
}

/** Provider enters the OTP the patient reads out at the door. */
export async function startBooking(provider: AuthUser, id: string, otp: string) {
  // Wrong attempts must be persisted, so the transaction commits and the error is raised afterwards.
  const outcome = await withTransaction(async (client) => {
    const row = await lockBooking(client, id);
    assertProviderOwns(row, provider);
    assertStatus(row, ['PAID']);

    if (row.otp_attempts >= env.OTP_MAX_ATTEMPTS) return 'LOCKED' as const;
    if (!row.visit_otp || !otpMatches(row.visit_otp, otp)) {
      await query('UPDATE bookings SET otp_attempts = otp_attempts + 1, updated_at = now() WHERE id = $1', [id], client);
      return 'WRONG' as const;
    }
    await query(
      `UPDATE bookings SET status = 'IN_PROGRESS', started_at = now(), visit_otp = NULL, updated_at = now() WHERE id = $1`,
      [id],
      client,
    );
    await recordEvent(client, id, 'PAID', 'IN_PROGRESS', provider.id, 'OTP verified');
    return 'OK' as const;
  });

  if (outcome === 'LOCKED') {
    throw new AppError(429, 'OTP_LOCKED', 'Too many wrong OTP attempts; contact support');
  }
  if (outcome === 'WRONG') throw new AppError(400, 'INVALID_OTP', 'The OTP is incorrect');
  return loadDetail(id, 'PROVIDER');
}

export async function completeBooking(provider: AuthUser, id: string, note?: string) {
  await withTransaction(async (client) => {
    const row = await lockBooking(client, id);
    assertProviderOwns(row, provider);
    assertStatus(row, ['IN_PROGRESS']);
    await query(`UPDATE bookings SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1`, [id], client);
    await recordEvent(client, id, 'IN_PROGRESS', 'COMPLETED', provider.id, note);
  });
  return loadDetail(id, 'PROVIDER');
}

// ---------- admin ----------

export function listAllBookings(filter: { status?: BookingStatus; careType?: CareType }) {
  return listDetails(
    '($1::booking_status IS NULL OR b.status = $1) AND ($2::care_type IS NULL OR b.care_type = $2)',
    [filter.status ?? null, filter.careType ?? null],
    'ADMIN',
  );
}
