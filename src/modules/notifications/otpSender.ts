import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { maskEmail, maskPhone } from '../../common/utils/normalize.js';
import type { VerificationChannel, VerificationPurpose } from '../../models/enums.js';

export interface OtpMessage {
  channel: VerificationChannel;
  destination: string;
  code: string;
  purpose: VerificationPurpose;
  ttlSeconds: number;
}

/**
 * A delivery provider for one-time codes. Implementations must throw on
 * delivery failure so the caller can fail closed (no OTP is recorded that the
 * user never received).
 */
export interface OtpSender {
  /** True when the provider always uses STATIC_OTP_CODE instead of a random code. */
  readonly usesStaticCode: boolean;
  send(message: OtpMessage): Promise<void>;
}

/**
 * Development/test provider: nothing is delivered and the code is always
 * STATIC_OTP_CODE. Env validation forbids it in production. The code itself
 * is never logged.
 */
class StaticOtpSender implements OtpSender {
  readonly usesStaticCode = true;

  async send(message: OtpMessage): Promise<void> {
    const masked = message.channel === 'email' ? maskEmail(message.destination) : maskPhone(message.destination);
    logger.info(
      { channel: message.channel, destination: masked, purpose: message.purpose },
      'OTP dispatched via static provider (no real delivery)',
    );
  }
}

const staticSender = new StaticOtpSender();

/**
 * Per-channel replacement used by the automated test suite to simulate
 * provider behaviour (e.g. outages). Unset in normal operation.
 */
const overrides = new Map<VerificationChannel, OtpSender>();

export function overrideOtpSender(channel: VerificationChannel, sender: OtpSender | null): void {
  if (sender) overrides.set(channel, sender);
  else overrides.delete(channel);
}

/**
 * Resolve the provider for a channel from configuration. Add real providers
 * (e.g. MSG91 / SES) here behind the same interface.
 */
export function getOtpSender(channel: VerificationChannel): OtpSender {
  const override = overrides.get(channel);
  if (override) return override;

  const provider = channel === 'email' ? env.EMAIL_PROVIDER : env.SMS_PROVIDER;
  switch (provider) {
    case 'static':
      return staticSender;
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported OTP provider: ${String(exhaustive)}`);
    }
  }
}
