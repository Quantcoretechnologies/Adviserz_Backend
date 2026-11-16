# Adviserz API

Backend for the Adviserz web and mobile apps. It is built with Node.js 24, TypeScript, Express 5, Sequelize 6 and PostgreSQL 18.

## Setup

```bash
nvm use 24
npm install
cp .env.example .env          # fill DB_*, secrets and SUPER_ADMIN_*
npm run db:migrate            # create the schema
npm run db:seed               # segments, policies v1, brokers, super admin
npm run dev                   # http://localhost:4000
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The API **refuses to start if a migration is pending**. Migrations are a separate deployment step and never run on boot.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with reload on change |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled build |
| `npm run typecheck` | Strict type check |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:undo` | Revert the last migration |
| `npm run db:migrate:undo:all` | Revert everything (blocked in production) |
| `npm run db:migrate:status` | Show executed and pending migrations |
| `npm run db:seed` / `db:seed:status` | Apply seeders / show their status |
| `npm run db:migrate:prod` / `db:seed:prod` | Same as above, run from the compiled `dist/` |
| `npm run test:e2e` | End-to-end suite: rebuilds the `*_test` database, runs every flow against the real app |
| `npm run maintenance:cleanup` | Purge ended sessions and old OTP records once (also runs hourly in-process) |

### Tests

`npm run test:e2e` drops and recreates the database named by `TEST_DB_NAME` (default `adviserz_test`), applies every migration and seed, and drives the real API over HTTP. The database credentials come from `.env`. For safety, the harness refuses to run unless the database name ends with `_test`. Run the suite before every merge.

## Project layout

```
src/
  config/        env validation (zod), logger (pino)
  db/            sequelize instance, umzug runner + CLI, migrations/, seeders/
  models/        typed models, value sets (enums.ts), associations (index.ts)
  common/        errors, response envelope, middleware, utils (crypto, decimal, password)
  modules/
    auth/          registration, login, refresh, logout, password reset, sessions, tokens
    verification/  OTP issue/verify, single-use verification tokens
    notifications/ OTP delivery providers (currently `static`)
    onboarding/    step-by-step risk profiling
    riskProfile/   versioned risk profiles (shared rules)
    users/         profile, password, devices, policy re-acceptance
    policies/      current policy versions and acceptance
    segments/ brokers/ catalog/   reference data
    admin/         super-admin console APIs
    audit/         append-only audit trail
```

## Conventions

- **Responses** always have the same shape: `{ success, message, data, requestId }`. Errors also include `code` and, where relevant, `details[]` (`path`, `message`, …).
  Clients should branch on `code` (see `src/common/errors/errorCodes.ts`), never on `message`.
- **Money and percentages** are returned as fixed-scale strings (`"150000.00"`, `"2.5000"`). They are stored as `NUMERIC(18,2)` and `NUMERIC(9,4)`.
  JavaScript floats are never used for these values. Requests may send either strings or numbers.
- **Phone numbers**: input is a 10-digit Indian mobile number (an optional `+91` prefix is accepted). Numbers are stored as `+91XXXXXXXXXX`.
- **Email** is stored in lower case. **Username** is unique regardless of upper/lower case.

## Client integration

### Registration (email and phone verified before the form is submitted)

1. `POST /api/v1/auth/register/email/send-otp {email}` returns `verificationId`.
2. `POST /api/v1/auth/register/phone/send-otp {phone}` returns `verificationId`.
3. `POST /api/v1/auth/register/verify-otp {verificationId, otp}` returns `verificationToken`. Do this once for email and once for phone.
4. `POST /api/v1/auth/register` with the form fields plus `emailVerificationToken` and `phoneVerificationToken`.
5. Send the user to the login screen.

Each verification token is valid only for the exact email or phone it was issued for, expires after 15 minutes and can be used once.

### Sessions

| | Web | Mobile |
| --- | --- | --- |
| Login | `POST /auth/web/login` | `POST /auth/mobile/login` |
| Refresh | `POST /auth/web/refresh` (cookie + `X-CSRF-Token` header) | `POST /auth/mobile/refresh {refreshToken}` |
| Logout | `POST /auth/web/logout` (cookie + `X-CSRF-Token`) | `POST /auth/mobile/logout {refreshToken}` |
| Refresh token location | HttpOnly cookie (never readable by JS) | Response body; store in Keychain (iOS) or Keystore (Android) |

- Login takes `{ identifier, password }`, where `identifier` is an email or a phone number.
- Login returns a 15-minute access token. Send it as `Authorization: Bearer <token>`.
- Login also returns `nextAction`, one of `onboarding`, `policy_acceptance` or `null`, so the client knows where to route the user.
- **Refresh tokens are replaced on every refresh.**
  - If a token is used again within a few seconds of being replaced (for example, two tabs refreshing at once), the request gets `409 REFRESH_TOKEN_ALREADY_ROTATED` and the session stays valid. Retry once: web with the current cookie, mobile with the latest stored token.
  - If an old token is reused after that window, it's treated as theft: that device's session is revoked with `401 TOKEN_REUSE_DETECTED`.
  - Still route requests through a single in-flight refresh per client.
- Web: pass `credentials: 'include'`, keep the `csrfToken` from the login/refresh response, and send it as `X-CSRF-Token`.

### Onboarding (required before any other feature)

Call `GET /api/v1/onboarding`. It returns the full state and `nextStep`. Each step saves a draft, and every save returns the updated state:

`PUT /segments` → `PUT /experience` → `PUT /capital` → `PUT /risk` → `POST /broker/skip` (optional step) → `POST /policies/accept` → `POST /confirm`

Until onboarding is confirmed, gated endpoints return `403 ONBOARDING_REQUIRED`. Once an admin publishes a new policy version, gated endpoints return `403 POLICY_ACCEPTANCE_REQUIRED` until the user accepts it (`GET` / `POST /users/me/policies`).

### Other endpoints

- `GET|PATCH /users/me`
- `POST /users/me/password`
- `GET /users/me/sessions`, `DELETE /users/me/sessions/:id`
- `POST /users/me/sessions/revoke-others`, `POST /users/me/sessions/revoke-all`
- `GET|PUT /users/me/risk-profile`, `GET /users/me/risk-profile/history`
- Password reset: `POST /auth/password/forgot` → `/verify-otp` → `/reset`
  - By design, these endpoints never reveal whether an email is registered. `forgot` always returns the same response, and `verify-otp` reports every failure as `OTP_INVALID`.
  - Show the user a generic message such as "If an account exists, we've sent a code".
- Admin console: `/api/v1/admin/...` (see `src/modules/admin/admin.routes.ts`)
- Public reference data: `GET /segments`, `GET /policies/current`, `GET /brokers`

## Before going to production

- **OTP delivery:** implement real SMS and email providers in `src/modules/notifications/otpSender.ts`. `static` is rejected at startup when `NODE_ENV=production`.
- **Policy text:** publish the approved Terms & Conditions and Risk Policy as version 2. The seeded version 1 is placeholder text.
- **Segment limits:** set minimum capital and the allowed risk ranges per segment from the admin console. They are seeded at `0` and `0.01–100%`.
- **Multiple instances:** if you run more than one instance, switch the in-memory rate limiter to a shared store such as Redis.
