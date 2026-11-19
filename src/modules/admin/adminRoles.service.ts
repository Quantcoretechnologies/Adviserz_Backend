import { QueryTypes, UniqueConstraintError, type Transaction } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { toPagination } from '../../common/utils/validation.js';
import { Admin, AdminRole, AdminRolePermission } from '../../models/index.js';
import { getEffectivePermissions } from '../access/access.service.js';
import { isPermissionKey, type PermissionKey } from '../access/permissionCatalog.js';
import {
  assertGrantable,
  cascadeRevoke,
  getVisibleAdminIds,
  lockStaffTree,
  runOrPreview,
  type Actor,
  type CascadeResult,
} from '../access/staffTree.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  created_by_admin_id: string;
  owner_name: string;
  owner_is_deleted: boolean;
  permission_keys: string[];
  holder_count: number;
  created_at: Date;
  updated_at: Date;
}

const ROLE_SELECT = `
  SELECT r.id, r.name, r.description, r.created_by_admin_id, r.created_at, r.updated_at,
         o.full_name AS owner_name, o.is_deleted AS owner_is_deleted,
         COALESCE((SELECT ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key)
                     FROM admin_role_permissions rp
                    WHERE rp.role_id = r.id AND rp.is_deleted = FALSE), ARRAY[]::VARCHAR[]) AS permission_keys,
         CAST((SELECT COUNT(*)
                 FROM admin_role_assignments ara
                 JOIN admins h ON h.id = ara.admin_id AND h.is_deleted = FALSE
                WHERE ara.role_id = r.id AND ara.is_deleted = FALSE) AS INTEGER) AS holder_count
    FROM admin_roles r
    JOIN admins o ON o.id = r.created_by_admin_id`;

function serializeRole(row: RoleRow, actor: Actor) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: { id: row.created_by_admin_id, fullName: row.owner_name },
    // Retired or unknown keys stored on a role grant nothing, so they are not shown.
    permissions: row.permission_keys.filter(isPermissionKey),
    holderCount: row.holder_count,
    /** Only the creator of a role, or a super admin, may change it. */
    canManage: actor.isSuperAdmin || row.created_by_admin_id === actor.adminId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Escape LIKE wildcards so search input is matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

async function loadRole(roleId: string, transaction?: Transaction): Promise<RoleRow | null> {
  const [row] = await sequelize.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = :roleId AND r.is_deleted = FALSE`, {
    type: QueryTypes.SELECT,
    replacements: { roleId },
    ...(transaction ? { transaction } : {}),
  });
  return row ?? null;
}

/** A live role the actor may see: their own, or one created inside their branch. */
async function findVisibleRole(actor: Actor, roleId: string, transaction?: Transaction): Promise<RoleRow> {
  const role = await loadRole(roleId, transaction);
  if (!role) throw AppError.notFound('Role not found');
  const visibleOwners = await getVisibleAdminIds(actor, { includeSelf: true }, transaction);
  if (visibleOwners && !visibleOwners.includes(role.created_by_admin_id)) throw AppError.notFound('Role not found');
  return role;
}

export async function listRoles(
  actor: Actor,
  query: { page: number; pageSize: number; search?: string | undefined; ownerId?: string | undefined; mine: boolean },
) {
  const visibleOwners = query.mine ? [actor.adminId] : await getVisibleAdminIds(actor, { includeSelf: true });
  const owners = query.ownerId
    ? visibleOwners === null || visibleOwners.includes(query.ownerId)
      ? [query.ownerId]
      : []
    : visibleOwners;

  if (owners !== null && owners.length === 0) {
    return { items: [], pagination: toPagination(query.page, query.pageSize, 0) };
  }

  const where = `
    WHERE r.is_deleted = FALSE
      ${owners === null ? '' : 'AND r.created_by_admin_id IN (:owners)'}
      ${query.search ? 'AND r.name ILIKE :search' : ''}`;
  const replacements = {
    ...(owners === null ? {} : { owners }),
    ...(query.search ? { search: likePattern(query.search) } : {}),
  };

  const [total] = await sequelize.query<{ total: number }>(
    `SELECT CAST(COUNT(*) AS INTEGER) AS total FROM admin_roles r ${where}`,
    { type: QueryTypes.SELECT, replacements },
  );
  const rows = await sequelize.query<RoleRow>(
    `${ROLE_SELECT} ${where} ORDER BY r.created_at DESC, r.id LIMIT :limit OFFSET :offset`,
    {
      type: QueryTypes.SELECT,
      replacements: { ...replacements, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
    },
  );

  return {
    items: rows.map((row) => serializeRole(row, actor)),
    pagination: toPagination(query.page, query.pageSize, total?.total ?? 0),
  };
}

export async function getRole(actor: Actor, roleId: string, transaction?: Transaction) {
  const role = await findVisibleRole(actor, roleId, transaction);
  const holders = await sequelize.query<{ id: string; full_name: string; email: string; status: string }>(
    `SELECT a.id, a.full_name, a.email, a.status
       FROM admin_role_assignments ara
       JOIN admins a ON a.id = ara.admin_id AND a.is_deleted = FALSE
      WHERE ara.role_id = :roleId AND ara.is_deleted = FALSE
      ORDER BY LOWER(a.full_name), a.id`,
    { type: QueryTypes.SELECT, replacements: { roleId }, ...(transaction ? { transaction } : {}) },
  );
  // A role can only hold what its owner holds (see applyRoleUpdate), so the
  // edit form needs the owner's permissions to show which ones can be added.
  const owner = await Admin.findByPk(role.created_by_admin_id, {
    attributes: ['id', 'isSuperAdmin'],
    ...(transaction ? { transaction } : {}),
  });
  const ownerHolds = await getEffectivePermissions(role.created_by_admin_id, owner?.isSuperAdmin ?? false, transaction);
  return {
    ...serializeRole(role, actor),
    holders: holders.map((row) => ({ id: row.id, fullName: row.full_name, email: row.email, status: row.status })),
    ownerPermissions: [...ownerHolds].sort(),
  };
}

function nameTaken(): AppError {
  return AppError.conflict('You already have a role with this name', ErrorCode.ROLE_NAME_TAKEN, [
    { path: 'name', message: 'You already have a role with this name' },
  ]);
}

async function assertNameFree(ownerId: string, name: string, exceptRoleId: string | null, transaction: Transaction) {
  const [clash] = await sequelize.query<{ id: string }>(
    `SELECT id FROM admin_roles
      WHERE created_by_admin_id = :ownerId AND LOWER(name) = LOWER(:name) AND is_deleted = FALSE
        AND (CAST(:exceptRoleId AS UUID) IS NULL OR id <> CAST(:exceptRoleId AS UUID))
      LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { ownerId, name, exceptRoleId }, transaction },
  );
  if (clash) throw nameTaken();
}

/**
 * Create a role owned by the actor. It may only contain permissions the actor
 * holds right now (re-read inside the transaction, not taken from the request).
 */
export async function createRole(
  actor: Actor,
  input: { name: string; description?: string | null | undefined; permissions: PermissionKey[] },
  context: RequestContext,
) {
  const roleId = await sequelize.transaction(async (transaction) => {
    await lockStaffTree(transaction);

    const held = await getEffectivePermissions(actor.adminId, actor.isSuperAdmin, transaction);
    assertGrantable(input.permissions, held);
    await assertNameFree(actor.adminId, input.name, null, transaction);

    let role: AdminRole;
    try {
      role = await AdminRole.create(
        { name: input.name, description: input.description ?? null, createdByAdminId: actor.adminId },
        { transaction },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw nameTaken();
      throw error;
    }

    await AdminRolePermission.bulkCreate(
      input.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey, grantedByAdminId: actor.adminId })),
      { transaction },
    );

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.ROLE_CREATED,
        entityType: 'admin_role',
        entityId: role.id,
        after: { name: role.name, description: role.description, permissions: [...input.permissions].sort() },
        context,
      },
      transaction,
    );
    return role.id;
  });

  return getRole(actor, roleId);
}

/**
 * Rename a role or change its permissions. Only its creator or a super admin
 * may do so, and even a super admin cannot give a role more than its owner
 * holds. Removing a permission also removes it from every role created by the
 * staff holding this one, all the way down.
 */
export async function updateRole(
  actor: Actor,
  roleId: string,
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    permissions?: PermissionKey[] | undefined;
  },
  context: RequestContext,
  options: { preview: boolean } = { preview: false },
): Promise<{ preview: boolean; role: Awaited<ReturnType<typeof getRole>>; cascade: CascadeResult }> {
  // The role is read back inside the transaction, so a preview returns it as
  // it would be after the change (the same as the staff-roles preview does).
  return runOrPreview(options.preview, async (transaction) => {
    const cascade = await applyRoleUpdate(actor, roleId, input, context, transaction);
    return { preview: options.preview, role: await getRole(actor, roleId, transaction), cascade };
  });
}

async function applyRoleUpdate(
  actor: Actor,
  roleId: string,
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    permissions?: PermissionKey[] | undefined;
  },
  context: RequestContext,
  transaction: Transaction,
): Promise<CascadeResult> {
  await lockStaffTree(transaction);

  const role = await findVisibleRole(actor, roleId, transaction);
  if (!actor.isSuperAdmin && role.created_by_admin_id !== actor.adminId) {
    throw AppError.forbidden('Only the admin who created this role can change it', ErrorCode.MANAGED_BY_ANOTHER_ADMIN);
  }

  const before = {
    name: role.name,
    description: role.description,
    permissions: role.permission_keys.filter(isPermissionKey),
  };
  const nextName = input.name ?? role.name;
  const nextDescription = input.description === undefined ? role.description : input.description;
  const nextPermissions = input.permissions ?? before.permissions;

  const current = new Set<string>(role.permission_keys);
  const wanted = new Set<string>(nextPermissions);
  const added = nextPermissions.filter((key) => !current.has(key));
  // Includes stored keys the catalog no longer defines, so they are cleaned up.
  const removed = input.permissions ? role.permission_keys.filter((key) => !wanted.has(key)) : [];

  if (input.permissions) {
    const owner = await Admin.findByPk(role.created_by_admin_id, { attributes: ['id', 'isSuperAdmin'], transaction });
    const ownerHolds = await getEffectivePermissions(role.created_by_admin_id, owner?.isSuperAdmin ?? false, transaction);
    assertGrantable(nextPermissions, ownerHolds);
  }

  if (nextName.toLowerCase() !== role.name.toLowerCase()) {
    await assertNameFree(role.created_by_admin_id, nextName, role.id, transaction);
  }

  const changed =
    nextName !== role.name || nextDescription !== role.description || added.length > 0 || removed.length > 0;
  if (!changed) return { roles: [], affectedAdminIds: [] } satisfies CascadeResult;

  try {
    await AdminRole.update(
      { name: nextName, description: nextDescription },
      { where: { id: role.id }, transaction },
    );
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw nameTaken();
    throw error;
  }

  if (removed.length > 0) {
    await sequelize.query(
      `UPDATE admin_role_permissions
          SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
        WHERE role_id = :roleId AND permission_key IN (:removed) AND is_deleted = FALSE`,
      { replacements: { roleId: role.id, removed, actorId: actor.adminId }, transaction },
    );
  }
  if (added.length > 0) {
    await AdminRolePermission.bulkCreate(
      added.map((permissionKey) => ({ roleId: role.id, permissionKey, grantedByAdminId: actor.adminId })),
      { transaction },
    );
  }

  // Everyone holding this role may now hold less: restore the subset rule below them.
  let result: CascadeResult = { roles: [], affectedAdminIds: [] };
  if (removed.length > 0) {
    const holders = await sequelize.query<{ admin_id: string }>(
      `SELECT admin_id FROM admin_role_assignments WHERE role_id = :roleId AND is_deleted = FALSE`,
      { type: QueryTypes.SELECT, replacements: { roleId: role.id }, transaction },
    );
    result = await cascadeRevoke(
      holders.map((holder) => holder.admin_id),
      { actorId: actor.adminId, action: AuditAction.ROLE_UPDATED, entityType: 'admin_role', entityId: role.id },
      context,
      transaction,
    );
  }

  await recordAudit(
    {
      actor: { type: 'admin', id: actor.adminId },
      action: AuditAction.ROLE_UPDATED,
      entityType: 'admin_role',
      entityId: role.id,
      severity: removed.length > 0 ? 'warning' : 'info',
      before,
      after: { name: nextName, description: nextDescription, permissions: [...nextPermissions].sort() },
      metadata: {
        ownerId: role.created_by_admin_id,
        added: [...added].sort(),
        removed: [...removed].sort(),
        cascade: { roles: result.roles.length, staff: result.affectedAdminIds.length },
      },
      context,
    },
    transaction,
  );
  return result;
}

/**
 * Delete a role (soft delete). Everyone holding it loses it, and whatever
 * they had handed down from it is stripped from the roles below. The staff
 * themselves are not deleted. With `preview`, nothing changes and the result
 * says what would happen.
 */
export async function deleteRole(actor: Actor, roleId: string, context: RequestContext, options: { preview: boolean }) {
  return runOrPreview(options.preview, async (transaction) => {
    await lockStaffTree(transaction);

    const role = await findVisibleRole(actor, roleId, transaction);
    if (!actor.isSuperAdmin && role.created_by_admin_id !== actor.adminId) {
      throw AppError.forbidden('Only the admin who created this role can delete it', ErrorCode.MANAGED_BY_ANOTHER_ADMIN);
    }

    const holders = await sequelize.query<{ id: string; full_name: string; email: string }>(
      `SELECT a.id, a.full_name, a.email
         FROM admin_role_assignments ara
         JOIN admins a ON a.id = ara.admin_id AND a.is_deleted = FALSE
        WHERE ara.role_id = :roleId AND ara.is_deleted = FALSE
        ORDER BY LOWER(a.full_name), a.id`,
      { type: QueryTypes.SELECT, replacements: { roleId: role.id }, transaction },
    );

    await sequelize.query(
      `UPDATE admin_roles
          SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
        WHERE id = :roleId`,
      { replacements: { roleId: role.id, actorId: actor.adminId }, transaction },
    );
    await sequelize.query(
      `UPDATE admin_role_assignments
          SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
        WHERE role_id = :roleId AND is_deleted = FALSE`,
      { replacements: { roleId: role.id, actorId: actor.adminId }, transaction },
    );

    const cascade = await cascadeRevoke(
      holders.map((holder) => holder.id),
      { actorId: actor.adminId, action: AuditAction.ROLE_DELETED, entityType: 'admin_role', entityId: role.id },
      context,
      transaction,
    );

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.ROLE_DELETED,
        entityType: 'admin_role',
        entityId: role.id,
        severity: 'critical',
        before: {
          name: role.name,
          description: role.description,
          permissions: role.permission_keys,
          holders: holders.map((holder) => holder.id),
        },
        metadata: {
          ownerId: role.created_by_admin_id,
          cascade: { roles: cascade.roles.length, staff: cascade.affectedAdminIds.length },
        },
        context,
      },
      transaction,
    );

    return {
      preview: options.preview,
      role: { id: role.id, name: role.name },
      /** Staff who lose this role. They keep their accounts and any other roles. */
      holders: holders.map((holder) => ({ id: holder.id, fullName: holder.full_name, email: holder.email })),
      cascade,
    };
  });
}
