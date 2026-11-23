/**
 * Adviserz API — end-to-end suite.
 *
 * Runs the real application against a freshly built PostgreSQL database
 * (see harness.ts). Sections run in order and share state, mirroring a real
 * user journey: register -> sign in -> onboard -> edit profile -> admin
 * actions -> password flows -> maintenance.
 *
 *   npm run test:e2e
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { QueryTypes } from 'sequelize';
import { cookieValue, createClient, sleep, toCookieHeader, type ApiResponse } from './client.js';
import {
  startTestEnvironment,
  TEST_ADMIN,
  TEST_OTP,
  TEST_OTP_COOLDOWN_SECONDS,
  TEST_ORIGIN,
  TEST_REFRESH_GRACE_SECONDS,
  type TestEnvironment,
} from './harness.js';

function check(condition: unknown, label: string, detail?: unknown): void {
  assert.ok(condition, detail === undefined ? label : `${label}\n  -> ${JSON.stringify(detail).slice(0, 800)}`);
}

let envHandle: TestEnvironment;
let call: ReturnType<typeof createClient>;

async function rows<T extends object>(sql: string, replacements: Record<string, unknown> = {}): Promise<T[]> {
  return envHandle.sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

// Shared journey state ---------------------------------------------------------
const unique = Date.now().toString().slice(-6);
const user = {
  fullName: 'Aarav  Sharma',
  username: `aarav_${unique}`,
  email: `Aarav.${unique}@Example.com`,
  phone: `98${unique}12`,
  password: 'Str0ng!Pass',
};
const emailNorm = user.email.toLowerCase();
let emailToken = '';
let phoneToken = '';
let mobile: any;
let web: any;
let webCookies = '';
let webCsrf = '';
let segments: Record<string, string> = {};
let userId = '';
let admin: any;
let adminCookies = '';

const login = (identifier: string, password: string, deviceName?: string): Promise<ApiResponse> =>
  call('POST', '/auth/mobile/login', { body: { identifier, password, ...(deviceName ? { deviceName } : {}) } });

describe('Adviserz API (end-to-end)', { concurrency: false }, () => {
  before(async () => {
    envHandle = await startTestEnvironment();
    call = createClient(envHandle.apiUrl);
  });

  after(async () => {
    envHandle.overrideOtpSender('email', null);
    envHandle.overrideOtpSender('sms', null);
    await envHandle?.close();
  });

  it('serves health checks, reference data and a consistent error envelope', async () => {
    const health = await call('GET', `${envHandle.baseUrl}/health`);
    check(health.status === 200, 'GET /health 200');
    check(health.headers.get('x-request-id'), 'X-Request-Id header present');
    check((await call('GET', `${envHandle.baseUrl}/ready`)).status === 200, 'GET /ready 200');

    const segs = await call('GET', '/segments');
    check(segs.status === 200 && segs.json.data.items.length === 4, 'four seeded segments', segs.json);
    const delivery = segs.json.data.items.find((s: any) => s.code === 'EQUITY_DELIVERY');
    const intraday = segs.json.data.items.find((s: any) => s.code === 'EQUITY_INTRADAY');
    check(delivery.minCapital === '25000.00' && delivery.riskRules.bands.length === 11, 'delivery bands, fixed-scale decimals', delivery);
    check(intraday.minCapital === '10000.00' && intraday.riskRules.bands[0].suggestedRiskPercent === '6.2500', 'intraday midpoint', intraday.riskRules);
    check(!segs.json.data.items.some((s: any) => s.code === 'HEDGING'), 'hedging not seeded');
    check((await call('GET', '/policies/current')).json.data.items.length === 2, 'two current policies');
    check((await call('GET', '/brokers')).json.data.items.length === 0, 'no active brokers');

    const notFound = await call('GET', '/nope');
    check(notFound.status === 404 && notFound.json.code === 'ROUTE_NOT_FOUND' && notFound.json.requestId, '404 envelope');
    const badJson = await call('POST', '/auth/web/login', { rawBody: '{bad json' });
    check(badJson.status === 400 && badJson.json.code === 'BAD_REQUEST', 'malformed JSON -> 400');
  });

  it('validates the registration form', async () => {
    const res = await call('POST', '/auth/register', {
      body: { fullName: 'A', username: '1abc', email: 'x', phone: '98abc12345', password: 'weak', confirmPassword: 'other', emailVerificationToken: '', phoneVerificationToken: '' },
    });
    const paths = new Set((res.json.details ?? []).map((d: any) => d.path));
    check(res.status === 422 && res.json.code === 'VALIDATION_ERROR', '422 VALIDATION_ERROR');
    for (const field of ['username', 'phone', 'password', 'email']) check(paths.has(field), `${field} rejected`, res.json.details);

    const res2 = await call('POST', '/auth/register', {
      body: { ...user, password: `${user.username}A1!`, confirmPassword: 'x', emailVerificationToken: 'a', phoneVerificationToken: 'b' },
    });
    const messages = (res2.json.details ?? []).map((d: any) => `${d.path}:${d.message}`).join('|');
    check(messages.includes('confirmPassword:Passwords do not match'), 'confirm mismatch', res2.json.details);
    check(messages.includes('password:Password must not contain'), 'password containing username', res2.json.details);
    check((await call('POST', '/auth/register/phone/send-otp', { body: { phone: '5123456789' } })).status === 422, 'non-Indian mobile rejected');
  });

  it('registers with email + phone OTP verification bound to each destination', async () => {
    check((await call('GET', `/auth/username-availability?username=${user.username}`)).json.data.available === true, 'username available');

    const sent = await call('POST', '/auth/register/email/send-otp', { body: { email: user.email } });
    check(sent.status === 200 && sent.json.data.verificationId, 'email OTP sent', sent.json);
    const again = await call('POST', '/auth/register/email/send-otp', { body: { email: user.email } });
    check(again.status === 429 && again.json.code === 'OTP_RESEND_TOO_SOON', 'registration resend cooldown is explicit', again.json);

    const wrong = await call('POST', '/auth/register/verify-otp', { body: { verificationId: sent.json.data.verificationId, otp: '000000' } });
    check(wrong.status === 400 && wrong.json.code === 'OTP_INVALID' && wrong.json.details?.[0]?.remainingAttempts === 4, 'registration shows remaining attempts', wrong.json);
    const ok = await call('POST', '/auth/register/verify-otp', { body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP } });
    check(ok.status === 200 && ok.json.data.channel === 'email', 'email verified', ok.json);
    emailToken = ok.json.data.verificationToken;
    const twice = await call('POST', '/auth/register/verify-otp', { body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP } });
    check(twice.status === 400 && twice.json.code === 'OTP_EXPIRED', 'OTP single use');

    const phone = await call('POST', '/auth/register/phone/send-otp', { body: { phone: `+91 ${user.phone}` } });
    check(phone.status === 200, '+91 prefix accepted', phone.json);
    const phoneOk = await call('POST', '/auth/register/verify-otp', { body: { verificationId: phone.json.data.verificationId, otp: TEST_OTP } });
    check(phoneOk.json.data.channel === 'sms', 'phone verified');
    phoneToken = phoneOk.json.data.verificationToken;

    const swapped = await call('POST', '/auth/register', {
      body: { ...user, confirmPassword: user.password, emailVerificationToken: emailToken, phoneVerificationToken: emailToken },
    });
    check(swapped.status === 422 && swapped.json.code === 'PHONE_NOT_VERIFIED', 'email token rejected as phone token', swapped.json);
    const otherEmail = await call('POST', '/auth/register', {
      body: { ...user, email: `someone.${unique}@example.com`, confirmPassword: user.password, emailVerificationToken: emailToken, phoneVerificationToken: phoneToken },
    });
    check(otherEmail.status === 422 && otherEmail.json.code === 'EMAIL_NOT_VERIFIED', 'token bound to its email');

    const reg = await call('POST', '/auth/register', {
      body: { ...user, confirmPassword: user.password, emailVerificationToken: emailToken, phoneVerificationToken: phoneToken },
    });
    check(reg.status === 201, 'registered', reg.json);
    userId = reg.json.data.user.id;
    check(reg.json.data.user.email === emailNorm, 'email normalised');
    check(reg.json.data.user.phone === `+91${user.phone}`, 'phone E.164');
    check(reg.json.data.user.fullName === 'Aarav Sharma', 'name whitespace collapsed');
    check(!/passwordHash|argon2/.test(JSON.stringify(reg.json)), 'no hash leaked');

    const replay = await call('POST', '/auth/register', {
      body: { ...user, username: `other_${unique}`, confirmPassword: user.password, emailVerificationToken: emailToken, phoneVerificationToken: phoneToken },
    });
    check(replay.status === 422 && replay.json.code === 'EMAIL_NOT_VERIFIED', 'consumed tokens not replayable');
    const dupe = await call('POST', '/auth/register/email/send-otp', { body: { email: emailNorm.toUpperCase() } });
    check(dupe.status === 409 && dupe.json.code === 'EMAIL_ALREADY_REGISTERED', 'duplicate email (any case)');
    check((await call('GET', `/auth/username-availability?username=${user.username.toUpperCase()}`)).json.data.available === false, 'username case-insensitive');
  });

  it('removes an undelivered OTP so the user can retry immediately', async () => {
    const email = `delivery.${unique}@example.com`;
    envHandle.overrideOtpSender('email', {
      usesStaticCode: true,
      send: async () => {
        throw new Error('provider down');
      },
    });
    const failed = await call('POST', '/auth/register/email/send-otp', { body: { email } });
    check(failed.status === 502 && failed.json.code === 'OTP_DELIVERY_FAILED', 'delivery failure surfaced', failed.json);
    const [{ n }] = (await rows<{ n: number }>('SELECT COUNT(*)::int AS n FROM verification_requests WHERE destination = :email', { email })) as [{ n: number }];
    check(n === 0, 'undelivered request removed', n);

    envHandle.overrideOtpSender('email', null);
    const retry = await call('POST', '/auth/register/email/send-otp', { body: { email } });
    check(retry.status === 200, 'immediate retry not blocked by cooldown', retry.json);

    // A later resend that fails must not kill the code the user already has.
    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);
    envHandle.overrideOtpSender('email', { usesStaticCode: true, send: async () => { throw new Error('provider down'); } });
    const failedResend = await call('POST', '/auth/register/email/send-otp', { body: { email } });
    envHandle.overrideOtpSender('email', null);
    check(failedResend.status === 502, 'failed resend reported');
    const stillValid = await call('POST', '/auth/register/verify-otp', { body: { verificationId: retry.json.data.verificationId, otp: TEST_OTP } });
    check(stillValid.status === 200, 'previous code still valid after a failed resend', stillValid.json);

    // A successful resend retires older codes.
    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);
    const older = await call('POST', '/auth/register/email/send-otp', { body: { email } });
    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);
    const newer = await call('POST', '/auth/register/email/send-otp', { body: { email } });
    check(older.status === 200 && newer.status === 200, 'two successful sends');
    const retired = await call('POST', '/auth/register/verify-otp', { body: { verificationId: older.json.data.verificationId, otp: TEST_OTP } });
    check(retired.status === 400 && retired.json.code === 'OTP_EXPIRED', 'older code retired by successful resend', retired.json);
  });

  it('signs in on mobile and web with the right token transport', async () => {
    const bad = await login(emailNorm, 'Wrong!Pass1');
    check(bad.status === 401 && bad.json.code === 'INVALID_CREDENTIALS', 'wrong password');
    const unknown = await login('nobody@example.com', 'Wrong!Pass1');
    check(unknown.status === 401 && unknown.json.code === 'INVALID_CREDENTIALS', 'unknown account looks identical');

    const m = await login(user.phone, user.password, 'Pixel 9');
    check(m.status === 200 && m.json.data.refreshToken && m.setCookies.length === 0, 'mobile: token in body, no cookies', m.json);
    check(m.json.data.nextAction === 'onboarding', 'nextAction onboarding');
    mobile = m.json.data;

    const w = await call('POST', '/auth/web/login', { body: { identifier: user.email, password: user.password }, headers: { origin: TEST_ORIGIN } });
    check(w.status === 200 && w.json.data.csrfToken && !('refreshToken' in w.json.data), 'web: csrf in body, no refresh token', w.json);
    const rt = w.setCookies.find((c) => c.startsWith('adz_rt='));
    check(rt && /HttpOnly/i.test(rt) && /SameSite=Strict/i.test(rt) && rt.includes('Path=/api/v1/auth/web'), 'refresh cookie flags', rt);
    web = w.json.data;
    webCookies = toCookieHeader(w.setCookies);
    webCsrf = web.csrfToken;

    const evil = await call('POST', '/auth/web/login', { body: { identifier: user.email, password: user.password }, headers: { origin: 'https://evil.example' } });
    check(evil.status === 403, 'disallowed origin rejected');
  });

  it('gates features behind authentication and onboarding', async () => {
    const none = await call('GET', '/users/me');
    check(none.status === 401 && none.json.code === 'UNAUTHENTICATED', 'no token');
    const junk = await call('GET', '/users/me', { token: 'abc.def.ghi' });
    check(junk.status === 401 && junk.json.code === 'ACCESS_TOKEN_INVALID', 'garbage token');
    const me = await call('GET', '/users/me', { token: mobile.accessToken });
    check(me.json.data.requirements.onboardingRequired === true, 'onboarding required');
    const rp = await call('GET', '/users/me/risk-profile', { token: mobile.accessToken });
    check(rp.status === 403 && rp.json.code === 'ONBOARDING_REQUIRED', 'ONBOARDING_REQUIRED');
  });

  it('completes onboarding step by step with exact decimals', async () => {
    const t = mobile.accessToken;
    const state = await call('GET', '/onboarding', { token: t });
    check(state.json.data.nextStep === 'segments' && state.json.data.draft === null, 'starts at segments', state.json.data);
    segments = Object.fromEntries(state.json.data.availableSegments.map((s: any) => [s.code, s.id]));
    const { EQUITY_DELIVERY: DEL, EQUITY_INTRADAY: INTRA, FNO_INDEX: IDX, FNO_STOCK: STK } = segments;

    const pre = await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [{ segmentId: DEL, capital: '1000' }] } });
    check(pre.status === 422 && pre.json.code === 'ONBOARDING_STEP_PREREQUISITE', 'capital before segments');
    const bogus = await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: ['00000000-0000-4000-8000-000000000000'] } });
    check(bogus.json.code === 'SEGMENT_NOT_AVAILABLE', 'unknown segment');

    const s1 = await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [DEL, INTRA, IDX, STK] } });
    check(s1.json.data.nextStep === 'experience' && s1.json.data.draft.segments.length === 4, 'segments saved', s1.json);
    check((await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'intermediate' } })).json.data.nextStep === 'capital', 'experience saved');
    check((await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'guru' } })).status === 422, 'invalid experience');

    const missing = await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [{ segmentId: DEL, capital: '1000' }] } });
    check(missing.status === 422 && missing.json.details.filter((d: any) => d.message.startsWith('Missing')).length === 3, 'missing capital listed');
    const threeDp = await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [
      { segmentId: DEL, capital: '100.123' }, { segmentId: INTRA, capital: '1' }, { segmentId: IDX, capital: '1' }, { segmentId: STK, capital: '1' }] } });
    check(threeDp.status === 422, 'three decimals rejected');

    const cap = await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [
      { segmentId: DEL, capital: '150000' }, { segmentId: INTRA, capital: 50000.5 }, { segmentId: IDX, capital: '75000.25' }, { segmentId: STK, capital: '10000' }] } });
    check(cap.json.data.nextStep === 'risk', 'capital saved', cap.json);
    const bySeg = (res: ApiResponse, code: string) => res.json.data.draft.segments.find((s: any) => s.code === code);
    check(bySeg(cap, 'EQUITY_DELIVERY').capital === '150000.00', 'string capital exact');
    check(bySeg(cap, 'EQUITY_INTRADAY').capital === '50000.50', 'numeric capital exact');
    check(cap.json.data.draft.totalCapital === '285000.75', 'decimal total', cap.json.data.draft.totalCapital);

    const s2 = await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [DEL, INTRA, IDX] } });
    check(s2.json.data.draft.segments.length === 3 && bySeg(s2, 'EQUITY_DELIVERY').capital === '150000.00', 'deselect keeps other values');
    const stockRows = () => rows<{ capital: string | null; is_deleted: boolean; deleted_at: Date | null }>(
      `SELECT rps.capital, rps.is_deleted, rps.deleted_at FROM risk_profile_segments rps
         JOIN risk_profiles rp ON rp.id = rps.risk_profile_id
        WHERE rp.user_id = :userId AND rps.segment_id = :segmentId ORDER BY rps.created_at`,
      { userId, segmentId: STK },
    );
    const removed = await stockRows();
    check(removed.length === 1 && removed[0]?.is_deleted && removed[0].deleted_at && removed[0].capital === '10000.00', 'deselected row kept as deleted with its value', removed);
    const reselect = await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [DEL, INTRA, IDX, STK] } });
    check(reselect.json.data.nextStep === 'capital' && bySeg(reselect, 'FNO_STOCK').capital === null, 'reselected segment starts fresh', reselect.json);
    check((await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [DEL, INTRA, IDX] } })).json.data.nextStep === 'risk', 'deselected again');
    const history = await stockRows();
    check(history.length === 2 && history.every((row) => row.is_deleted), 'both removals kept', history);

    const tooRisky = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [
      { segmentId: DEL, riskPercent: '150' }, { segmentId: INTRA, riskPercent: '2' }, { segmentId: IDX, riskPercent: '1.5' }] } });
    check(tooRisky.status === 422 && tooRisky.json.code === 'RISK_OUT_OF_RANGE', 'risk out of range');
    const risk = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [
      { segmentId: DEL, riskPercent: '20' }, { segmentId: INTRA, riskPercent: '2' }, { segmentId: IDX, riskPercent: '1.5' }] } });
    check(risk.json.data.nextStep === 'broker', 'risk saved', risk.json);
    check(bySeg(risk, 'EQUITY_DELIVERY').riskBasis === 'total_capital' && bySeg(risk, 'EQUITY_INTRADAY').riskBasis === 'daily_loss', 'risk basis snapshot');

    const early = await call('POST', '/onboarding/confirm', { token: t });
    check(early.json.code === 'ONBOARDING_INCOMPLETE' && early.json.details.map((d: any) => d.step).join(',') === 'broker,policies', 'incomplete steps listed', early.json);
    const broker = await call('POST', '/onboarding/broker/skip', { token: t });
    check(broker.json.data.nextStep === 'policies' && broker.json.data.steps.brokerStepStatus === 'skipped', 'broker skipped');

    const fake = await call('POST', '/onboarding/policies/accept', { token: t, body: { policyDocumentIds: ['00000000-0000-4000-8000-000000000000'] } });
    check(fake.status === 409 && fake.json.code === 'POLICY_VERSION_OUTDATED', 'non-current policy rejected');
    const accepted = await call('POST', '/onboarding/policies/accept', { token: t, body: { policyDocumentIds: broker.json.data.policies.map((p: any) => p.id) } });
    check(accepted.json.data.nextStep === 'confirm', 'policies accepted');
    check((await call('GET', '/onboarding', { token: web.accessToken })).json.data.nextStep === 'confirm', 'web sees same progress');

    const confirm = await call('POST', '/onboarding/confirm', { token: t });
    check(confirm.status === 200 && confirm.json.data.riskProfile.version === 1 && confirm.json.data.user.onboardingStatus === 'completed', 'confirmed', confirm.json);
    check(confirm.json.data.riskProfile.segments.length === 3 && !confirm.json.data.riskProfile.segments.some((s: any) => s.code === 'FNO_STOCK'), 'active profile hides removed segments', confirm.json.data.riskProfile);
    const after = await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'beginner' } });
    check(after.status === 409 && after.json.code === 'ONBOARDING_ALREADY_COMPLETED', 'locked after completion');
  });

  it('versions risk-profile edits and keeps history', async () => {
    const t = mobile.accessToken;
    check((await call('GET', '/users/me/risk-profile', { token: t })).json.data.segments.length === 3, 'active profile');
    const upd = await call('PUT', '/users/me/risk-profile', { token: t, body: { marketExperience: 'experienced', allocations: [
      { segmentId: segments['EQUITY_DELIVERY'], capital: '200000', riskPercent: '24.25' },
      { segmentId: segments['FNO_STOCK'], capital: '60000', riskPercent: '1' }] } });
    check(upd.json.data.version === 2 && upd.json.data.source === 'profile_update', 'v2 created', upd.json);
    // Identical resubmission (different formatting and order) must not create v3.
    const same = await call('PUT', '/users/me/risk-profile', { token: t, body: { marketExperience: 'experienced', allocations: [
      { segmentId: segments['FNO_STOCK'], capital: 60000, riskPercent: '1.0000' },
      { segmentId: segments['EQUITY_DELIVERY'], capital: '200000.00', riskPercent: 24.25 }] } });
    check(same.status === 422 && same.json.code === 'NO_CHANGES', 'unchanged profile rejected', same.json);
    const history = await call('GET', '/users/me/risk-profile/history', { token: t });
    check(history.json.data.items.length === 2, 'no version added for unchanged profile');
    const [v2, v1] = history.json.data.items;
    check(v2.status === 'active' && v1.status === 'superseded' && v1.supersededAt, 'history statuses');
    check(v1.segments.find((s: any) => s.code === 'EQUITY_DELIVERY').riskPercent === '20.0000', 'v1 preserved');
  });

  it('rotates refresh tokens: grace window for races, revocation for real reuse', async () => {
    const first = await call('POST', '/auth/mobile/refresh', { body: { refreshToken: mobile.refreshToken } });
    check(first.status === 200 && first.json.data.refreshToken !== mobile.refreshToken, 'rotated', first.json);
    check((await call('POST', '/auth/mobile/refresh', { body: { refreshToken: 'x'.repeat(43) } })).json.code === 'REFRESH_TOKEN_INVALID', 'unknown token');

    const race = await call('POST', '/auth/mobile/refresh', { body: { refreshToken: mobile.refreshToken } });
    check(race.status === 409 && race.json.code === 'REFRESH_TOKEN_ALREADY_ROTATED', 'reuse within grace -> 409, no revocation', race.json);
    const second = await call('POST', '/auth/mobile/refresh', { body: { refreshToken: first.json.data.refreshToken } });
    check(second.status === 200, 'session survived the benign race', second.json);

    await sleep(TEST_REFRESH_GRACE_SECONDS * 1000 + 300);
    const theft = await call('POST', '/auth/mobile/refresh', { body: { refreshToken: mobile.refreshToken } });
    check(theft.status === 401 && theft.json.code === 'TOKEN_REUSE_DETECTED', 'reuse after grace -> revoked', theft.json);
    check((await call('POST', '/auth/mobile/refresh', { body: { refreshToken: second.json.data.refreshToken } })).json.code === 'SESSION_REVOKED', 'family revoked');
    check((await call('GET', '/users/me', { token: second.json.data.accessToken })).json.code === 'SESSION_REVOKED', 'access cut immediately');
    check((await call('GET', '/users/me', { token: web.accessToken })).status === 200, 'other device unaffected');

    const fresh = (await login(emailNorm, user.password)).json.data;
    check(fresh.nextAction === null, 'onboarded user nextAction null');
    const [a, b] = await Promise.all([
      call('POST', '/auth/mobile/refresh', { body: { refreshToken: fresh.refreshToken } }),
      call('POST', '/auth/mobile/refresh', { body: { refreshToken: fresh.refreshToken } }),
    ]);
    check([a.status, b.status].sort().join(',') === '200,409', 'concurrent refresh: one wins, loser gets 409', [a.json, b.json]);

    mobile = (await login(user.phone, user.password, 'Pixel 9')).json.data;
  });

  it('protects web refresh with CSRF and keeps cookies intact on a tab race', async () => {
    const headers = { origin: TEST_ORIGIN, 'x-csrf-token': webCsrf };
    check((await call('POST', '/auth/web/refresh', { cookies: webCookies, headers: { origin: TEST_ORIGIN } })).json.code === 'CSRF_TOKEN_INVALID', 'missing CSRF');
    check((await call('POST', '/auth/web/refresh', { cookies: webCookies, headers: { origin: TEST_ORIGIN, 'x-csrf-token': 'nope' } })).status === 403, 'wrong CSRF');

    // Two tabs refresh with the same cookie at once.
    const [x, y] = await Promise.all([
      call('POST', '/auth/web/refresh', { cookies: webCookies, headers }),
      call('POST', '/auth/web/refresh', { cookies: webCookies, headers }),
    ]);
    const winner = x.status === 200 ? x : y;
    const loser = x.status === 200 ? y : x;
    check(winner.status === 200 && loser.status === 409 && loser.json.code === 'REFRESH_TOKEN_ALREADY_ROTATED', 'tab race resolved', [x.json, y.json]);
    check(loser.setCookies.length === 0, 'losing tab does not clear the new cookies', loser.setCookies);
    check(cookieValue(winner.setCookies, 'adz_rt') !== cookieValue(webCookies.split('; '), 'adz_rt'), 'cookie rotated');
    webCookies = toCookieHeader(winner.setCookies);
    webCsrf = winner.json.data.csrfToken;
    web.accessToken = winner.json.data.accessToken;

    const retry = await call('POST', '/auth/web/refresh', { cookies: webCookies, headers: { origin: TEST_ORIGIN, 'x-csrf-token': webCsrf } });
    check(retry.status === 200, 'losing tab retries with latest cookie', retry.json);
    webCookies = toCookieHeader(retry.setCookies);
    webCsrf = retry.json.data.csrfToken;
    web.accessToken = retry.json.data.accessToken;

    const noCookie = await call('POST', '/auth/web/refresh', { headers: { origin: TEST_ORIGIN, 'x-csrf-token': webCsrf }, cookies: `adz_csrf=${webCsrf}` });
    check(noCookie.status === 401, 'missing refresh cookie');
  });

  it('runs the admin console: limits, policies, blocking and audit', async () => {
    check((await call('POST', '/admin/auth/login', { body: { email: TEST_ADMIN.email, password: 'nope' }, headers: { origin: TEST_ORIGIN } })).status === 401, 'admin wrong password');
    check((await call('GET', '/admin/users', { token: mobile.accessToken })).json.code === 'ACCESS_TOKEN_INVALID', 'user token rejected by admin API');
    const signIn = await call('POST', '/admin/auth/login', { body: { email: TEST_ADMIN.email.toUpperCase(), password: TEST_ADMIN.password }, headers: { origin: TEST_ORIGIN } });
    check(signIn.status === 200, 'admin login', signIn.json);
    admin = signIn.json.data;
    adminCookies = toCookieHeader(signIn.setCookies);
    check((await call('GET', '/users/me', { token: admin.accessToken })).status === 401, 'admin token rejected by user API');
    check((await call('GET', '/admin/auth/me', { token: admin.accessToken })).json.data.admin.isSuperAdmin === true, 'admin me');
    const refreshed = await call('POST', '/admin/auth/refresh', { cookies: adminCookies, headers: { origin: TEST_ORIGIN, 'x-csrf-token': admin.csrfToken } });
    check(refreshed.status === 200, 'admin refresh');
    admin.accessToken = refreshed.json.data.accessToken;
    admin.csrfToken = refreshed.json.data.csrfToken;
    adminCookies = toCookieHeader(refreshed.setCookies);
    const A = { token: admin.accessToken };

    const list = await call('GET', `/admin/users?search=${encodeURIComponent(user.username)}`, A);
    check(list.json.data.pagination.total === 1 && list.json.data.items[0].id === userId, 'search', list.json);
    check((await call('GET', '/admin/users?search=%25', A)).json.data.items.length === 0, 'LIKE wildcard escaped');
    const detail = await call('GET', `/admin/users/${userId}`, A);
    check(detail.json.data.activeRiskProfile.version === 2 && detail.json.data.policyAcceptances.length === 2, 'user detail', detail.json.data);
    check((await call('GET', `/admin/users/${userId}/risk-profiles`, A)).json.data.items.length === 2, 'profile history');
    const stats = await call('GET', '/admin/stats?days=7', A);
    check(stats.json.data.daily.length === 7 && stats.json.data.users.onboarded >= 1, 'stats', stats.json.data);

    const limits = await call('PATCH', `/admin/segments/${segments['EQUITY_DELIVERY']}`, { ...A, body: { minCapital: '250000', maxRiskPercent: '10' } });
    check(limits.status === 422 && limits.json.details.some((d: any) => d.path === 'minCapital'), 'limits only through the band table', limits.json);
    const renamed = await call('PATCH', `/admin/segments/${segments['EQUITY_DELIVERY']}`, { ...A, body: { description: 'Long-term equity holdings.' } });
    check(renamed.status === 200 && renamed.json.data.segment.riskRules.version === 1, 'segment edit keeps bands', renamed.json);
    const below = await call('PUT', '/users/me/risk-profile', { token: mobile.accessToken, body: { marketExperience: 'experienced', allocations: [
      { segmentId: segments['EQUITY_DELIVERY'], capital: '20000', riskPercent: '4' }] } });
    check(below.json.code === 'CAPITAL_BELOW_MINIMUM' && below.json.details[0].minCapital === '25000.00', 'minimum enforced', below.json);
    const created = await call('POST', '/admin/segments', { ...A, body: { code: 'hedging', name: 'Hedging', riskBasis: 'daily_loss', isActive: false } });
    check(created.status === 201 && created.json.data.segment.code === 'HEDGING', 'segment created');
    check((await call('POST', '/admin/segments', { ...A, body: { code: 'HEDGING', name: 'Hedging 2', riskBasis: 'daily_loss' } })).status === 409, 'duplicate code');
    const inactive = await call('PUT', '/users/me/risk-profile', { token: mobile.accessToken, body: { marketExperience: 'experienced', allocations: [
      { segmentId: created.json.data.segment.id, capital: '1000', riskPercent: '1' }] } });
    check(inactive.json.code === 'SEGMENT_NOT_AVAILABLE', 'inactive segment not selectable');

    const draft = await call('POST', '/admin/policies', { ...A, body: { type: 'terms_and_conditions', title: 'Terms v2', content: 'Updated terms.' } });
    check(draft.status === 201 && draft.json.data.policy.version === 2, 'draft v2');
    check((await call('POST', '/admin/policies', { ...A, body: { type: 'terms_and_conditions', title: 'Another draft', content: 'y' } })).status === 409, 'one draft per type');
    check((await call('GET', '/users/me/risk-profile', { token: mobile.accessToken })).status === 200, 'draft does not affect users');
    check((await call('POST', `/admin/policies/${draft.json.data.policy.id}/publish`, A)).json.data.policy.status === 'published', 'published');
    check((await call('PATCH', `/admin/policies/${draft.json.data.policy.id}`, { ...A, body: { title: 'changed' } })).json.code === 'POLICY_NOT_EDITABLE', 'published immutable');
    const gated = await call('GET', '/users/me/risk-profile', { token: mobile.accessToken });
    check(gated.status === 403 && gated.json.code === 'POLICY_ACCEPTANCE_REQUIRED' && gated.json.details[0].version === 2, 're-acceptance required', gated.json);
    check((await login(user.phone, user.password)).json.data.nextAction === 'policy_acceptance', 'login routes to acceptance');
    const v1Terms = detail.json.data.policyAcceptances.find((a: any) => a.policy.type === 'terms_and_conditions').policy.id;
    check((await call('POST', '/users/me/policies/accept', { token: mobile.accessToken, body: { policyDocumentIds: [v1Terms] } })).status === 409, 'old version rejected');
    check((await call('POST', '/users/me/policies/accept', { token: mobile.accessToken, body: { policyDocumentIds: [draft.json.data.policy.id] } })).json.data.acceptanceRequired === false, 'v2 accepted');
    check((await call('GET', '/users/me/risk-profile', { token: mobile.accessToken })).status === 200, 'access restored');

    const blocked = await call('POST', `/admin/users/${userId}/block`, { ...A, body: { reason: 'Suspicious activity' } });
    check(blocked.json.data.user.status === 'blocked', 'blocked');
    check([401, 403].includes((await call('GET', '/users/me', { token: web.accessToken })).status), 'sessions cut');
    check((await login(user.phone, user.password)).json.code === 'ACCOUNT_DISABLED', 'blocked login');
    check((await login(user.phone, 'Wrong!Pass1')).status === 401, 'blocked state hidden on wrong password');
    check((await call('POST', `/admin/users/${userId}/unblock`, A)).json.data.user.status === 'active', 'unblocked');
    mobile = (await login(user.phone, user.password, 'Pixel 9')).json.data;
    check(mobile?.accessToken, 'login after unblock');

    const logs = await call('GET', `/admin/users/${userId}/audit-logs?pageSize=200`, A);
    const actions = new Set(logs.json.data.items.map((x: any) => x.action));
    for (const action of ['auth.user_registered', 'auth.login_succeeded', 'auth.login_failed', 'onboarding.completed', 'risk_profile.updated',
      'policy.accepted', 'admin.user_blocked', 'admin.user_unblocked', 'auth.refresh_token_reuse_detected']) {
      check(actions.has(action), `audit has ${action}`);
    }
    check(logs.json.data.items.every((x: any) => x.requestId && x.ipAddress), 'audit has request id + ip');
    check(!/\$argon2|"otp"\s*:\s*"\d|refreshToken"\s*:\s*"[A-Za-z0-9_-]{20}/.test(JSON.stringify(logs.json.data.items)), 'no secrets in audit');

    check((await call('POST', '/admin/auth/logout', { cookies: adminCookies, headers: { origin: TEST_ORIGIN, 'x-csrf-token': admin.csrfToken } })).status === 200, 'admin logout');
  });

  it('manages profile, devices and password change', async () => {
    const t = mobile.accessToken;
    check((await call('PATCH', '/users/me', { token: t, body: { username: 'admin' } })).status === 422, 'reserved username');
    check((await call('PATCH', '/users/me', { token: t, body: { fullName: "Aarav K. D'Souza-Sharma" } })).json.data.user.fullName === "Aarav K. D'Souza-Sharma", 'name updated');
    const other = await call('POST', '/auth/web/login', { body: { identifier: emailNorm, password: user.password }, headers: { origin: TEST_ORIGIN } });
    const sessions = await call('GET', '/users/me/sessions', { token: t });
    check(sessions.json.data.items.some((s: any) => s.isCurrent && s.deviceName === 'Pixel 9'), 'current device flagged');

    check((await call('POST', '/users/me/password', { token: t, body: { currentPassword: 'Nope!123x', newPassword: 'N3w!Password', confirmPassword: 'N3w!Password' } })).json.code === 'CURRENT_PASSWORD_INCORRECT', 'wrong current');
    check((await call('POST', '/users/me/password', { token: t, body: { currentPassword: user.password, newPassword: user.password, confirmPassword: user.password } })).json.code === 'PASSWORD_REUSE', 'same password');
    const changed = await call('POST', '/users/me/password', { token: t, body: { currentPassword: user.password, newPassword: 'N3w!Password', confirmPassword: 'N3w!Password' } });
    check(changed.status === 200 && changed.json.data.revokedSessions >= 1, 'changed', changed.json);
    check((await call('GET', '/users/me', { token: t })).status === 200, 'current session kept');
    check((await call('GET', '/users/me', { token: other.json.data.accessToken })).json.code === 'SESSION_REVOKED', 'other device signed out');
    check((await login(user.phone, user.password)).status === 401, 'old password dead');
    user.password = 'N3w!Password';

    check((await call('POST', '/auth/mobile/logout', { body: { refreshToken: mobile.refreshToken } })).status === 200, 'logout');
    check((await call('GET', '/users/me', { token: t })).status === 401, 'access dead after logout');
    check((await call('POST', '/auth/mobile/logout', { body: { refreshToken: mobile.refreshToken } })).status === 200, 'logout idempotent');
  });

  it('never reveals whether an email is registered during password reset', async () => {
    const shape = (res: ApiResponse) => `${res.status}|${res.json.message}|${Object.keys(res.json.data).sort().join(',')}`;
    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);

    const real1 = await call('POST', '/auth/password/forgot', { body: { email: emailNorm } });
    const real2 = await call('POST', '/auth/password/forgot', { body: { email: emailNorm } }); // inside cooldown
    const ghost1 = await call('POST', '/auth/password/forgot', { body: { email: `ghost.${unique}@example.com` } });
    const ghost2 = await call('POST', '/auth/password/forgot', { body: { email: `ghost.${unique}@example.com` } });
    check(real1.status === 200, 'real request sent', real1.json);
    check(new Set([real1, real2, ghost1, ghost2].map(shape)).size === 1, 'identical responses incl. throttled real request',
      [real1, real2, ghost1, ghost2].map(shape));

    envHandle.overrideOtpSender('email', { usesStaticCode: true, send: async () => { throw new Error('provider down'); } });
    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);
    const outage = await call('POST', '/auth/password/forgot', { body: { email: emailNorm } });
    envHandle.overrideOtpSender('email', null);
    check(shape(outage) === shape(ghost1), 'provider outage masked as well', outage.json);

    // Verification failures are indistinguishable between real and decoy ids.
    const decoyWrong = await call('POST', '/auth/password/verify-otp', { body: { verificationId: ghost1.json.data.verificationId, otp: '000000' } });
    const failures: ApiResponse[] = [];
    for (let i = 0; i < 6; i += 1) {
      failures.push(await call('POST', '/auth/password/verify-otp', { body: { verificationId: real1.json.data.verificationId, otp: '000000' } }));
    }
    const signature = (res: ApiResponse) => `${res.status}|${res.json.code}|${res.json.message}|${JSON.stringify(res.json.details ?? null)}`;
    check(failures.every((res) => signature(res) === signature(decoyWrong)), 'wrong code, then attempts exhausted: same as decoy',
      [signature(decoyWrong), ...failures.map(signature)]);
    const [audit] = await rows<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'verification.otp_verify_failed' AND metadata->>'reason' = 'OTP_ATTEMPTS_EXCEEDED' AND subject_user_id = :userId`,
      { userId },
    );
    check((audit?.n ?? 0) >= 1, 'real failure reason kept in the audit log');
  });

  it('resets a password with a single-use token and signs out everywhere', async () => {
    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);
    const session = (await login(user.phone, user.password)).json.data;
    const sent = await call('POST', '/auth/password/forgot', { body: { email: emailNorm } });
    const verified = await call('POST', '/auth/password/verify-otp', { body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP } });
    check(verified.status === 200 && verified.json.data.resetToken, 'reset token issued', verified.json);
    const resetToken = verified.json.data.resetToken;

    check((await call('POST', '/auth/password/reset', { body: { resetToken: emailToken, newPassword: 'R3set!Pass', confirmPassword: 'R3set!Pass' } })).json.code === 'RESET_TOKEN_INVALID', 'registration token not usable');
    check((await call('POST', '/auth/password/reset', { body: { resetToken, newPassword: user.password, confirmPassword: user.password } })).json.code === 'PASSWORD_REUSE', 'same password');
    const withIdentity = `${user.username.toUpperCase()}!9a`;
    const identity = await call('POST', '/auth/password/reset', { body: { resetToken, newPassword: withIdentity, confirmPassword: withIdentity } });
    check(identity.status === 422 && identity.json.details?.[0]?.path === 'newPassword', 'reset rejects password containing username', identity.json);
    check((await call('POST', '/auth/password/reset', { body: { resetToken, newPassword: 'R3set!Pass', confirmPassword: 'R3set!Pass' } })).status === 200, 'reset');
    check((await call('POST', '/auth/password/reset', { body: { resetToken, newPassword: 'Other!Pass9', confirmPassword: 'Other!Pass9' } })).status === 400, 'token single use');
    check((await call('GET', '/users/me', { token: session.accessToken })).json.code === 'SESSION_REVOKED', 'all sessions revoked');
    user.password = 'R3set!Pass';
    check((await login(emailNorm, user.password)).status === 200, 'new password works');
  });

  it('purges only ended sessions and finished OTP records', async () => {
    const live = (await login(user.phone, user.password)).json.data;
    const [before] = await rows<{ ended: number; live: number; otp: number }>(
      `SELECT (SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NOT NULL)::int AS ended,
              (SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > NOW())::int AS live,
              (SELECT COUNT(*) FROM verification_requests)::int AS otp`,
    );
    check(before && before.ended > 0 && before.otp > 0, 'there is data to purge', before);

    // Pretend the retention period has passed for everything that already ended.
    const result = await envHandle.purgeExpiredAuthData(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    check(!result.skipped && result.sessionsDeleted === before?.ended && result.verificationRequestsDeleted === before?.otp, 'purged', { result, before });

    const [afterwards] = await rows<{ ended: number; live: number; orphans: number; users: number; audits: number }>(
      `SELECT (SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NOT NULL)::int AS ended,
              (SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > NOW())::int AS live,
              (SELECT COUNT(*) FROM refresh_tokens rt LEFT JOIN auth_sessions s ON s.id = rt.session_id WHERE s.id IS NULL)::int AS orphans,
              (SELECT COUNT(*) FROM users)::int AS users,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'system.expired_auth_data_purged')::int AS audits`,
    );
    check(afterwards?.ended === 0 && afterwards.live === before?.live && afterwards.orphans === 0, 'live sessions untouched, no orphans', afterwards);
    check(afterwards?.users === 1 && afterwards.audits === 1, 'users kept, purge audited', afterwards);
    check((await call('GET', '/users/me', { token: live.accessToken })).status === 200, 'live session still works');

    const again = await envHandle.purgeExpiredAuthData(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    check(again.sessionsDeleted === 0 && again.verificationRequestsDeleted === 0, 'second run is a no-op');
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i += 1) await login(user.phone, 'Wrong!Pass1');
    const locked = await login(user.phone, user.password);
    check(locked.status === 423 && locked.json.code === 'ACCOUNT_LOCKED' && locked.json.details[0].retryAfterSeconds > 0, 'locked', locked.json);
  });

  it('enforces integrity in the database itself', async () => {
    for (const [label, sql] of [
      ['UPDATE', 'UPDATE audit_logs SET action = action WHERE id = (SELECT MIN(id) FROM audit_logs)'],
      ['DELETE', 'DELETE FROM audit_logs WHERE id = (SELECT MIN(id) FROM audit_logs)'],
      ['TRUNCATE', 'TRUNCATE audit_logs'],
    ] as const) {
      await assert.rejects(envHandle.sequelize.query(sql), /append-only/, `audit_logs ${label} blocked`);
    }
    // Sequelize wraps driver errors; the violated constraint is on `parent`.
    const violates = (constraint: string) => (error: any) => error?.parent?.constraint === constraint;
    await assert.rejects(
      envHandle.sequelize.query(`UPDATE users SET phone = '+911234' WHERE id = :userId`, { replacements: { userId } }),
      violates('users_phone_format_check'),
    );
    await assert.rejects(
      envHandle.sequelize.query(`UPDATE risk_profiles SET status = 'active', superseded_at = NULL WHERE status = 'superseded' AND user_id = :userId`, { replacements: { userId } }),
      violates('risk_profiles_one_active_per_user_unique'),
    );
    // Business data is never hard-deleted: links RESTRICT instead of cascading.
    const restrictViolation = (error: any) => error?.parent?.code === '23001';
    await assert.rejects(
      envHandle.sequelize.query(`DELETE FROM users WHERE id = :userId`, { replacements: { userId } }),
      restrictViolation,
      'deleting a user with history is refused',
    );
    await assert.rejects(
      envHandle.sequelize.query(`DELETE FROM risk_profiles WHERE user_id = :userId`, { replacements: { userId } }),
      restrictViolation,
      'deleting a risk profile with segments is refused',
    );
    const cascading = await rows<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype = 'f' AND confdeltype IN ('c', 'n') ORDER BY conname`,
    );
    check(
      cascading.map((row) => row.conname).join(',') === 'refresh_tokens_replaced_by_id_fkey,refresh_tokens_session_id_fkey',
      'only session tokens cascade',
      cascading,
    );
    const [hash] = await rows<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = :userId', { userId });
    check(hash?.password_hash.startsWith('$argon2id$'), 'argon2id');
  });

  it('signs up with one contact, verifies the other during onboarding, and signs in with a phone code', async () => {
    const verifyContact = async (path: string, body: object): Promise<string> => {
      const sent = await call('POST', path, { body });
      check(sent.status === 200 && sent.json.data.verificationId, `${path} sends a code`, sent.json);
      const verified = await call('POST', '/auth/register/verify-otp', {
        body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP },
      });
      check(verified.status === 200, 'code verified', verified.json);
      return verified.json.data.verificationToken;
    };

    // --- Phone signup (web): no password, no email, no username -------------
    const phone = `97${unique}34`;
    const phoneToken2 = await verifyContact('/auth/register/phone/send-otp', { phone });
    const badMethod = await call('POST', '/auth/web/signup', { body: { method: 'carrier-pigeon', fullName: 'Meera Nair' } });
    check(badMethod.status === 422, 'unknown signup method rejected', badMethod.json);

    const signup = await call('POST', '/auth/web/signup', {
      headers: { origin: TEST_ORIGIN },
      body: { method: 'phone', fullName: 'Meera  Nair', phone, verificationToken: phoneToken2 },
    });
    const meera = signup.json.data;
    check(signup.status === 201 && meera.accessToken && meera.csrfToken, 'phone signup signs the user in', signup.json);
    check(cookieValue(signup.setCookies, 'adz_rt'), 'refresh cookie set on signup');
    check(meera.user.fullName === 'Meera Nair' && meera.user.phone === `+91${phone}`, 'name collapsed, phone normalised', meera.user);
    check(meera.user.email === null && meera.user.username === null && meera.user.emailVerifiedAt === null, 'no email or username yet', meera.user);
    check(meera.nextAction === 'onboarding', 'nextAction onboarding');

    const replay = await call('POST', '/auth/web/signup', {
      body: { method: 'phone', fullName: 'Meera Nair', phone, verificationToken: phoneToken2 },
    });
    check(replay.status === 422 && replay.json.code === 'PHONE_NOT_VERIFIED', 'verification token is single-use', replay.json);
    check(
      (await call('POST', '/auth/register/phone/send-otp', { body: { phone } })).json.code === 'PHONE_ALREADY_REGISTERED',
      'number now registered',
    );

    // --- Contact step: add and verify the missing email ----------------------
    const t = meera.accessToken;
    const state = await call('GET', '/onboarding', { token: t });
    check(state.json.data.nextStep === 'contact' && state.json.data.steps.missingContact === 'email', 'onboarding starts at contact', state.json.data);

    const wrongKind = await call('POST', '/onboarding/contact/send-otp', { token: t, body: { phone: `96${unique}34` } });
    check(wrongKind.status === 409, 'cannot add a second phone', wrongKind.json);
    const both = await call('POST', '/onboarding/contact/send-otp', { token: t, body: { email: 'a@example.com', phone } });
    check(both.status === 422, 'exactly one contact required', both.json);
    const taken = await call('POST', '/onboarding/contact/send-otp', { token: t, body: { email: emailNorm } });
    check(taken.status === 409 && taken.json.code === 'EMAIL_ALREADY_REGISTERED', 'email of another account rejected', taken.json);
    check((await call('POST', '/onboarding/contact/send-otp', { body: { email: 'x@example.com' } })).status === 401, 'contact step needs auth');

    const meeraEmail = `meera.${unique}@example.com`;
    const sent = await call('POST', '/onboarding/contact/send-otp', { token: t, body: { email: `Meera.${unique}@Example.com` } });
    check(sent.status === 200 && sent.json.data.channel === 'email', 'code sent to the new email', sent.json);
    const wrong = await call('POST', '/onboarding/contact/verify', { token: t, body: { verificationId: sent.json.data.verificationId, otp: '000000' } });
    check(wrong.status === 400 && wrong.json.code === 'OTP_INVALID', 'wrong code rejected', wrong.json);

    // A code requested by one user cannot be redeemed by another.
    const strangerPhone = `94${unique}34`;
    const stranger = await call('POST', '/auth/mobile/signup', {
      body: { method: 'phone', fullName: 'Stranger Rao', phone: strangerPhone, verificationToken: await verifyContact('/auth/register/phone/send-otp', { phone: strangerPhone }) },
    });
    check(stranger.status === 201 && stranger.json.data.refreshToken, 'second account created on mobile', stranger.json);
    const other = await call('POST', '/onboarding/contact/verify', { token: stranger.json.data.accessToken, body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP } });
    check(other.status === 400 && other.json.code === 'OTP_INVALID', 'another user cannot redeem the code', other.json);
    const [untouched] = await rows<{ attempts: number; verified_at: Date | null }>(
      'SELECT attempts, verified_at FROM verification_requests WHERE id = :id',
      { id: sent.json.data.verificationId },
    );
    check(untouched?.attempts === 1 && untouched.verified_at === null, "and does not spend the owner's attempts", untouched);

    const incomplete = await call('POST', '/onboarding/confirm', { token: t });
    check(
      incomplete.status === 422 && incomplete.json.details.some((d: any) => d.step === 'contact'),
      'cannot confirm without the second contact',
      incomplete.json,
    );
    const [unfinished] = await rows<{ id: string }>('SELECT id FROM users WHERE phone = :phone', { phone: `+91${phone}` });
    await assert.rejects(
      envHandle.sequelize.query(`UPDATE users SET onboarding_status = 'completed', onboarding_completed_at = NOW() WHERE id = :id`, { replacements: { id: unfinished?.id } }),
      (error: any) => error?.parent?.constraint === 'users_onboarded_contacts_check',
    );
    await assert.rejects(
      envHandle.sequelize.query(`UPDATE users SET phone = NULL, phone_verified_at = NULL WHERE id = :id`, { replacements: { id: unfinished?.id } }),
      (error: any) => error?.parent?.constraint === 'users_contact_present_check',
    );

    // The owner's code is still good after the wrong attempt and the stranger's try.
    const done = await call('POST', '/onboarding/contact/verify', { token: t, body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP } });
    check(done.status === 200 && done.json.data.nextStep === 'segments' && done.json.data.steps.missingContact === null, 'contact step complete', done.json);
    const me = await call('GET', '/users/me', { token: t });
    check(me.json.data.user.email === meeraEmail && me.json.data.user.emailVerifiedAt, 'email stored lower-cased and verified', me.json);
    check((await call('POST', '/onboarding/contact/send-otp', { token: t, body: { email: 'second@example.com' } })).status === 409, 'contact cannot be replaced here');
    check((await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'new' } })).status === 200, "'new' experience accepted");

    // --- Signing in: no password for a phone account, code instead -----------
    const noPassword = await login(phone, 'Whatever@123');
    check(noPassword.status === 401 && noPassword.json.code === 'INVALID_CREDENTIALS', 'password login refused identically', noPassword.json);

    const codeFor = await call('POST', '/auth/login/otp/send', { body: { phone } });
    check(codeFor.status === 200 && codeFor.json.data.channel === 'sms', 'sign-in code sent', codeFor.json);
    const decoy = await call('POST', '/auth/login/otp/send', { body: { phone: '9000000009' } });
    check(decoy.status === 200 && Object.keys(decoy.json.data).sort().join() === Object.keys(codeFor.json.data).sort().join(), 'unknown number gets an identical-looking reply', decoy.json);
    const decoyVerify = await call('POST', '/auth/mobile/login/otp', { body: { verificationId: decoy.json.data.verificationId, otp: TEST_OTP } });
    check(decoyVerify.status === 400 && decoyVerify.json.message === 'The code is invalid or has expired', 'decoy cannot sign in', decoyVerify.json);

    const badCode = await call('POST', '/auth/mobile/login/otp', { body: { verificationId: codeFor.json.data.verificationId, otp: '111111' } });
    check(badCode.status === 400 && badCode.json.message === decoyVerify.json.message, 'wrong code looks the same as a decoy', badCode.json);
    const otpLogin = await call('POST', '/auth/mobile/login/otp', { body: { verificationId: codeFor.json.data.verificationId, otp: TEST_OTP, deviceName: 'Pixel 9' } });
    check(otpLogin.status === 200 && otpLogin.json.data.refreshToken && otpLogin.json.data.user.phone === `+91${phone}`, 'signed in with the code', otpLogin.json);
    check(otpLogin.json.data.nextAction === 'onboarding', 'nextAction still onboarding');
    const reused = await call('POST', '/auth/mobile/login/otp', { body: { verificationId: codeFor.json.data.verificationId, otp: TEST_OTP } });
    check(reused.status === 400, 'a sign-in code works once', reused.json);

    await sleep(TEST_OTP_COOLDOWN_SECONDS * 1000 + 200);
    const webCode = await call('POST', '/auth/login/otp/send', { body: { phone } });
    const evil = await call('POST', '/auth/web/login/otp', { headers: { origin: 'https://evil.example' }, body: { verificationId: webCode.json.data.verificationId, otp: TEST_OTP } });
    check(evil.status === 403, 'web code login checks the origin', evil.json);
    const webOtp = await call('POST', '/auth/web/login/otp', { headers: { origin: TEST_ORIGIN }, body: { verificationId: webCode.json.data.verificationId, otp: TEST_OTP } });
    check(webOtp.status === 200 && webOtp.json.data.csrfToken && !webOtp.json.data.refreshToken && cookieValue(webOtp.setCookies, 'adz_rt'), 'web code login uses cookies', webOtp.json);

    const [audit] = await rows<{ metadata: any }>(
      `SELECT metadata FROM audit_logs WHERE action = 'auth.login_succeeded' AND subject_user_id = :id ORDER BY id DESC LIMIT 1`,
      { id: unfinished?.id },
    );
    check(audit?.metadata.method === 'otp', 'sign-in method audited', audit);

    // --- A phone account sets its first password through password reset -----
    const forgot = await call('POST', '/auth/password/forgot', { body: { email: meeraEmail } });
    const resetCode = await call('POST', '/auth/password/verify-otp', { body: { verificationId: forgot.json.data.verificationId, otp: TEST_OTP } });
    check(resetCode.status === 200 && resetCode.json.data.resetToken, 'reset code verified for an account without a password', resetCode.json);
    const firstPassword = 'Fr3sh!Passw0rd';
    const setPassword = await call('POST', '/auth/password/reset', { body: { resetToken: resetCode.json.data.resetToken, newPassword: firstPassword, confirmPassword: firstPassword } });
    check(setPassword.status === 200, 'first password set', setPassword.json);
    check((await login(meeraEmail, firstPassword)).status === 200 && (await login(phone, firstPassword)).status === 200, 'password login now works by email and by phone');

    // --- The admin console handles accounts with missing fields --------------
    const adminSignIn = await call('POST', '/admin/auth/login', { headers: { origin: TEST_ORIGIN }, body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password } });
    check(adminSignIn.status === 200, 'admin signs in', adminSignIn.json);
    const asAdmin = { token: adminSignIn.json.data.accessToken };
    const found = await call('GET', `/admin/users?search=${strangerPhone}`, asAdmin);
    check(found.status === 200 && found.json.data.items.length === 1, 'admin search finds a phone-only account', found.json);
    check(found.json.data.items[0].username === null && found.json.data.items[0].email === null, 'missing fields are returned as null', found.json.data.items[0]);
    check((await call('GET', '/admin/users?search=stranger', asAdmin)).json.data.items.length === 1, 'admin search by name still works');
    check((await call('GET', `/admin/users/${found.json.data.items[0].id}`, asAdmin)).status === 200, 'admin can open a phone-only account');
    check((await call('GET', '/admin/users', asAdmin)).status === 200, 'admin list loads with mixed accounts');

    // --- Email signup (mobile): password required, phone added later ---------
    const kabirEmail = `kabir.${unique}@example.com`;
    const emailToken2 = await verifyContact('/auth/register/email/send-otp', { email: kabirEmail });
    const leaky = await call('POST', '/auth/mobile/signup', {
      body: { method: 'email', fullName: 'Kabir Rao', email: kabirEmail, password: `Kabir.${unique}A1!`, verificationToken: emailToken2 },
    });
    check(leaky.status === 422 && leaky.json.details.some((d: any) => d.path === 'password'), 'password containing the email rejected', leaky.json);
    const crossed = await call('POST', '/auth/mobile/signup', {
      body: { method: 'email', fullName: 'Kabir Rao', email: `other.${unique}@example.com`, password: user.password, verificationToken: emailToken2 },
    });
    check(crossed.status === 422 && crossed.json.code === 'EMAIL_NOT_VERIFIED', 'token is bound to the verified email', crossed.json);

    const kabir = await call('POST', '/auth/mobile/signup', {
      body: { method: 'email', fullName: 'Kabir Rao', email: kabirEmail, password: user.password, verificationToken: emailToken2 },
    });
    check(kabir.status === 201 && kabir.json.data.refreshToken && kabir.json.data.user.phone === null, 'email signup signs the user in', kabir.json);
    check((await login(kabirEmail, user.password)).status === 200, 'email account signs in with its password');
    const kabirState = await call('GET', '/onboarding', { token: kabir.json.data.accessToken });
    check(kabirState.json.data.steps.missingContact === 'phone', 'email account must add a phone', kabirState.json.data);
    const kabirPhone = await call('POST', '/onboarding/contact/send-otp', { token: kabir.json.data.accessToken, body: { phone: `95${unique}34` } });
    const kabirDone = await call('POST', '/onboarding/contact/verify', { token: kabir.json.data.accessToken, body: { verificationId: kabirPhone.json.data.verificationId, otp: TEST_OTP } });
    check(kabirDone.status === 200 && kabirDone.json.data.steps.contact === true, 'phone verified for the email account', kabirDone.json);
  });
});
