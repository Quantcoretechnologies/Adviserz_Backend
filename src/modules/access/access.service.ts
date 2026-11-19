import { QueryTypes, type Transaction } from 'sequelize';
import { logger } from '../../config/logger.js';
import { sequelize } from '../../db/sequelize.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditAction } from '../audit/auditActions.js';
import {
  ACTIVE_PERMISSIONS,
  ALL_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  isPermissionKey,
  type PermissionKey,
} from './permissionCatalog.js';

/** Any fixed number: serialises catalog syncs when several instances start together. */
const CATALOG_SYNC_LOCK_ID = 7_403_118_001;

export interface CatalogSyncResult {
  added: string[];
  retired: string[];
  restored: string[];
}

/**
 * Bring the `permissions` table in line with the catalog in code. Safe to run
 * on every start and from several instances at once: it only ever inserts
 * missing keys and flips `is_active`; it never deletes a row.
 *
 * A key that exists in the database but not in this build's catalog is left
 * untouched (an older instance must not switch off a newer build's
 * permissions during a rolling deploy). Such keys are simply never granted,
 * because every check goes through the catalog in code.
 */
export async function syncPermissionCatalog(): Promise<CatalogSyncResult> {
  const result = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
      replacements: { lockId: CATALOG_SYNC_LOCK_ID },
      transaction,
    });

    const existing = await sequelize.query<{ key: string; is_active: boolean }>(
      'SELECT key, is_active FROM permissions',
      { type: QueryTypes.SELECT, transaction },
    );
    const stored = new Map(existing.map((row) => [row.key, row.is_active]));

    const outcome: CatalogSyncResult = { added: [], retired: [], restored: [] };

    for (const definition of PERMISSION_CATALOG) {
      const active = !definition.retired;
      const current = stored.get(definition.key);

      if (current === undefined) {
        await sequelize.query(
          `INSERT INTO permissions (key, module, action, is_active)
           VALUES (:key, :module, :action, :active)`,
          {
            replacements: { key: definition.key, module: definition.module, action: definition.action, active },
            transaction,
          },
        );
        outcome.added.push(definition.key);
      } else if (current !== active) {
        await sequelize.query('UPDATE permissions SET is_active = :active, updated_at = NOW() WHERE key = :key', {
          replacements: { key: definition.key, active },
          transaction,
        });
        (active ? outcome.restored : outcome.retired).push(definition.key);
      }
    }

    const known = new Set<string>(PERMISSION_CATALOG.map((definition) => definition.key));
    const unknown = existing.map((row) => row.key).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      logger.warn({ unknown }, 'Permissions exist in the database that this build does not define; they are ignored');
    }

    if (outcome.added.length + outcome.retired.length + outcome.restored.length > 0) {
      await recordAudit(
        {
          actor: { type: 'system' },
          action: AuditAction.PERMISSION_CATALOG_SYNCED,
          entityType: 'permission',
          severity: 'warning',
          metadata: { ...outcome },
        },
        transaction,
      );
    }
    return outcome;
  });

  if (result.added.length + result.retired.length + result.restored.length > 0) {
    logger.info(result, 'Permission catalog synced');
  }
  return result;
}

/**
 * What an admin may do right now.
 *
 * A super admin holds every active permission, including ones added after
 * their account was created. Everyone else holds the permissions of the live
 * roles assigned to them. Read from the database on every request (never from
 * the access token), so a change takes effect on the very next request.
 */
export async function getEffectivePermissions(
  adminId: string,
  isSuperAdmin: boolean,
  transaction?: Transaction,
): Promise<ReadonlySet<PermissionKey>> {
  if (isSuperAdmin) return ALL_PERMISSION_KEYS;

  const rows = await sequelize.query<{ permission_key: string }>(
    `SELECT DISTINCT rp.permission_key
       FROM admin_role_assignments ara
       JOIN admin_roles r             ON r.id = ara.role_id AND r.is_deleted = FALSE
       JOIN admin_role_permissions rp ON rp.role_id = r.id AND rp.is_deleted = FALSE
      WHERE ara.admin_id = :adminId
        AND ara.is_deleted = FALSE`,
    { type: QueryTypes.SELECT, replacements: { adminId }, ...(transaction ? { transaction } : {}) },
  );

  const granted = new Set<PermissionKey>();
  for (const row of rows) {
    // Retired or unknown keys stored on a role grant nothing.
    if (isPermissionKey(row.permission_key)) granted.add(row.permission_key);
  }
  return granted;
}

/** The catalog grouped by module for the role form, marking what the caller holds. */
export function describeCatalogFor(granted: ReadonlySet<PermissionKey>) {
  const modules: {
    key: string;
    label: string;
    permissions: {
      key: PermissionKey;
      action: string;
      label: string;
      description: string;
      requires: readonly PermissionKey[];
      /** The caller holds it, so they may hand it down to a role they create. */
      granted: boolean;
    }[];
  }[] = [];

  for (const definition of ACTIVE_PERMISSIONS) {
    let group = modules.find((entry) => entry.key === definition.module);
    if (!group) {
      group = { key: definition.module, label: definition.moduleLabel, permissions: [] };
      modules.push(group);
    }
    group.permissions.push({
      key: definition.key,
      action: definition.action,
      label: definition.label,
      description: definition.description,
      requires: definition.requires,
      granted: granted.has(definition.key),
    });
  }
  return modules;
}
