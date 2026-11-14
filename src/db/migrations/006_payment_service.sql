-- Payments go through the shared Uyir payment-service (Razorpay behind it). HBC creates a payment intent,
-- the patient pays on the hosted checkout, and payment-service POSTs a signed PAID / FAILED callback.

-- The current payment-service payment for the booking (one per booking: Idempotency-Key hbc-booking-<id>).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_id             UUID,
  ADD COLUMN IF NOT EXISTS payment_status         TEXT CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED')),
  ADD COLUMN IF NOT EXISTS payment_failure_reason TEXT;

-- A settled payment, written once when payment-service reports PAID.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS external_payment_id UUID,
  ADD COLUMN IF NOT EXISTS note                TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_external ON payments(external_payment_id)
  WHERE external_payment_id IS NOT NULL;

-- Callbacks are delivered at least once; each eventId is processed once.
CREATE TABLE IF NOT EXISTS payment_callbacks (
  event_id     TEXT PRIMARY KEY,
  payment_id   UUID NOT NULL,
  booking_id   UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  amount       NUMERIC(10, 2) NOT NULL,
  outcome      TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_callbacks_booking ON payment_callbacks(booking_id);
