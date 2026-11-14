-- Provider profiles no longer collect an email; contact is by phone.
ALTER TABLE provider_profiles DROP COLUMN IF EXISTS email;
