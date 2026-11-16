import { z } from 'zod';
import type { MigrationContext } from '../umzug.js';
import { env } from '../../config/env.js';
import { passwordSchema } from '../../modules/auth/auth.schemas.js';
import { hashPassword } from '../../common/utils/password.js';
import { normalizeEmail } from '../../common/utils/normalize.js';

/**
 * Create the super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD /
 * SUPER_ADMIN_NAME. Fails loudly when they are unset so the seed is never
 * silently recorded as done without an admin existing. Remove the password
 * from the environment after seeding.
 */
const SuperAdminSchema = z.object({
  SUPER_ADMIN_NAME: z.string({ error: 'SUPER_ADMIN_NAME is required' }).trim().min(2).max(100),
  SUPER_ADMIN_EMAIL: z.email({ error: 'SUPER_ADMIN_EMAIL must be a valid email' }),
  // Stricter than customer passwords: at least 12 characters.
  SUPER_ADMIN_PASSWORD: passwordSchema.and(
    z.string().min(12, 'SUPER_ADMIN_PASSWORD must be at least 12 characters'),
  ),
});

export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  const parsed = SuperAdminSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Cannot seed super admin — ${problems}`);
  }
  const { SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_NAME } = parsed.data;

  const email = normalizeEmail(SUPER_ADMIN_EMAIL);
  const passwordHash = await hashPassword(SUPER_ADMIN_PASSWORD);

  await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `INSERT INTO admins (full_name, email, password_hash, role)
       VALUES (:name, :email, :passwordHash, 'super_admin')
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      { replacements: { name: SUPER_ADMIN_NAME, email, passwordHash }, transaction },
    );
    const created = (rows as { id: string }[])[0];
    if (created) {
      await sequelize.query(
        `INSERT INTO audit_logs (actor_type, action, entity_type, entity_id, severity, after_data)
         VALUES ('system', 'system.super_admin_seeded', 'admin', :id, 'warning', CAST(:after AS JSONB))`,
        { replacements: { id: created.id, after: JSON.stringify({ email, role: 'super_admin' }) }, transaction },
      );
    }
  });
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  if (!env.SUPER_ADMIN_EMAIL) return;
  await sequelize.query(`DELETE FROM admins WHERE email = :email`, {
    replacements: { email: normalizeEmail(env.SUPER_ADMIN_EMAIL) },
  });
}
