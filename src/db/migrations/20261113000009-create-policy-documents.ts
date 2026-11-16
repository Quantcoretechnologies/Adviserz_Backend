import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Versioned legal documents (Terms & Conditions, Risk Policy).
 *
 * Admins author a draft (at most one per type), then publish it. Published
 * versions are immutable; the highest published version per type is the
 * "current" one every user must have accepted. content_sha256 proves exactly
 * which text a user agreed to.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE policy_documents (
      id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      type                   VARCHAR(40)  NOT NULL,
      version                INTEGER      NOT NULL,
      title                  VARCHAR(200) NOT NULL,
      content                TEXT         NOT NULL,
      content_sha256         CHAR(64)     NOT NULL,
      status                 VARCHAR(20)  NOT NULL DEFAULT 'draft',
      published_at           TIMESTAMPTZ  NULL,
      created_by_admin_id    UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE SET NULL,
      published_by_admin_id  UUID         NULL REFERENCES admins (id) ON UPDATE CASCADE ON DELETE SET NULL,
      created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT policy_documents_type_check CHECK (type IN ('terms_and_conditions', 'risk_policy')),
      CONSTRAINT policy_documents_status_check CHECK (status IN ('draft', 'published')),
      CONSTRAINT policy_documents_published_consistency_check CHECK ((status = 'published') = (published_at IS NOT NULL)),
      CONSTRAINT policy_documents_version_check CHECK (version >= 1),
      CONSTRAINT policy_documents_content_not_blank_check CHECK (LENGTH(BTRIM(content)) > 0),
      CONSTRAINT policy_documents_content_sha256_format_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
    )`,
    `CREATE UNIQUE INDEX policy_documents_type_version_unique ON policy_documents (type, version)`,
    `CREATE UNIQUE INDEX policy_documents_one_draft_per_type_unique ON policy_documents (type) WHERE status = 'draft'`,
    `CREATE INDEX policy_documents_published_idx ON policy_documents (type, version DESC) WHERE status = 'published'`,
    `CREATE INDEX policy_documents_created_by_admin_id_idx
       ON policy_documents (created_by_admin_id) WHERE created_by_admin_id IS NOT NULL`,
    `CREATE INDEX policy_documents_published_by_admin_id_idx
       ON policy_documents (published_by_admin_id) WHERE published_by_admin_id IS NOT NULL`,
    `COMMENT ON TABLE policy_documents IS 'Versioned Terms & Conditions and Risk Policy documents'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS policy_documents`]);
}
