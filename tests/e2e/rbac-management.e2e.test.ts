/**
 * Staff roles and permissions (RBAC) — end-to-end suite, part 2: management.
 *
 * Everything here goes through the API, the way the admin console will use
 * it: a super admin builds a three-level hierarchy
 *
 *   super admin -> Manager -> Assistant -> Junior
 *
 * and the suite checks the rules that keep it sound: generated passwords,
 * the subset rule, who can see and change whom, and the cascade that removes
 * a permission from everyone below.
 *
 *   npm run test:e2e
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { QueryTypes } from 'sequelize';
import { createClient, type ApiResponse } from './client.js';
import { startTestEnvironment, TEST_ADMIN, TEST_ORIGIN, type TestEnvironment } from './harness.js';

function check(condition: unknown, label: string, detail?: unknown): void {
  assert.ok(condition, detail === undefined ? label : `${label}\n  -> ${JSON.stringify(detail).slice(0, 900)}`);
}

let envHandle: TestEnvironment;
let call: ReturnType<typeof createClient>;

async function rows<T extends object>(sql: string, replacements: Record<string, unknown> = {}): Promise<T[]> {
  return envHandle.sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

const signIn = (email: string, password: string): Promise<ApiResponse> =>
  call('POST', '/admin/auth/login', { body: { email, password }, headers: { origin: TEST_ORIGIN } });

/** Sign in with a generated password, replace it, and return the working token. */
async function firstSignIn(email: string, temporaryPassword: string, newPassword: string): Promise<string> {
  const login = await signIn(email, temporaryPassword);
  check(login.status === 200 && login.json.data.admin.mustChangePassword === true, `${email} signs in with the generated password`, login.json);
  const token = login.json.data.accessToken as string;
  const changed = await call('POST', '/admin/auth/change-password', {
    token,
    body: { currentPassword: temporaryPassword, newPassword, confirmPassword: newPassword },
  });
  check(changed.status === 200, `${email} replaces the generated password`, changed.json);
  return token;
}

/**
 * The rule the whole design rests on: no live role holds a permission its
 * (non-super-admin) owner does not hold. Checked straight from the tables.
 */
async function assertSubsetRuleHolds(label: string): Promise<void> {
  const violations = await rows<{ role: string; permission_key: string }>(
    `SELECT r.name AS role, rp.permission_key
       FROM admin_roles r
       JOIN admins o ON o.id = r.created_by_admin_id AND o.is_super_admin = FALSE
       JOIN admin_role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = FALSE
      WHERE r.is_deleted = FALSE
        AND NOT EXISTS (
          SELECT 1
            FROM admin_role_assignments ara
            JOIN admin_roles pr ON pr.id = ara.role_id AND pr.is_deleted = FALSE
            JOIN admin_role_permissions prp ON prp.role_id = pr.id AND prp.is_deleted = FALSE
           WHERE ara.admin_id = o.id AND ara.is_deleted = FALSE
             AND prp.permission_key = rp.permission_key)`,
  );
  check(violations.length === 0, `subset rule holds: ${label}`, violations);
}

const MANAGER = { fullName: 'Meera Manager', email: 'meera.manager@example.test', password: 'Meera-Works#2026' };
const ASSISTANT = { fullName: 'Arjun Assistant', email: 'arjun.assistant@example.test', password: 'Arjun-Works#2026' };
const JUNIOR = { fullName: 'Jaya Junior', email: 'jaya.junior@example.test', password: 'Jaya-Works#20261' };
const OUTSIDER = { fullName: 'Omar Outsider', email: 'omar.outsider@example.test' };
const SECOND_SUPER = { fullName: 'Sana Second', email: 'sana.second@example.test', password: 'Sana-Works#20261' };

const MANAGER_PERMISSIONS = [
  'users.view', 'users.block', 'analytics.view',
  'staff.view', 'staff.create', 'staff.edit', 'staff.block', 'staff.unblock', 'staff.reset_password',
  'roles.view', 'roles.create', 'roles.edit', 'roles.assign',
];
const ASSISTANT_PERMISSIONS = ['users.view', 'analytics.view', 'staff.view', 'staff.create', 'roles.view', 'roles.create', 'roles.edit', 'roles.assign'];
const JUNIOR_PERMISSIONS = ['users.view', 'analytics.view'];

let superToken = '';
let superId = '';
let managerRoleId = '';
let managerId = '';
let managerToken = '';
let assistantRoleId = '';
let assistantId = '';
let assistantToken = '';
let juniorRoleId = '';
let juniorId = '';
let juniorToken = '';
let outsiderId = '';

const S = () => ({ token: superToken });
const M = () => ({ token: managerToken });
const A = () => ({ token: assistantToken });
const J = () => ({ token: juniorToken });

const permissionsOf = async (auth: { token: string }): Promise<string[]> =>
  (await call('GET', '/admin/auth/me', auth)).json.data.permissions;

describe('Staff RBAC: management (end-to-end)', { concurrency: false }, () => {
  before(async () => {
    envHandle = await startTestEnvironment();
    call = createClient(envHandle.apiUrl);
    const login = await signIn(TEST_ADMIN.email, TEST_ADMIN.password);
    superToken = login.json.data.accessToken;
    superId = login.json.data.admin.id;
  });

  after(async () => {
    await envHandle?.close();
  });

  it('creates a role with a free-text name and explicit permissions', async () => {
    const created = await call('POST', '/admin/roles', {
      ...S(),
      body: { name: '  Customer   Manager ', description: 'Looks after customers', permissions: MANAGER_PERMISSIONS },
    });
    check(created.status === 201, 'role created', created.json);
    const role = created.json.data.role;
    managerRoleId = role.id;
    check(role.name === 'Customer Manager', 'the name is whatever was typed, tidied', role.name);
    check(JSON.stringify(role.permissions) === JSON.stringify([...MANAGER_PERMISSIONS].sort()), 'exactly the ticked permissions', role.permissions);
    check(role.owner.id === superId && role.canManage === true && role.holderCount === 0, 'owned by its creator', role);

    const unknown = await call('POST', '/admin/roles', { ...S(), body: { name: 'Bad', permissions: ['users.fly'] } });
    check(unknown.status === 422 && unknown.json.details[0].message.includes('users.fly'), 'unknown permission refused', unknown.json);
    const empty = await call('POST', '/admin/roles', { ...S(), body: { name: 'Empty', permissions: [] } });
    check(empty.status === 422, 'a role needs at least one permission', empty.json);
    const dependency = await call('POST', '/admin/roles', { ...S(), body: { name: 'Blocker', permissions: ['users.block'] } });
    check(dependency.status === 422 && dependency.json.code === 'PERMISSION_DEPENDENCY_MISSING', 'block needs view', dependency.json);
    check(dependency.json.details[0].requires === 'users.view', 'the missing permission is named', dependency.json.details);
    const duplicate = await call('POST', '/admin/roles', { ...S(), body: { name: 'customer manager', permissions: ['users.view'] } });
    check(duplicate.status === 409 && duplicate.json.code === 'ROLE_NAME_TAKEN', 'same name refused, ignoring case', duplicate.json);

    const listed = await call('GET', '/admin/roles?search=customer', S());
    check(listed.status === 200 && listed.json.data.items.length === 1, 'role is listed and searchable', listed.json);
    const detail = await call('GET', `/admin/roles/${managerRoleId}`, S());
    check(detail.status === 200 && detail.json.data.role.holders.length === 0, 'role detail loads', detail.json);
  });

  it('creates staff with a generated password that is shown once', async () => {
    const created = await call('POST', '/admin/staff', {
      ...S(),
      body: { fullName: MANAGER.fullName, email: MANAGER.email.toUpperCase(), roleIds: [managerRoleId] },
    });
    check(created.status === 201, 'staff created', created.json);
    const { staff, credentials } = created.json.data;
    managerId = staff.id;
    check(created.headers.get('cache-control') === 'no-store', 'the response is never cached');
    check(credentials.email === MANAGER.email, 'credentials carry the sign-in email', credentials);
    const password: string = credentials.temporaryPassword;
    check(
      password.length === 16 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password),
      'the generated password meets the policy',
      password,
    );
    check(!/[0O1lI]/.test(password), 'and has no look-alike characters', password);
    check(staff.mustChangePassword === true && staff.isSuperAdmin === false, 'must change it at first sign-in', staff);
    check(staff.createdBy.id === superId && staff.roles[0].id === managerRoleId, 'parent and role recorded', staff);

    const stored = await rows<{ password_hash: string }>('SELECT password_hash FROM admins WHERE id = :managerId', { managerId });
    check(stored[0]?.password_hash.startsWith('$argon2') && !stored[0]?.password_hash.includes(password), 'only a hash is stored');
    const leaked = await rows<{ id: string }>(
      `SELECT id FROM audit_logs WHERE CAST(after_data AS TEXT) LIKE :needle OR CAST(metadata AS TEXT) LIKE :needle`,
      { needle: `%${password}%` },
    );
    check(leaked.length === 0, 'the password never reaches the audit log');

    const another = await call('POST', '/admin/staff', { ...S(), body: { fullName: 'Second Try', email: MANAGER.email } });
    check(another.status === 409 && another.json.code === 'EMAIL_ALREADY_REGISTERED', 'duplicate email refused', another.json);
    const second = await call('POST', '/admin/staff', { ...S(), body: { fullName: OUTSIDER.fullName, email: OUTSIDER.email } });
    check(second.status === 201 && second.json.data.staff.roles.length === 0, 'staff can be created without roles', second.json);
    outsiderId = second.json.data.staff.id;
    check(second.json.data.credentials.temporaryPassword !== password, 'every password is different');

    // --- First sign-in: nothing works until the password is replaced --------
    const login = await signIn(MANAGER.email, password);
    check(login.status === 200 && login.json.data.admin.mustChangePassword === true, 'signs in with the generated password', login.json);
    managerToken = login.json.data.accessToken;
    const gated = await call('GET', '/admin/users', M());
    check(gated.status === 403 && gated.json.code === 'PASSWORD_CHANGE_REQUIRED', 'everything else is locked', gated.json);
    check((await call('GET', '/admin/permissions', M())).json.code === 'PASSWORD_CHANGE_REQUIRED', 'including the catalog');
    check((await call('GET', '/admin/auth/me', M())).status === 200, 'the profile still loads');

    const change = (body: Record<string, string>) => call('POST', '/admin/auth/change-password', { ...M(), body });
    const wrong = await change({ currentPassword: 'not-it', newPassword: MANAGER.password, confirmPassword: MANAGER.password });
    check(wrong.status === 400 && wrong.json.code === 'CURRENT_PASSWORD_INCORRECT', 'wrong current password', wrong.json);
    check((await change({ currentPassword: password, newPassword: 'Short#1a', confirmPassword: 'Short#1a' })).status === 422, 'staff passwords need 12 characters');
    check((await change({ currentPassword: password, newPassword: MANAGER.password, confirmPassword: 'Different#2026x' })).status === 422, 'confirmation must match');
    check((await change({ currentPassword: password, newPassword: password, confirmPassword: password })).json.code === 'PASSWORD_REUSE', 'cannot keep the generated password');
    const identity = await change({ currentPassword: password, newPassword: 'Meera.Manager#2026', confirmPassword: 'Meera.Manager#2026' });
    check(identity.status === 422, 'cannot contain the email name', identity.json);
    const changed = await change({ currentPassword: password, newPassword: MANAGER.password, confirmPassword: MANAGER.password });
    check(changed.status === 200, 'password changed', changed.json);

    check((await call('GET', '/admin/users', M())).status === 200, 'now the role applies');
    check((await signIn(MANAGER.email, password)).status === 401, 'the generated password no longer works');
    const fresh = await signIn(MANAGER.email, MANAGER.password);
    check(fresh.status === 200 && fresh.json.data.admin.mustChangePassword === false, 'the new one does', fresh.json);
    check(JSON.stringify(await permissionsOf(M())) === JSON.stringify([...MANAGER_PERMISSIONS].sort()), 'holds exactly the role permissions');
    const me = await call('GET', '/admin/auth/me', M());
    check(me.json.data.admin.roles[0].name === 'Customer Manager', 'me lists the roles held', me.json.data.admin);
  });

  it('lets a manager hand down only what they hold', async () => {
    const tooMuch = await call('POST', '/admin/roles', { ...M(), body: { name: 'Overreach', permissions: ['users.view', 'segments.view'] } });
    check(tooMuch.status === 403 && tooMuch.json.code === 'PERMISSION_NOT_GRANTABLE', 'cannot grant what they do not hold', tooMuch.json);
    check(tooMuch.json.details.length === 1 && tooMuch.json.details[0].permission === 'segments.view', 'the offending permission is named', tooMuch.json.details);

    const role = await call('POST', '/admin/roles', { ...M(), body: { name: 'Assistant Customer Manager', permissions: ASSISTANT_PERMISSIONS } });
    check(role.status === 201 && role.json.data.role.owner.id === managerId, 'manager creates a role under themselves', role.json);
    assistantRoleId = role.json.data.role.id;

    const superRole = await call('POST', '/admin/staff', { ...M(), body: { fullName: 'Wrong Role', email: 'wrong.role@example.test', roleIds: [managerRoleId] } });
    check(superRole.status === 422 && superRole.json.code === 'ROLE_NOT_ASSIGNABLE', 'cannot give out a role someone else created', superRole.json);
    const promote = await call('POST', '/admin/staff', { ...M(), body: { fullName: 'Fake Super', email: 'fake.super@example.test', isSuperAdmin: true } });
    check(promote.status === 403, 'only a super admin creates super admins', promote.json);

    const staff = await call('POST', '/admin/staff', { ...M(), body: { fullName: ASSISTANT.fullName, email: ASSISTANT.email, roleIds: [assistantRoleId] } });
    check(staff.status === 201 && staff.json.data.staff.createdBy.id === managerId, 'manager creates staff under themselves', staff.json);
    assistantId = staff.json.data.staff.id;
    assistantToken = await firstSignIn(ASSISTANT.email, staff.json.data.credentials.temporaryPassword, ASSISTANT.password);

    const juniorRole = await call('POST', '/admin/roles', { ...A(), body: { name: 'Junior', permissions: JUNIOR_PERMISSIONS } });
    check(juniorRole.status === 201, 'the assistant creates a role too', juniorRole.json);
    juniorRoleId = juniorRole.json.data.role.id;
    const junior = await call('POST', '/admin/staff', { ...A(), body: { fullName: JUNIOR.fullName, email: JUNIOR.email, roleIds: [juniorRoleId] } });
    check(junior.status === 201, 'and staff under themselves', junior.json);
    juniorId = junior.json.data.staff.id;
    juniorToken = await firstSignIn(JUNIOR.email, junior.json.data.credentials.temporaryPassword, JUNIOR.password);

    check((await call('GET', '/admin/users', J())).status === 200, 'three levels down, the permission works');
    check((await call('GET', '/admin/staff', J())).status === 403, 'and nothing more than was given');
    check((await call('POST', '/admin/roles', { ...J(), body: { name: 'X', permissions: ['users.view'] } })).status === 403, 'the junior cannot create roles');
    await assertSubsetRuleHolds('after building the hierarchy');
  });

  it('shows each admin their own branch and nothing else', async () => {
    const all = await call('GET', '/admin/staff/tree', S());
    check(all.status === 200 && all.json.data.nodes.length === 5, 'the super admin sees everyone', all.json.data.nodes.length);
    check(JSON.stringify(all.json.data.rootIds) === JSON.stringify([superId]), 'rooted at the super admin', all.json.data.rootIds);
    const parentOf = (id: string) => all.json.data.nodes.find((node: any) => node.id === id)?.parentId;
    check(parentOf(managerId) === superId && parentOf(assistantId) === managerId && parentOf(juniorId) === assistantId, 'each reports to their creator');

    const branch = await call('GET', '/admin/staff/tree', M());
    const ids = branch.json.data.nodes.map((node: any) => node.id).sort();
    check(JSON.stringify(ids) === JSON.stringify([managerId, assistantId, juniorId].sort()), 'the manager sees only their branch', ids);
    check(JSON.stringify(branch.json.data.rootIds) === JSON.stringify([managerId]), 'rooted at themselves, with no parent shown');

    const list = await call('GET', '/admin/staff', M());
    const byId = new Map<string, any>(list.json.data.items.map((item: any) => [item.id, item]));
    check(byId.size === 2 && byId.has(assistantId) && byId.has(juniorId), 'the list holds the branch below', [...byId.keys()]);
    check(byId.get(assistantId).canManage === true && byId.get(juniorId).canManage === false, 'they manage only who they created');
    check((await call('GET', `/admin/staff?search=${encodeURIComponent('jaya')}`, M())).json.data.items.length === 1, 'search works');

    check((await call('GET', `/admin/staff/${outsiderId}`, M())).status === 404, 'staff in another branch look like they do not exist');
    check((await call('GET', `/admin/staff/${superId}`, M())).status === 404, 'so does the super admin');
    check((await call('GET', `/admin/staff/${managerId}`, A())).status === 404, 'and nobody sees upward');
    const detail = await call('GET', `/admin/staff/${juniorId}`, M());
    check(detail.status === 200 && JSON.stringify(detail.json.data.permissions) === JSON.stringify([...JUNIOR_PERMISSIONS].sort()), 'detail shows effective permissions', detail.json);

    const notMine = await call('PATCH', `/admin/staff/${juniorId}`, { ...M(), body: { fullName: 'Changed Name' } });
    check(notMine.status === 403 && notMine.json.code === 'MANAGED_BY_ANOTHER_ADMIN', 'visible but not theirs to change', notMine.json);
    check((await call('PATCH', `/admin/staff/${juniorId}`, { ...S(), body: { fullName: 'Jaya J Junior' } })).status === 200, 'a super admin can change anyone');

    const roles = await call('GET', '/admin/roles', M());
    const names = roles.json.data.items.map((item: any) => item.name).sort();
    check(JSON.stringify(names) === JSON.stringify(['Assistant Customer Manager', 'Junior']), 'roles of the branch are visible', names);
    const junior = roles.json.data.items.find((item: any) => item.name === 'Junior');
    check(junior.canManage === false, 'but a role is changed only by its creator');
    check((await call('GET', '/admin/roles?mine=true', M())).json.data.items.length === 1, 'mine=true lists what they can assign');
    check((await call('GET', `/admin/roles/${managerRoleId}`, M())).status === 404, 'the role above them is not listed');
    const edit = await call('PATCH', `/admin/roles/${juniorRoleId}`, { ...M(), body: { name: 'Renamed' } });
    check(edit.status === 403 && edit.json.code === 'MANAGED_BY_ANOTHER_ADMIN', 'manager cannot edit a role created below', edit.json);
    check((await call('GET', '/admin/roles', S())).json.data.items.length === 3, 'the super admin sees every role');
  });

  it('removes a permission from everyone below when it is taken away', async () => {
    const without = MANAGER_PERMISSIONS.filter((key) => key !== 'analytics.view');
    const updated = await call('PATCH', `/admin/roles/${managerRoleId}`, { ...S(), body: { permissions: without } });
    check(updated.status === 200, 'permission removed from the manager role', updated.json);
    const cascade = updated.json.data.cascade;
    const stripped = cascade.roles.map((role: any) => role.name).sort();
    check(JSON.stringify(stripped) === JSON.stringify(['Assistant Customer Manager', 'Junior']), 'both roles below lost it', cascade);
    check(cascade.roles.every((role: any) => JSON.stringify(role.revoked) === JSON.stringify(['analytics.view'])), 'only that permission');
    check(cascade.affectedAdminIds.length === 2, 'two staff affected', cascade.affectedAdminIds);

    for (const [who, auth] of [['manager', M()], ['assistant', A()], ['junior', J()]] as const) {
      check((await call('GET', '/admin/stats', auth)).status === 403, `${who} lost analytics`);
      check((await call('GET', '/admin/users', auth)).status === 200, `${who} kept customers`);
    }
    await assertSubsetRuleHolds('after removing a permission at the top');

    const audits = await rows<{ entity_id: string; metadata: any; before_data: any }>(
      `SELECT entity_id, metadata, before_data FROM audit_logs WHERE action = 'role.permissions_cascade_revoked' ORDER BY id`,
    );
    check(audits.length === 2, 'each stripped role is audited', audits.length);
    check(audits.every((row) => row.metadata.causedBy.entityId === managerRoleId && row.before_data.permissions[0] === 'analytics.view'), 'pointing at the cause', audits);
    const kept = await rows<{ is_deleted: boolean }>(
      `SELECT is_deleted FROM admin_role_permissions WHERE role_id = :juniorRoleId AND permission_key = 'analytics.view'`,
      { juniorRoleId },
    );
    check(kept.length === 1 && kept[0]?.is_deleted === true, 'the row is marked deleted, not removed');

    // Giving it back does not flow down: each level re-ticks it deliberately.
    const restored = await call('PATCH', `/admin/roles/${managerRoleId}`, { ...S(), body: { permissions: MANAGER_PERMISSIONS } });
    check(restored.status === 200 && restored.json.data.cascade.roles.length === 0, 'permission given back', restored.json);
    check((await call('GET', '/admin/stats', M())).status === 200, 'the manager has it again');
    check((await call('GET', '/admin/stats', A())).status === 403, 'the assistant does not');
    const reticked = await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...M(), body: { permissions: ASSISTANT_PERMISSIONS } });
    check(reticked.status === 200, 'the manager ticks it again', reticked.json);
    check((await call('GET', '/admin/stats', A())).status === 200, 'now the assistant has it');
    check((await call('GET', '/admin/stats', J())).status === 403, 'the junior still waits for the assistant');
  });

  it('holds even a super admin to the subset rule', async () => {
    const beyond = await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...S(), body: { permissions: [...ASSISTANT_PERMISSIONS, 'segments.view'] } });
    check(beyond.status === 403 && beyond.json.code === 'PERMISSION_NOT_GRANTABLE', 'cannot give a role more than its owner holds', beyond.json);
    const renamed = await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...S(), body: { name: 'Assistant CM', description: '' } });
    check(renamed.status === 200 && renamed.json.data.role.name === 'Assistant CM' && renamed.json.data.role.description === null, 'but can rename it', renamed.json);
    const unchanged = await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...S(), body: { name: 'Assistant CM' } });
    check(unchanged.status === 200, 'saving without changes is harmless');
    check((await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...S(), body: {} })).status === 422, 'an empty update is refused');
    await assertSubsetRuleHolds('after super admin edits');
  });

  it('strips what was handed down when a role is taken away', async () => {
    const wrongRole = await call('PUT', `/admin/staff/${assistantId}/roles`, { ...S(), body: { roleIds: [managerRoleId] } });
    check(wrongRole.status === 422 && wrongRole.json.code === 'ROLE_NOT_ASSIGNABLE', 'a role can only come from the staff member\'s own parent', wrongRole.json);
    const selfRole = await call('PUT', `/admin/staff/${managerId}/roles`, { ...M(), body: { roleIds: [] } });
    check(selfRole.status === 404, 'nobody can change their own roles (they are not in their own branch)', selfRole.json);

    const removed = await call('PUT', `/admin/staff/${managerId}/roles`, { ...S(), body: { roleIds: [] } });
    check(removed.status === 200 && removed.json.data.staff.roles.length === 0, 'role taken from the manager', removed.json);
    check(removed.json.data.cascade.roles.length === 2, 'both roles below were stripped', removed.json.data.cascade);
    check((await permissionsOf(M())).length === 0, 'the manager holds nothing');
    check((await permissionsOf(A())).length === 0, 'the assistant holds nothing');
    check((await permissionsOf(J())).length === 0, 'the junior holds nothing');
    check((await call('GET', '/admin/users', J())).status === 403, 'so access is gone three levels down');
    await assertSubsetRuleHolds('after taking a role away');

    const history = await rows<{ is_deleted: boolean }>(
      'SELECT is_deleted FROM admin_role_assignments WHERE admin_id = :managerId AND role_id = :managerRoleId',
      { managerId, managerRoleId },
    );
    check(history.length === 1 && history[0]?.is_deleted === true, 'the assignment row is kept');

    const again = await call('PUT', `/admin/staff/${managerId}/roles`, { ...S(), body: { roleIds: [managerRoleId] } });
    check(again.status === 200 && again.json.data.staff.roles.length === 1, 'the role can be given again', again.json);
    check((await call('GET', '/admin/users', M())).status === 200, 'the manager is back');
    check((await call('GET', '/admin/users', A())).status === 403, 'the team below is not, until re-ticked');
    check((await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...M(), body: { permissions: ASSISTANT_PERMISSIONS } })).status === 200, 'manager restores the assistant role');
    check((await call('PATCH', `/admin/roles/${juniorRoleId}`, { ...A(), body: { permissions: JUNIOR_PERMISSIONS } })).status === 200, 'assistant restores the junior role');
    check((await call('GET', '/admin/users', J())).status === 200, 'access is back all the way down');
    await assertSubsetRuleHolds('after rebuilding');
  });

  it('adds several roles together, and removing one keeps what another still grants', async () => {
    const extra = await call('POST', '/admin/roles', { ...S(), body: { name: 'Second Hat', permissions: ['users.view', 'segments.view', 'roles.view', 'roles.create', 'roles.edit', 'staff.view'] } });
    check(extra.status === 201, 'a second role', extra.json);
    const both = await call('PUT', `/admin/staff/${managerId}/roles`, { ...S(), body: { roleIds: [managerRoleId, extra.json.data.role.id] } });
    check(both.status === 200 && both.json.data.staff.roles.length === 2, 'one staff member, two roles', both.json);
    check((await permissionsOf(M())).includes('segments.view'), 'powers are added together');

    const widened = await call('PATCH', `/admin/roles/${assistantRoleId}`, { ...M(), body: { permissions: [...ASSISTANT_PERMISSIONS, 'segments.view'] } });
    check(widened.status === 200, 'the manager can now hand down the extra permission', widened.json);
    check((await call('GET', '/admin/segments', A())).status === 200, 'and it works below');

    const dropped = await call('PUT', `/admin/staff/${managerId}/roles`, { ...S(), body: { roleIds: [managerRoleId] } });
    check(dropped.status === 200, 'second role removed', dropped.json);
    const cascade = dropped.json.data.cascade;
    check(cascade.roles.length === 1 && JSON.stringify(cascade.roles[0].revoked) === JSON.stringify(['segments.view']), 'only what no other role still grants is stripped', cascade);
    check((await call('GET', '/admin/segments', A())).status === 403, 'the extra permission is gone below');
    check((await call('GET', '/admin/users', A())).status === 200, 'the shared permission survives');
    await assertSubsetRuleHolds('after dropping one of two roles');
  });

  it('blocks one person without stopping their team', async () => {
    const self = await call('POST', `/admin/staff/${superId}/block`, { ...S(), body: { reason: 'Testing self block' } });
    check(self.status === 403 && self.json.code === 'CANNOT_MODIFY_SELF', 'nobody blocks themselves', self.json);

    const blocked = await call('POST', `/admin/staff/${managerId}/block`, { ...S(), body: { reason: 'On extended leave' } });
    check(blocked.status === 200 && blocked.json.data.staff.status === 'disabled' && blocked.json.data.staff.blockedReason === 'On extended leave', 'manager blocked', blocked.json);
    check((await call('GET', '/admin/users', M())).status === 401, 'signed out at once');
    check((await signIn(MANAGER.email, MANAGER.password)).json.code === 'ACCOUNT_DISABLED', 'and cannot sign in');
    check((await call('POST', `/admin/staff/${managerId}/block`, { ...S(), body: { reason: 'Again please' } })).status === 409, 'already blocked');

    check((await call('GET', '/admin/users', A())).status === 200, 'the assistant keeps working');
    check((await call('GET', '/admin/users', J())).status === 200, 'so does the junior');
    check((await permissionsOf(A())).length === ASSISTANT_PERMISSIONS.length, 'with all their permissions');

    const unblocked = await call('POST', `/admin/staff/${managerId}/unblock`, S());
    check(unblocked.status === 200 && unblocked.json.data.staff.status === 'active', 'unblocked', unblocked.json);
    const login = await signIn(MANAGER.email, MANAGER.password);
    check(login.status === 200, 'the manager signs in again', login.json);
    managerToken = login.json.data.accessToken;
    check((await permissionsOf(M())).length === MANAGER_PERMISSIONS.length, 'with their role intact');

    const byManager = await call('POST', `/admin/staff/${assistantId}/block`, { ...M(), body: { reason: 'Manager decision' } });
    check(byManager.status === 200, 'a manager blocks their own staff', byManager.json);
    check((await call('POST', `/admin/staff/${juniorId}/block`, { ...M(), body: { reason: 'Not mine to block' } })).json.code === 'MANAGED_BY_ANOTHER_ADMIN', 'but not staff created below');
    check((await call('POST', `/admin/staff/${assistantId}/unblock`, M())).status === 200, 'and unblocks them');
    assistantToken = (await signIn(ASSISTANT.email, ASSISTANT.password)).json.data.accessToken;
  });

  it('resets a password and edits details', async () => {
    const reset = await call('POST', `/admin/staff/${assistantId}/reset-password`, M());
    check(reset.status === 200 && reset.json.data.credentials.temporaryPassword.length === 16, 'a new password is generated', reset.json);
    check(reset.headers.get('cache-control') === 'no-store', 'not cached');
    check((await call('GET', '/admin/users', A())).status === 401, 'the old session is signed out');
    check((await signIn(ASSISTANT.email, ASSISTANT.password)).status === 401, 'the old password is dead');
    assistantToken = await firstSignIn(ASSISTANT.email, reset.json.data.credentials.temporaryPassword, 'Arjun-Again#2026');
    check((await call('GET', '/admin/users', A())).status === 200, 'working again after choosing a new password');

    const edited = await call('PATCH', `/admin/staff/${assistantId}`, { ...M(), body: { fullName: 'Arjun  A Assistant', email: 'Arjun.New@Example.test' } });
    check(edited.status === 200 && edited.json.data.staff.fullName === 'Arjun A Assistant' && edited.json.data.staff.email === 'arjun.new@example.test', 'name and email edited', edited.json);
    const clash = await call('PATCH', `/admin/staff/${assistantId}`, { ...M(), body: { email: JUNIOR.email } });
    check(clash.status === 409 && clash.json.code === 'EMAIL_ALREADY_REGISTERED', 'email must stay unique', clash.json);
    check((await signIn('arjun.new@example.test', 'Arjun-Again#2026')).status === 200, 'sign-in uses the new email');
  });

  it('supports several super admins and protects the original one', async () => {
    const withRoles = await call('POST', '/admin/staff', { ...S(), body: { fullName: 'Bad Combo', email: 'bad.combo@example.test', isSuperAdmin: true, roleIds: [managerRoleId] } });
    check(withRoles.status === 422, 'a super admin is not given roles', withRoles.json);
    const created = await call('POST', '/admin/staff', { ...S(), body: { fullName: SECOND_SUPER.fullName, email: SECOND_SUPER.email, isSuperAdmin: true } });
    check(created.status === 201 && created.json.data.staff.isSuperAdmin === true, 'a super admin creates another', created.json);
    const secondId = created.json.data.staff.id;
    const secondToken = await firstSignIn(SECOND_SUPER.email, created.json.data.credentials.temporaryPassword, SECOND_SUPER.password);
    const second = { token: secondToken };

    const catalog = await call('GET', '/admin/permissions', second);
    check(catalog.json.data.modules.flatMap((module: any) => module.permissions).every((entry: any) => entry.granted), 'with every permission');
    check((await call('GET', '/admin/staff/tree', second)).json.data.nodes.length === 6, 'and sight of the whole organisation');
    check((await call('PATCH', `/admin/staff/${juniorId}`, { ...second, body: { fullName: 'Jaya Junior' } })).status === 200, 'and the power to change anyone');

    const protectedBlock = await call('POST', `/admin/staff/${superId}/block`, { ...second, body: { reason: 'Hostile takeover' } });
    check(protectedBlock.status === 403 && protectedBlock.json.code === 'PROTECTED_ACCOUNT', 'the original super admin cannot be blocked', protectedBlock.json);
    check((await call('POST', `/admin/staff/${superId}/reset-password`, second)).json.code === 'PROTECTED_ACCOUNT', 'nor have their password reset');
    check((await call('PATCH', `/admin/staff/${superId}`, { ...second, body: { fullName: 'Renamed Owner' } })).json.code === 'PROTECTED_ACCOUNT', 'nor be edited');
    check((await call('PUT', `/admin/staff/${secondId}/roles`, { ...S(), body: { roleIds: [] } })).json.code === 'ROLE_NOT_ASSIGNABLE', 'super admins do not hold roles');
    check((await call('POST', `/admin/staff/${secondId}/block`, { ...S(), body: { reason: 'Left the company' } })).status === 200, 'another super admin can be blocked');
    check((await call('GET', '/admin/auth/me', second)).status === 401, 'and is signed out');
  });

  it('keeps the subset rule when two admins edit the tree at the same moment', async () => {
    const without = MANAGER_PERMISSIONS.filter((key) => key !== 'analytics.view');
    for (let round = 0; round < 6; round += 1) {
      // The super admin takes analytics away from the manager while the
      // manager is ticking it on the role below. Whatever the order, the role
      // below must never end up holding more than the manager does.
      await Promise.all([
        call('PATCH', `/admin/roles/${managerRoleId}`, { ...S(), body: { permissions: without } }),
        call('PATCH', `/admin/roles/${assistantRoleId}`, { ...M(), body: { permissions: ASSISTANT_PERMISSIONS } }),
        call('PATCH', `/admin/roles/${juniorRoleId}`, { ...A(), body: { permissions: JUNIOR_PERMISSIONS } }),
      ]);
      await assertSubsetRuleHolds(`concurrent round ${round + 1} (removed)`);
      check(!(await permissionsOf(A())).includes('analytics.view'), 'the assistant never keeps a permission the manager lost');
      check(!(await permissionsOf(J())).includes('analytics.view'), 'nor does the junior');

      const restore = await call('PATCH', `/admin/roles/${managerRoleId}`, { ...S(), body: { permissions: MANAGER_PERMISSIONS } });
      check(restore.status === 200, 'restored for the next round', restore.json);
    }
  });

  it('writes every change to the audit trail', async () => {
    const actions = (await rows<{ action: string }>('SELECT DISTINCT action FROM audit_logs')).map((row) => row.action);
    for (const expected of [
      'role.created', 'role.updated', 'role.permissions_cascade_revoked',
      'staff.created', 'staff.updated', 'staff.roles_changed', 'staff.blocked', 'staff.unblocked', 'staff.password_reset',
      'admin.password_changed',
    ]) {
      check(actions.includes(expected), `audit trail has ${expected}`, actions);
    }
    const visible = await call('GET', '/admin/audit-logs?action=staff.created', S());
    check(visible.status === 200 && visible.json.data.items.length >= 5, 'and the super admin can read it', visible.json.data.pagination);
    const secrets = await rows<{ id: string }>(
      `SELECT id FROM audit_logs WHERE CAST(metadata AS TEXT) ILIKE '%temporaryPassword%' OR CAST(after_data AS TEXT) ILIKE '%passwordHash%'`,
    );
    check(secrets.length === 0, 'with no passwords in it');
  });
});
