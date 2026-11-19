/**
 * Staff roles and permissions (RBAC) — end-to-end suite, part 1: enforcement.
 *
 * Covers the foundation: the permission catalog, the checks on every admin
 * route, and the database rules. Staff, roles and assignments are written
 * straight into the database here because the endpoints that manage them are
 * tested separately; what matters in this file is that the API obeys whatever
 * the tables say, on the very next request.
 *
 *   npm run test:e2e
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { QueryTypes } from 'sequelize';
import { createClient, toCookieHeader } from './client.js';
import { startTestEnvironment, TEST_ADMIN, TEST_ORIGIN, type TestEnvironment } from './harness.js';

function check(condition: unknown, label: string, detail?: unknown): void {
  assert.ok(condition, detail === undefined ? label : `${label}\n  -> ${JSON.stringify(detail).slice(0, 800)}`);
}

let envHandle: TestEnvironment;
let call: ReturnType<typeof createClient>;

async function rows<T extends object>(sql: string, replacements: Record<string, unknown> = {}): Promise<T[]> {
  return envHandle.sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

/** The statement must be refused by the named database constraint (not by some other error). */
async function refusedByDatabase(
  sql: string,
  replacements: Record<string, unknown>,
  constraint: string,
  label: string,
): Promise<void> {
  let violated: string | null = null;
  try {
    await envHandle.sequelize.query(sql, { replacements });
    violated = '(statement succeeded)';
  } catch (error) {
    violated = (error as { original?: { constraint?: string } }).original?.constraint ?? String(error);
  }
  check(violated === constraint, label, { expected: constraint, got: violated });
}

const STAFF = { name: 'Staff One', email: 'staff.one@example.test', password: 'Staff-One-Pass#2026' };

interface Route {
  method: string;
  path: string;
  access: unknown;
}

let guardedRoutes: Route[] = [];
let authenticatedOnly: unknown;
let catalogKeys: string[] = [];
let superAdminId = '';
let superToken = '';
let staffId = '';
let staffToken = '';
let staffCookies = '';
let staffCsrf = '';
let roleId = '';

const signIn = (email: string, password: string) =>
  call('POST', '/admin/auth/login', { body: { email, password }, headers: { origin: TEST_ORIGIN } });

/** A concrete URL for a route pattern; ids are random, so nothing real is touched. */
const concrete = (path: string): string => `/admin${path.replace(/:id/g, randomUUID())}`;

const asStaff = () => ({ token: staffToken });

async function tick(permission: string): Promise<void> {
  await envHandle.sequelize.query(
    `INSERT INTO admin_role_permissions (role_id, permission_key, granted_by_admin_id)
     VALUES (:roleId, :permission, :superAdminId)`,
    { replacements: { roleId, permission, superAdminId } },
  );
}

async function untick(permission: string): Promise<void> {
  await envHandle.sequelize.query(
    `UPDATE admin_role_permissions
        SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :superAdminId
      WHERE role_id = :roleId AND permission_key = :permission AND is_deleted = FALSE`,
    { replacements: { roleId, permission, superAdminId } },
  );
}

async function assign(): Promise<void> {
  await envHandle.sequelize.query(
    `INSERT INTO admin_role_assignments (admin_id, role_id, assigned_by_admin_id)
     VALUES (:staffId, :roleId, :superAdminId)`,
    { replacements: { staffId, roleId, superAdminId } },
  );
}

async function unassign(): Promise<void> {
  await envHandle.sequelize.query(
    `UPDATE admin_role_assignments
        SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :superAdminId
      WHERE admin_id = :staffId AND role_id = :roleId AND is_deleted = FALSE`,
    { replacements: { staffId, roleId, superAdminId } },
  );
}

describe('Staff RBAC: enforcement (end-to-end)', { concurrency: false }, () => {
  before(async () => {
    envHandle = await startTestEnvironment();
    call = createClient(envHandle.apiUrl);

    const routesModule = await import('../../src/modules/admin/admin.routes.js');
    const guardModule = await import('../../src/modules/admin/guardedRouter.js');
    const catalogModule = await import('../../src/modules/access/permissionCatalog.js');
    guardedRoutes = [...routesModule.guardedAdminRoutes];
    authenticatedOnly = guardModule.AUTHENTICATED_ONLY;
    catalogKeys = catalogModule.ACTIVE_PERMISSIONS.map((definition) => definition.key).sort();
  });

  after(async () => {
    await envHandle?.close();
  });

  it('mirrors the permission catalog into the database, once', async () => {
    const stored = await rows<{ key: string; module: string; action: string; is_active: boolean }>(
      'SELECT key, module, action, is_active FROM permissions ORDER BY key',
    );
    check(catalogKeys.length > 0, 'catalog is not empty');
    check(JSON.stringify(stored.map((row) => row.key)) === JSON.stringify(catalogKeys), 'every catalog key is stored', stored);
    check(stored.every((row) => row.is_active && row.key === `${row.module}.${row.action}`), 'rows are active and well formed');

    const { syncPermissionCatalog } = await import('../../src/modules/access/access.service.js');
    const again = await syncPermissionCatalog();
    check(again.added.length === 0 && again.retired.length === 0 && again.restored.length === 0, 'a second sync changes nothing', again);

    const audits = await rows<{ metadata: any }>(
      `SELECT metadata FROM audit_logs WHERE action = 'system.permission_catalog_synced'`,
    );
    check(audits.length === 1, 'the first sync is audited exactly once', audits);
    check(audits[0]?.metadata.added.length === catalogKeys.length, 'the audit entry lists the added keys');
  });

  it('names a permission on every signed-in admin route', async () => {
    check(guardedRoutes.length >= 18, 'routes are registered', guardedRoutes.length);
    const open = guardedRoutes.filter((route) => route.access === authenticatedOnly).map((route) => route.path).sort();
    check(JSON.stringify(open) === JSON.stringify(['/auth/change-password', '/auth/me', '/permissions']), 'only the profile, password change and catalog are open to every admin', open);
    for (const route of guardedRoutes) {
      if (route.access === authenticatedOnly) continue;
      check(catalogKeys.includes(route.access as string), `${route.method} ${route.path} uses a catalog permission`, route.access);
    }
  });

  it('gives the super admin every permission', async () => {
    const login = await signIn(TEST_ADMIN.email, TEST_ADMIN.password);
    check(login.status === 200, 'super admin signs in', login.json);
    check(login.json.data.admin.isSuperAdmin === true, 'login reports a super admin');
    check(!('role' in login.json.data.admin), 'the old role field is gone');
    superToken = login.json.data.accessToken;
    superAdminId = login.json.data.admin.id;

    const me = await call('GET', '/admin/auth/me', { token: superToken });
    check(me.status === 200 && me.json.data.admin.isSuperAdmin === true, 'me reports a super admin', me.json);
    check(JSON.stringify(me.json.data.permissions) === JSON.stringify(catalogKeys), 'me lists every permission', me.json.data.permissions);

    const catalog = await call('GET', '/admin/permissions', { token: superToken });
    check(catalog.status === 200, 'catalog loads', catalog.json);
    const listed = catalog.json.data.modules.flatMap((module: any) => module.permissions);
    check(listed.length === catalogKeys.length && listed.every((entry: any) => entry.granted === true), 'everything is granted to a super admin');
    check(catalog.json.data.modules.some((module: any) => module.key === 'users' && module.label === 'Customers'), 'grouped by module with labels');
    const block = listed.find((entry: any) => entry.key === 'users.block');
    check(block?.requires.includes('users.view'), 'dependencies are published', block);

    for (const route of guardedRoutes) {
      const response = await call(route.method.toUpperCase(), concrete(route.path), { token: superToken });
      check(response.status !== 401 && response.status !== 403, `super admin passes ${route.method} ${route.path}`, response.json);
    }
  });

  it('refuses a staff member without roles on every route', async () => {
    const { hashPassword } = await import('../../src/common/utils/password.js');
    const [created] = await rows<{ id: string }>(
      `INSERT INTO admins (full_name, email, password_hash, created_by_admin_id)
       VALUES (:name, :email, :hash, :superAdminId) RETURNING id`,
      { name: STAFF.name, email: STAFF.email, hash: await hashPassword(STAFF.password), superAdminId },
    );
    staffId = created?.id ?? '';
    check(staffId, 'staff account created');

    const login = await signIn(STAFF.email, STAFF.password);
    check(login.status === 200 && login.json.data.admin.isSuperAdmin === false, 'staff signs in as an ordinary admin', login.json);
    staffToken = login.json.data.accessToken;
    staffCookies = toCookieHeader(login.setCookies);
    staffCsrf = login.json.data.csrfToken;

    const me = await call('GET', '/admin/auth/me', asStaff());
    check(me.status === 200 && me.json.data.permissions.length === 0, 'no roles means no permissions', me.json);

    const catalog = await call('GET', '/admin/permissions', asStaff());
    const listed = catalog.json.data.modules.flatMap((module: any) => module.permissions);
    check(catalog.status === 200 && listed.every((entry: any) => entry.granted === false), 'the catalog is visible but nothing is granted');

    let refusedCount = 0;
    for (const route of guardedRoutes) {
      if (route.access === authenticatedOnly) continue;
      const response = await call(route.method.toUpperCase(), concrete(route.path), asStaff());
      check(
        response.status === 403 && response.json.code === 'INSUFFICIENT_PERMISSIONS',
        `${route.method} ${route.path} is refused`,
        response.json,
      );
      refusedCount += 1;
    }

    const denials = await rows<{ metadata: any }>(
      `SELECT metadata FROM audit_logs WHERE action = 'admin.permission_denied' AND actor_id = :staffId`,
      { staffId },
    );
    check(denials.length === refusedCount, 'every refusal is audited', { denials: denials.length, refusedCount });
    check(denials.some((row) => row.metadata.permission === 'users.block'), 'the audit entry names the missing permission');
  });

  it('applies a role on the very next request', async () => {
    const [role] = await rows<{ id: string }>(
      `INSERT INTO admin_roles (name, description, created_by_admin_id)
       VALUES ('Any Custom Name', 'Free text chosen by the creator', :superAdminId) RETURNING id`,
      { superAdminId },
    );
    roleId = role?.id ?? '';
    await tick('users.view');
    await tick('analytics.view');
    await assign();

    // Same access token as before: nothing about permissions lives in it.
    check((await call('GET', '/admin/users', asStaff())).status === 200, 'can list customers');
    check((await call('GET', '/admin/stats', asStaff())).status === 200, 'can see analytics');
    check((await call('GET', '/admin/segments', asStaff())).status === 403, 'cannot see segments');
    check((await call('GET', '/admin/audit-logs', asStaff())).status === 403, 'cannot see audit logs');
    const block = await call('POST', concrete('/users/:id/block'), { ...asStaff(), body: { reason: 'Not allowed to do this' } });
    check(block.status === 403 && block.json.code === 'INSUFFICIENT_PERMISSIONS', 'viewing customers does not allow blocking them', block.json);
    check((await call('GET', concrete('/users/:id/risk-profiles'), asStaff())).status === 403, 'each action is separate');

    const me = await call('GET', '/admin/auth/me', asStaff());
    check(JSON.stringify(me.json.data.permissions) === JSON.stringify(['analytics.view', 'users.view']), 'me lists exactly the role permissions', me.json.data.permissions);

    const catalog = await call('GET', '/admin/permissions', asStaff());
    const granted = catalog.json.data.modules
      .flatMap((module: any) => module.permissions)
      .filter((entry: any) => entry.granted)
      .map((entry: any) => entry.key)
      .sort();
    check(JSON.stringify(granted) === JSON.stringify(['analytics.view', 'users.view']), 'the catalog marks what can be handed down', granted);
  });

  it('withdraws access on the very next request, and keeps the history rows', async () => {
    await untick('analytics.view');
    check((await call('GET', '/admin/stats', asStaff())).status === 403, 'an unticked permission stops working');
    check((await call('GET', '/admin/users', asStaff())).status === 200, 'the other permission is untouched');

    await tick('analytics.view');
    check((await call('GET', '/admin/stats', asStaff())).status === 200, 'ticking it again works');
    const history = await rows<{ is_deleted: boolean }>(
      `SELECT is_deleted FROM admin_role_permissions WHERE role_id = :roleId AND permission_key = 'analytics.view'`,
      { roleId },
    );
    check(history.length === 2 && history.filter((row) => row.is_deleted).length === 1, 'the unticked row is kept, not removed', history);

    await unassign();
    check((await call('GET', '/admin/users', asStaff())).status === 403, 'taking the role away stops access');
    await assign();
    check((await call('GET', '/admin/users', asStaff())).status === 200, 'giving it back restores access');

    // A second role granting the same permission keeps it alive.
    const [second] = await rows<{ id: string }>(
      `INSERT INTO admin_roles (name, created_by_admin_id) VALUES ('Second Role', :superAdminId) RETURNING id`,
      { superAdminId },
    );
    await envHandle.sequelize.query(
      `INSERT INTO admin_role_permissions (role_id, permission_key, granted_by_admin_id) VALUES (:id, 'users.view', :superAdminId)`,
      { replacements: { id: second?.id, superAdminId } },
    );
    await envHandle.sequelize.query(
      `INSERT INTO admin_role_assignments (admin_id, role_id, assigned_by_admin_id) VALUES (:staffId, :id, :superAdminId)`,
      { replacements: { staffId, id: second?.id, superAdminId } },
    );
    await untick('users.view');
    check((await call('GET', '/admin/users', asStaff())).status === 200, 'several roles add up');
    await envHandle.sequelize.query(
      `UPDATE admin_roles SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :superAdminId WHERE id = :id`,
      { replacements: { id: second?.id, superAdminId } },
    );
    check((await call('GET', '/admin/users', asStaff())).status === 403, 'a deleted role grants nothing');
    check((await call('GET', '/admin/stats', asStaff())).status === 200, 'the live role still works');

    // A key the code does not define grants nothing, even if stored on a role.
    await envHandle.sequelize.query(`INSERT INTO permissions (key, module, action) VALUES ('legacy.thing', 'legacy', 'thing')`);
    await tick('legacy.thing');
    const me = await call('GET', '/admin/auth/me', asStaff());
    check(JSON.stringify(me.json.data.permissions) === JSON.stringify(['analytics.view']), 'unknown keys are ignored', me.json.data.permissions);
  });

  it('locks out blocked and deleted staff at once', async () => {
    await envHandle.sequelize.query(
      `UPDATE admins SET status = 'disabled', disabled_at = NOW(), disabled_reason = 'On leave', disabled_by_admin_id = :superAdminId WHERE id = :staffId`,
      { replacements: { staffId, superAdminId } },
    );
    const blocked = await call('GET', '/admin/auth/me', asStaff());
    check(blocked.status === 403 && blocked.json.code === 'ACCOUNT_DISABLED', 'a blocked staff member is refused', blocked.json);
    check((await signIn(STAFF.email, STAFF.password)).json.code === 'ACCOUNT_DISABLED', 'and cannot sign in');

    await envHandle.sequelize.query(
      `UPDATE admins SET status = 'active', disabled_at = NULL, disabled_reason = NULL, disabled_by_admin_id = NULL WHERE id = :staffId`,
      { replacements: { staffId } },
    );
    check((await call('GET', '/admin/auth/me', asStaff())).status === 200, 'unblocking restores access');

    await envHandle.sequelize.query(
      `UPDATE admins SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :superAdminId WHERE id = :staffId`,
      { replacements: { staffId, superAdminId } },
    );
    const deleted = await call('GET', '/admin/auth/me', asStaff());
    check(deleted.status === 401 && deleted.json.code === 'ACCESS_TOKEN_INVALID', 'a deleted staff member is signed out', deleted.json);
    const login = await signIn(STAFF.email, STAFF.password);
    check(login.status === 401 && login.json.code === 'INVALID_CREDENTIALS', 'a deleted account answers like an unknown email', login.json);
    const refresh = await call('POST', '/admin/auth/refresh', {
      cookies: staffCookies,
      headers: { origin: TEST_ORIGIN, 'x-csrf-token': staffCsrf },
    });
    check(refresh.status >= 400, 'and cannot refresh its session', refresh.json);

    const kept = await rows<{ email: string }>('SELECT email FROM admins WHERE id = :staffId', { staffId });
    check(kept[0]?.email === STAFF.email, 'the row is kept (soft delete)');

    const { hashPassword } = await import('../../src/common/utils/password.js');
    const reused = await rows<{ id: string }>(
      `INSERT INTO admins (full_name, email, password_hash, created_by_admin_id)
       VALUES ('Staff One Again', :email, :hash, :superAdminId) RETURNING id`,
      { email: STAFF.email, hash: await hashPassword(STAFF.password), superAdminId },
    );
    check(reused.length === 1 && reused[0]?.id !== staffId, 'the email of a deleted account can be used again');
    const freshLogin = await signIn(STAFF.email, STAFF.password);
    check(freshLogin.status === 200 && freshLogin.json.data.admin.id === reused[0]?.id, 'sign-in reaches the new account, not the deleted one', freshLogin.json);
  });

  it('enforces the structural rules in the database itself', async () => {
    await refusedByDatabase(
      `UPDATE admins SET is_deleted = TRUE, deleted_at = NOW() WHERE id = :superAdminId`,
      { superAdminId },
      'admins_seeded_never_deleted_check',
      'the seeded super admin cannot be deleted',
    );
    await refusedByDatabase(
      `INSERT INTO admins (full_name, email, password_hash) VALUES ('Orphan', 'orphan@example.test', 'x')`,
      {},
      'admins_creator_check',
      'ordinary staff must have a creator',
    );
    await refusedByDatabase(
      `INSERT INTO admins (full_name, email, password_hash, created_by_admin_id) VALUES ('Dup', :email, 'x', :superAdminId)`,
      { email: STAFF.email, superAdminId },
      'admins_email_unique',
      'two live accounts cannot share an email',
    );
    await refusedByDatabase(
      `INSERT INTO admin_roles (name, created_by_admin_id) VALUES ('any custom NAME', :superAdminId)`,
      { superAdminId },
      'admin_roles_owner_name_unique',
      'one owner cannot have two live roles with the same name',
    );
    await refusedByDatabase(
      `INSERT INTO admin_role_permissions (role_id, permission_key, granted_by_admin_id) VALUES (:roleId, 'analytics.view', :superAdminId)`,
      { roleId, superAdminId },
      'admin_role_permissions_live_unique',
      'a permission cannot be ticked twice on a role',
    );
    await refusedByDatabase(
      `INSERT INTO admin_role_permissions (role_id, permission_key, granted_by_admin_id) VALUES (:roleId, 'not.defined', :superAdminId)`,
      { roleId, superAdminId },
      'admin_role_permissions_permission_key_fkey',
      'a role cannot hold a permission that does not exist',
    );
    await refusedByDatabase(
      `UPDATE admin_roles SET is_deleted = TRUE WHERE id = :roleId`,
      { roleId },
      'admin_roles_deleted_consistency_check',
      'a deletion must record when it happened',
    );
    await refusedByDatabase(
      `DELETE FROM permissions WHERE key = 'analytics.view'`,
      {},
      'admin_role_permissions_permission_key_fkey',
      'a permission in use cannot be removed',
    );
  });
});
