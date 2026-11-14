import { query } from '../../db/pool';
import type { CareType } from '../../middleware/auth';
import { badRequest, notFound } from '../../utils/errors';

interface ServiceRow {
  id: string;
  care_type: CareType;
  name: string;
  description: string | null;
  price: number;
  duration_minutes: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ServiceInput {
  careType: CareType;
  name: string;
  description?: string;
  price: number;
  durationMinutes: number;
  isActive?: boolean;
}

export type ServicePatch = Partial<Omit<ServiceInput, 'careType'>>;

const toDto = (s: ServiceRow) => ({
  id: s.id,
  careType: s.care_type,
  name: s.name,
  description: s.description,
  price: s.price,
  durationMinutes: s.duration_minutes,
  isActive: s.is_active,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

export async function listServices(opts: { careType?: CareType; activeOnly: boolean }) {
  const rows = await query<ServiceRow>(
    `SELECT * FROM care_services
     WHERE ($1::care_type IS NULL OR care_type = $1) AND ($2::boolean = false OR is_active)
     ORDER BY care_type, name`,
    [opts.careType ?? null, opts.activeOnly],
  );
  return rows.map(toDto);
}

export async function createService(input: ServiceInput, adminId: string) {
  const [row] = await query<ServiceRow>(
    `INSERT INTO care_services (care_type, name, description, price, duration_minutes, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.careType, input.name, input.description ?? null, input.price, input.durationMinutes, input.isActive ?? true, adminId],
  );
  return toDto(row);
}

const PATCH_COLUMNS: Record<keyof ServicePatch, string> = {
  name: 'name',
  description: 'description',
  price: 'price',
  durationMinutes: 'duration_minutes',
  isActive: 'is_active',
};

export async function updateService(id: string, patch: ServicePatch) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof ServicePatch, string][]) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) throw badRequest('No fields to update');

  values.push(id);
  const [row] = await query<ServiceRow>(
    `UPDATE care_services SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  if (!row) throw notFound('Service');
  return toDto(row);
}

export async function deactivateService(id: string) {
  const rows = await query('UPDATE care_services SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id', [id]);
  if (!rows.length) throw notFound('Service');
}
