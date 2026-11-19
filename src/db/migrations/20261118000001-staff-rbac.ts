import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Staff roles and permissions (RBAC) for the admin console.
 *
 * admins
 *   - `role` (which only ever allowed 'super_admin') is replaced by
 *     `is_super_admin`. Every existing admin is converted to a super admin, so
 *     nobody loses access. Access for everyone else comes from roles.
 *   - `created_by_admin_id` is the staff member's one parent: the admin who
 *     created the account. Only seeded super admins have no creator.
 *   - Staff are never hard-deleted: `is_deleted` hides the account and keeps
 *     the row for history. The email of a deleted account can be used again,
 *     so the unique index now covers live accounts only.
 *   - A seeded super admin (no creator) can never be deleted. The CHECK makes
 *     that impossible even for a bug in application code.
 *
 * permissions
 *   - Mirror of the permission catalog in code (modules/access). Rows are
 *     added by the catalog sync at server start, never renamed and never
 *     removed; a retired permission is switched off with `is_active`.
 *
 * admin_roles / admin_role_permissions / admin_role_assignments
 *   - A role is owned by the admin who created it. Its permissions and the
 *     staff holding it are link rows. Unticking a permission or taking a role
 *     away marks the link row deleted instead of removing it, so the tables
 *     keep the full history; partial unique indexes allow the same link to be
 *     created again later.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `ALTER TABLE admins
       ADD COLUMN is_super_admin        BOOLEAN      NOT NULL DEFAULT FALSE,
       ADD COLUMN created_by_admin_id   UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
       ADD COLUMN must_change_password  BOOLEAN      NOT NULL DEFAULT FALSE,
       ADD COLUMN disabled_at           TIMESTAMPTZ  NULL,
       ADD COLUMN disabled_reason       VARCHAR(500) NULL,
       ADD COLUMN disabled_by_admin_id  UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
       ADD COLUMN is_deleted            BOOLEAN      NOT NULL DEFAULT FALSE,
       ADD COLUMN deleted_at            TIMESTAMPTZ  NULL,
       ADD COLUMN deleted_by_admin_id   UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT`,
    `UPDATE admins SET is_super_admin = TRUE WHERE role = 'super_admin'`,
    `UPDATE admins SET disabled_at = updated_at WHERE status = 'disabled'`,
    `ALTER TABLE admins DROP CONSTRAINT admins_role_check`,
    `ALTER TABLE admins DROP COLUMN role`,
    `ALTER TABLE admins
       ADD CONSTRAINT admins_creator_check CHECK (created_by_admin_id IS NOT NULL OR is_super_admin),
       ADD CONSTRAINT admins_not_own_creator_check CHECK (created_by_admin_id <> id),
       ADD CONSTRAINT admins_disabled_consistency_check CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
       ADD CONSTRAINT admins_deleted_consistency_check CHECK (is_deleted = (deleted_at IS NOT NULL)),
       ADD CONSTRAINT admins_seeded_never_deleted_check CHECK (NOT (is_deleted AND created_by_admin_id IS NULL))`,
    `DROP INDEX admins_email_unique`,
    `CREATE UNIQUE INDEX admins_email_unique ON admins (email) WHERE is_deleted = FALSE`,
    `CREATE INDEX admins_created_by_admin_id_idx ON admins (created_by_admin_id) WHERE created_by_admin_id IS NOT NULL`,

    `CREATE TABLE permissions (
      key         VARCHAR(100) PRIMARY KEY,
      module      VARCHAR(50)  NOT NULL,
      action      VARCHAR(50)  NOT NULL,
      is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT permissions_key_format_check CHECK (key ~ '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$'),
      CONSTRAINT permissions_key_parts_check CHECK (key = module || '.' || action)
    )`,
    `COMMENT ON TABLE permissions IS 'Mirror of the permission catalog in code; synced at server start'`,

    `CREATE TABLE admin_roles (
      id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name                 VARCHAR(80)  NOT NULL,
      description          VARCHAR(500) NULL,
      created_by_admin_id  UUID         NOT NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      is_deleted           BOOLEAN      NOT NULL DEFAULT FALSE,
      deleted_at           TIMESTAMPTZ  NULL,
      deleted_by_admin_id  UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT admin_roles_name_check CHECK (name = BTRIM(name) AND name <> ''),
      CONSTRAINT admin_roles_deleted_consistency_check CHECK (is_deleted = (deleted_at IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX admin_roles_owner_name_unique
       ON admin_roles (created_by_admin_id, LOWER(name)) WHERE is_deleted = FALSE`,
    `CREATE INDEX admin_roles_created_by_admin_id_idx ON admin_roles (created_by_admin_id)`,
    `COMMENT ON TABLE admin_roles IS 'Custom staff roles; each is owned by the admin who created it'`,

    `CREATE TABLE admin_role_permissions (
      id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id              UUID         NOT NULL REFERENCES admin_roles (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      permission_key       VARCHAR(100) NOT NULL REFERENCES permissions (key) ON UPDATE CASCADE ON DELETE RESTRICT,
      granted_by_admin_id  UUID         NOT NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      is_deleted           BOOLEAN      NOT NULL DEFAULT FALSE,
      deleted_at           TIMESTAMPTZ  NULL,
      deleted_by_admin_id  UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT admin_role_permissions_deleted_consistency_check CHECK (is_deleted = (deleted_at IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX admin_role_permissions_live_unique
       ON admin_role_permissions (role_id, permission_key) WHERE is_deleted = FALSE`,
    `CREATE INDEX admin_role_permissions_permission_key_idx ON admin_role_permissions (permission_key)`,
    `COMMENT ON TABLE admin_role_permissions IS 'Permissions ticked on a role; unticking marks the row deleted'`,

    `CREATE TABLE admin_role_assignments (
      id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id              UUID         NOT NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      role_id               UUID         NOT NULL REFERENCES admin_roles (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      assigned_by_admin_id  UUID         NOT NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      is_deleted            BOOLEAN      NOT NULL DEFAULT FALSE,
      deleted_at            TIMESTAMPTZ  NULL,
      deleted_by_admin_id   UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT admin_role_assignments_deleted_consistency_check CHECK (is_deleted = (deleted_at IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX admin_role_assignments_live_unique
       ON admin_role_assignments (admin_id, role_id) WHERE is_deleted = FALSE`,
    `CREATE INDEX admin_role_assignments_role_id_idx ON admin_role_assignments (role_id)`,
    `COMMENT ON TABLE admin_role_assignments IS 'Roles held by a staff member; taking a role away marks the row deleted'`,
  ]);
}

/**
 * Reverting is only possible while every admin is still a live super admin.
 * Otherwise restoring `role` would turn ordinary or deleted staff into super
 * admins, so the migration refuses and rolls back leaving the schema untouched.
 */
export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM admins WHERE NOT is_super_admin OR is_deleted) THEN
         RAISE EXCEPTION 'Cannot revert staff RBAC: staff or deleted admin accounts exist';
       END IF;
     END
     $$`,
    `DROP TABLE IF EXISTS admin_role_assignments`,
    `DROP TABLE IF EXISTS admin_role_permissions`,
    `DROP TABLE IF EXISTS admin_roles`,
    `DROP TABLE IF EXISTS permissions`,
    `DROP INDEX admins_created_by_admin_id_idx`,
    `DROP INDEX admins_email_unique`,
    `CREATE UNIQUE INDEX admins_email_unique ON admins (email)`,
    `ALTER TABLE admins
       DROP CONSTRAINT admins_creator_check,
       DROP CONSTRAINT admins_not_own_creator_check,
       DROP CONSTRAINT admins_disabled_consistency_check,
       DROP CONSTRAINT admins_deleted_consistency_check,
       DROP CONSTRAINT admins_seeded_never_deleted_check`,
    `ALTER TABLE admins
       DROP COLUMN is_super_admin,
       DROP COLUMN created_by_admin_id,
       DROP COLUMN must_change_password,
       DROP COLUMN disabled_at,
       DROP COLUMN disabled_reason,
       DROP COLUMN disabled_by_admin_id,
       DROP COLUMN is_deleted,
       DROP COLUMN deleted_at,
       DROP COLUMN deleted_by_admin_id`,
    `ALTER TABLE admins ADD COLUMN role VARCHAR(30) NOT NULL DEFAULT 'super_admin'`,
    `ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('super_admin'))`,
  ]);
}
