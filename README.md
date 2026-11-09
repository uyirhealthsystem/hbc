claude --resume cd8ab74d-d943-4856-8f4b-6a79bb388ecb
# Home Based Care API

Express + TypeScript + PostgreSQL backend for booking home care from **Nurses**, **Physiotherapists** and **Caretakers**.
The API contract is in [`openapi.yaml`](./openapi.yaml).

## Booking flow (same for all three care types)

```
Patient books (+ prescriptions) ──► PENDING ──(provider picks from pool)──► ACCEPTED  ← patient contact revealed
                                       ▲                                        │
                                       └──────── release (couldn't reach) ──────┤
                                                                                ▼ provider calls & confirms
                                                                            CONFIRMED
                                                                                │ patient pays via payment-service → visit OTP issued
                                                                                ▼
                                                                              PAID
                                                                                │ provider enters OTP at home
                                                                                ▼
                                                                           IN_PROGRESS ──► COMPLETED
Patient can cancel while PENDING / ACCEPTED / CONFIRMED → CANCELLED
```

- **Pool** shows only bookings **matched** to the provider (see below), nearest first, with `distanceKm` but without the patient's name, phone, address, exact coordinates, notes or prescriptions.
- **Accept** locks the row (`SELECT … FOR UPDATE`), so if two providers pick the same booking only one wins (the other gets `409 BOOKING_UNAVAILABLE`).
- **Visit OTP** (6 digits) is issued once payment-service reports the payment PAID and shown only to the patient. The provider must get it from the patient at the door. Wrong attempts are counted, and the OTP locks after `OTP_MAX_ATTEMPTS`.
- Providers **register their profile** (`POST /provider/profile`) with their care type, pincode, latitude and longitude, and can pick bookings straight away. There is no admin verification.
- **Accept** applies the same matching rule as the pool, so a provider can't pick a booking outside their area by id.
- HBC keeps **no patient profile**. The patient's name, phone and address are captured on each booking.
- Every status change is written to `booking_events` as an audit trail.

## Payments (Uyir payment-service)

HBC never talks to Razorpay. It uses the shared [payment-service](../payment-service/docs/IMPLEMENTATION_GUIDE.md) as module `HOME_CARE_BOOKING`.

```
app ── POST /patient/bookings/:id/pay ──► HBC ── POST /api/payments/intents ──► payment-service ──► Razorpay link
    ◄────────── { payment: { id, status: PENDING, checkoutUrl } } ◄──────────
app opens checkoutUrl, patient pays
app ── POST /api/payments/{payment.id}/refresh (payment-service, via gateway), then polls GET /patient/bookings/:id
payment-service ── signed POST /api/v1/hbc/payments/webhook ──► HBC: booking CONFIRMED → PAID, visit OTP issued
```

- **Pay** (`POST /patient/bookings/:id/pay`, no body) works only on a `CONFIRMED` booking. The amount always comes from the booking, never from the app. The `Idempotency-Key` is `hbc-booking-<bookingId>`, so calling it again is safe: you get the same checkout while it is valid, or a fresh one after it expires or fails.
- **Identity:** payment-service creates the payment *as the patient*, so HBC forwards the patient's `Authorization: Bearer` header (the gateway passes it through), and payment-service verifies it via `AUTH_JWKS_URL`. With `PAYMENT_SEND_IDENTITY_HEADERS=true` (local only) HBC sends `X-User-Id` / `X-User-Role` instead, for payment-service's `local` profile.
- **Callback** (`POST /api/v1/hbc/payments/webhook`): no user headers. It is authenticated by `X-Payment-Signature`, an HMAC-SHA256 over `timestamp.rawBody` with `PAYMENT_WEBHOOK_SECRET`, and the timestamp must be within ±5 min. Each `eventId` is processed once, in the same transaction as the booking change.
  - `PAID` with amount ≥ the booking amount: the booking becomes `PAID`, a `payments` row is written, and the OTP is issued. An underpaid callback is logged as `AMOUNT MISMATCH` and the booking is not marked paid.
  - `FAILED`: shown as `payment.status = FAILED` with `failureReason`. The booking is not cancelled, and the patient can pay again. A late `FAILED` after `PAID` is ignored.
  - `PAID` on a booking that was cancelled while its checkout was still open: the payment is recorded and `payment.refundRequired = true` (patient and admin views). Refund it with payment-service `POST /api/payments/{id}/refunds` (ADMIN).
- Patient and admin booking views carry `payment: { id, status, failureReason, refundRequired }`.

| HBC env | |
|---|---|
| `PAYMENT_SERVICE_URL` | payment-service base URL (e.g. `http://payment-service:8083`), or the api-gateway. Required in production |
| `PAYMENT_WEBHOOK_SECRET` | Same value as payment-service `HOMECARE_PAYMENT_WEBHOOK_SECRET` (`openssl rand -hex 32`). Required in production |
| `PAYMENT_REFERENCE_TYPE` | Default `HOME_CARE_BOOKING` |
| `PAYMENT_SEND_IDENTITY_HEADERS` | `true` only against payment-service's `local` profile. Production refuses to start with it |

| payment-service env | |
|---|---|
| `HOMECARE_PAYMENT_WEBHOOK_URL` | `http://<hbc host>:4000/api/v1/hbc/payments/webhook`. Point it at HBC **directly**, because the gateway's `/api/v1/hbc` route requires a user token. Until it is set, payment-service refuses `HOME_CARE_BOOKING` intents with a real provider |
| `HOMECARE_PAYMENT_WEBHOOK_SECRET` | Same as HBC `PAYMENT_WEBHOOK_SECRET` (local profile default: `local-homecare-payment-secret`) |
| `HOMECARE_PAYMENT_RETURN_URL` | Optional app page shown after checkout |

Local: start payment-service with `--spring.profiles.active=local` (mock provider, pays at once) and `HOMECARE_PAYMENT_WEBHOOK_URL=http://localhost:4000/api/v1/hbc/payments/webhook`, then `npm run test:e2e`.

## Location matching

A booking is matched to a provider when:

1. the **care type** is the same (`NURSE`, `PHYSIO` or `CARETAKER`), **and**
2. the booking is in the provider's **pincode**, **or** within `SERVICE_RADIUS_KM` (default `10`) of the provider's **latitude/longitude**.

Bookings and provider profiles both carry `pincode`, `latitude` and `longitude`. Distance is the great-circle (haversine) distance, computed in SQL. A provider who moves updates their location with `PATCH /provider/profile` (latitude and longitude together), and their pool changes with it.

Data created before this rule: bookings without coordinates still match by pincode. Provider profiles without a location get `403 PROVIDER_LOCATION_REQUIRED` on the pool until they add one.

## Roles

| Role | Does what |
|------|-----------|
| `SUPER_ADMIN` | Lives in the separate super-admin service. Manages the service catalog, lists providers and views all bookings by calling `/admin/*` through the gateway with `X-Role: SUPER_ADMIN`. |
| `PATIENT` | Books care (with contact details and prescriptions), pays, cancels. |
| `HBC` | Every care provider. Registers a profile with a care type (`NURSE`, `PHYSIO` or `CARETAKER`), then picks, confirms, starts (OTP) and completes bookings of that type. The care type is fixed after registration. |

## Gateway identity (`src/middleware/auth.ts`)

User accounts, login credentials and tokens live in the separate **auth service**. HBC has no `/auth` endpoints and stores no credentials. The API gateway validates the access token, then forwards the request with:

| Header | Value |
|--------|-------|
| `X-User-Id` | the caller's user id (UUID) |
| `X-Role` | `SUPER_ADMIN`, `PATIENT` or `HBC` |
| `X-Gateway-Secret` | only when `GATEWAY_SHARED_SECRET` is set in `.env` |

This service does not verify JWTs. It trusts these headers for every role check, so it **must only be reachable through the gateway**. Don't expose its port publicly. Missing or invalid headers return `401`, and the wrong role returns `403`.

## Setup

```bash
npm install
# edit .env → set DATABASE_URL (copy from .env.example)
createdb home_care            # or: psql -U postgres -c "CREATE DATABASE home_care"
npm run db:migrate
npm run dev                   # http://localhost:4000
```

Run the end-to-end flow test (server must be running):

```bash
npm run test:e2e
```

It runs the full flow for all three care types: catalog creation, provider profile registration, location matching (same pincode, nearby by distance, far away, moving), booking with prescriptions, pool privacy, the accept race, confirmation, payment, wrong and correct OTP, completion, release and cancellation.

## Postman

The collection calls HBC directly and sends the identity headers itself, the same way the gateway does.

| File | What it is |
|------|------------|
| `postman/Home Based Care API.postman_collection.json` | All endpoints as one runnable end-to-end flow, with tests |
| `postman/HBC Local.postman_environment.json` | `baseUrl` and `gatewaySecret` for a local server |

### Import

1. Start the server (`npm run dev`).
2. In Postman, choose **Import** and drop in both JSON files.
3. Pick **HBC Local** in the environment selector (top right).
4. Edit the environment:
   - `baseUrl`: the host only, `http://localhost:4000`. Request URLs already include `/api/v1/hbc`.
   - `gatewaySecret`: the same value as `GATEWAY_SHARED_SECRET` in `.env`. Leave it empty if that isn't set.

When re-importing after an update, **delete the old collection and the old HBC Local environment first**. Postman keeps an existing environment's values on import, so an old `baseUrl` such as `http://localhost:4000/api/v1` survives and produces wrong paths like `/api/v1/api/v1/hbc/...`.

### Run

Run the whole collection with the Collection Runner, keeping the folders in order. Each step saves ids (provider, service, booking, OTP) for the next one. The folders are:

1. **Provider profiles**: generates this run's user ids, registers two `HBC` providers in T Nagar (600017) and checks the profile rules (location required, care type fixed, no verification).
2. **Super Admin**: creates and updates a catalog service and lists providers by care type and pincode.
3. **Catalog**: public service list.
4. **Booking flow**: book, pool (with `distanceKm`), accept (with a losing rival), confirm, pay, start with OTP, complete.
5. **Location matching**: a booking in Adyar (another pincode, ~5 km) is matched by distance; one in Coimbatore (~430 km) isn't, and accepting it returns `404`.
6. **Release and cancel**: a second booking that is released back to the pool and then cancelled.
7. **Gateway header checks**: missing or invalid headers (`401`) and wrong roles (`403`).

To run the same flow for another care type, set the collection variable `careType` to `PHYSIO` or `CARETAKER`.

From the command line:

```bash
postman collection run "postman/Home Based Care API.postman_collection.json" \
  -e "postman/HBC Local.postman_environment.json" \
  --env-var "gatewaySecret=<your GATEWAY_SHARED_SECRET>" \
  --env-var careType=NURSE
```

### Sending single requests

User ids are normally issued by the auth service. The first request (**Register provider profile**) generates `patientId`, `providerId` and `rivalId` for the run, so send it first, or set those collection variables to UUIDs yourself. `adminId` can be any UUID, since super admins live in a separate service.

### Common errors

| Response | Cause | Fix |
|----------|-------|-----|
| `401 Request did not come through the gateway` | `GATEWAY_SHARED_SECRET` is set but `gatewaySecret` is empty or different | Set `gatewaySecret` to the `.env` value |
| `401 Missing or invalid X-User-Id / X-Role headers` | `details` names the bad header and shows what arrived. `"received": "{{adminId}}"` means the Postman variable didn't resolve. `X-User-Id` must be a UUID, and `X-Role` must be exactly `SUPER_ADMIN`, `PATIENT` or `HBC` (case-sensitive) | Select the **HBC Local** environment, check the variable has a UUID value, or send **Register provider profile** first |
| 404 shaped `{"status":404,"error":"Not Found","path":...}` | The request reached the API gateway, which has no `/api/v1/hbc/**` route | Point `baseUrl` at HBC (`http://localhost:4000`), or add the route to the gateway |
| `404 Route ... not found` (HBC format) | Wrong path, often a stale `baseUrl` from an old import | Delete and re-import the environment |
| Server exits with `GATEWAY_SHARED_SECRET ... at least 16 character(s)` | The secret in `.env` is too short | Use 16+ characters, or comment the line out |

## Endpoints (prefix `/api/v1/hbc`)

| Area | Method & path |
|------|---------------|
| Catalog (public) | `GET /catalog/services?careType=` |
| Admin | `GET/POST /admin/catalog/services`, `PATCH/DELETE /admin/catalog/services/:id`, `GET /admin/providers?careType=&pincode=`, `GET /admin/bookings` |
| Patient | `POST/GET /patient/bookings`, `GET /patient/bookings/:id`, `POST /patient/bookings/:id/pay` (returns checkout URL), `POST /patient/bookings/:id/cancel` |
| Payments (payment-service only) | `POST /payments/webhook` (HMAC-signed, no user headers) |
| Provider profile | `POST/GET/PATCH /provider/profile` |
| Provider bookings | `GET /provider/bookings/pool`, `GET /provider/bookings`, `GET /provider/bookings/:id`, `POST /provider/bookings/:id/{accept,release,confirm,start,complete}` |

## Project layout

```
src/
  app.ts, server.ts
  config/env.ts              validated environment
  db/                        pg pool, transaction helper, SQL migrations
  middleware/                authenticate (gateway headers) / requireRole, zod validation, error handler
  modules/
    providers/               service-provider profiles (register, view, update, location)
    catalog/                 care services catalog
    admin/                   super-admin routes (catalog CRUD, provider and booking lists)
    bookings/                booking state machine (patient + provider routes, payment settlement)
    payments/                payment-service client + signed callback receiver
scripts/e2e.ts               end-to-end flow test (sends gateway headers)
postman/                     Postman collection + local environment (v2.1 JSON, import into Postman)
openapi.yaml                 API contract
```

## Not yet production-ready

- **Refunds** are not automated. Paid bookings cannot be cancelled, and `refundRequired` bookings must be refunded by an admin in payment-service.
- **Prescription files** are stored as `documentUrl` links. Add an upload endpoint (S3 or similar) if patients need to upload images or PDFs.
- Add rate limiting on the OTP endpoint.
