import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { Admin } from '../../models/index.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { getEffectivePermissions } from './access.service.js';
import { PERMISSION_CATALOG, type PermissionKey } from './permissionCatalog.js';

/**
 * The staff hierarchy and the rules that hold it together.
 *
 *  - Every staff member has one parent: the admin who created them.
 *  - A role is owned by its creator and may only contain permissions the
 *    owner holds (the subset rule).
 *  - When an admin loses a permission, it is taken out of every role they
 *    created, and so on down the tree (the cascade).
 *
 * Every change to staff, roles or assignments runs inside one transaction
 * that first takes `lockStaffTree`, so two people editing the tree at the same
 * moment can never leave a role holding more than its owner.
 */

/** The signed-in admin performing an action. */
export interface Actor {
  adminId: string;
  isSuperAdmin: boolean;
  permissions: ReadonlySet<PermissionKey>;
}

/** Any fixed number; distinct from the catalog sync lock. */
const STAFF_TREE_LOCK_ID = 7_403_118_002;

/** Serialise every change to the staff tree. Released when the transaction ends. */
export async function lockStaffTree(transaction: Transaction): Promise<void> {
  await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
    replacements: { lockId: STAFF_TREE_LOCK_ID },
    transaction,
  });
}

class PreviewRollback extends Error {
  constructor(readonly value: unknown) {
    super('preview: rolling back');
  }
}

/**
 * Run a change to the staff tree, or only preview it.
 *
 * A preview executes exactly the same code inside a transaction and then
 * rolls it back, so the "this will affect ..." shown before a destructive
 * action can never disagree with what the action really does. Nothing
 * survives a preview, audit entries included.
 */
export async function runOrPreview<T>(preview: boolean, work: (transaction: Transaction) => Promise<T>): Promise<T> {
  if (!preview) return sequelize.transaction(work);
  try {
    await sequelize.transaction(async (transaction) => {
      throw new PreviewRollback(await work(transaction));
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.value as T;
    throw error;
  }
  throw new Error('A preview transaction must roll back');
}

/** Ids of every live staff member below `adminId` (not including `adminId`). */
export async function getDescendantIds(adminId: string, transaction?: Transaction): Promise<string[]> {
  const rows = await sequelize.query<{ id: string }>(
    `WITH RECURSIVE branch AS (
       SELECT id FROM admins WHERE created_by_admin_id = :adminId AND is_deleted = FALSE
       UNION ALL
       SELECT a.id FROM admins a JOIN branch b ON a.created_by_admin_id = b.id WHERE a.is_deleted = FALSE
     )
     SELECT id FROM branch`,
    { type: QueryTypes.SELECT, replacements: { adminId }, ...(transaction ? { transaction } : {}) },
  );
  return rows.map((row) => row.id);
}

/**
 * Whose staff and roles the actor may see: `null` means everyone (a super
 * admin); otherwise the ids of the actor's own branch.
 */
export async function getVisibleAdminIds(
  actor: Actor,
  options: { includeSelf: boolean },
  transaction?: Transaction,
): Promise<string[] | null> {
  if (actor.isSuperAdmin) return null;
  const descendants = await getDescendantIds(actor.adminId, transaction);
  return options.includeSelf ? [actor.adminId, ...descendants] : descendants;
}

/**
 * Load a live staff member the actor is allowed to see. Anything outside the
 * actor's branch answers "not found", so its existence is never revealed.
 */
export async function findVisibleStaff(actor: Actor, staffId: string, transaction?: Transaction): Promise<Admin> {
  const staff = await Admin.findOne({
    where: { id: staffId, isDeleted: false },
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!staff) throw AppError.notFound('Staff member not found');
  if (!actor.isSuperAdmin) {
    const visible = await getDescendantIds(actor.adminId, transaction);
    if (!visible.includes(staff.id)) throw AppError.notFound('Staff member not found');
  }
  return staff;
}

/** Why the actor may not change `staff`, or null when they may. */
export function manageRefusal(actor: Actor, staff: Admin): AppError | null {
  if (staff.id === actor.adminId) {
    return AppError.forbidden('You cannot do this to your own account', ErrorCode.CANNOT_MODIFY_SELF);
  }
  // No creator marks the seeded super admin, which nobody else may change.
  if (staff.createdByAdminId === null) {
    return AppError.forbidden('This account is protected and cannot be changed', ErrorCode.PROTECTED_ACCOUNT);
  }
  if (!actor.isSuperAdmin && staff.createdByAdminId !== actor.adminId) {
    return AppError.forbidden(
      'Only the admin who created this staff member can change them',
      ErrorCode.MANAGED_BY_ANOTHER_ADMIN,
    );
  }
  return null;
}

/** True when the actor may change `staff` (their creator, or a super admin). */
export function canManageStaff(actor: Actor, staff: Admin): boolean {
  return manageRefusal(actor, staff) === null;
}

/** Load a staff member the actor may change, or throw the reason they may not. */
export async function findManageableStaff(actor: Actor, staffId: string, transaction: Transaction): Promise<Admin> {
  const staff = await findVisibleStaff(actor, staffId, transaction);
  const refusal = manageRefusal(actor, staff);
  if (refusal) throw refusal;
  return staff;
}

const REQUIRES = new Map<string, readonly PermissionKey[]>(
  PERMISSION_CATALOG.map((definition) => [definition.key, definition.requires]),
);

/**
 * Check a set of permissions chosen for a role:
 *  - every permission it depends on is selected too, and
 *  - every one is held by the role's owner.
 * Both problems are reported per permission so the form can point at them.
 */
export function assertGrantable(selected: readonly PermissionKey[], ownerPermissions: ReadonlySet<PermissionKey>): void {
  const chosen = new Set(selected);

  const missing = selected.flatMap((key) =>
    (REQUIRES.get(key) ?? [])
      .filter((required) => !chosen.has(required))
      .map((required) => ({ path: 'permissions', message: `"${key}" also needs "${required}"`, permission: key, requires: required })),
  );
  if (missing.length > 0) {
    throw AppError.unprocessable(
      'Some permissions need another permission to be selected with them',
      ErrorCode.PERMISSION_DEPENDENCY_MISSING,
      missing,
    );
  }

  const notHeld = selected.filter((key) => !ownerPermissions.has(key));
  if (notHeld.length > 0) {
    throw new AppError(
      403,
      ErrorCode.PERMISSION_NOT_GRANTABLE,
      'A role can only contain permissions its owner holds',
      notHeld.map((key) => ({ path: 'permissions', message: `"${key}" is not held by the owner of this role`, permission: key })),
    );
  }
}

export interface CascadeResult {
  /** Roles that lost at least one permission. */
  roles: { id: string; name: string; ownerId: string; revoked: string[] }[];
  /** Staff whose access shrank as a result. */
  affectedAdminIds: string[];
}

/**
 * Restore the subset rule below `startAdminIds` after their permissions may
 * have shrunk: every role they created loses whatever they no longer hold,
 * then the same is done for everyone holding those roles, all the way down.
 *
 * Must run inside the caller's transaction, after `lockStaffTree`. Rows are
 * marked deleted, never removed, and every stripped role gets its own audit
 * entry pointing at the action that caused it.
 */
export async function cascadeRevoke(
  startAdminIds: readonly string[],
  cause: { actorId: string; action: AuditAction; entityType: string; entityId: string },
  context: RequestContext,
  transaction: Transaction,
): Promise<CascadeResult> {
  const result: CascadeResult = { roles: [], affectedAdminIds: [] };
  const queue = [...new Set(startAdminIds)];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const adminId = queue.shift() as string;
    if (seen.has(adminId)) continue;
    seen.add(adminId);

    const admin = await Admin.findByPk(adminId, { attributes: ['id', 'isSuperAdmin', 'isDeleted'], transaction });
    // A super admin holds everything, so nothing they created can exceed them.
    if (!admin || admin.isDeleted || admin.isSuperAdmin) continue;

    const held = await getEffectivePermissions(adminId, false, transaction);

    const owned = await sequelize.query<{ id: string; name: string; permission_key: string }>(
      `SELECT r.id, r.name, rp.permission_key
         FROM admin_roles r
         JOIN admin_role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = FALSE
        WHERE r.created_by_admin_id = :adminId
          AND r.is_deleted = FALSE`,
      { type: QueryTypes.SELECT, replacements: { adminId }, transaction },
    );

    const excessByRole = new Map<string, { name: string; revoked: string[] }>();
    for (const row of owned) {
      if (held.has(row.permission_key as PermissionKey)) continue;
      const entry = excessByRole.get(row.id) ?? { name: row.name, revoked: [] };
      entry.revoked.push(row.permission_key);
      excessByRole.set(row.id, entry);
    }

    for (const [roleId, { name, revoked }] of excessByRole) {
      revoked.sort();
      await sequelize.query(
        `UPDATE admin_role_permissions
            SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
          WHERE role_id = :roleId
            AND permission_key IN (:revoked)
            AND is_deleted = FALSE`,
        { replacements: { roleId, revoked, actorId: cause.actorId }, transaction },
      );

      await recordAudit(
        {
          actor: { type: 'admin', id: cause.actorId },
          action: AuditAction.ROLE_PERMISSIONS_CASCADE_REVOKED,
          entityType: 'admin_role',
          entityId: roleId,
          severity: 'warning',
          before: { permissions: revoked },
          metadata: {
            roleName: name,
            ownerId: adminId,
            reason: 'The owner of this role no longer holds these permissions',
            causedBy: { action: cause.action, entityType: cause.entityType, entityId: cause.entityId },
          },
          context,
        },
        transaction,
      );
      result.roles.push({ id: roleId, name, ownerId: adminId, revoked });

      const holders = await sequelize.query<{ admin_id: string }>(
        `SELECT admin_id FROM admin_role_assignments WHERE role_id = :roleId AND is_deleted = FALSE`,
        { type: QueryTypes.SELECT, replacements: { roleId }, transaction },
      );
      for (const holder of holders) {
        if (!result.affectedAdminIds.includes(holder.admin_id)) result.affectedAdminIds.push(holder.admin_id);
        queue.push(holder.admin_id);
      }
    }
  }
  return result;
}

/** Live roles held by each of the given staff, keyed by admin id. */
export async function getRolesHeldBy(
  adminIds: readonly string[],
  transaction?: Transaction,
): Promise<Map<string, { id: string; name: string }[]>> {
  const held = new Map<string, { id: string; name: string }[]>();
  if (adminIds.length === 0) return held;

  const rows = await sequelize.query<{ admin_id: string; id: string; name: string }>(
    `SELECT ara.admin_id, r.id, r.name
       FROM admin_role_assignments ara
       JOIN admin_roles r ON r.id = ara.role_id AND r.is_deleted = FALSE
      WHERE ara.admin_id IN (:adminIds)
        AND ara.is_deleted = FALSE
      ORDER BY LOWER(r.name), r.id`,
    { type: QueryTypes.SELECT, replacements: { adminIds: [...adminIds] }, ...(transaction ? { transaction } : {}) },
  );
  for (const row of rows) {
    const list = held.get(row.admin_id) ?? [];
    list.push({ id: row.id, name: row.name });
    held.set(row.admin_id, list);
  }
  return held;
}
