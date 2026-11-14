import { Router } from 'express';
import { z } from 'zod';
import { CARE_TYPES } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { listServices } from './catalog.service';

export const careTypeQuery = z.object({ careType: z.enum(CARE_TYPES).optional() });

/** Public catalog: active services only. */
export const catalogRouter = Router();

catalogRouter.get('/services', validate('query', careTypeQuery), async (_req, res) => {
  res.json(await listServices({ careType: res.locals.query.careType, activeOnly: true }));
});
