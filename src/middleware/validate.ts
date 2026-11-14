import { RequestHandler } from 'express';
import { ZodTypeAny, z } from 'zod';

type Part = 'body' | 'query' | 'params';

/** Validates a request part and stores the parsed result on `res.locals[part]`. */
export const validate =
  (part: Part, schema: ZodTypeAny): RequestHandler =>
  (req, res, next) => {
    // Missing JSON body arrives as undefined; treat it as {} so optional-body schemas pass.
    res.locals[part] = schema.parse(req[part] ?? {});
    next();
  };

export const idParam = z.object({ id: z.string().uuid() });

/** Where care happens (bookings) or where a provider works from (profiles); used for matching. */
export const locationFields = {
  pincode: z.string().trim().regex(/^[0-9]{4,10}$/, 'Pincode must be 4-10 digits'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
};
