-- Credentials and tokens move to the external auth service. Users are identified by the
-- X-User-Id the gateway forwards; HBC keeps only service-provider profiles. Patient contact
-- details are captured on each booking.

-- ---------- provider profiles become self-contained ----------
ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS full_name  TEXT,
  ADD COLUMN IF NOT EXISTS phone      TEXT,
  ADD COLUMN IF NOT EXISTS email      TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE provider_profiles p
SET full_name = u.full_name, phone = u.phone, email = u.email, created_at = u.created_at
FROM users u
WHERE u.id = p.user_id AND p.full_name IS NULL;

ALTER TABLE provider_profiles
  ALTER COLUMN full_name SET NOT NULL,
  ALTER COLUMN phone SET NOT NULL;

-- ---------- bookings keep the patient's contact ----------
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS patient_name  TEXT,
  ADD COLUMN IF NOT EXISTS patient_phone TEXT;

UPDATE bookings b
SET patient_name = u.full_name, patient_phone = u.phone
FROM users u
WHERE u.id = b.patient_id AND b.patient_name IS NULL;

ALTER TABLE bookings
  ALTER COLUMN patient_name SET NOT NULL,
  ALTER COLUMN patient_phone SET NOT NULL;

-- ---------- detach from users and drop the auth tables ----------
ALTER TABLE provider_profiles DROP CONSTRAINT IF EXISTS provider_profiles_user_id_fkey;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_patient_id_fkey;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_provider_id_fkey;
ALTER TABLE booking_events DROP CONSTRAINT IF EXISTS booking_events_actor_id_fkey;
ALTER TABLE care_services DROP CONSTRAINT IF EXISTS care_services_created_by_fkey;

DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS patient_profiles;
DROP TABLE IF EXISTS users;
DROP TYPE IF EXISTS user_role;
