import { createHash } from 'node:crypto';
import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Version 1 of the Terms & Conditions and Risk Policy, so the onboarding
 * consent step works end to end.
 *
 * THE TEXT IS A PLACEHOLDER. Before launch, publish the legally approved text
 * as version 2 from the admin console; every user is then prompted to accept
 * it automatically.
 */
const POLICIES = [
  {
    type: 'terms_and_conditions',
    title: 'Terms and Conditions',
    content:
      'PLACEHOLDER — Adviserz Terms and Conditions.\n\n' +
      'This text must be replaced with the legally approved Terms and Conditions before launch.',
  },
  {
    type: 'risk_policy',
    title: 'Risk Policy',
    content:
      'PLACEHOLDER — Adviserz Risk Policy.\n\n' +
      'Trading in securities markets involves risk of loss. This text must be replaced with the ' +
      'approved Risk Policy before launch.',
  },
] as const;

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    for (const policy of POLICIES) {
      await sequelize.query(
        `INSERT INTO policy_documents (type, version, title, content, content_sha256, status, published_at)
         VALUES (:type, 1, :title, :content, :sha, 'published', NOW())
         ON CONFLICT (type, version) DO NOTHING`,
        {
          replacements: {
            type: policy.type,
            title: policy.title,
            content: policy.content,
            sha: createHash('sha256').update(policy.content, 'utf8').digest('hex'),
          },
          transaction,
        },
      );
    }
  });
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  // Fails (FK RESTRICT) once any user has accepted them — consent records are never discarded.
  await executeInTransaction(sequelize, [
    `DELETE FROM policy_documents WHERE version = 1 AND type IN ('terms_and_conditions', 'risk_policy')`,
  ]);
}
