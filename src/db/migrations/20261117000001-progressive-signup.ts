import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * Progressive signup: an account is created from ONE verified contact (phone,
 * or email + password) and the rest is collected during onboarding.
 *
 * users
 *   - username, email, phone, password_hash and both *_verified_at become
 *     nullable. A phone signup has no password and signs in with an OTP.
 *   - Invariants kept by CHECKs:
 *       * at least one contact is always present
 *       * a stored contact is always a verified one (contact and its
 *         verified_at are both set or both NULL)
 *       * onboarding can only be completed once BOTH contacts are present
 *
 * verification_requests
 *   - new purposes: 'login' (OTP sign-in) and 'contact_verification' (adding
 *     the second contact). Only 'registration' happens before a user exists,
 *     so every other purpose must be bound to a user.
 *
 * risk_profiles
 *   - market_experience gains 'new' (less than six months of trading).
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `ALTER TABLE users
       ALTER COLUMN username DROP NOT NULL,
       ALTER COLUMN email DROP NOT NULL,
       ALTER COLUMN phone DROP NOT NULL,
       ALTER COLUMN password_hash DROP NOT NULL,
       ALTER COLUMN email_verified_at DROP NOT NULL,
       ALTER COLUMN phone_verified_at DROP NOT NULL`,
    `ALTER TABLE users
       ADD CONSTRAINT users_contact_present_check CHECK (email IS NOT NULL OR phone IS NOT NULL),
       ADD CONSTRAINT users_email_verified_consistency_check CHECK ((email IS NULL) = (email_verified_at IS NULL)),
       ADD CONSTRAINT users_phone_verified_consistency_check CHECK ((phone IS NULL) = (phone_verified_at IS NULL)),
       ADD CONSTRAINT users_onboarded_contacts_check
         CHECK (onboarding_status <> 'completed' OR (email IS NOT NULL AND phone IS NOT NULL))`,

    `ALTER TABLE verification_requests
       DROP CONSTRAINT verification_requests_purpose_check,
       DROP CONSTRAINT verification_requests_user_binding_check`,
    `ALTER TABLE verification_requests
       ADD CONSTRAINT verification_requests_purpose_check
         CHECK (purpose IN ('registration', 'password_reset', 'login', 'contact_verification')),
       ADD CONSTRAINT verification_requests_user_binding_check
         CHECK ((purpose <> 'registration') = (user_id IS NOT NULL))`,
    `COMMENT ON TABLE verification_requests IS
       'OTP verification of email/phone ownership for registration, sign-in, adding a contact and password reset'`,

    `ALTER TABLE risk_profiles DROP CONSTRAINT risk_profiles_market_experience_check`,
    `ALTER TABLE risk_profiles
       ADD CONSTRAINT risk_profiles_market_experience_check
         CHECK (market_experience IS NULL OR market_experience IN ('new', 'beginner', 'intermediate', 'experienced'))`,
  ]);
}

/**
 * Reverting is only possible while no row depends on the new rules. Rows that
 * do (single-contact users, 'new' experience) make the restored constraints
 * fail, and the whole migration rolls back leaving the schema untouched.
 */
export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `ALTER TABLE risk_profiles DROP CONSTRAINT risk_profiles_market_experience_check`,
    `ALTER TABLE risk_profiles
       ADD CONSTRAINT risk_profiles_market_experience_check
         CHECK (market_experience IS NULL OR market_experience IN ('beginner', 'intermediate', 'experienced'))`,

    // Short-lived OTP rows for the new purposes carry no history worth keeping.
    `DELETE FROM verification_requests WHERE purpose IN ('login', 'contact_verification')`,
    `ALTER TABLE verification_requests
       DROP CONSTRAINT verification_requests_purpose_check,
       DROP CONSTRAINT verification_requests_user_binding_check`,
    `ALTER TABLE verification_requests
       ADD CONSTRAINT verification_requests_purpose_check CHECK (purpose IN ('registration', 'password_reset')),
       ADD CONSTRAINT verification_requests_user_binding_check
         CHECK ((purpose = 'password_reset') = (user_id IS NOT NULL))`,
    `COMMENT ON TABLE verification_requests IS
       'OTP verification of email/phone ownership for registration and password reset'`,

    `ALTER TABLE users
       DROP CONSTRAINT users_contact_present_check,
       DROP CONSTRAINT users_email_verified_consistency_check,
       DROP CONSTRAINT users_phone_verified_consistency_check,
       DROP CONSTRAINT users_onboarded_contacts_check`,
    `ALTER TABLE users
       ALTER COLUMN username SET NOT NULL,
       ALTER COLUMN email SET NOT NULL,
       ALTER COLUMN phone SET NOT NULL,
       ALTER COLUMN password_hash SET NOT NULL,
       ALTER COLUMN email_verified_at SET NOT NULL,
       ALTER COLUMN phone_verified_at SET NOT NULL`,
  ]);
}
