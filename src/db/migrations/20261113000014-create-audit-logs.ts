import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Append-only audit trail of every state change and security event.
 *
 * - No foreign keys on actor_id / subject_user_id on purpose: audit history
 *   must survive deletion of the records it describes.
 * - A trigger rejects UPDATE, DELETE and TRUNCATE, so rows cannot be altered
 *   through the application role. Retention purges, when introduced, must run
 *   as a privileged maintenance job that disables the trigger explicitly.
 * - before_data / after_data hold allow-listed, redacted fields only; secrets
 *   (passwords, OTPs, tokens) are never written here.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE audit_logs (
      id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      actor_type       VARCHAR(20)  NOT NULL,
      actor_id         UUID         NULL,
      action           VARCHAR(100) NOT NULL,
      entity_type      VARCHAR(50)  NULL,
      entity_id        VARCHAR(64)  NULL,
      subject_user_id  UUID         NULL,
      severity         VARCHAR(10)  NOT NULL DEFAULT 'info',
      outcome          VARCHAR(10)  NOT NULL DEFAULT 'success',
      before_data      JSONB        NULL,
      after_data       JSONB        NULL,
      metadata         JSONB        NULL,
      ip_address       VARCHAR(45)  NULL,
      user_agent       VARCHAR(512) NULL,
      request_id       VARCHAR(64)  NULL,
      CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IN ('user', 'admin', 'system', 'anonymous')),
      CONSTRAINT audit_logs_actor_id_check CHECK (actor_type IN ('system', 'anonymous') OR actor_id IS NOT NULL),
      CONSTRAINT audit_logs_severity_check CHECK (severity IN ('info', 'warning', 'critical')),
      CONSTRAINT audit_logs_outcome_check CHECK (outcome IN ('success', 'failure'))
    )`,
    `CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at DESC)`,
    `CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_type, actor_id, occurred_at DESC)`,
    `CREATE INDEX audit_logs_subject_user_idx ON audit_logs (subject_user_id, occurred_at DESC)
       WHERE subject_user_id IS NOT NULL`,
    `CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC)`,
    `CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC)`,
    `CREATE FUNCTION audit_logs_reject_mutation() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
           USING ERRCODE = 'insufficient_privilege';
       END;
       $$`,
    `CREATE TRIGGER audit_logs_no_update_delete
       BEFORE UPDATE OR DELETE ON audit_logs
       FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation()`,
    `CREATE TRIGGER audit_logs_no_truncate
       BEFORE TRUNCATE ON audit_logs
       FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation()`,
    `COMMENT ON TABLE audit_logs IS 'Append-only audit trail of state changes and security events'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `DROP TABLE IF EXISTS audit_logs`,
    `DROP FUNCTION IF EXISTS audit_logs_reject_mutation()`,
  ]);
}
