-- Super admins live in a separate service and reach HBC through the gateway (X-User-Id / X-Role),
-- so their ids are not rows in `users`. Keep created_by as a plain reference to that external id.
ALTER TABLE care_services DROP CONSTRAINT IF EXISTS care_services_created_by_fkey;
