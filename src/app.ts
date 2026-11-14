import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFoundHandler } from './middleware/error';
import { adminRouter } from './modules/admin/admin.routes';
import { patientBookingsRouter, providerBookingsRouter } from './modules/bookings/bookings.routes';
import { catalogRouter } from './modules/catalog/catalog.routes';
import { paymentWebhookRouter } from './modules/payments/payments.webhook';
import { providerProfileRouter } from './modules/providers/providers.routes';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors());
  // Signed payment-service callbacks need the raw body, so this is mounted before the JSON parser.
  app.use('/api/v1/hbc/payments', paymentWebhookRouter);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const api = express.Router();
  api.use('/catalog', catalogRouter);
  api.use('/admin', adminRouter);
  api.use('/patient/bookings', patientBookingsRouter);
  api.use('/provider/profile', providerProfileRouter);
  api.use('/provider/bookings', providerBookingsRouter);
  app.use('/api/v1/hbc', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
