/**
 * Capital-band risk limits — end-to-end suite.
 *
 * Covers: the default bands, band edges and risk levels, disclaimers and the
 * acknowledgements stored for them (onboarding and profile edits), the admin
 * band table (validation, preview, versions), risk-limit change notices
 * (combined, blocking, must-change, silent versions, acceptance report) and
 * the append-only records.
 *
 *   npm run test:e2e
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { QueryTypes } from 'sequelize';
import { createClient, type ApiResponse } from './client.js';
import { startTestEnvironment, TEST_ADMIN, TEST_ORIGIN, TEST_OTP, type TestEnvironment } from './harness.js';

function check(condition: unknown, label: string, detail?: unknown): void {
  assert.ok(condition, detail === undefined ? label : `${label}\n  -> ${JSON.stringify(detail).slice(0, 1500)}`);
}

let envHandle: TestEnvironment;
let call: ReturnType<typeof createClient>;

async function rows<T extends object>(sql: string, replacements: Record<string, unknown> = {}): Promise<T[]> {
  return envHandle.sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

const unique = Date.now().toString().slice(-6);
let sequence = 0;
const nextPhone = (): string => `9${String(++sequence).padStart(3, '0')}${unique}`;

let seg: Record<string, string> = {};
let adminToken = '';
const A = () => ({ token: adminToken });

interface TestUser {
  token: string;
  phone: string;
  id: string;
}

async function verifyCode(path: string, body: object): Promise<string> {
  const sent = await call('POST', path, { body });
  check(sent.status === 200, `${path} sent`, sent.json);
  const verified = await call('POST', '/auth/register/verify-otp', {
    body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP },
  });
  check(verified.status === 200, 'code verified', verified.json);
  return verified.json.data.verificationToken;
}

/** A phone signup with the email verified: onboarding then starts at segments. */
async function newUser(fullName: string): Promise<TestUser> {
  const phone = nextPhone();
  const verificationToken = await verifyCode('/auth/register/phone/send-otp', { phone });
  const signup = await call('POST', '/auth/mobile/signup', { body: { method: 'phone', fullName, phone, verificationToken } });
  check(signup.status === 201, 'signup', signup.json);
  const token = signup.json.data.accessToken;
  const sent = await call('POST', '/onboarding/contact/send-otp', { token, body: { email: `risk.${sequence}.${unique}@example.com` } });
  const verified = await call('POST', '/onboarding/contact/verify', {
    token,
    body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP },
  });
  check(verified.json.data.nextStep === 'segments', 'contact verified', verified.json);
  return { token, phone, id: signup.json.data.user.id };
}

/** The acknowledgement to send back for a disclaimer the API returned. */
function ackFor(disclaimer: any, typed = 'I ACCEPT THE RISK') {
  return {
    level: disclaimer.level,
    ruleSetId: disclaimer.ruleSetId,
    policyDocumentId: disclaimer.policyDocumentId,
    statementSha256: disclaimer.statementSha256,
    ...(disclaimer.level === 'above_maximum' ? { typedConfirmation: typed } : {}),
  };
}

/** Send risk values; if disclaimers are needed, accept them (as the app would) and send again. */
async function saveRiskAccepting(token: string, allocations: { segmentId: string; riskPercent: string }[]): Promise<ApiResponse> {
  const first = await call('PUT', '/onboarding/risk', { token, body: { allocations } });
  if (first.json.code !== 'RISK_ACKNOWLEDGEMENT_REQUIRED') return first;
  const bySegment = new Map(first.json.details.map((d: any) => [d.segmentId, d.disclaimer]));
  return call('PUT', '/onboarding/risk', {
    token,
    body: {
      allocations: allocations.map((item) =>
        bySegment.has(item.segmentId) ? { ...item, acknowledgement: ackFor(bySegment.get(item.segmentId)) } : item,
      ),
    },
  });
}

async function onboard(user: TestUser, values: { code: string; capital: string; riskPercent: string }[]): Promise<void> {
  const t = user.token;
  const ids = values.map((value) => seg[value.code] as string);
  check((await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: ids } })).status === 200, 'segments');
  check((await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'intermediate' } })).status === 200, 'experience');
  const capital = await call('PUT', '/onboarding/capital', {
    token: t,
    body: { allocations: values.map((value) => ({ segmentId: seg[value.code], capital: value.capital })) },
  });
  check(capital.json.data?.nextStep === 'risk', 'capital', capital.json);
  const risk = await saveRiskAccepting(
    t,
    values.map((value) => ({ segmentId: seg[value.code] as string, riskPercent: value.riskPercent })),
  );
  check(risk.json.data?.nextStep === 'broker', 'risk', risk.json);
  const broker = await call('POST', '/onboarding/broker/skip', { token: t });
  const accepted = await call('POST', '/onboarding/policies/accept', {
    token: t,
    body: { policyDocumentIds: broker.json.data.policies.map((p: any) => p.id) },
  });
  check(accepted.json.data.nextStep === 'confirm', 'policies', accepted.json);
  const confirm = await call('POST', '/onboarding/confirm', { token: t });
  check(confirm.status === 200, 'confirmed', confirm.json);
}

/** The current band table of a segment in the shape PUT risk-rules takes. */
async function currentTable(code: string): Promise<any[]> {
  const res = await call('GET', `/admin/segments/${seg[code]}/risk-rules`, A());
  check(res.status === 200, 'rules loaded', res.json);
  const manual = res.json.data.current.suggestedMode === 'manual';
  return res.json.data.current.bands.map((band: any) => ({
    capitalFrom: band.capitalFrom,
    minRiskPercent: band.minRiskPercent,
    maxRiskPercent: band.maxRiskPercent,
    ...(manual ? { suggestedRiskPercent: band.suggestedRiskPercent } : {}),
  }));
}

async function putRules(code: string, bands: any[], query = ''): Promise<ApiResponse> {
  return call('PUT', `/admin/segments/${seg[code]}/risk-rules${query}`, { ...A(), body: { bands } });
}

const assessOne = (token: string, code: string, capital: string, riskPercent: string) =>
  call('POST', '/users/me/risk-assessment', { token, body: { allocations: [{ segmentId: seg[code], capital, riskPercent }] } });

let userA: TestUser;
let userB: TestUser;
let userC: TestUser;
let userD: TestUser;

describe('Capital-band risk limits (end-to-end)', { concurrency: false }, () => {
  before(async () => {
    envHandle = await startTestEnvironment();
    call = createClient(envHandle.apiUrl);
    const signIn = await call('POST', '/admin/auth/login', {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
      headers: { origin: TEST_ORIGIN },
    });
    adminToken = signIn.json.data.accessToken;
  });

  after(async () => {
    await envHandle?.close();
  });

  it('seeds the default bands for each segment', async () => {
    const res = await call('GET', '/segments');
    const items = res.json.data.items;
    seg = Object.fromEntries(items.map((s: any) => [s.code, s.id]));
    const byCode = (code: string) => items.find((s: any) => s.code === code);

    const intraday = byCode('EQUITY_INTRADAY');
    check(intraday.minCapital === '10000.00' && intraday.suggestedMode === 'midpoint', 'intraday minimum 10,000, midpoint', intraday);
    check(intraday.riskRules.bands.length === 12 && intraday.riskRules.ceilingPercent === '100.0000', 'intraday 12 bands');
    const first = intraday.riskRules.bands[0];
    check(
      first.capitalFrom === '10000.00' && first.capitalTo === '19999.99' && first.minRiskPercent === '5.0000' &&
        first.suggestedRiskPercent === '6.2500' && first.maxRiskPercent === '7.5000',
      'first intraday band 5 / 6.25 / 7.5 (typo fixed) up to 19,999.99',
      first,
    );
    const fiftyLakh = intraday.riskRules.bands.find((b: any) => b.capitalFrom === '5000000.00');
    check(fiftyLakh.suggestedRiskPercent === '0.6950', 'midpoint keeps 4 decimals', fiftyLakh);
    check(intraday.riskRules.bands[11].capitalTo === null, 'last band has no upper end');

    const delivery = byCode('EQUITY_DELIVERY');
    check(delivery.minCapital === '25000.00' && delivery.suggestedMode === 'manual', 'delivery minimum 25,000', delivery);
    check(delivery.riskRules.bands.every((b: any) => b.maxRiskPercent === '50.0000'), 'delivery maximum 50% everywhere');
    check(
      delivery.riskRules.bands.map((b: any) => b.suggestedRiskPercent).join(',') ===
        ['32.8', '30.4', '27.7', '25', '21', '18', '15', '13', '11.5', '10', '10'].map((v) => Number(v).toFixed(4)).join(','),
      'delivery suggested values',
      delivery.riskRules.bands,
    );

    for (const code of ['FNO_STOCK', 'FNO_INDEX']) {
      const fno = byCode(code);
      check(fno.riskRules.bands.length === 1 && fno.riskRules.bands[0].suggestedRiskPercent === '100.0000', `${code} placeholder band`, fno);
    }
    check((await call('GET', '/policies/current')).json.data.items.length === 2, 'disclaimers are not consent policies');
  });

  it('finds the band and the risk level, and returns the filled-in disclaimer', async () => {
    userA = await newUser('Kabir Anand');
    const t = userA.token;
    const band = async (capital: string) => (await assessOne(t, 'EQUITY_INTRADAY', capital, '6')).json.data.items[0];
    check((await band('19999.99')).assessment.band.capitalFrom === '10000.00', '19,999.99 is in the 10k band');
    check((await band('20000')).assessment.band.capitalFrom === '20000.00', '20,000 starts the next band');
    const tooLow = await band('9999.99');
    check(!tooLow.allowed && tooLow.violation.path === 'capital' && tooLow.violation.minCapital === '10000.00', 'below the first band', tooLow);

    const level = async (riskPercent: string) => (await assessOne(t, 'EQUITY_INTRADAY', '15000', riskPercent)).json.data.items[0];
    const atSuggested = await level('6.25');
    check(atSuggested.allowed && atSuggested.assessment.level === 'within' && atSuggested.disclaimer === null, 'exactly suggested: no disclaimer', atSuggested);
    check(atSuggested.assessment.riskAmount === '937.50', 'amount at risk', atSuggested.assessment);
    check((await level('6.2501')).assessment.level === 'above_suggested', 'just above suggested');
    const atMax = await level('7.5');
    check(atMax.assessment.level === 'above_suggested' && atMax.disclaimer.level === 'above_suggested', 'exactly maximum: caution only', atMax);
    const aboveMax = await level('7.5001');
    check(aboveMax.disclaimer.level === 'above_maximum' && aboveMax.disclaimer.confirmationPhrase === 'I ACCEPT THE RISK', 'above maximum: strict', aboveMax);
    check((await level('100')).allowed === true, '100% allowed with the strict disclaimer');
    const ceiling = await level('100.0001');
    check(!ceiling.allowed && ceiling.violation.reason === 'above_ceiling', 'above 100% blocked', ceiling);
    const belowMin = await level('4.9999');
    check(!belowMin.allowed && belowMin.violation.reason === 'below_minimum' && belowMin.disclaimer === null, 'below minimum blocked', belowMin);

    const seven = (await level('7')).disclaimer;
    check(
      seven.statement.includes('7% (₹1,050 per day) for Equity Intraday on a capital of ₹15,000') &&
        seven.statement.includes('suggested level of 6.25%') &&
        seven.statement.includes('Declaration: I have read and understood this disclaimer') &&
        seven.title === 'Risk Acknowledgement: Above Suggested Level' &&
        seven.policyVersion === 1,
      'caution text filled in with the user numbers',
      seven,
    );
    const delivery = (await assessOne(t, 'EQUITY_DELIVERY', '25000', '50')).json.data.items[0];
    check(delivery.assessment.level === 'above_suggested', 'delivery 50% is above suggested 32.8%', delivery);
    const deliveryMax = (await assessOne(t, 'EQUITY_DELIVERY', '25000', '50.0001')).json.data.items[0];
    check(
      deliveryMax.disclaimer.level === 'above_maximum' && deliveryMax.disclaimer.statement.includes('(₹12,500.03 of capital)'),
      'delivery above 50% needs the strict disclaimer; amount is of capital',
      deliveryMax.disclaimer,
    );
  });

  it('requires and stores acknowledgements during onboarding', async () => {
    const t = userA.token;
    const INTRA = seg['EQUITY_INTRADAY'] as string;
    const DEL = seg['EQUITY_DELIVERY'] as string;
    await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [INTRA, DEL] } });
    await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'intermediate' } });
    const early = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [{ segmentId: INTRA, riskPercent: '6' }, { segmentId: DEL, riskPercent: '20' }] } });
    check(early.status === 422 && early.json.code === 'ONBOARDING_STEP_PREREQUISITE', 'risk needs capital first', early.json);
    await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [{ segmentId: INTRA, capital: '15000' }, { segmentId: DEL, capital: '100000' }] } });

    const deliveryAtSuggested = { segmentId: DEL, riskPercent: '27.7' };
    const allocations = [{ segmentId: INTRA, riskPercent: '7' }, deliveryAtSuggested];
    const missing = await call('PUT', '/onboarding/risk', { token: t, body: { allocations } });
    check(missing.status === 422 && missing.json.code === 'RISK_ACKNOWLEDGEMENT_REQUIRED', 'disclaimer required', missing.json);
    check(missing.json.details.length === 1 && missing.json.details[0].segmentId === INTRA, 'only the segment above suggested (27.7 = suggested is fine)', missing.json.details);
    const disclaimer = missing.json.details[0].disclaimer;
    check(missing.json.details[0].reason === 'missing' && disclaimer.level === 'above_suggested', 'detail carries the disclaimer', missing.json.details[0]);

    const withAck = (ack: object) => [{ segmentId: INTRA, riskPercent: '7', acknowledgement: ack }, deliveryAtSuggested];
    const wrongLevel = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: withAck({ ...ackFor(disclaimer), level: 'above_maximum', typedConfirmation: 'I ACCEPT THE RISK' }) } });
    check(wrongLevel.json.details?.[0]?.reason === 'level_mismatch', 'level must match', wrongLevel.json);
    const tampered = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: withAck({ ...ackFor(disclaimer), statementSha256: '0'.repeat(64) }) } });
    check(tampered.json.details?.[0]?.reason === 'outdated', 'fingerprint must match the text shown', tampered.json);

    const saved = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: withAck(ackFor(disclaimer)) } });
    check(saved.status === 200 && saved.json.data.nextStep === 'broker', 'saved with the acknowledgement', saved.json);
    const check1 = saved.json.data.segmentChecks.find((c: any) => c.segmentId === INTRA);
    check(check1.acknowledged && check1.level === 'above_suggested' && check1.riskAmount === '1050.00', 'segment check', check1);

    const [ack] = await rows<any>(`SELECT * FROM risk_acknowledgements WHERE user_id = :id ORDER BY created_at DESC LIMIT 1`, { id: userA.id });
    check(
      ack.level === 'above_suggested' && ack.source === 'onboarding' && ack.capital === '15000.00' && ack.risk_percent === '7.0000' &&
        ack.risk_amount === '1050.00' && ack.band_capital_from === '10000.00' && ack.band_min_percent === '5.0000' &&
        ack.band_suggested_percent === '6.2500' && ack.band_max_percent === '7.5000' && ack.typed_confirmation === null &&
        ack.statement === disclaimer.statement && ack.statement_sha256 === disclaimer.statementSha256 &&
        ack.ip_address && ack.request_id && ack.policy_content_sha256.length === 64,
      'acknowledgement stored with values, band, exact text and request details',
      ack,
    );

    // Strict disclaimer: the typed phrase is required; case and spacing do not matter.
    const nine = [{ segmentId: INTRA, riskPercent: '9' }, deliveryAtSuggested];
    const strictNeeded = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: nine } });
    const strict = strictNeeded.json.details[0].disclaimer;
    check(strict.level === 'above_maximum' && strict.title === 'Important Risk Warning: Above Maximum Limit', 'strict disclaimer', strict);
    const noPhrase = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [{ ...nine[0], acknowledgement: { ...ackFor(strict), typedConfirmation: 'I accept' } }, nine[1]] } });
    check(noPhrase.json.details?.[0]?.reason === 'confirmation_phrase', 'phrase checked', noPhrase.json);
    const typed = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [{ ...nine[0], acknowledgement: ackFor(strict, '  i accept   the risk ') }, nine[1]] } });
    check(typed.status === 200, 'phrase accepted regardless of case and spacing', typed.json);
    const [strictAck] = await rows<any>(`SELECT * FROM risk_acknowledgements WHERE user_id = :id ORDER BY created_at DESC LIMIT 1`, { id: userA.id });
    check(strictAck.typed_confirmation === 'I ACCEPT THE RISK' && strictAck.previous_risk_percent === '7.0000' && strictAck.level === 'above_maximum', 'strict acknowledgement stored with the change', strictAck);

    const again = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: nine } });
    check(again.status === 200, 'same values again: the stored acknowledgement still covers them', again.json);

    // A new capital invalidates the acknowledgement.
    const capital = await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [{ segmentId: INTRA, capital: '16000' }, { segmentId: DEL, capital: '100000' }] } });
    check(capital.json.data.nextStep === 'risk', 'back to the risk step after a capital change', capital.json.data);
    check(capital.json.data.segmentChecks.find((c: any) => c.segmentId === INTRA).acknowledged === false, 'not acknowledged for the new capital');
    const broker = await call('POST', '/onboarding/broker/skip', { token: t });
    await call('POST', '/onboarding/policies/accept', { token: t, body: { policyDocumentIds: broker.json.data.policies.map((p: any) => p.id) } });
    const confirmEarly = await call('POST', '/onboarding/confirm', { token: t });
    check(confirmEarly.status === 422 && confirmEarly.json.code === 'RISK_ACKNOWLEDGEMENT_REQUIRED', 'confirm re-checks acknowledgements', confirmEarly.json);

    const resaved = await saveRiskAccepting(t, nine);
    check(resaved.json.data.nextStep === 'confirm', 'acknowledged for the new capital', resaved.json);
    const confirm = await call('POST', '/onboarding/confirm', { token: t });
    check(confirm.status === 200, 'onboarding confirmed', confirm.json);
    const linked = await rows<any>(
      `SELECT rps.rule_set_id, rps.risk_acknowledgement_id, s.code FROM risk_profile_segments rps
         JOIN risk_profiles rp ON rp.id = rps.risk_profile_id JOIN segments s ON s.id = rps.segment_id
        WHERE rp.user_id = :id AND rp.status = 'active' AND rps.is_deleted = FALSE`,
      { id: userA.id },
    );
    check(linked.every((row) => row.rule_set_id) && linked.find((row) => row.code === 'EQUITY_INTRADAY').risk_acknowledgement_id, 'profile linked to bands and acknowledgement', linked);
  });

  it('lists segments in a fixed order and logs what each acknowledgement changed', async () => {
    const user = await newUser('Order And History');
    const t = user.token;
    const intraday = seg.EQUITY_INTRADAY as string;
    const delivery = seg.EQUITY_DELIVERY as string;
    // Chosen Intraday first; listed in the segment list's order (Delivery first) on every read.
    await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [intraday, delivery] } });
    await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'intermediate' } });
    const listed = (response: ApiResponse) => response.json.data.draft.segments.map((s: any) => s.code).join(',');
    const capital = { token: t, body: { allocations: [{ segmentId: intraday, capital: '15000' }, { segmentId: delivery, capital: '100000' }] } };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const saved = await call('PUT', '/onboarding/capital', capital);
      check(listed(saved) === 'EQUITY_DELIVERY,EQUITY_INTRADAY', 'segments in list order', listed(saved));
    }

    // First acknowledgements: nothing saved before Intraday; Delivery had 20% on 1,00,000.
    check((await saveRiskAccepting(t, [{ segmentId: intraday, riskPercent: '6' }, { segmentId: delivery, riskPercent: '20' }])).status === 200, 'within');
    check((await saveRiskAccepting(t, [{ segmentId: intraday, riskPercent: '7' }, { segmentId: delivery, riskPercent: '30' }])).status === 200, 'acknowledged');
    // The capital change unlinks Intraday's acknowledgement; the next one still records what changed.
    await call('PUT', '/onboarding/capital', {
      token: t,
      body: { allocations: [{ segmentId: intraday, capital: '16000' }, { segmentId: delivery, capital: '100000' }] },
    });
    check((await saveRiskAccepting(t, [{ segmentId: intraday, riskPercent: '9' }, { segmentId: delivery, riskPercent: '30' }])).status === 200, 'strict');

    const log = await rows<{ code: string; capital: string; risk_percent: string; previous_capital: string | null; previous_risk_percent: string | null }>(
      `SELECT s.code, ra.capital, ra.risk_percent, ra.previous_capital, ra.previous_risk_percent
         FROM risk_acknowledgements ra JOIN segments s ON s.id = ra.segment_id
        WHERE ra.user_id = :userId ORDER BY s.code, ra.created_at`,
      { userId: user.id },
    );
    const line = (r: (typeof log)[number]) => `${r.code} ${r.previous_capital}@${r.previous_risk_percent} -> ${r.capital}@${r.risk_percent}`;
    check(
      JSON.stringify(log.map(line)) ===
        JSON.stringify([
          'EQUITY_DELIVERY 100000.00@20.0000 -> 100000.00@30.0000',
          'EQUITY_INTRADAY 15000.00@6.0000 -> 15000.00@7.0000',
          'EQUITY_INTRADAY 15000.00@7.0000 -> 16000.00@9.0000',
        ]),
      'each acknowledgement records the values before it',
      log.map(line),
    );
  });

  it('applies the same rules to profile edits', async () => {
    const t = userA.token;
    const INTRA = seg['EQUITY_INTRADAY'];
    const DEL = seg['EQUITY_DELIVERY'];
    const experienceOnly = await call('PUT', '/users/me/risk-profile', { token: t, body: { marketExperience: 'experienced', allocations: [
      { segmentId: INTRA, capital: '16000', riskPercent: '9' }, { segmentId: DEL, capital: '100000', riskPercent: '27.7' }] } });
    check(experienceOnly.status === 200 && experienceOnly.json.data.version === 2, 'only experience changed: no new acknowledgement needed', experienceOnly.json);

    const body = { marketExperience: 'experienced', allocations: [{ segmentId: INTRA, capital: '16000', riskPercent: '8' }, { segmentId: DEL, capital: '100000', riskPercent: '27.7' }] };
    const needed = await call('PUT', '/users/me/risk-profile', { token: t, body });
    check(needed.json.code === 'RISK_ACKNOWLEDGEMENT_REQUIRED' && needed.json.details[0].level === 'above_maximum', 'strict disclaimer for 8% (max 7.5%)', needed.json);
    const disclaimer = needed.json.details[0].disclaimer;
    const updated = await call('PUT', '/users/me/risk-profile', { token: t, body: { ...body, allocations: [{ ...body.allocations[0], acknowledgement: ackFor(disclaimer) }, body.allocations[1]] } });
    check(updated.status === 200 && updated.json.data.version === 3, 'edit saved', updated.json);
    const [ack] = await rows<any>(`SELECT * FROM risk_acknowledgements WHERE user_id = :id ORDER BY created_at DESC LIMIT 1`, { id: userA.id });
    check(ack.source === 'profile_update' && ack.previous_risk_percent === '9.0000' && ack.previous_capital === '16000.00', 'stored with the previous values', ack);
    const audit = await rows<any>(`SELECT action FROM audit_logs WHERE subject_user_id = :id AND action = 'risk.acknowledged'`, { id: userA.id });
    check(audit.length === 4, 'every acknowledgement audited (3 in onboarding, 1 here)', audit.length);
  });

  it('validates and previews the admin band table', async () => {
    userB = await newUser('Ira Sethi');
    await onboard(userB, [
      { code: 'EQUITY_INTRADAY', capital: '50000', riskPercent: '2' },
      { code: 'FNO_STOCK', capital: '10000', riskPercent: '1' },
    ]);
    userC = await newUser('Dev Kohli');
    await onboard(userC, [{ code: 'EQUITY_DELIVERY', capital: '100000', riskPercent: '20' }]);
    userD = await newUser('Nisha Rao');
    {
      const t = userD.token;
      await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [seg['EQUITY_INTRADAY']] } });
      await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'new' } });
      await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [{ segmentId: seg['EQUITY_INTRADAY'], capital: '12000' }] } });
      await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [{ segmentId: seg['EQUITY_INTRADAY'], riskPercent: '6' }] } });
      const broker = await call('POST', '/onboarding/broker/skip', { token: t });
      const ready = await call('POST', '/onboarding/policies/accept', { token: t, body: { policyDocumentIds: broker.json.data.policies.map((p: any) => p.id) } });
      check(ready.json.data.nextStep === 'confirm', 'user D waits at confirm', ready.json.data);
    }

    const info = await call('GET', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules`, A());
    check(info.json.data.current.version === 1 && info.json.data.versions[0].source === 'seed' && info.json.data.versions[0].notifyUsers === false, 'seeded version 1, silent', info.json.data.versions);

    const table = await currentTable('EQUITY_INTRADAY');
    const swapped = [table[1], table[0], ...table.slice(2)];
    const order = await putRules('EQUITY_INTRADAY', swapped);
    check(order.status === 422 && order.json.details.some((d: any) => d.path === 'bands.1.capitalFrom'), 'capitals must go up', order.json);
    const midpointGiven = await putRules('EQUITY_INTRADAY', [{ ...table[0], suggestedRiskPercent: '6' }, ...table.slice(1)]);
    check(midpointGiven.json.details?.some((d: any) => d.path === 'bands.0.suggestedRiskPercent'), 'midpoint segments take no suggested value', midpointGiven.json);
    const inverted = await putRules('EQUITY_INTRADAY', [{ ...table[0], minRiskPercent: '9' }, ...table.slice(1)]);
    check(inverted.json.details?.some((d: any) => d.path === 'bands.0.minRiskPercent'), 'min above max rejected', inverted.json);
    const overCeiling = await putRules('EQUITY_INTRADAY', [{ ...table[0], maxRiskPercent: '101' }, ...table.slice(1)]);
    check(overCeiling.json.details?.some((d: any) => d.path === 'bands.0.maxRiskPercent'), 'max above 100 rejected', overCeiling.json);
    const unchanged = await putRules('EQUITY_INTRADAY', table);
    check(unchanged.status === 422 && unchanged.json.code === 'NO_CHANGES', 'identical table rejected', unchanged.json);
    const deliveryTable = await currentTable('EQUITY_DELIVERY');
    const noSuggested = await putRules('EQUITY_DELIVERY', deliveryTable.map(({ suggestedRiskPercent: _s, ...band }: any) => band));
    check(noSuggested.json.details?.some((d: any) => d.message === 'Suggested risk is required'), 'manual segments need suggested', noSuggested.json);

    // Version 2: the 10k band becomes 5 – 10% (suggested 7.5%).
    const v2 = [{ ...table[0], maxRiskPercent: '10' }, ...table.slice(1)];
    const preview = await putRules('EQUITY_INTRADAY', v2, '?preview=true');
    check(preview.status === 200 && preview.json.data.preview === true && preview.json.data.ruleSet.version === 2, 'preview', preview.json);
    check(preview.json.data.ruleSet.bands[0].suggestedRiskPercent === '7.5000', 'midpoint recalculated', preview.json.data.ruleSet.bands[0]);
    const impact = preview.json.data.impact;
    check(impact.customers === 2 && impact.needsCautionAck === 1 && impact.ok === 1 && impact.mustChange === 0, 'impact: A now above suggested, B fine, D not a customer yet', impact);
    check(preview.json.data.changes.bands.length === 1 && preview.json.data.changes.bands[0].change === 'changed', 'one band changed', preview.json.data.changes);
    const [{ count }] = await rows<any>(`SELECT COUNT(*)::int AS count FROM segment_risk_rule_sets WHERE segment_id = :id`, { id: seg['EQUITY_INTRADAY'] });
    check(count === 1, 'preview saved nothing');

    const saved = await putRules('EQUITY_INTRADAY', v2);
    check(saved.status === 200 && saved.json.data.ruleSet.version === 2, 'version 2 saved', saved.json);
    const audit = await rows<any>(`SELECT before_data, after_data FROM audit_logs WHERE action = 'admin.segment_risk_rules_updated'`);
    check(audit.length === 1 && audit[0].before_data.version === 1 && audit[0].after_data.version === 2, 'change audited with before and after', audit);
  });

  it('blocks affected customers until they accept one combined notice', async () => {
    const empty = await call('GET', '/users/me/risk-notice', { token: userC.token });
    check(empty.json.data.required === false, 'a delivery-only customer is not affected');
    check((await call('GET', '/users/me/risk-notice', { token: userD.token })).json.code === 'ONBOARDING_REQUIRED', 'onboarding users get no notice');

    const me = await call('GET', '/users/me', { token: userA.token });
    check(me.json.data.requirements.riskNoticeRequired === true, 'requirement listed', me.json.data.requirements);
    const gated = await call('GET', '/users/me/risk-profile', { token: userA.token });
    check(gated.status === 403 && gated.json.code === 'RISK_NOTICE_PENDING', 'blocked until accepted', gated.json);
    const otp = await call('POST', '/auth/login/otp/send', { body: { phone: userA.phone } });
    const login = await call('POST', '/auth/mobile/login/otp', { body: { verificationId: otp.json.data.verificationId, otp: TEST_OTP } });
    check(login.json.data.nextAction === 'risk_notice', 'login routes to the notice', login.json);

    const first = (await call('GET', '/users/me/risk-notice', { token: userA.token })).json.data.notice;
    check(first.segments.length === 1 && first.segments[0].status === 'needs_caution_ack', 'A is now above suggested', first.segments);

    // Version 3 before A responds: the 20k band minimum goes 2.5 -> 3.
    const table = await currentTable('EQUITY_INTRADAY');
    const v3 = table.map((band: any) => (band.capitalFrom === '20000.00' ? { ...band, minRiskPercent: '3' } : band));
    check((await putRules('EQUITY_INTRADAY', v3)).status === 200, 'version 3 saved');

    const noticeRes = await call('GET', '/users/me/risk-notice', { token: userA.token });
    const notice = noticeRes.json.data.notice;
    const entry = notice.segments[0];
    check(entry.fromRuleSet.version === 1 && entry.toRuleSet.version === 3, 'one notice: last seen version 1 -> version 3', entry);
    check(entry.bandChanges.length === 2 && entry.yourBand.before.maxRiskPercent === '7.5000' && entry.yourBand.after.maxRiskPercent === '10.0000', 'all changes listed', entry);
    check(
      notice.statement.includes('For your capital of ₹16,000: minimum 5% (unchanged), suggested 6.25% → 7.5%, maximum 7.5% → 10%.') &&
        notice.statement.includes('Your current setting: 8% (₹1,280 per day).') &&
        notice.statement.includes('above the suggested level for your capital'),
      'notice text',
      notice.statement,
    );
    check(notice.disclaimers.length === 1 && notice.disclaimers[0].level === 'above_suggested', 'the disclaimer comes with the notice', notice.disclaimers);

    const stale = await call('POST', '/users/me/risk-notice/accept', { token: userA.token, body: { noticeSha256: first.noticeSha256, policyDocumentId: first.policyDocumentId } });
    check(stale.status === 409 && stale.json.code === 'RISK_NOTICE_OUTDATED', 'an older notice cannot be accepted', stale.json);
    const noAck = await call('POST', '/users/me/risk-notice/accept', { token: userA.token, body: { noticeSha256: notice.noticeSha256, policyDocumentId: notice.policyDocumentId } });
    check(noAck.json.code === 'RISK_ACKNOWLEDGEMENT_REQUIRED', 'the disclaimer must be accepted too', noAck.json);
    const accepted = await call('POST', '/users/me/risk-notice/accept', {
      token: userA.token,
      body: {
        noticeSha256: notice.noticeSha256,
        policyDocumentId: notice.policyDocumentId,
        segments: [{ segmentId: seg['EQUITY_INTRADAY'], acknowledgement: ackFor(notice.disclaimers[0]) }],
      },
    });
    check(accepted.status === 200 && accepted.json.data.riskProfile.version === 3, 'accepted; values unchanged so no new profile version', accepted.json);
    check((await call('GET', '/users/me/risk-profile', { token: userA.token })).status === 200, 'access restored');

    const [stored] = await rows<any>(`SELECT * FROM risk_notice_acceptances WHERE user_id = :id`, { id: userA.id });
    check(stored.statement === notice.statement && stored.notice_sha256 === notice.noticeSha256 && stored.notice.segments[0].toRuleSet.version === 3, 'notice stored exactly as shown', stored);
    const [part] = await rows<any>(`SELECT * FROM risk_notice_acceptance_segments WHERE acceptance_id = :id`, { id: stored.id });
    check(part.status === 'needs_caution_ack' && part.values_changed === false && part.to_version === 3 && part.risk_acknowledgement_id, 'per-segment record', part);
    const [ack] = await rows<any>(`SELECT source FROM risk_acknowledgements WHERE id = :id`, { id: part.risk_acknowledgement_id });
    check(ack.source === 'risk_notice', 'acknowledgement from the notice');

    // B holds intraday too; its band did not change, so a plain acceptance is enough.
    const bNotice = (await call('GET', '/users/me/risk-notice', { token: userB.token })).json.data.notice;
    check(bNotice.segments.length === 1 && bNotice.segments[0].status === 'ok' && bNotice.disclaimers.length === 0, 'B: ok', bNotice.segments);
    const report = await call('GET', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules/3/acceptances`, A());
    check(report.json.data.summary.accepted === 1 && report.json.data.summary.pending === 1, 'report: A accepted, B pending', report.json.data);
    const pendingOnly = await call('GET', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules/3/acceptances?status=pending`, A());
    check(pendingOnly.json.data.items.length === 1 && pendingOnly.json.data.items[0].userId === userB.id, 'filter by status', pendingOnly.json.data);
    const bAccepted = await call('POST', '/users/me/risk-notice/accept', { token: userB.token, body: { noticeSha256: bNotice.noticeSha256, policyDocumentId: bNotice.policyDocumentId } });
    check(bAccepted.status === 200, 'B accepted', bAccepted.json);
    check((await call('GET', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules/2/acceptances`, A())).json.data.summary.accepted === 2, 'accepting v3 covers v2');
    check((await call('GET', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules/1/acceptances`, A())).status === 422, 'the silent seed version has no report');

    // A silent version (initial setup) never notifies.
    await envHandle.sequelize.query(
      `WITH rs AS (INSERT INTO segment_risk_rule_sets (segment_id, version, suggested_mode, source, notify_users)
                   VALUES (:id, 2, 'manual', 'seed', FALSE) RETURNING id)
       INSERT INTO segment_risk_bands (rule_set_id, capital_from, min_risk_percent, suggested_risk_percent, max_risk_percent)
       SELECT id, 5000, 0.5, 2, 3 FROM rs`,
      { replacements: { id: seg['FNO_STOCK'] } },
    );
    check((await call('GET', '/users/me/risk-notice', { token: userB.token })).json.data.required === false, 'silent version: no notice');
  });

  it('makes customers change values that fall below the new minimum', async () => {
    const table = await currentTable('EQUITY_INTRADAY');
    const v4 = [{ ...table[0], minRiskPercent: '8.5' }, ...table.slice(1)];
    const preview = await putRules('EQUITY_INTRADAY', v4, '?preview=true');
    check(preview.json.data.impact.mustChange === 1, 'preview shows A must change', preview.json.data.impact);
    check((await putRules('EQUITY_INTRADAY', v4)).status === 200, 'version 4 saved');

    const notice = (await call('GET', '/users/me/risk-notice', { token: userA.token })).json.data.notice;
    check(notice.segments[0].status === 'must_change' && notice.segments[0].reason === 'risk_below_minimum', 'A must change', notice.segments[0]);
    check(notice.statement.includes('is now below the minimum allowed. Please update it to continue.'), 'action in the text', notice.statement);
    const base = { noticeSha256: notice.noticeSha256, policyDocumentId: notice.policyDocumentId };
    const acceptOnly = await call('POST', '/users/me/risk-notice/accept', { token: userA.token, body: base });
    check(acceptOnly.json.code === 'RISK_OUT_OF_RANGE', 'accepting alone is not enough', acceptOnly.json);
    const other = await call('POST', '/users/me/risk-notice/accept', { token: userA.token, body: { ...base, segments: [{ segmentId: seg['EQUITY_DELIVERY'], riskPercent: '20' }] } });
    check(other.status === 422, 'only segments in the notice can be changed here', other.json);
    const fixed = await call('POST', '/users/me/risk-notice/accept', { token: userA.token, body: { ...base, segments: [{ segmentId: seg['EQUITY_INTRADAY'], riskPercent: '9' }] } });
    check(fixed.status === 200 && fixed.json.data.riskProfile.version === 4 && fixed.json.data.riskProfile.source === 'risk_notice', 'new profile version from the notice', fixed.json);
    const [part] = await rows<any>(
      `SELECT s.* FROM risk_notice_acceptance_segments s WHERE s.user_id = :id ORDER BY s.created_at DESC LIMIT 1`,
      { id: userA.id },
    );
    check(part.status === 'must_change' && part.values_changed === true && part.to_version === 4, 'recorded as changed', part);

    // D is still onboarding: no notice, but the values are checked against version 4.
    const dState = (await call('GET', '/onboarding', { token: userD.token })).json.data;
    check(dState.nextStep === 'risk' && dState.segmentChecks[0].riskOk === false, 'D is sent back to the risk step', dState);
    const dConfirm = await call('POST', '/onboarding/confirm', { token: userD.token });
    check(dConfirm.json.code === 'RISK_OUT_OF_RANGE', 'confirm checks the bands in force', dConfirm.json);

    const acks = await call('GET', `/admin/users/${userA.id}/risk-acknowledgements?pageSize=50`, A());
    check(acks.json.data.items.length === 5 && acks.json.data.items[0].segment.code === 'EQUITY_INTRADAY', 'admin sees the acknowledgements', acks.json.data.pagination);
    const notices = await call('GET', `/admin/users/${userA.id}/risk-notice-acceptances`, A());
    check(notices.json.data.items.length === 2 && notices.json.data.items[0].statement, 'admin sees the accepted notices', notices.json.data);
  });

  it('versions disclaimer texts without asking for re-acceptance', async () => {
    const list = await call('GET', '/admin/policies?type=risk_disclaimer_above_suggested', A());
    const v1 = (await call('GET', `/admin/policies/${list.json.data.items[0].id}`, A())).json.data.policy;
    const broken = await call('POST', '/admin/policies', { ...A(), body: { type: 'risk_disclaimer_above_suggested', title: v1.title, content: 'You chose a high risk.' } });
    check(broken.status === 422 && broken.json.details[0].missing.includes('riskPercent'), 'placeholders are required', broken.json);
    const draft = await call('POST', '/admin/policies', { ...A(), body: { type: 'risk_disclaimer_above_suggested', title: v1.title, content: `${v1.content}\n\nPlease review your choice.` } });
    check(draft.status === 201, 'draft created', draft.json);
    check((await call('POST', `/admin/policies/${draft.json.data.policy.id}/publish`, A())).status === 200, 'published');

    const assessed = (await assessOne(userC.token, 'EQUITY_DELIVERY', '100000', '30')).json.data.items[0];
    check(assessed.disclaimer.policyVersion === 2 && assessed.disclaimer.statement.endsWith('Please review your choice.'), 'new wording used from now on', assessed.disclaimer);
    const me = await call('GET', '/users/me', { token: userA.token });
    check(me.json.data.requirements.policyAcceptanceRequired === false && me.json.data.requirements.riskNoticeRequired === false, 'nobody is asked to accept it again', me.json.data.requirements);
  });

  it('asks nothing when a change is undone before the customer responds', async () => {
    const user = await newUser('Undo Customer');
    await onboard(user, [{ code: 'FNO_INDEX', capital: '50000', riskPercent: '5' }]);
    const original = await currentTable('FNO_INDEX');
    const changed = original.map((band: any) => ({ ...band, suggestedRiskPercent: '8', maxRiskPercent: '10' }));
    const pending = async () => (await call('GET', '/users/me/risk-notice', { token: user.token })).json.data;

    const v2 = await putRules('FNO_INDEX', changed);
    check(v2.status === 200 && v2.json.data.impact.notified === 1, 'the change notifies the holder', v2.json.data?.impact);
    check((await pending()).required === true, 'notice owed after the change');

    // The undo: the same limits the customer already has.
    const preview = await putRules('FNO_INDEX', original, '?preview=true');
    check(preview.json.data.impact.customers === 1 && preview.json.data.impact.notified === 0, 'preview: nobody to notify', preview.json.data.impact);
    const v3 = await putRules('FNO_INDEX', original);
    check(v3.status === 200 && v3.json.data.ruleSet.version === 3, 'undo saved as version 3', v3.json);
    check((await pending()).required === false, 'no notice once the change is undone');
    const me = await call('GET', '/users/me', { token: user.token });
    check(me.json.data.requirements.riskNoticeRequired === false, 'not blocked', me.json.data.requirements);
    check((await call('GET', '/users/me/risk-profile', { token: user.token })).status === 200, 'profile opens');

    for (const version of [2, 3]) {
      const report = await call('GET', `/admin/segments/${seg.FNO_INDEX}/risk-rules/${version}/acceptances`, A());
      check(
        report.json.data.summary.upToDate === 1 && report.json.data.summary.pending === 0,
        `report v${version}: already up to date`,
        report.json.data.summary,
      );
    }

    // A later real change is compared with what the customer last saw (version 1).
    check((await putRules('FNO_INDEX', changed)).status === 200, 'version 4 saved');
    const notice = (await pending()).notice;
    check(
      notice.segments.length === 1 && notice.segments[0].fromRuleSet.version === 1 && notice.segments[0].toRuleSet.version === 4,
      'notice from the last seen version',
      notice.segments,
    );
    const report = await call('GET', `/admin/segments/${seg.FNO_INDEX}/risk-rules/4/acceptances`, A());
    check(report.json.data.summary.pending === 1, 'report v4: pending', report.json.data.summary);
  });

  it('keeps every risk record append-only in the database', async () => {
    for (const [table, sql] of [
      ['risk_acknowledgements', 'UPDATE risk_acknowledgements SET capital = capital'],
      ['risk_acknowledgements', 'DELETE FROM risk_acknowledgements'],
      ['segment_risk_bands', 'UPDATE segment_risk_bands SET max_risk_percent = 100'],
      ['segment_risk_rule_sets', 'DELETE FROM segment_risk_rule_sets'],
      ['risk_notice_acceptances', 'TRUNCATE risk_notice_acceptances CASCADE'],
      ['risk_notice_acceptance_segments', 'UPDATE risk_notice_acceptance_segments SET status = status'],
    ] as const) {
      await assert.rejects(envHandle.sequelize.query(sql), /append-only/, `${table}: ${sql}`);
    }
  });
});
