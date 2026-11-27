import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * In-app notifications for customers (the bell), also pushed live over the
 * socket connection.
 *
 * - The title and body are stored exactly as sent, so the web app and the
 *   mobile app always show the same words, and the record shows what the
 *   customer was told.
 * - Business data is never hard-deleted: a trigger rejects DELETE and
 *   TRUNCATE. The only change allowed is marking an unread notification as
 *   read (read_at from NULL to a time); everything else is fixed once sent.
 */
const NOTIFICATION_TYPES = ['risk_notice.required'] as const;

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE notifications (
      id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID          NOT NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT,
      type        VARCHAR(50)   NOT NULL,
      title       VARCHAR(200)  NOT NULL,
      body        TEXT          NOT NULL,
      link        VARCHAR(200)  NULL,
      data        JSONB         NULL,
      read_at     TIMESTAMPTZ   NULL,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT notifications_type_check CHECK (type IN (${NOTIFICATION_TYPES.map((type) => `'${type}'`).join(', ')})),
      CONSTRAINT notifications_title_check CHECK (length(btrim(title)) > 0),
      CONSTRAINT notifications_body_check CHECK (length(btrim(body)) > 0),
      CONSTRAINT notifications_link_check CHECK (link IS NULL OR link LIKE '/%')
    )`,
    // The bell: a user's notifications, newest first.
    `CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC)`,
    // The unread badge.
    `CREATE INDEX notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL`,
    `COMMENT ON TABLE notifications IS 'In-app notifications for customers; never deleted, only marked read'`,

    `CREATE FUNCTION notifications_guard() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'UPDATE' THEN
           IF OLD.read_at IS NULL AND NEW.read_at IS NOT NULL
              AND (NEW.id, NEW.user_id, NEW.type, NEW.title, NEW.body, NEW.link, NEW.data, NEW.created_at)
                  IS NOT DISTINCT FROM
                  (OLD.id, OLD.user_id, OLD.type, OLD.title, OLD.body, OLD.link, OLD.data, OLD.created_at)
           THEN
             RETURN NEW;
           END IF;
           RAISE EXCEPTION 'notifications: only marking an unread notification as read is permitted'
             USING ERRCODE = 'insufficient_privilege';
         END IF;
         RAISE EXCEPTION 'notifications: % is not permitted', TG_OP
           USING ERRCODE = 'insufficient_privilege';
       END;
       $$`,
    `CREATE TRIGGER notifications_guard_row
       BEFORE UPDATE OR DELETE ON notifications
       FOR EACH ROW EXECUTE FUNCTION notifications_guard()`,
    `CREATE TRIGGER notifications_no_truncate
       BEFORE TRUNCATE ON notifications
       FOR EACH STATEMENT EXECUTE FUNCTION notifications_guard()`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `DROP TABLE notifications`,
    `DROP FUNCTION notifications_guard()`,
  ]);
}
