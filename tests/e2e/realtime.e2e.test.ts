/**
 * Real-time notifications — end-to-end suite.
 *
 * Covers: the socket handshake (who may connect, error codes), notifications
 * created when an admin saves new risk limits (stored for everyone it blocks,
 * pushed live to connected devices, never to anyone else), the bell API, the
 * alerts cleared by accepting the notice, and sockets closed by token expiry,
 * sign-out and blocking.
 *
 *   npm run test:e2e
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { QueryTypes } from 'sequelize';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createClient, type ApiResponse } from './client.js';
import { startTestEnvironment, TEST_ADMIN, TEST_ORIGIN, TEST_OTP, type TestEnvironment } from './harness.js';

function check(condition: unknown, label: string, detail?: unknown): void {
  assert.ok(condition, detail === undefined ? label : `${label}\n  -> ${JSON.stringify(detail).slice(0, 1500)}`);
}

let envHandle: TestEnvironment;
let call: ReturnType<typeof createClient>;
let adminToken = '';
const A = () => ({ token: adminToken });
let seg: Record<string, string> = {};

const unique = Date.now().toString().slice(-6);
let sequence = 0;
const nextPhone = (): string => `8${String(++sequence).padStart(3, '0')}${unique}`;

const sockets: Socket[] = [];

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

function open(token: string | undefined, namespace = '/user'): Socket {
  const socket = connectSocket(`${envHandle.baseUrl}${namespace}`, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 5000,
  });
  sockets.push(socket);
  return socket;
}

/** Connect and wait until the server accepts. */
function connected(token: string): Promise<Socket> {
  const socket = open(token);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error: any) => reject(new Error(`refused: ${error.message} ${JSON.stringify(error.data)}`)));
  });
}

/** Connect and expect a refusal; resolves with what the client sees. */
function refused(token: string | undefined, namespace = '/user'): Promise<{ message: string; code: string | undefined }> {
  const socket = open(token, namespace);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => reject(new Error('connected but should have been refused')));
    socket.once('connect_error', (error: any) => resolve({ message: error.message, code: error.data?.code }));
  });
}

function next<T = any>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${event}" within ${timeoutMs}ms`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves with every `event` received during the window. */
function collect(socket: Socket, event: string, windowMs = 500): Promise<any[]> {
  const seen: any[] = [];
  const listener = (payload: any) => seen.push(payload);
  socket.on(event, listener);
  return new Promise((resolve) =>
    setTimeout(() => {
      socket.off(event, listener);
      resolve(seen);
    }, windowMs),
  );
}

function disconnected(socket: Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      resolve('already disconnected');
      return;
    }
    const timer = setTimeout(() => reject(new Error('still connected')), timeoutMs);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

// ---------------------------------------------------------------------------
// Customer helpers
// ---------------------------------------------------------------------------

interface TestUser {
  token: string;
  phone: string;
  id: string;
}

async function newUser(fullName: string): Promise<TestUser> {
  const phone = nextPhone();
  const sent = await call('POST', '/auth/register/phone/send-otp', { body: { phone } });
  const verified = await call('POST', '/auth/register/verify-otp', {
    body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP },
  });
  const signup = await call('POST', '/auth/mobile/signup', {
    body: { method: 'phone', fullName, phone, verificationToken: verified.json.data.verificationToken },
  });
  check(signup.status === 201, 'signup', signup.json);
  const token = signup.json.data.accessToken;
  const contact = await call('POST', '/onboarding/contact/send-otp', { token, body: { email: `rt.${sequence}.${unique}@example.com` } });
  const contactOk = await call('POST', '/onboarding/contact/verify', {
    token,
    body: { verificationId: contact.json.data.verificationId, otp: TEST_OTP },
  });
  check(contactOk.json.data.nextStep === 'segments', 'contact verified', contactOk.json);
  return { token, phone, id: signup.json.data.user.id };
}

/** Onboarding up to the confirm step; `confirm` finishes it. Values stay below the suggested level. */
async function onboard(user: TestUser, code: string, capital: string, riskPercent: string, confirm = true): Promise<void> {
  const t = user.token;
  check((await call('PUT', '/onboarding/segments', { token: t, body: { segmentIds: [seg[code]] } })).status === 200, 'segments');
  check((await call('PUT', '/onboarding/experience', { token: t, body: { marketExperience: 'intermediate' } })).status === 200, 'experience');
  const cap = await call('PUT', '/onboarding/capital', { token: t, body: { allocations: [{ segmentId: seg[code], capital }] } });
  check(cap.json.data?.nextStep === 'risk', 'capital', cap.json);
  const risk = await call('PUT', '/onboarding/risk', { token: t, body: { allocations: [{ segmentId: seg[code], riskPercent }] } });
  check(risk.json.data?.nextStep === 'broker', 'risk', risk.json);
  const broker = await call('POST', '/onboarding/broker/skip', { token: t });
  const accepted = await call('POST', '/onboarding/policies/accept', {
    token: t,
    body: { policyDocumentIds: broker.json.data.policies.map((p: any) => p.id) },
  });
  check(accepted.json.data.nextStep === 'confirm', 'policies', accepted.json);
  if (confirm) check((await call('POST', '/onboarding/confirm', { token: t })).status === 200, 'confirmed');
}

/** A second session for the same customer (another device), by OTP login. */
async function secondSession(user: TestUser): Promise<string> {
  const sent = await call('POST', '/auth/login/otp/send', { body: { phone: user.phone } });
  check(sent.status === 200, 'login code sent', sent.json);
  const login = await call('POST', '/auth/mobile/login/otp', {
    body: { verificationId: sent.json.data.verificationId, otp: TEST_OTP, deviceName: 'Second device' },
  });
  check(login.status === 200, 'second session', login.json);
  return login.json.data.accessToken;
}

async function intradayTable(): Promise<any[]> {
  const res = await call('GET', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules`, A());
  return res.json.data.current.bands.map((band: any) => ({
    capitalFrom: band.capitalFrom,
    minRiskPercent: band.minRiskPercent,
    maxRiskPercent: band.maxRiskPercent,
  }));
}

async function saveIntraday(firstBandMin: string, preview = false): Promise<ApiResponse> {
  const bands = await intradayTable();
  bands[0].minRiskPercent = firstBandMin;
  return call('PUT', `/admin/segments/${seg['EQUITY_INTRADAY']}/risk-rules${preview ? '?preview=true' : ''}`, {
    ...A(),
    body: { bands },
  });
}

const notificationsOf = (token: string, query = '') => call('GET', `/users/me/notifications${query}`, { token });

let p: TestUser; // Intraday holder, two devices online
let q: TestUser; // Intraday holder, offline when the change is saved
let r: TestUser; // Delivery only: not affected
let s: TestUser; // Intraday chosen but onboarding not finished: not affected
let notificationForQ = '';

describe('Real-time notifications (end-to-end)', { concurrency: false }, () => {
  before(async () => {
    envHandle = await startTestEnvironment();
    call = createClient(envHandle.apiUrl);
    const signIn = await call('POST', '/admin/auth/login', {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
      headers: { origin: TEST_ORIGIN },
    });
    adminToken = signIn.json.data.accessToken;
    const segments = await call('GET', '/segments');
    seg = Object.fromEntries(segments.json.data.items.map((item: any) => [item.code, item.id]));
  });

  after(async () => {
    for (const socket of sockets) socket.disconnect();
    await envHandle?.close();
  });

  it('refuses sockets without a valid customer token, with a code the client can act on', async () => {
    const none = await refused(undefined);
    check(none.code === 'UNAUTHENTICATED', 'no token', none);

    const garbage = await refused('not-a-token');
    check(garbage.code === 'ACCESS_TOKEN_INVALID', 'garbage token', garbage);

    const staff = await refused(adminToken);
    check(staff.code === 'ACCESS_TOKEN_INVALID', 'a staff token is not a customer token', staff);

    p = await newUser('Pooja Realtime');
    const claims: any = jwt.decode(p.token);
    const expired = jwt.sign({ sid: claims.sid, typ: 'access' }, process.env['JWT_ACCESS_SECRET'] as string, {
      algorithm: 'HS256',
      subject: claims.sub,
      audience: claims.aud,
      issuer: claims.iss,
      expiresIn: -10,
    });
    const old = await refused(expired);
    check(old.code === 'ACCESS_TOKEN_EXPIRED', 'expired token: refresh and reconnect', old);

    const root = await refused(p.token, '/');
    check(root.code === 'NOT_FOUND', 'nothing is served on the default namespace', root);
  });

  it('lets any signed-in customer connect, even before onboarding is finished', async () => {
    const socket = await connected(p.token);
    check(socket.connected, 'connected mid-onboarding');
    socket.disconnect();
  });

  it('notifies exactly the customers a risk-limit change blocks, live and in the bell', async () => {
    await onboard(p, 'EQUITY_INTRADAY', '15000', '6');
    q = await newUser('Qasim Realtime');
    await onboard(q, 'EQUITY_INTRADAY', '15000', '6');
    r = await newUser('Ritu Realtime');
    await onboard(r, 'EQUITY_DELIVERY', '100000', '20');
    s = await newUser('Sahil Realtime');
    await onboard(s, 'EQUITY_INTRADAY', '15000', '6', false);

    const pPhone = await connected(p.token);
    const pLaptop = await connected(await secondSession(p));
    const rSocket = await connected(r.token);
    const sSocket = await connected(s.token);

    // A preview saves nothing and notifies nobody.
    const quiet = collect(pPhone, 'notification:new', 600);
    const preview = await saveIntraday('5.5', true);
    check(preview.status === 200 && preview.json.data.preview === true, 'preview', preview.json);
    check((await quiet).length === 0, 'no notification for a preview');

    const othersSeen = Promise.all([collect(rSocket, 'notification:new', 1200), collect(sSocket, 'notification:new', 1200)]);
    const onPhone = next(pPhone, 'notification:new');
    const onLaptop = next(pLaptop, 'notification:new');
    const saved = await saveIntraday('5.5');
    check(saved.status === 200 && saved.json.data.preview === false, 'saved', saved.json);
    check(saved.json.data.impact.notified === 2 && saved.json.data.impact.notifiedUserIds === undefined, 'P and Q notified; ids not sent to the admin', saved.json.data.impact);

    const [phonePayload, laptopPayload] = await Promise.all([onPhone, onLaptop]);
    const live = phonePayload.notification;
    check(laptopPayload.notification.id === live.id, 'every device of the customer gets it', laptopPayload);
    check(
      live.type === 'risk_notice.required' &&
        live.title === 'Your risk limits have changed' &&
        live.body === 'Adviserz has updated the limits for Equity Intraday. Please review and accept them to continue.' &&
        live.link === '/risk-notice' &&
        live.readAt === null &&
        live.data.segmentCode === 'EQUITY_INTRADAY' &&
        live.data.version === saved.json.data.ruleSet.version,
      'notification content',
      live,
    );
    const [rSeen, sSeen] = await othersSeen;
    check(rSeen.length === 0 && sSeen.length === 0, 'a Delivery holder and a customer still onboarding get nothing', { rSeen, sSeen });

    // Q was offline: it is waiting in the bell, the same as P's.
    const bell = await notificationsOf(q.token);
    check(bell.status === 200 && bell.json.data.unreadCount === 1 && bell.json.data.items.length === 1, 'Q has one unread', bell.json);
    notificationForQ = bell.json.data.items[0].id;
    check(bell.json.data.items[0].body === live.body && bell.json.data.pagination.total === 1, 'same text in the bell', bell.json.data);
    check((await notificationsOf(r.token)).json.data.items.length === 0, 'R has none');
    check((await notificationsOf(s.token)).json.data.items.length === 0, 'S has none');

    const me = await call('GET', '/users/me', { token: p.token });
    check(me.json.data.requirements.riskNoticeRequired === true, 'and P must now review the change', me.json.data.requirements);

    const stored = await envHandle.sequelize.query<any>(`SELECT COUNT(*)::int AS n FROM notifications`, { type: QueryTypes.SELECT });
    check(stored[0].n === 2, 'exactly two notifications stored', stored);
    for (const socket of [pPhone, pLaptop, rSocket, sSocket]) socket.disconnect();
  });

  it('shows the bell while a notice blocks everything else, and marks notifications read', async () => {
    const qSocket = await connected(q.token);
    check((await call('GET', '/users/me/risk-profile', { token: q.token })).status === 403, 'Q is blocked by the notice');

    const count = await call('GET', '/users/me/notifications/unread-count', { token: q.token });
    check(count.status === 200 && count.json.data.unreadCount === 1, 'unread count still reachable', count.json);

    check((await call('POST', '/users/me/notifications/read', { token: q.token, body: { ids: [] } })).status === 422, 'empty list refused');
    check((await call('POST', '/users/me/notifications/read', { token: q.token, body: { ids: ['abc'] } })).status === 422, 'bad id refused');
    check((await notificationsOf(q.token, '?pageSize=101')).status === 422, 'page size limited');

    const notTheirs = await call('POST', '/users/me/notifications/read', { token: r.token, body: { ids: [notificationForQ] } });
    check(notTheirs.status === 200 && notTheirs.json.data.updated === 0, 'another customer cannot mark it', notTheirs.json);

    const badge = next(qSocket, 'notification:read');
    const read = await call('POST', '/users/me/notifications/read', { token: q.token, body: { ids: [notificationForQ] } });
    check(read.status === 200 && read.json.data.updated === 1 && read.json.data.unreadCount === 0, 'marked read', read.json);
    check((await badge).unreadCount === 0, 'other devices are told to refresh the badge');

    const again = await call('POST', '/users/me/notifications/read', { token: q.token, body: { ids: [notificationForQ] } });
    check(again.json.data.updated === 0, 'marking again changes nothing', again.json);
    const listed = await notificationsOf(q.token);
    check(listed.json.data.items[0].readAt !== null && listed.json.data.unreadCount === 0, 'read time recorded', listed.json.data);
    qSocket.disconnect();
  });

  it('clears the risk alerts when the customer accepts the notice', async () => {
    const pSocket = await connected(p.token);
    const notice = (await call('GET', '/users/me/risk-notice', { token: p.token })).json.data.notice;
    const badge = next(pSocket, 'notification:read');
    const accepted = await call('POST', '/users/me/risk-notice/accept', {
      token: p.token,
      body: { noticeSha256: notice.noticeSha256, policyDocumentId: notice.policyDocumentId },
    });
    check(accepted.status === 200, 'notice accepted (6% still fits)', accepted.json);
    check((await badge).unreadCount === 0, 'badge cleared live');
    check((await notificationsOf(p.token)).json.data.unreadCount === 0, 'alert marked read');
    pSocket.disconnect();
  });

  it('keeps notifications: no deletes, and only marking as read', async () => {
    const attempt = async (sql: string) => {
      try {
        await envHandle.sequelize.query(sql);
        return 'ALLOWED';
      } catch (error: any) {
        return error.original?.code ?? error.message;
      }
    };
    check((await attempt(`DELETE FROM notifications`)) === '42501', 'delete blocked');
    check((await attempt(`TRUNCATE notifications`)) === '42501', 'truncate blocked');
    check((await attempt(`UPDATE notifications SET title = 'x'`)) === '42501', 'text cannot change');
    check((await attempt(`UPDATE notifications SET read_at = NULL`)) === '42501', 'cannot be marked unread');
  });

  it('marks everything read at once', async () => {
    const saved = await saveIntraday('5.2');
    check(saved.status === 200, 'another change', saved.json);
    check((await notificationsOf(q.token)).json.data.unreadCount === 1, 'Q has a new unread alert');
    const all = await call('POST', '/users/me/notifications/read-all', { token: q.token });
    check(all.status === 200 && all.json.data.updated === 1 && all.json.data.unreadCount === 0, 'read-all', all.json);
  });

  it('settles an alert when the limits are changed back before the customer responds', async () => {
    // P accepted the 5.5 table and was then alerted about 5.2; Q never
    // accepted anything.
    const pSocket = await connected(p.token);
    const alerted = next(pSocket, 'notification:new');
    check((await saveIntraday('5.6')).status === 200, 'a new change');
    await alerted;
    check((await notificationsOf(p.token)).json.data.unreadCount === 2, 'P has two unread alerts (5.2 and 5.6)');
    check((await call('GET', '/users/me', { token: p.token })).json.data.requirements.riskNoticeRequired === true, 'P must review it');

    // Back to the table P already accepted: nothing left for P to do.
    const cleared = next(pSocket, 'notification:read');
    const noNewAlert = collect(pSocket, 'notification:new', 800);
    const reverted = await saveIntraday('5.5');
    check(reverted.status === 200, 'changed back', reverted.json);
    check((await cleared).unreadCount === 0, "P's dot cleared live");
    check((await noNewAlert).length === 0, 'P is not alerted about limits they already accepted');
    const pBell = (await notificationsOf(p.token)).json.data;
    check(pBell.unreadCount === 0 && pBell.items.every((item: any) => item.readAt !== null), 'P has nothing unread', pBell);
    check((await call('GET', '/users/me', { token: p.token })).json.data.requirements.riskNoticeRequired === false, 'and no notice');

    // Q still has a notice to accept, so Q's alerts stay unread.
    const qBell = (await notificationsOf(q.token)).json.data;
    check(qBell.unreadCount === 2, 'Q keeps both unread alerts (5.6 and 5.5)', qBell);
    check((await call('GET', '/users/me', { token: q.token })).json.data.requirements.riskNoticeRequired === true, 'Q still must review');
    pSocket.disconnect();
  });

  it('closes a socket when the token it was opened with expires', async () => {
    const claims: any = jwt.decode(r.token);
    const shortLived = jwt.sign({ sid: claims.sid, typ: 'access' }, process.env['JWT_ACCESS_SECRET'] as string, {
      algorithm: 'HS256',
      subject: claims.sub,
      audience: claims.aud,
      issuer: claims.iss,
      expiresIn: 2,
    });
    const socket = await connected(shortLived);
    const expired = next(socket, 'auth:expired', 4000);
    const gone = disconnected(socket, 4000);
    await expired;
    check((await gone) === 'io server disconnect', 'server closed it after telling the client');
  });

  it('closes the sockets of a signed-out session, and keeps the device that signed the others out', async () => {
    const otherToken = await secondSession(r);
    const thisDevice = await connected(r.token);
    const otherDevice = await connected(otherToken);

    const revoked = next(otherDevice, 'session:revoked');
    const otherGone = disconnected(otherDevice);
    const stays = collect(thisDevice, 'session:revoked', 800);
    const res = await call('POST', '/users/me/sessions/revoke-others', { token: r.token });
    check(res.status === 200, 'other devices signed out', res.json);
    check((await revoked).reason === 'logout_all', 'told why', await revoked);
    await otherGone;
    check((await stays).length === 0 && thisDevice.connected, 'this device stays connected');

    const retry = await refused(otherToken);
    check(retry.code === 'SESSION_REVOKED', 'the signed-out session cannot reconnect', retry);

    const allGone = disconnected(thisDevice);
    check((await call('POST', '/users/me/sessions/revoke-all', { token: r.token })).status === 200, 'sign out everywhere');
    await allGone;
  });

  it('closes every socket of a customer an admin blocks', async () => {
    const socket = await connected(q.token);
    const revoked = next(socket, 'session:revoked');
    const gone = disconnected(socket);
    const block = await call('POST', `/admin/users/${q.id}/block`, { ...A(), body: { reason: 'Real-time test' } });
    check(block.status === 200, 'blocked', block.json);
    check((await revoked).reason === 'account_blocked', 'told the account was blocked');
    await gone;
    const retry = await refused(q.token);
    check(retry.code === 'SESSION_REVOKED' || retry.code === 'ACCOUNT_DISABLED', 'cannot reconnect', retry);
  });

  it('limits open connections per customer', async () => {
    const opened: Socket[] = [];
    for (let i = 0; i < 20; i += 1) opened.push(await connected(s.token));
    const extra = await refused(s.token);
    check(extra.code === 'RATE_LIMITED', '21st connection refused', extra);
    for (const socket of opened) socket.disconnect();
  });

  // Keep last: it shuts the socket server down for the rest of this file.
  it('on shutdown, drops connections so clients reconnect by themselves', async () => {
    const { closeRealtime } = await import('../../src/modules/realtime/realtime.server.js');
    // A client as the apps configure it: automatic reconnection on.
    const socket = connectSocket(`${envHandle.baseUrl}/user`, {
      auth: { token: s.token },
      transports: ['websocket'],
      forceNew: true,
      reconnectionDelay: 50,
      reconnectionDelayMax: 50,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (error: any) => reject(new Error(`refused: ${error.message}`)));
    });

    const reason = disconnected(socket);
    const retrying = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reconnect attempt within 3000ms')), 3000);
      socket.io.once('reconnect_attempt', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    closeRealtime();

    const why = await reason;
    check(why === 'transport close', 'disconnect is not a deliberate kick, so the client may reconnect', why);
    await retrying;
    check(socket.active, 'the client is trying to reconnect');
    socket.disconnect();
  });
});
