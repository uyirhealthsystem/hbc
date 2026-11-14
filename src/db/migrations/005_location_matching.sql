-- Providers no longer need admin verification. They are matched to bookings by location:
-- same pincode, or within SERVICE_RADIUS_KM of the booking's coordinates.

ALTER TABLE provider_profiles
  DROP COLUMN IF EXISTS is_verified,
  DROP COLUMN IF EXISTS verified_at,
  ADD COLUMN IF NOT EXISTS pincode   TEXT,
  ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180);
-- Location stays nullable here only for profiles registered before this migration; the API requires it,
-- and a provider without one is asked to add it before seeing the pool.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180);
-- Bookings created before this migration have no coordinates and match by pincode only.

CREATE INDEX IF NOT EXISTS idx_bookings_pool_pincode ON bookings(care_type, pincode) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_bookings_pool_geo ON bookings(care_type, latitude) WHERE status = 'PENDING';
