import type { MigrationContext } from '../umzug.js';
import { executeInTransaction } from '../migrationUtils.js';

/**
 * OTP verification of an email address or phone number.
 *
 * Lifecycle of a row:
 *   1. created when an OTP is sent (otp_hash = HMAC-SHA256 of the code)
 *   2. verified_at + token_hash set when the correct OTP is submitted; the
 *      plain verification token is returned to the client exactly once
 *   3. consumed_at set when the token is spent (registration / password reset)
 *
 * Sending a new OTP to the same destination + purpose invalidates every
 * earlier unconsumed row (invalidated_at), so only the latest code/token works.
 * Each row is bound to a single destination; a token can never be replayed
 * against a different email or phone.
 */
export async function up({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [
    `CREATE TABLE verification_requests (
      id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      purpose           VARCHAR(30)  NOT NULL,
      channel           VARCHAR(10)  NOT NULL,
      destination       VARCHAR(254) NOT NULL,
      user_id           UUID         NULL REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
      otp_hash          CHAR(64)     NOT NULL,
      otp_expires_at    TIMESTAMPTZ  NOT NULL,
      attempts          SMALLINT     NOT NULL DEFAULT 0,
      max_attempts      SMALLINT     NOT NULL,
      verified_at       TIMESTAMPTZ  NULL,
      token_hash        CHAR(64)     NULL,
      token_expires_at  TIMESTAMPTZ  NULL,
      consumed_at       TIMESTAMPTZ  NULL,
      invalidated_at    TIMESTAMPTZ  NULL,
      ip_address        VARCHAR(45)  NULL,
      user_agent        VARCHAR(512) NULL,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT verification_requests_purpose_check CHECK (purpose IN ('registration', 'password_reset')),
      CONSTRAINT verification_requests_channel_check CHECK (channel IN ('email', 'sms')),
      CONSTRAINT verification_requests_user_binding_check
        CHECK ((purpose = 'password_reset') = (user_id IS NOT NULL)),
      CONSTRAINT verification_requests_attempts_check CHECK (attempts >= 0 AND attempts <= max_attempts),
      CONSTRAINT verification_requests_max_attempts_check CHECK (max_attempts > 0),
      CONSTRAINT verification_requests_token_pair_check CHECK ((token_hash IS NULL) = (token_expires_at IS NULL)),
      CONSTRAINT verification_requests_token_requires_verification_check
        CHECK (token_hash IS NULL OR verified_at IS NOT NULL),
      CONSTRAINT verification_requests_consumed_requires_token_check
        CHECK (consumed_at IS NULL OR token_hash IS NOT NULL),
      CONSTRAINT verification_requests_otp_hash_format_check CHECK (otp_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT verification_requests_token_hash_format_check CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$')
    )`,
    `CREATE UNIQUE INDEX verification_requests_token_hash_unique
       ON verification_requests (token_hash) WHERE token_hash IS NOT NULL`,
    `CREATE INDEX verification_requests_destination_idx
       ON verification_requests (destination, purpose, channel, created_at DESC)`,
    `CREATE INDEX verification_requests_user_id_idx ON verification_requests (user_id) WHERE user_id IS NOT NULL`,
    `CREATE INDEX verification_requests_created_at_idx ON verification_requests (created_at)`,
    `COMMENT ON TABLE verification_requests IS 'OTP verification of email/phone ownership for registration and password reset'`,
  ]);
}

export async function down({ context: { sequelize } }: { context: MigrationContext }): Promise<void> {
  await executeInTransaction(sequelize, [`DROP TABLE IF EXISTS verification_requests`]);
}
