import { Op, UniqueConstraintError, type Transaction, type WhereOptions } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../common/errors/AppError.js';
import { ErrorCode } from '../../common/errors/errorCodes.js';
import type { RequestContext } from '../../common/http/requestContext.js';
import { generateTemporaryPassword } from '../../common/utils/crypto.js';
import { hashPassword } from '../../common/utils/password.js';
import { toPagination } from '../../common/utils/validation.js';
import { Admin, AdminRole, AdminRoleAssignment } from '../../models/index.js';
import type { AdminStatus } from '../../models/enums.js';
import { getEffectivePermissions } from '../access/access.service.js';
import {
  canManageStaff,
  cascadeRevoke,
  findManageableStaff,
  findVisibleStaff,
  getRolesHeldBy,
  getVisibleAdminIds,
  getDescendantIds,
  lockStaffTree,
  runOrPreview,
  type Actor,
  type CascadeResult,
} from '../access/staffTree.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import { passwordAvoidsIdentity } from '../auth/auth.schemas.js';
import { revokeAllAdminSessions, revokeSessionsOfAdmins } from '../auth/session.service.js';

type RoleSummary = { id: string; name: string };

function serializeStaff(staff: Admin, roles: RoleSummary[], actor: Actor, creatorName?: string | null) {
  return {
    id: staff.id,
    fullName: staff.fullName,
    email: staff.email,
    isSuperAdmin: staff.isSuperAdmin,
    status: staff.status,
    blockedAt: staff.disabledAt,
    blockedReason: staff.disabledReason,
    /** Still on the generated password; must change it before doing anything else. */
    mustChangePassword: staff.mustChangePassword,
    lastLoginAt: staff.lastLoginAt,
    /** The admin who created this account: the one person they report to. */
    createdBy: staff.createdByAdminId ? { id: staff.createdByAdminId, fullName: creatorName ?? null } : null,
    roles,
    /** Whether the signed-in admin may change this account. */
    canManage: canManageStaff(actor, staff),
    createdAt: staff.createdAt,
    updatedAt: staff.updatedAt,
  };
}

async function creatorNames(staff: readonly Admin[], transaction?: Transaction): Promise<Map<string, string>> {
  const ids = [...new Set(staff.map((row) => row.createdByAdminId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const creators = await Admin.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['id', 'fullName'],
    ...(transaction ? { transaction } : {}),
  });
  return new Map(creators.map((creator) => [creator.id, creator.fullName]));
}

async function describe(staff: Admin, actor: Actor, transaction?: Transaction) {
  const [roles, names] = await Promise.all([getRolesHeldBy([staff.id], transaction), creatorNames([staff], transaction)]);
  return serializeStaff(
    staff,
    roles.get(staff.id) ?? [],
    actor,
    staff.createdByAdminId ? names.get(staff.createdByAdminId) : null,
  );
}

/** Escape LIKE wildcards so search input is matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const emailTaken = (): AppError =>
  AppError.conflict('A staff account with this email already exists', ErrorCode.EMAIL_ALREADY_REGISTERED, [
    { path: 'email', message: 'A staff account with this email already exists' },
  ]);

async function assertEmailFree(email: string, exceptAdminId: string | null, transaction: Transaction): Promise<void> {
  const clash = await Admin.findOne({
    where: { email, isDeleted: false, ...(exceptAdminId ? { id: { [Op.ne]: exceptAdminId } } : {}) },
    attributes: ['id'],
    transaction,
  });
  if (clash) throw emailTaken();
}

/** A fresh temporary password that does not happen to contain the email name. */
function newTemporaryPassword(email: string): string {
  for (;;) {
    const candidate = generateTemporaryPassword();
    if (passwordAvoidsIdentity(candidate, { email })) return candidate;
  }
}

/**
 * Roles that may be given to a staff member whose parent is `parentId`: live
 * roles created by that same parent. Anything else is refused.
 */
async function loadAssignableRoles(
  roleIds: readonly string[],
  parentId: string,
  transaction: Transaction,
): Promise<AdminRole[]> {
  if (roleIds.length === 0) return [];
  const roles = await AdminRole.findAll({ where: { id: { [Op.in]: [...roleIds] }, isDeleted: false }, transaction });
  const byId = new Map(roles.map((role) => [role.id, role]));

  const refused = roleIds
    .filter((id) => byId.get(id)?.createdByAdminId !== parentId)
    .map((id) => ({
      path: 'roleIds',
      message: byId.has(id)
        ? 'This role was created by someone else. A role can only be given by its creator to staff they created'
        : 'Role not found',
      roleId: id,
    }));
  if (refused.length > 0) {
    throw AppError.unprocessable('Some roles cannot be given to this staff member', ErrorCode.ROLE_NOT_ASSIGNABLE, refused);
  }
  return roleIds.map((id) => byId.get(id) as AdminRole);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Staff the actor can see: everyone for a super admin, otherwise their own branch. */
export async function listStaff(
  actor: Actor,
  query: {
    page: number;
    pageSize: number;
    search?: string | undefined;
    status?: AdminStatus | undefined;
    createdBy?: string | undefined;
    sortOrder: 'asc' | 'desc';
  },
) {
  const visible = await getVisibleAdminIds(actor, { includeSelf: false });
  if (visible !== null && visible.length === 0) {
    return { items: [], pagination: toPagination(query.page, query.pageSize, 0) };
  }

  const where: WhereOptions<Admin> = {
    isDeleted: false,
    ...(visible === null ? {} : { id: { [Op.in]: visible } }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.createdBy ? { createdByAdminId: query.createdBy } : {}),
    ...(query.search
      ? {
          [Op.or]: [
            { fullName: { [Op.iLike]: likePattern(query.search) } },
            { email: { [Op.iLike]: likePattern(query.search) } },
          ],
        }
      : {}),
  };

  const { rows, count } = await Admin.findAndCountAll({
    where,
    order: [
      ['createdAt', query.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  const [roles, names] = await Promise.all([getRolesHeldBy(rows.map((row) => row.id)), creatorNames(rows)]);
  return {
    items: rows.map((row) =>
      serializeStaff(row, roles.get(row.id) ?? [], actor, row.createdByAdminId ? names.get(row.createdByAdminId) : null),
    ),
    pagination: toPagination(query.page, query.pageSize, count),
  };
}

/**
 * The hierarchy as a flat list of nodes with their parent, ready to be drawn
 * as a tree. A super admin gets the whole organisation; anyone else gets
 * themselves as the root with their branch below.
 */
export async function getStaffTree(actor: Actor) {
  const visible = await getVisibleAdminIds(actor, { includeSelf: true });
  const staff = await Admin.findAll({
    where: { isDeleted: false, ...(visible === null ? {} : { id: { [Op.in]: visible } }) },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  const roles = await getRolesHeldBy(staff.map((row) => row.id));
  const present = new Set(staff.map((row) => row.id));

  const nodes = staff.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    isSuperAdmin: row.isSuperAdmin,
    status: row.status,
    // A parent outside what the actor can see is not exposed: the node becomes a root.
    parentId: row.createdByAdminId && present.has(row.createdByAdminId) ? row.createdByAdminId : null,
    roles: roles.get(row.id) ?? [],
    isSelf: row.id === actor.adminId,
    canManage: canManageStaff(actor, row),
  }));

  return { rootIds: nodes.filter((node) => node.parentId === null).map((node) => node.id), nodes };
}

export async function getStaff(actor: Actor, staffId: string) {
  const staff = await findVisibleStaff(actor, staffId);
  const [summary, permissions, directReports, rolesCreated] = await Promise.all([
    describe(staff, actor),
    getEffectivePermissions(staff.id, staff.isSuperAdmin),
    Admin.count({ where: { createdByAdminId: staff.id, isDeleted: false } }),
    AdminRole.count({ where: { createdByAdminId: staff.id, isDeleted: false } }),
  ]);
  return {
    staff: summary,
    /** Everything this staff member may do right now (all roles added together). */
    permissions: [...permissions].sort(),
    directReports,
    rolesCreated,
  };
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/**
 * Create a staff account under the actor. The password is generated here and
 * returned exactly once; only its hash is stored. The new staff member must
 * change it at first sign-in.
 */
export async function createStaff(
  actor: Actor,
  input: { fullName: string; email: string; roleIds: string[]; isSuperAdmin: boolean },
  context: RequestContext,
) {
  if (input.isSuperAdmin && !actor.isSuperAdmin) {
    throw AppError.forbidden('Only a super admin can create another super admin');
  }
  if (input.isSuperAdmin && input.roleIds.length > 0) {
    throw AppError.unprocessable('A super admin already holds every permission and cannot be given roles', ErrorCode.VALIDATION_ERROR, [
      { path: 'roleIds', message: 'A super admin cannot be given roles' },
    ]);
  }
  if (input.roleIds.length > 0 && !actor.permissions.has('roles.assign')) {
    throw AppError.forbidden('You do not have permission to assign roles');
  }

  const temporaryPassword = newTemporaryPassword(input.email);
  const passwordHash = await hashPassword(temporaryPassword);

  const staff = await sequelize.transaction(async (transaction) => {
    await lockStaffTree(transaction);
    await assertEmailFree(input.email, null, transaction);
    const roles = await loadAssignableRoles(input.roleIds, actor.adminId, transaction);

    let created: Admin;
    try {
      created = await Admin.create(
        {
          fullName: input.fullName,
          email: input.email,
          passwordHash,
          isSuperAdmin: input.isSuperAdmin,
          createdByAdminId: actor.adminId,
          mustChangePassword: true,
        },
        { transaction },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw emailTaken();
      throw error;
    }

    if (roles.length > 0) {
      await AdminRoleAssignment.bulkCreate(
        roles.map((role) => ({ adminId: created.id, roleId: role.id, assignedByAdminId: actor.adminId })),
        { transaction },
      );
    }

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.STAFF_CREATED,
        entityType: 'admin',
        entityId: created.id,
        severity: input.isSuperAdmin ? 'critical' : 'warning',
        after: {
          fullName: created.fullName,
          email: created.email,
          isSuperAdmin: created.isSuperAdmin,
          roles: roles.map((role) => ({ id: role.id, name: role.name })),
        },
        context,
      },
      transaction,
    );
    return describe(created, actor, transaction);
  });

  return {
    staff,
    /** Shown once. It is not stored and cannot be retrieved again; use reset password instead. */
    credentials: { email: staff.email, temporaryPassword },
  };
}

export async function updateStaff(
  actor: Actor,
  staffId: string,
  input: { fullName?: string | undefined; email?: string | undefined },
  context: RequestContext,
) {
  return sequelize.transaction(async (transaction) => {
    await lockStaffTree(transaction);
    const staff = await findManageableStaff(actor, staffId, transaction);

    const before = { fullName: staff.fullName, email: staff.email };
    const after = { fullName: input.fullName ?? staff.fullName, email: input.email ?? staff.email };
    if (after.fullName === before.fullName && after.email === before.email) return describe(staff, actor, transaction);

    if (after.email !== before.email) await assertEmailFree(after.email, staff.id, transaction);

    staff.fullName = after.fullName;
    staff.email = after.email;
    try {
      await staff.save({ transaction });
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw emailTaken();
      throw error;
    }

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.STAFF_UPDATED,
        entityType: 'admin',
        entityId: staff.id,
        severity: after.email !== before.email ? 'warning' : 'info',
        before,
        after,
        context,
      },
      transaction,
    );
    return describe(staff, actor, transaction);
  });
}

/**
 * Replace the roles a staff member holds. Only roles created by their own
 * parent can be given. Taking a role away also strips whatever the staff
 * member had handed down from it, all the way down their branch.
 */
export async function setStaffRoles(
  actor: Actor,
  staffId: string,
  roleIds: string[],
  context: RequestContext,
  options: { preview: boolean } = { preview: false },
): Promise<{ preview: boolean; staff: Awaited<ReturnType<typeof describe>>; cascade: CascadeResult }> {
  const preview = options.preview;
  return runOrPreview(preview, async (transaction) => {
    await lockStaffTree(transaction);
    const staff = await findManageableStaff(actor, staffId, transaction);
    if (staff.isSuperAdmin) {
      throw AppError.unprocessable('A super admin already holds every permission and cannot be given roles', ErrorCode.ROLE_NOT_ASSIGNABLE);
    }

    // findManageableStaff refuses the seeded super admin, so a parent always exists here.
    const wanted = await loadAssignableRoles(roleIds, staff.createdByAdminId as string, transaction);
    const current = (await getRolesHeldBy([staff.id], transaction)).get(staff.id) ?? [];

    const currentIds = new Set(current.map((role) => role.id));
    const wantedIds = new Set(wanted.map((role) => role.id));
    const added = wanted.filter((role) => !currentIds.has(role.id));
    const removed = current.filter((role) => !wantedIds.has(role.id));

    let cascade: CascadeResult = { roles: [], affectedAdminIds: [] };
    if (added.length === 0 && removed.length === 0) return { preview, staff: await describe(staff, actor, transaction), cascade };

    if (removed.length > 0) {
      await sequelize.query(
        `UPDATE admin_role_assignments
            SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
          WHERE admin_id = :adminId AND role_id IN (:roleIds) AND is_deleted = FALSE`,
        { replacements: { adminId: staff.id, roleIds: removed.map((role) => role.id), actorId: actor.adminId }, transaction },
      );
    }
    if (added.length > 0) {
      await AdminRoleAssignment.bulkCreate(
        added.map((role) => ({ adminId: staff.id, roleId: role.id, assignedByAdminId: actor.adminId })),
        { transaction },
      );
    }

    if (removed.length > 0) {
      cascade = await cascadeRevoke(
        [staff.id],
        { actorId: actor.adminId, action: AuditAction.STAFF_ROLES_CHANGED, entityType: 'admin', entityId: staff.id },
        context,
        transaction,
      );
    }

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.STAFF_ROLES_CHANGED,
        entityType: 'admin',
        entityId: staff.id,
        severity: 'warning',
        before: { roles: current },
        after: { roles: wanted.map((role) => ({ id: role.id, name: role.name })) },
        metadata: {
          added: added.map((role) => role.id),
          removed: removed.map((role) => role.id),
          cascade: { roles: cascade.roles.length, staff: cascade.affectedAdminIds.length },
        },
        context,
      },
      transaction,
    );
    return { preview, staff: await describe(staff, actor, transaction), cascade };
  });
}

/**
 * Block one staff member and sign them out everywhere. Their team keeps
 * working and keeps its roles: a block is temporary by nature.
 */
export async function blockStaff(actor: Actor, staffId: string, reason: string, context: RequestContext) {
  return sequelize.transaction(async (transaction) => {
    await lockStaffTree(transaction);
    const staff = await findManageableStaff(actor, staffId, transaction);
    if (staff.status === 'disabled') throw AppError.conflict('This staff member is already blocked');

    staff.status = 'disabled';
    staff.disabledAt = new Date();
    staff.disabledReason = reason;
    staff.disabledByAdminId = actor.adminId;
    await staff.save({ transaction });

    const revokedSessions = await revokeAllAdminSessions(staff.id, 'account_blocked', transaction);

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.STAFF_BLOCKED,
        entityType: 'admin',
        entityId: staff.id,
        severity: 'critical',
        before: { status: 'active' },
        after: { status: 'disabled', reason },
        metadata: { revokedSessions },
        context,
      },
      transaction,
    );
    return describe(staff, actor, transaction);
  });
}

export async function unblockStaff(actor: Actor, staffId: string, context: RequestContext) {
  return sequelize.transaction(async (transaction) => {
    await lockStaffTree(transaction);
    const staff = await findManageableStaff(actor, staffId, transaction);
    if (staff.status !== 'disabled') throw AppError.conflict('This staff member is not blocked');

    const previousReason = staff.disabledReason;
    staff.status = 'active';
    staff.disabledAt = null;
    staff.disabledReason = null;
    staff.disabledByAdminId = null;
    staff.failedLoginAttempts = 0;
    staff.lockedUntil = null;
    await staff.save({ transaction });

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.STAFF_UNBLOCKED,
        entityType: 'admin',
        entityId: staff.id,
        severity: 'warning',
        before: { status: 'disabled', reason: previousReason },
        after: { status: 'active' },
        context,
      },
      transaction,
    );
    return describe(staff, actor, transaction);
  });
}

/**
 * Give a staff member a new generated password (returned once), sign them out
 * everywhere and make them change it at next sign-in.
 */
export async function resetStaffPassword(actor: Actor, staffId: string, context: RequestContext) {
  // Hash outside the transaction: it is slow on purpose and needs no lock.
  const visible = await findVisibleStaff(actor, staffId);
  const temporaryPassword = newTemporaryPassword(visible.email);
  const passwordHash = await hashPassword(temporaryPassword);

  const staff = await sequelize.transaction(async (transaction) => {
    await lockStaffTree(transaction);
    const target = await findManageableStaff(actor, staffId, transaction);

    await Admin.update(
      {
        passwordHash,
        passwordChangedAt: new Date(),
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      { where: { id: target.id }, transaction },
    );
    const revokedSessions = await revokeAllAdminSessions(target.id, 'password_reset', transaction);

    await recordAudit(
      {
        actor: { type: 'admin', id: actor.adminId },
        action: AuditAction.STAFF_PASSWORD_RESET,
        entityType: 'admin',
        entityId: target.id,
        severity: 'critical',
        metadata: { revokedSessions },
        context,
      },
      transaction,
    );
    await target.reload({ transaction });
    return describe(target, actor, transaction);
  });

  return { staff, credentials: { email: staff.email, temporaryPassword } };
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

type StaffSummary = { id: string; fullName: string; email: string };
type OwnedRoleSummary = { id: string; name: string; ownerId: string };

export interface StaffDeletionResult {
  preview: boolean;
  /** Accounts and roles marked deleted (kept in the database, never removed). */
  deleted: { staff: StaffSummary[]; roles: OwnedRoleSummary[] };
  /** Only when a super admin is deleted: what moved under the admin who deleted them. */
  transferred: { staff: StaffSummary[]; roles: (OwnedRoleSummary & { previousName: string })[] };
}

const summarize = (staff: Admin): StaffSummary => ({ id: staff.id, fullName: staff.fullName, email: staff.email });

/** A name for a moved role that does not clash with the roles its new owner already has. */
function freeRoleName(name: string, fromOwner: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? ` (from ${fromOwner})` : ` (from ${fromOwner} ${attempt})`;
    const candidate = `${name.slice(0, 80 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Delete a staff member (soft delete: `is_deleted = true`, the row is kept).
 *
 *  - Ordinary staff: everyone below them and every role any of them created
 *    are deleted with them, all the way down, and all of them are signed out.
 *  - A super admin: only that account is deleted. The staff and roles they
 *    created are kept and move under the super admin doing the deletion.
 *
 * The seeded super admin and the caller's own account can never be deleted.
 * With `preview`, nothing changes and the result says what would happen.
 */
export async function deleteStaff(
  actor: Actor,
  staffId: string,
  context: RequestContext,
  options: { preview: boolean },
): Promise<StaffDeletionResult> {
  return runOrPreview(options.preview, async (transaction) => {
    await lockStaffTree(transaction);
    const target = await findManageableStaff(actor, staffId, transaction);
    const result: StaffDeletionResult = {
      preview: options.preview,
      deleted: { staff: [], roles: [] },
      transferred: { staff: [], roles: [] },
    };

    const markStaffDeleted = (ids: readonly string[]) =>
      sequelize.query(
        `UPDATE admins
            SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
          WHERE id IN (:ids) AND is_deleted = FALSE`,
        { replacements: { ids: [...ids], actorId: actor.adminId }, transaction },
      );

    if (target.isSuperAdmin) {
      if (!actor.isSuperAdmin) throw AppError.forbidden('Only a super admin can delete a super admin');

      const reports = await Admin.findAll({
        where: { createdByAdminId: target.id, isDeleted: false },
        order: [['createdAt', 'ASC']],
        transaction,
      });
      const roles = await AdminRole.findAll({
        where: { createdByAdminId: target.id, isDeleted: false },
        order: [['createdAt', 'ASC']],
        transaction,
      });
      const mine = await AdminRole.findAll({
        where: { createdByAdminId: actor.adminId, isDeleted: false },
        attributes: ['name'],
        transaction,
      });
      const taken = new Set(mine.map((role) => role.name.toLowerCase()));

      // Roles and the staff holding them move together, so every assignment
      // stays valid: the role's owner is still the staff member's parent.
      for (const role of roles) {
        const previousName = role.name;
        const name = freeRoleName(role.name, target.fullName, taken);
        taken.add(name.toLowerCase());
        await AdminRole.update({ name, createdByAdminId: actor.adminId }, { where: { id: role.id }, transaction });
        result.transferred.roles.push({ id: role.id, name, ownerId: actor.adminId, previousName });
      }
      if (reports.length > 0) {
        await Admin.update(
          { createdByAdminId: actor.adminId },
          { where: { id: { [Op.in]: reports.map((report) => report.id) } }, transaction },
        );
      }
      result.transferred.staff = reports.map(summarize);

      await markStaffDeleted([target.id]);
      const revokedSessions = await revokeSessionsOfAdmins([target.id], 'account_deleted', transaction);
      result.deleted.staff = [summarize(target)];

      await recordAudit(
        {
          actor: { type: 'admin', id: actor.adminId },
          action: AuditAction.STAFF_DELETED,
          entityType: 'admin',
          entityId: target.id,
          severity: 'critical',
          before: { fullName: target.fullName, email: target.email, isSuperAdmin: true },
          metadata: { revokedSessions, transferredStaff: reports.length, transferredRoles: roles.length },
          context,
        },
        transaction,
      );
      if (reports.length + roles.length > 0) {
        await recordAudit(
          {
            actor: { type: 'admin', id: actor.adminId },
            action: AuditAction.STAFF_TRANSFERRED,
            entityType: 'admin',
            entityId: actor.adminId,
            severity: 'critical',
            metadata: {
              from: target.id,
              to: actor.adminId,
              staff: result.transferred.staff.map((staff) => staff.id),
              roles: result.transferred.roles,
            },
            context,
          },
          transaction,
        );
      }
      return result;
    }

    // Ordinary staff: the whole branch goes with them.
    const ids = [target.id, ...(await getDescendantIds(target.id, transaction))];
    const branch = await Admin.findAll({ where: { id: { [Op.in]: ids } }, order: [['createdAt', 'ASC']], transaction });
    const roles = await AdminRole.findAll({
      where: { createdByAdminId: { [Op.in]: ids }, isDeleted: false },
      order: [['createdAt', 'ASC']],
      transaction,
    });
    const roleIds = roles.map((role) => role.id);

    await markStaffDeleted(ids);
    if (roleIds.length > 0) {
      await sequelize.query(
        `UPDATE admin_roles
            SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
          WHERE id IN (:roleIds) AND is_deleted = FALSE`,
        { replacements: { roleIds, actorId: actor.adminId }, transaction },
      );
    }
    // Roles the branch held, and anyone holding the branch's roles (always inside the branch).
    await sequelize.query(
      `UPDATE admin_role_assignments
          SET is_deleted = TRUE, deleted_at = NOW(), deleted_by_admin_id = :actorId, updated_at = NOW()
        WHERE is_deleted = FALSE
          AND (admin_id IN (:ids) ${roleIds.length > 0 ? 'OR role_id IN (:roleIds)' : ''})`,
      { replacements: { ids, actorId: actor.adminId, ...(roleIds.length > 0 ? { roleIds } : {}) }, transaction },
    );
    const revokedSessions = await revokeSessionsOfAdmins(ids, 'account_deleted', transaction);

    result.deleted.staff = branch.map(summarize);
    result.deleted.roles = roles.map((role) => ({ id: role.id, name: role.name, ownerId: role.createdByAdminId }));

    const cause = { action: AuditAction.STAFF_DELETED, entityType: 'admin', entityId: target.id };
    for (const staff of branch) {
      const isTarget = staff.id === target.id;
      await recordAudit(
        {
          actor: { type: 'admin', id: actor.adminId },
          action: AuditAction.STAFF_DELETED,
          entityType: 'admin',
          entityId: staff.id,
          severity: 'critical',
          before: { fullName: staff.fullName, email: staff.email, createdBy: staff.createdByAdminId },
          metadata: isTarget
            ? { revokedSessions, deletedStaff: branch.length, deletedRoles: roles.length }
            : { reason: 'Deleted together with the admin above them', causedBy: cause },
          context,
        },
        transaction,
      );
    }
    for (const role of roles) {
      await recordAudit(
        {
          actor: { type: 'admin', id: actor.adminId },
          action: AuditAction.ROLE_DELETED,
          entityType: 'admin_role',
          entityId: role.id,
          severity: 'critical',
          before: { name: role.name, description: role.description },
          metadata: { ownerId: role.createdByAdminId, reason: 'Deleted together with its owner', causedBy: cause },
          context,
        },
        transaction,
      );
    }
    return result;
  });
}
