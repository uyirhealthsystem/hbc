import { Router } from 'express';
import { z } from 'zod';
import { authenticate, CARE_TYPES, currentUser, requireRole } from '../../middleware/auth';
import { idParam, locationFields, validate } from '../../middleware/validate';
import { BOOKING_STATUSES, listAllBookings } from '../bookings/bookings.service';
import { careTypeQuery } from '../catalog/catalog.routes';
import * as catalog from '../catalog/catalog.service';
import { listProviders } from '../providers/providers.service';

const serviceSchema = z.object({
  careType: z.enum(CARE_TYPES),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  price: z.number().nonnegative().multipleOf(0.01),
  durationMinutes: z.number().int().positive().max(24 * 60),
  isActive: z.boolean().optional(),
});
const servicePatchSchema = serviceSchema.omit({ careType: true }).partial();

const providersQuery = careTypeQuery.extend({ pincode: locationFields.pincode.optional() });
const bookingsQuery = careTypeQuery.extend({ status: z.enum(BOOKING_STATUSES).optional() });

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('SUPER_ADMIN'));

// ---------- catalog ----------
adminRouter.get('/catalog/services', validate('query', careTypeQuery), async (_req, res) => {
  res.json(await catalog.listServices({ careType: res.locals.query.careType, activeOnly: false }));
});

adminRouter.post('/catalog/services', validate('body', serviceSchema), async (req, res) => {
  res.status(201).json(await catalog.createService(res.locals.body, currentUser(req).id));
});

adminRouter.patch('/catalog/services/:id', validate('params', idParam), validate('body', servicePatchSchema), async (_req, res) => {
  res.json(await catalog.updateService(res.locals.params.id, res.locals.body));
});

adminRouter.delete('/catalog/services/:id', validate('params', idParam), async (_req, res) => {
  await catalog.deactivateService(res.locals.params.id);
  res.status(204).end();
});

// ---------- providers ----------
adminRouter.get('/providers', validate('query', providersQuery), async (_req, res) => {
  res.json(await listProviders(res.locals.query));
});

// ---------- bookings ----------
adminRouter.get('/bookings', validate('query', bookingsQuery), async (_req, res) => {
  res.json(await listAllBookings(res.locals.query));
});
