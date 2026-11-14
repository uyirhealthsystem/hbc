import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../middleware/auth';
import { idParam, locationFields, validate } from '../../middleware/validate';
import { phoneSchema } from '../providers/providers.routes';
import * as bookings from './bookings.service';

const prescriptionSchema = z.object({
  medicineName: z.string().trim().min(1).max(200),
  dosage: z.string().trim().max(100).optional(),
  frequency: z.string().trim().max(100).optional(),
  duration: z.string().trim().max(100).optional(),
  instructions: z.string().trim().max(1000).optional(),
  documentUrl: z.string().url().optional(),
});

const createBookingSchema = z.object({
  serviceId: z.string().uuid(),
  scheduledAt: z.coerce.date(),
  patientName: z.string().trim().min(2).max(120),
  patientPhone: phoneSchema,
  address: z.string().trim().min(5),
  city: z.string().trim().min(2),
  ...locationFields,
  notes: z.string().trim().max(1000).optional(),
  prescriptions: z.array(prescriptionSchema).max(20).default([]),
});

const statusQuery = z.object({ status: z.enum(bookings.BOOKING_STATUSES).optional() });
const reasonSchema = z.object({ reason: z.string().trim().max(500).optional() });
const noteSchema = z.object({ note: z.string().trim().max(500).optional() });
const otpSchema = z.object({ otp: z.string().regex(/^[0-9]{6}$/, 'OTP must be 6 digits') });

// ---------- patient ----------
export const patientBookingsRouter = Router();
patientBookingsRouter.use(authenticate, requireRole('PATIENT'));

patientBookingsRouter.post('/', validate('body', createBookingSchema), async (req, res) => {
  res.status(201).json(await bookings.createBooking(currentUser(req), res.locals.body));
});

patientBookingsRouter.get('/', validate('query', statusQuery), async (req, res) => {
  res.json(await bookings.listPatientBookings(currentUser(req), res.locals.query.status));
});

patientBookingsRouter.get('/:id', validate('params', idParam), async (req, res) => {
  res.json(await bookings.getPatientBooking(currentUser(req), res.locals.params.id));
});

// Starts the online payment: answers with the checkout URL to open. The booking turns PAID on payment-service's
// callback. Safe to call again (same checkout while valid, a fresh one after it expired or failed).
patientBookingsRouter.post('/:id/pay', validate('params', idParam), async (req, res) => {
  const user = currentUser(req);
  res.json(await bookings.payBooking(user, res.locals.params.id, { user, authorization: req.get('authorization') }));
});

patientBookingsRouter.post('/:id/cancel', validate('params', idParam), validate('body', reasonSchema), async (req, res) => {
  res.json(await bookings.cancelBooking(currentUser(req), res.locals.params.id, res.locals.body.reason));
});

// ---------- provider (X-Role: HBC; nurse / physio / caretaker by profile) ----------
export const providerBookingsRouter = Router();
providerBookingsRouter.use(authenticate, requireRole('HBC'));

providerBookingsRouter.get('/pool', async (req, res) => {
  res.json(await bookings.listPool(currentUser(req)));
});

providerBookingsRouter.get('/', validate('query', statusQuery), async (req, res) => {
  res.json(await bookings.listProviderBookings(currentUser(req), res.locals.query.status));
});

providerBookingsRouter.get('/:id', validate('params', idParam), async (req, res) => {
  res.json(await bookings.getProviderBooking(currentUser(req), res.locals.params.id));
});

providerBookingsRouter.post('/:id/accept', validate('params', idParam), async (req, res) => {
  res.json(await bookings.acceptBooking(currentUser(req), res.locals.params.id));
});

providerBookingsRouter.post('/:id/release', validate('params', idParam), validate('body', reasonSchema), async (req, res) => {
  res.json(await bookings.releaseBooking(currentUser(req), res.locals.params.id, res.locals.body.reason));
});

providerBookingsRouter.post('/:id/confirm', validate('params', idParam), validate('body', noteSchema), async (req, res) => {
  res.json(await bookings.confirmBooking(currentUser(req), res.locals.params.id, res.locals.body.note));
});

providerBookingsRouter.post('/:id/start', validate('params', idParam), validate('body', otpSchema), async (req, res) => {
  res.json(await bookings.startBooking(currentUser(req), res.locals.params.id, res.locals.body.otp));
});

providerBookingsRouter.post('/:id/complete', validate('params', idParam), validate('body', noteSchema), async (req, res) => {
  res.json(await bookings.completeBooking(currentUser(req), res.locals.params.id, res.locals.body.note));
});
