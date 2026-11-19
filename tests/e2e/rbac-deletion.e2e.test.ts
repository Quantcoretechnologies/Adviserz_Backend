/**
 * Staff roles and permissions (RBAC) — end-to-end suite, part 3: deletion.
 *
 * Builds, through the API,
 *
 *   super admin -> Manager -> Assistant -> Junior
 *                         \-> Second assistant
 *               -> Outsider
 *
 * and checks previews (nothing changes), role deletion, the cascading
 * deletion of a whole branch, and the transfer of a deleted super admin's
 * team. Everything is a soft delete: rows are kept.
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

interface Person {
  id: string;
  email: string;
  password: string;
  token: string;
}

/** Create a staff member as `creator`, sign them in and replace the generated password. */
async function hire(
  creator: { token: string },
  fullName: string,
  email: string,
  options: { roleIds?: string[]; isSuperAdmin?: boolean } = {},
): Promise<Person> {
  const created = await call('POST', '/admin/staff', {
    ...creator,
    body: { fullName, email, roleIds: options.roleIds ?? [], isSuperAdmin: options.isSuperAdmin ?? false },
  });
  check(created.status === 201, `${fullName} created`, created.json);
  const password = `${fullName.split(' ')[0]}-Pass#20261x`;
  const login = await signIn(email, created.json.data.credentials.temporaryPassword);
  check(login.status === 200, `${fullName} signs in`, login.json);
  const token = login.json.data.accessToken as string;
  const changed = await call('POST', '/admin/auth/change-password', {
    token,
    body: { currentPassword: created.json.data.credentials.temporaryPassword, newPassword: password, confirmPassword: password },
  });
  check(changed.status === 200, `${fullName} sets a password`, changed.json);
  return { id: created.json.data.staff.id, email, password, token };
}

async function makeRole(creator: { token: string }, name: string, permissions: string[]): Promise<string> {
  const created = await call('POST', '/admin/roles', { ...creator, body: { name, permissions } });
  check(created.status === 201, `role "${name}" created`, created.json);
  return created.json.data.role.id;
}

const auth = (person: { token: string }) => ({ token: person.token });
const names = (list: { fullName?: string; name?: string }[]): string[] =>
  list.map((entry) => entry.fullName ?? entry.name ?? '').sort();

/** A snapshot of everything deletion touches, to prove a preview changes nothing. */
async function snapshot(): Promise<string> {
  const data = await rows(
    `SELECT 'admin' AS kind, CAST(id AS TEXT) AS id, is_deleted, CAST(created_by_admin_id AS TEXT) AS ref, full_name AS label FROM admins
     UNION ALL SELECT 'role', CAST(id AS TEXT), is_deleted, CAST(created_by_admin_id AS TEXT), name FROM admin_roles
     UNION ALL SELECT 'grant', CAST(id AS TEXT), is_deleted, CAST(role_id AS TEXT), permission_key FROM admin_role_permissions
     UNION ALL SELECT 'assignment', CAST(id AS TEXT), is_deleted, CAST(role_id AS TEXT), CAST(admin_id AS TEXT) FROM admin_role_assignments
     UNION ALL SELECT 'session', CAST(id AS TEXT), revoked_at IS NOT NULL, NULL, NULL FROM auth_sessions WHERE admin_id IS NOT NULL
     ORDER BY 1, 2`,
  );
  const [audit] = await rows<{ n: number }>('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM audit_logs');
  return JSON.stringify({ data, audit: audit?.n });
}

const MANAGER_PERMISSIONS = [
  'users.view', 'analytics.view',
  'staff.view', 'staff.create', 'staff.delete',
  'roles.view', 'roles.create', 'roles.edit', 'roles.assign', 'roles.delete',
];
const ASSISTANT_PERMISSIONS = [
  'users.view', 'analytics.view',
  'staff.view', 'staff.create', 'staff.delete',
  'roles.view', 'roles.create', 'roles.assign', 'roles.delete',
];

const root = { id: '', token: '' };
let managerRoleId = '';
let assistantRoleId = '';
let juniorRoleId = '';
let manager: Person;
let assistant: Person;
let second: Person;
let junior: Person;
let outsider: Person;

describe('Staff RBAC: deletion (end-to-end)', { concurrency: false }, () => {
  before(async () => {
    envHandle = await startTestEnvironment();
    call = createClient(envHandle.apiUrl);
    const login = await signIn(TEST_ADMIN.email, TEST_ADMIN.password);
    root.token = login.json.data.accessToken;
    root.id = login.json.data.admin.id;

    managerRoleId = await makeRole(root, 'Customer Manager', MANAGER_PERMISSIONS);
    manager = await hire(root, 'Meera Manager', 'meera.manager@example.test', { roleIds: [managerRoleId] });
    assistantRoleId = await makeRole(manager, 'Assistant', ASSISTANT_PERMISSIONS);
    assistant = await hire(manager, 'Arjun Assistant', 'arjun.assistant@example.test', { roleIds: [assistantRoleId] });
    second = await hire(manager, 'Sara Second', 'sara.second@example.test', { roleIds: [assistantRoleId] });
    juniorRoleId = await makeRole(assistant, 'Junior', ['users.view', 'analytics.view']);
    junior = await hire(assistant, 'Jaya Junior', 'jaya.junior@example.test', { roleIds: [juniorRoleId] });
    outsider = await hire(root, 'Omar Outsider', 'omar.outsider@example.test');
  });

  after(async () => {
    await envHandle?.close();
  });

  it('previews a change without changing anything', async () => {
    const before = await snapshot();

    const roleImpact = await call('GET', `/admin/roles/${assistantRoleId}/deletion-impact`, auth(manager));
    check(roleImpact.status === 200 && roleImpact.json.data.preview === true, 'role deletion preview', roleImpact.json);
    check(JSON.stringify(names(roleImpact.json.data.holders)) === JSON.stringify(['Arjun Assistant', 'Sara Second']), 'lists who loses the role', roleImpact.json.data.holders);
    check(roleImpact.json.data.cascade.roles.length === 1 && roleImpact.json.data.cascade.roles[0].name === 'Junior', 'and the role below that is stripped', roleImpact.json.data.cascade);

    const staffImpact = await call('GET', `/admin/staff/${manager.id}/deletion-impact`, auth(root));
    check(staffImpact.status === 200 && staffImpact.json.data.preview === true, 'staff deletion preview', staffImpact.json);
    check(
      JSON.stringify(names(staffImpact.json.data.deleted.staff)) === JSON.stringify(['Arjun Assistant', 'Jaya Junior', 'Meera Manager', 'Sara Second']),
      'lists the whole branch',
      staffImpact.json.data.deleted.staff,
    );
    check(JSON.stringify(names(staffImpact.json.data.deleted.roles)) === JSON.stringify(['Assistant', 'Junior']), 'and every role the branch created', staffImpact.json.data.deleted.roles);

    const without = MANAGER_PERMISSIONS.filter((key) => key !== 'analytics.view');
    const editImpact = await call('PATCH', `/admin/roles/${managerRoleId}?preview=true`, { ...auth(root), body: { permissions: without } });
    check(editImpact.status === 200 && editImpact.json.data.preview === true, 'permission removal preview', editImpact.json);
    check(JSON.stringify(names(editImpact.json.data.cascade.roles)) === JSON.stringify(['Assistant', 'Junior']), 'lists the roles that would be stripped', editImpact.json.data.cascade);
    check(!editImpact.json.data.role.permissions.includes('analytics.view'), 'the role is returned as it would be after the change', editImpact.json.data.role);
    const stored = await call('GET', `/admin/roles/${managerRoleId}`, auth(root));
    check(stored.json.data.role.permissions.includes('analytics.view'), 'while the stored role still has the permission', stored.json.data.role);

    const unassignImpact = await call('PUT', `/admin/staff/${manager.id}/roles?preview=true`, { ...auth(root), body: { roleIds: [] } });
    check(unassignImpact.status === 200 && unassignImpact.json.data.cascade.roles.length === 2, 'role removal preview', unassignImpact.json);
    check(unassignImpact.json.data.staff.roles.length === 0, 'the staff member is returned as they would be after the change', unassignImpact.json.data.staff);

    check((await snapshot()) === before, 'no row, session or audit entry changed');
    check((await call('GET', '/admin/stats', auth(junior))).status === 200, 'and access is untouched three levels down');

    const denied = await call('GET', `/admin/staff/${manager.id}/deletion-impact`, auth(outsider));
    check(denied.status === 403 && denied.json.code === 'INSUFFICIENT_PERMISSIONS', 'a preview needs the same permission as the action', denied.json);
  });

  it('protects accounts that must not be deleted', async () => {
    const self = await call('DELETE', `/admin/staff/${root.id}`, auth(root));
    check(self.status === 403 && self.json.code === 'CANNOT_MODIFY_SELF', 'nobody deletes themselves', self.json);
    check((await call('DELETE', `/admin/staff/${manager.id}`, auth(manager))).status === 404, 'a manager is not in their own branch');
    check((await call('DELETE', `/admin/staff/${manager.id}`, auth(assistant))).status === 404, 'nobody deletes upward');
    check((await call('DELETE', `/admin/staff/${outsider.id}`, auth(manager))).status === 404, 'or across branches');
    const below = await call('DELETE', `/admin/staff/${junior.id}`, auth(manager));
    check(below.status === 403 && below.json.code === 'MANAGED_BY_ANOTHER_ADMIN', 'a manager deletes only staff they created', below.json);
    const role = await call('DELETE', `/admin/roles/${juniorRoleId}`, auth(manager));
    check(role.status === 403 && role.json.code === 'MANAGED_BY_ANOTHER_ADMIN', 'and only roles they created', role.json);
    check((await call('DELETE', `/admin/roles/${managerRoleId}`, auth(manager))).status === 404, 'the role above them is out of reach');
  });

  it('deletes a role: holders lose it, their accounts stay', async () => {
    const deleted = await call('DELETE', `/admin/roles/${juniorRoleId}`, auth(assistant));
    check(deleted.status === 200 && deleted.json.data.preview === false, 'role deleted by its creator', deleted.json);
    check(deleted.json.data.holders.length === 1 && deleted.json.data.holders[0].id === junior.id, 'reports who lost it', deleted.json.data);

    check((await call('GET', '/admin/users', auth(junior))).status === 403, 'the holder loses the access');
    const me = await call('GET', '/admin/auth/me', auth(junior));
    check(me.status === 200 && me.json.data.permissions.length === 0 && me.json.data.admin.roles.length === 0, 'but keeps the account, with no roles', me.json);
    check((await call('GET', `/admin/roles/${juniorRoleId}`, auth(assistant))).status === 404, 'the role is gone from the API');
    check((await call('GET', '/admin/roles?mine=true', auth(assistant))).json.data.items.length === 0, 'and from lists');
    check((await call('DELETE', `/admin/roles/${juniorRoleId}`, auth(assistant))).status === 404, 'deleting twice is not found');
    const reuse = await call('PUT', `/admin/staff/${junior.id}/roles`, { ...auth(assistant), body: { roleIds: [juniorRoleId] } });
    check(reuse.status === 422 && reuse.json.code === 'ROLE_NOT_ASSIGNABLE', 'a deleted role cannot be given', reuse.json);

    const kept = await rows<{ is_deleted: boolean; deleted_by_admin_id: string; live_assignments: number }>(
      `SELECT r.is_deleted, r.deleted_by_admin_id,
              CAST((SELECT COUNT(*) FROM admin_role_assignments a WHERE a.role_id = r.id AND a.is_deleted = FALSE) AS INTEGER) AS live_assignments
         FROM admin_roles r WHERE r.id = :juniorRoleId`,
      { juniorRoleId },
    );
    check(kept[0]?.is_deleted === true && kept[0]?.deleted_by_admin_id === assistant.id && kept[0]?.live_assignments === 0, 'the row is kept and marked deleted', kept);

    juniorRoleId = await makeRole(assistant, 'Junior', ['users.view', 'analytics.view']);
    const again = await call('PUT', `/admin/staff/${junior.id}/roles`, { ...auth(assistant), body: { roleIds: [juniorRoleId] } });
    check(again.status === 200, 'the name can be used again for a new role', again.json);
    check((await call('GET', '/admin/users', auth(junior))).status === 200, 'and the junior is back at work');
  });

  it('deleting a role strips what was handed down from it', async () => {
    const deleted = await call('DELETE', `/admin/roles/${assistantRoleId}`, auth(root));
    check(deleted.status === 200 && deleted.json.data.holders.length === 2, 'a super admin can delete any role', deleted.json);
    check(deleted.json.data.cascade.roles.length === 1 && deleted.json.data.cascade.roles[0].revoked.length === 2, 'the role below is emptied', deleted.json.data.cascade);
    check((await call('GET', '/admin/users', auth(assistant))).status === 403, 'the assistant lost access');
    check((await call('GET', '/admin/users', auth(junior))).status === 403, 'and so did the junior below');
    check((await call('GET', '/admin/auth/me', auth(second))).json.data.permissions.length === 0, 'the second assistant too');
    check((await signIn(junior.email, junior.password)).status === 200, 'all of them can still sign in');

    // Rebuild for the next tests.
    assistantRoleId = await makeRole(manager, 'Assistant', ASSISTANT_PERMISSIONS);
    for (const person of [assistant, second]) {
      const given = await call('PUT', `/admin/staff/${person.id}/roles`, { ...auth(manager), body: { roleIds: [assistantRoleId] } });
      check(given.status === 200, 'role given again', given.json);
    }
    const restored = await call('PATCH', `/admin/roles/${juniorRoleId}`, { ...auth(root), body: { permissions: ['users.view', 'analytics.view'] } });
    check(restored.status === 200, 'junior role restored', restored.json);
    check((await call('GET', '/admin/users', auth(junior))).status === 200, 'access is back');
  });

  it('deletes a manager together with everyone and everything below them', async () => {
    const deleted = await call('DELETE', `/admin/staff/${manager.id}`, auth(root));
    check(deleted.status === 200 && deleted.json.data.preview === false, 'manager deleted', deleted.json);
    check(
      JSON.stringify(names(deleted.json.data.deleted.staff)) === JSON.stringify(['Arjun Assistant', 'Jaya Junior', 'Meera Manager', 'Sara Second']),
      'the whole branch went with them',
      deleted.json.data.deleted.staff,
    );
    check(JSON.stringify(names(deleted.json.data.deleted.roles)) === JSON.stringify(['Assistant', 'Junior']), 'with every role the branch created', deleted.json.data.deleted.roles);
    check(deleted.json.data.transferred.staff.length === 0, 'nothing is transferred for ordinary staff');

    for (const person of [manager, assistant, second, junior]) {
      const me = await call('GET', '/admin/auth/me', auth(person));
      check(me.status === 401, `${person.email} is signed out`, me.json);
      const login = await signIn(person.email, person.password);
      check(login.status === 401 && login.json.code === 'INVALID_CREDENTIALS', `${person.email} cannot sign in`, login.json);
    }
    check((await call('GET', '/admin/auth/me', auth(outsider))).status === 200, 'staff in another branch are untouched');

    const state = await rows<{ email: string; is_deleted: boolean; deleted_by_admin_id: string | null }>(
      `SELECT email, is_deleted, deleted_by_admin_id FROM admins ORDER BY email`,
    );
    check(state.length === 6, 'no row was removed', state.length);
    check(state.filter((row) => row.is_deleted).length === 4 && state.every((row) => !row.is_deleted || row.deleted_by_admin_id === root.id), 'four are marked deleted, by the super admin', state);
    const live = await rows<{ n: number }>(
      `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM admin_role_assignments a JOIN admins s ON s.id = a.admin_id WHERE a.is_deleted = FALSE AND s.is_deleted = TRUE`,
    );
    check(live[0]?.n === 0, 'no live role assignment points at a deleted account');
    const sessions = await rows<{ revoked_reason: string }>(
      `SELECT DISTINCT revoked_reason FROM auth_sessions WHERE admin_id = :id`,
      { id: junior.id },
    );
    check(sessions.length === 1 && sessions[0]?.revoked_reason === 'account_deleted', 'sessions were revoked as deleted', sessions);

    const tree = await call('GET', '/admin/staff/tree', auth(root));
    check(JSON.stringify(names(tree.json.data.nodes)) === JSON.stringify(['E2E Admin', 'Omar Outsider']), 'the tree no longer shows them', names(tree.json.data.nodes));
    check((await call('GET', `/admin/staff/${manager.id}`, auth(root))).status === 404, 'a deleted account is not found');
    check((await call('DELETE', `/admin/staff/${manager.id}`, auth(root))).status === 404, 'and cannot be deleted twice');

    const role = await call('GET', `/admin/roles/${managerRoleId}`, auth(root));
    check(role.status === 200 && role.json.data.role.holderCount === 0, 'the super admin\'s own role survives, with nobody holding it', role.json);
    check((await call('GET', '/admin/roles', auth(root))).json.data.items.length === 1, 'only that role is left');

    const audits = await rows<{ action: string; n: number }>(
      `SELECT action, CAST(COUNT(*) AS INTEGER) AS n FROM audit_logs WHERE action IN ('staff.deleted', 'role.deleted') GROUP BY action`,
    );
    const count = (action: string) => audits.find((row) => row.action === action)?.n;
    check(count('staff.deleted') === 4, 'every deleted account is audited', audits);
    check((count('role.deleted') ?? 0) >= 4, 'and every deleted role', audits);

    const rehired = await hire(root, 'Meera Manager', manager.email, { roleIds: [managerRoleId] });
    check(rehired.id !== manager.id, 'the email can be used for a new account');
    check((await call('GET', '/admin/staff', auth(rehired))).json.data.items.length === 0, 'which starts with an empty branch');
    manager = rehired;
  });

  it('moves a deleted super admin\'s team to the super admin who deleted them', async () => {
    const cfo = await hire(root, 'Chitra Cfo', 'chitra.cfo@example.test', { isSuperAdmin: true });

    const guarded = await call('DELETE', `/admin/staff/${root.id}`, auth(cfo));
    check(guarded.status === 403 && guarded.json.code === 'PROTECTED_ACCOUNT', 'the original super admin cannot be deleted', guarded.json);
    check((await call('GET', `/admin/staff/${root.id}/deletion-impact`, auth(cfo))).json.code === 'PROTECTED_ACCOUNT', 'not even previewed');

    // The CFO builds a team. One of her role names clashes with a role the founder already has.
    const cfoRoleId = await makeRole(cfo, 'Customer Manager', ['users.view', 'analytics.view', 'staff.view', 'staff.create', 'roles.view', 'roles.create', 'roles.assign']);
    const financeRoleId = await makeRole(cfo, 'Finance Lead', ['analytics.view', 'audit_logs.view']);
    const lead = await hire(cfo, 'Leela Lead', 'leela.lead@example.test', { roleIds: [cfoRoleId, financeRoleId] });
    const clerkRoleId = await makeRole(lead, 'Clerk', ['users.view']);
    const clerk = await hire(lead, 'Kabir Clerk', 'kabir.clerk@example.test', { roleIds: [clerkRoleId] });

    const preview = await call('GET', `/admin/staff/${cfo.id}/deletion-impact`, auth(root));
    check(preview.status === 200 && preview.json.data.deleted.staff.length === 1, 'the preview deletes only the super admin', preview.json);
    check(preview.json.data.transferred.staff.length === 1 && preview.json.data.transferred.roles.length === 2, 'and shows what would move', preview.json.data.transferred);
    check((await call('GET', '/admin/auth/me', auth(cfo))).status === 200, 'nothing happened yet');

    const deleted = await call('DELETE', `/admin/staff/${cfo.id}`, auth(root));
    check(deleted.status === 200, 'super admin deleted', deleted.json);
    const { transferred } = deleted.json.data;
    check(deleted.json.data.deleted.staff.length === 1 && deleted.json.data.deleted.roles.length === 0, 'only that account is deleted', deleted.json.data.deleted);
    check(transferred.staff.length === 1 && transferred.staff[0].id === lead.id, 'their direct report moved', transferred.staff);
    const renamed = transferred.roles.find((role: any) => role.id === cfoRoleId);
    check(renamed.previousName === 'Customer Manager' && renamed.name === 'Customer Manager (from Chitra Cfo)', 'a clashing role name is made unique', transferred.roles);
    check(transferred.roles.find((role: any) => role.id === financeRoleId).name === 'Finance Lead', 'other names are kept');

    check((await call('GET', '/admin/auth/me', auth(cfo))).status === 401, 'the deleted super admin is signed out');
    check((await signIn(cfo.email, cfo.password)).status === 401, 'and cannot sign in');

    const leadMe = await call('GET', '/admin/auth/me', auth(lead));
    check(leadMe.status === 200 && leadMe.json.data.permissions.length === 8 && leadMe.json.data.admin.roles.length === 2, 'the team keeps working with the same access', leadMe.json);
    check((await call('GET', '/admin/users', auth(clerk))).status === 200, 'all the way down');
    const detail = await call('GET', `/admin/staff/${lead.id}`, auth(root));
    check(detail.json.data.staff.createdBy.id === root.id, 'and now reports to the super admin who deleted the other', detail.json.data.staff.createdBy);
    const clerkDetail = await call('GET', `/admin/staff/${clerk.id}`, auth(root));
    check(clerkDetail.json.data.staff.createdBy.id === lead.id, 'deeper levels keep their own parent');

    const owned = await call('GET', '/admin/roles?mine=true', auth(root));
    check(owned.json.data.items.length === 3, 'the moved roles now belong to the remaining super admin', names(owned.json.data.items));
    const stillAssignable = await call('PUT', `/admin/staff/${lead.id}/roles`, { ...auth(root), body: { roleIds: [financeRoleId] } });
    check(stillAssignable.status === 200 && stillAssignable.json.data.staff.roles.length === 1, 'who can manage them like their own', stillAssignable.json);

    const audit = await rows<{ metadata: any }>(`SELECT metadata FROM audit_logs WHERE action = 'staff.transferred'`);
    check(audit.length === 1 && audit[0]?.metadata.from === cfo.id && audit[0]?.metadata.to === root.id, 'the transfer is audited', audit);
  });

  it('leaves the hierarchy consistent', async () => {
    const violations = await rows(
      `SELECT r.name, rp.permission_key
         FROM admin_roles r
         JOIN admins o ON o.id = r.created_by_admin_id AND o.is_super_admin = FALSE
         JOIN admin_role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = FALSE
        WHERE r.is_deleted = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM admin_role_assignments ara
              JOIN admin_roles pr ON pr.id = ara.role_id AND pr.is_deleted = FALSE
              JOIN admin_role_permissions prp ON prp.role_id = pr.id AND prp.is_deleted = FALSE
             WHERE ara.admin_id = o.id AND ara.is_deleted = FALSE AND prp.permission_key = rp.permission_key)`,
    );
    check(violations.length === 0, 'no role holds more than its owner', violations);

    const orphans = await rows(
      `SELECT a.email FROM admins a JOIN admins p ON p.id = a.created_by_admin_id
        WHERE a.is_deleted = FALSE AND p.is_deleted = TRUE`,
    );
    check(orphans.length === 0, 'no live account reports to a deleted one', orphans);

    const strays = await rows(
      `SELECT r.name FROM admin_roles r JOIN admins o ON o.id = r.created_by_admin_id
        WHERE r.is_deleted = FALSE AND o.is_deleted = TRUE`,
    );
    check(strays.length === 0, 'no live role is owned by a deleted account', strays);

    const mismatched = await rows(
      `SELECT s.email FROM admin_role_assignments a
         JOIN admins s ON s.id = a.admin_id AND s.is_deleted = FALSE
         JOIN admin_roles r ON r.id = a.role_id AND r.is_deleted = FALSE
        WHERE a.is_deleted = FALSE AND s.created_by_admin_id <> r.created_by_admin_id`,
    );
    check(mismatched.length === 0, 'every role is held by staff of the role\'s own creator', mismatched);
  });
});
