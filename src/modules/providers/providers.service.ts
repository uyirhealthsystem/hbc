import { query } from '../../db/pool';
import type { AuthUser, CareType } from '../../middleware/auth';
import { AppError, badRequest, notFound } from '../../utils/errors';

interface ProviderRow {
  user_id: string;
  full_name: string;
  phone: string;
  care_type: CareType;
  license_no: string | null;
  experience_years: number | null;
  city: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: Date;
}

export const toProviderDto = (p: ProviderRow) => ({
  id: p.user_id,
  fullName: p.full_name,
  phone: p.phone,
  careType: p.care_type,
  licenseNo: p.license_no,
  experienceYears: p.experience_years,
  city: p.city,
  pincode: p.pincode,
  latitude: p.latitude,
  longitude: p.longitude,
  createdAt: p.created_at,
});

export interface ProviderProfileInput {
  careType: CareType;
  fullName: string;
  phone: string;
  pincode: string;
  latitude: number;
  longitude: number;
  licenseNo?: string;
  experienceYears?: number;
  city?: string;
}

export type ProviderProfilePatch = Partial<Omit<ProviderProfileInput, 'careType'>>;

/**
 * Registers the caller's provider profile with their care type (NURSE / PHYSIO / CARETAKER) and the
 * location they work from. They can pick bookings straight away; there is no admin verification.
 */
export async function registerProfile(provider: AuthUser, input: ProviderProfileInput) {
  const [row] = await query<ProviderRow>(
    `INSERT INTO provider_profiles
       (user_id, care_type, full_name, phone, pincode, latitude, longitude, license_no, experience_years, city)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO NOTHING RETURNING *`,
    [
      provider.id,
      input.careType,
      input.fullName,
      input.phone,
      input.pincode,
      input.latitude,
      input.longitude,
      input.licenseNo ?? null,
      input.experienceYears ?? null,
      input.city ?? null,
    ],
  );
  if (!row) throw new AppError(409, 'PROFILE_EXISTS', 'Your provider profile is already registered');
  return toProviderDto(row);
}

export async function getProfile(provider: AuthUser) {
  const [row] = await query<ProviderRow>('SELECT * FROM provider_profiles WHERE user_id = $1', [provider.id]);
  if (!row) throw notFound('Provider profile');
  return toProviderDto(row);
}

const PATCH_COLUMNS: Record<keyof ProviderProfilePatch, string> = {
  fullName: 'full_name',
  phone: 'phone',
  pincode: 'pincode',
  latitude: 'latitude',
  longitude: 'longitude',
  licenseNo: 'license_no',
  experienceYears: 'experience_years',
  city: 'city',
};

export async function updateProfile(provider: AuthUser, patch: ProviderProfilePatch) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof ProviderProfilePatch, string][]) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) throw badRequest('No fields to update');

  values.push(provider.id);
  const [row] = await query<ProviderRow>(
    `UPDATE provider_profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${values.length} RETURNING *`,
    values,
  );
  if (!row) throw notFound('Provider profile');
  return toProviderDto(row);
}

export async function listProviders(filter: { careType?: CareType; pincode?: string }) {
  const rows = await query<ProviderRow>(
    `SELECT * FROM provider_profiles
     WHERE ($1::care_type IS NULL OR care_type = $1) AND ($2::text IS NULL OR pincode = $2)
     ORDER BY created_at DESC`,
    [filter.careType ?? null, filter.pincode ?? null],
  );
  return rows.map(toProviderDto);
}
