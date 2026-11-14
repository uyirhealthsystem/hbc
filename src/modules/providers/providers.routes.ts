import { Router } from 'express';
import { z } from 'zod';
import { authenticate, CARE_TYPES, currentUser, requireRole } from '../../middleware/auth';
import { locationFields, validate } from '../../middleware/validate';
import * as providers from './providers.service';

export const phoneSchema = z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10-15 digits, optional leading +');

const profileSchema = z.object({
  careType: z.enum(CARE_TYPES),
  fullName: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  ...locationFields,
  licenseNo: z.string().trim().max(64).optional(),
  experienceYears: z.number().int().min(0).max(60).optional(),
  city: z.string().trim().max(120).optional(),
});

// The care type is fixed at registration: it decides which bookings the provider is matched with.
// Coordinates move together, so a half-updated location can't place the provider somewhere else.
const profilePatchSchema = profileSchema
  .omit({ careType: true })
  .partial()
  .strict()
  .refine((p) => (p.latitude === undefined) === (p.longitude === undefined), {
    message: 'latitude and longitude must be updated together',
    path: ['latitude'],
  });

/** The caller's own provider profile (X-Role: HBC). */
export const providerProfileRouter = Router();
providerProfileRouter.use(authenticate, requireRole('HBC'));

providerProfileRouter.post('/', validate('body', profileSchema), async (req, res) => {
  res.status(201).json(await providers.registerProfile(currentUser(req), res.locals.body));
});

providerProfileRouter.get('/', async (req, res) => {
  res.json(await providers.getProfile(currentUser(req)));
});

providerProfileRouter.patch('/', validate('body', profilePatchSchema), async (req, res) => {
  res.json(await providers.updateProfile(currentUser(req), res.locals.body));
});
