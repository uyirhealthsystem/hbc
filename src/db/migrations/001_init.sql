CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'PATIENT', 'NURSE', 'PHYSIO', 'CARETAKER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE care_type AS ENUM ('NURSE', 'PHYSIO', 'CARETAKER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM
    ('PENDING', 'ACCEPTED', 'CONFIRMED', 'PAID', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('SUCCESS', 'FAILED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Auth service ----------
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           user_role NOT NULL,
  full_name      TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ---------- Profiles ----------
CREATE TABLE IF NOT EXISTS patient_profiles (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address     TEXT NOT NULL,
  city        TEXT NOT NULL,
  pincode     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  care_type         care_type NOT NULL,
  license_no        TEXT,
  experience_years  INT CHECK (experience_years >= 0),
  city              TEXT,
  is_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at       TIMESTAMPTZ
);

-- ---------- Catalog (managed by super admin) ----------
CREATE TABLE IF NOT EXISTS care_services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  care_type         care_type NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  price             NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  duration_minutes  INT NOT NULL CHECK (duration_minutes > 0),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (care_type, name)
);

-- ---------- Bookings ----------
CREATE TABLE IF NOT EXISTS bookings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID NOT NULL REFERENCES users(id),
  service_id        UUID NOT NULL REFERENCES care_services(id),
  care_type         care_type NOT NULL,
  status            booking_status NOT NULL DEFAULT 'PENDING',
  amount            NUMERIC(10, 2) NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  address           TEXT NOT NULL,
  city              TEXT NOT NULL,
  pincode           TEXT NOT NULL,
  notes             TEXT,
  provider_id       UUID REFERENCES users(id),
  visit_otp         TEXT,
  otp_attempts      INT NOT NULL DEFAULT 0,
  accepted_at       TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_pool ON bookings(care_type, scheduled_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_bookings_patient ON bookings(patient_id);
CREATE INDEX IF NOT EXISTS idx_bookings_provider ON bookings(provider_id);

CREATE TABLE IF NOT EXISTS prescriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  medicine_name  TEXT NOT NULL,
  dosage         TEXT,
  frequency      TEXT,
  duration       TEXT,
  instructions   TEXT,
  document_url   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_booking ON prescriptions(booking_id);

CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES bookings(id),
  amount           NUMERIC(10, 2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  method           TEXT NOT NULL,
  status           payment_status NOT NULL,
  transaction_ref  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

-- Audit trail of every status transition
CREATE TABLE IF NOT EXISTS booking_events (
  id           BIGSERIAL PRIMARY KEY,
  booking_id   UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status  booking_status,
  to_status    booking_status NOT NULL,
  actor_id     UUID REFERENCES users(id),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id);
