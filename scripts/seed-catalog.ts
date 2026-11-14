/**
 * Creates the starter care-service catalog through the admin API. Safe to run again: services that already
 * exist (same care type + name) are skipped, nothing is changed or deleted.
 *   BASE_URL=http://15.252.164.86:4000/api/v1/hbc ADMIN_TOKEN=<SUPER_ADMIN access token> npm run seed:catalog
 * Prices are in INR; edit CATALOG below before running.
 */
import 'dotenv/config';

type CareType = 'NURSE' | 'PHYSIO' | 'CARETAKER';
interface Service {
  careType: CareType;
  name: string;
  description: string;
  price: number;
  durationMinutes: number;
}

const CATALOG: Service[] = [
  // ---- NURSE ----
  { careType: 'NURSE', name: 'Nurse home visit', description: 'General check-up at home: vitals, medication review and basic care.', price: 600, durationMinutes: 60 },
  { careType: 'NURSE', name: 'Injection administration', description: 'Intramuscular, subcutaneous or intravenous injection as prescribed.', price: 300, durationMinutes: 30 },
  { careType: 'NURSE', name: 'IV infusion / drip', description: 'Setting up and monitoring an IV drip as prescribed by a doctor.', price: 900, durationMinutes: 90 },
  { careType: 'NURSE', name: 'Wound dressing', description: 'Cleaning and dressing of surgical or chronic wounds.', price: 500, durationMinutes: 45 },
  { careType: 'NURSE', name: 'Catheter care', description: 'Urinary catheter insertion, change or care.', price: 700, durationMinutes: 45 },
  { careType: 'NURSE', name: 'Post-operative care', description: 'Recovery care after surgery: dressing, medication and monitoring.', price: 1200, durationMinutes: 120 },
  { careType: 'NURSE', name: 'Nursing care - 12 hour shift', description: 'A trained nurse at home for a 12-hour day or night shift.', price: 1800, durationMinutes: 720 },
  { careType: 'NURSE', name: 'Nursing care - 24 hours', description: 'Round-the-clock nursing care for 24 hours.', price: 3200, durationMinutes: 1440 },

  // ---- PHYSIO ----
  { careType: 'PHYSIO', name: 'Physiotherapy session', description: 'Assessment and exercise therapy session at home.', price: 800, durationMinutes: 60 },
  { careType: 'PHYSIO', name: 'Post-surgery rehabilitation', description: 'Rehab after knee, hip or spine surgery to restore movement and strength.', price: 1000, durationMinutes: 60 },
  { careType: 'PHYSIO', name: 'Stroke rehabilitation', description: 'Neuro physiotherapy to regain mobility and balance after a stroke.', price: 1100, durationMinutes: 60 },
  { careType: 'PHYSIO', name: 'Back and neck pain therapy', description: 'Pain relief and posture correction for back and neck pain.', price: 800, durationMinutes: 45 },
  { careType: 'PHYSIO', name: 'Elderly mobility therapy', description: 'Balance, strength and fall-prevention exercises for seniors.', price: 700, durationMinutes: 45 },

  // ---- CARETAKER ----
  { careType: 'CARETAKER', name: 'Elderly care - 4 hours', description: 'Companionship, feeding, hygiene and medication reminders.', price: 800, durationMinutes: 240 },
  { careType: 'CARETAKER', name: 'Caretaker - 12 hour shift', description: 'Daily living assistance for a 12-hour day or night shift.', price: 1500, durationMinutes: 720 },
  { careType: 'CARETAKER', name: 'Caretaker - 24 hour live-in', description: 'A live-in caretaker for 24 hours.', price: 2500, durationMinutes: 1440 },
  { careType: 'CARETAKER', name: 'Bedridden patient care - 12 hours', description: 'Turning, hygiene, feeding and bed-sore prevention for bedridden patients.', price: 1800, durationMinutes: 720 },
  { careType: 'CARETAKER', name: 'Hospital discharge assistance', description: 'Help getting home from the hospital and settling in.', price: 1000, durationMinutes: 240 },
];

const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}/api/v1/hbc`).replace(/\/+$/, '');
const TOKEN = process.env.ADMIN_TOKEN;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function main() {
  if (!TOKEN) throw new Error('Set ADMIN_TOKEN to a SUPER_ADMIN access token from the auth service');

  const existing = await api('GET', '/admin/catalog/services');
  if (existing.status !== 200) throw new Error(`Listing the catalog failed (${existing.status}): ${JSON.stringify(existing.data)}`);
  const have = new Set((existing.data as { careType: string; name: string }[]).map((s) => `${s.careType}|${s.name.toLowerCase()}`));

  let created = 0;
  for (const s of CATALOG) {
    if (have.has(`${s.careType}|${s.name.toLowerCase()}`)) {
      console.log(`  = ${s.careType.padEnd(9)} ${s.name} (already exists)`);
      continue;
    }
    const res = await api('POST', '/admin/catalog/services', s);
    if (res.status !== 201) throw new Error(`Creating "${s.name}" failed (${res.status}): ${JSON.stringify(res.data)}`);
    console.log(`  + ${s.careType.padEnd(9)} ${s.name}  Rs ${s.price} / ${s.durationMinutes} min`);
    created++;
  }
  console.log(`\nDone: ${created} created, ${CATALOG.length - created} already there (${BASE}).`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
