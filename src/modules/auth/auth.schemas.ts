import { z } from 'zod';
import { normalizeEmail, normalizeIndianPhone } from '../../common/utils/normalize.js';

/**
 * Field rules shared by registration, password reset and profile updates.
 * Every identifier is normalised here, so services only ever see canonical
 * values.
 */

const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'adviserz',
  'root',
  'support',
  'system',
  'help',
  'security',
  'api',
]);

export const usernameSchema = z
  .string({ error: 'Username is required' })
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[A-Za-z]/, 'Username must start with a letter')
  .regex(/^[A-Za-z0-9._]+$/, 'Username may contain only letters, numbers, "." and "_"')
  .refine((value) => !value.includes('..'), 'Username cannot contain consecutive dots')
  .refine((value) => !value.endsWith('.'), 'Username cannot end with a dot')
  .refine((value) => !RESERVED_USERNAMES.has(value.toLowerCase()), 'This username is reserved');

export const fullNameSchema = z
  .string({ error: 'Full name is required' })
  .trim()
  .transform((value) => value.replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2, 'Full name must be at least 2 characters')
      .max(100, 'Full name must be at most 100 characters')
      .regex(/^[A-Za-z][A-Za-z .'-]*$/, 'Full name may contain only letters, spaces, full stops, apostrophes and hyphens'),
  );

export const emailSchema = z
  .string({ error: 'Email is required' })
  .trim()
  .max(254, 'Email must be at most 254 characters')
  .pipe(z.email({ error: 'Enter a valid email address' }))
  .transform(normalizeEmail);

export const phoneSchema = z
  .string({ error: 'Phone number is required' })
  .transform((value, ctx) => {
    const normalized = normalizeIndianPhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

export const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(64, 'Password must be at most 64 characters')
  .regex(/^\S+$/, 'Password must not contain spaces')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/\d/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const otpCodeSchema = z
  .string({ error: 'Code is required' })
  .trim()
  .regex(/^\d{6}$/, 'Code must be 6 digits');

export const deviceNameSchema = z
  .string({ error: 'Device name must be text' })
  .trim()
  .min(1, 'Device name cannot be empty')
  .max(100, 'Device name must be at most 100 characters')
  .optional();

/** Password must not embed the username or the email's local part. */
export function passwordAvoidsIdentity(
  password: string,
  identity: { username?: string | null | undefined; email?: string | null | undefined },
): boolean {
  const lowered = password.toLowerCase();
  const fragments = [identity.username, identity.email?.split('@')[0]]
    .filter((value): value is string => typeof value === 'string' && value.length >= 3)
    .map((value) => value.toLowerCase());
  return fragments.every((fragment) => !lowered.includes(fragment));
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const usernameAvailabilityQuery = z.object({ username: usernameSchema });

export const sendEmailOtpBody = z.object({ email: emailSchema });
export const sendPhoneOtpBody = z.object({ phone: phoneSchema });

export const verifyOtpBody = z.object({
  verificationId: z.uuid({ error: 'Invalid verification id' }),
  otp: otpCodeSchema,
});

export const registerBody = z
  .object({
    fullName: fullNameSchema,
    username: usernameSchema,
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    confirmPassword: z.string({ error: 'Confirm password is required' }),
    emailVerificationToken: z
      .string({ error: 'Email verification is required' })
      .min(1, 'Email verification is required'),
    phoneVerificationToken: z
      .string({ error: 'Phone verification is required' })
      .min(1, 'Phone verification is required'),
  })
  .superRefine((body, ctx) => {
    if (body.password !== body.confirmPassword) {
      ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
    }
    if (!passwordAvoidsIdentity(body.password, { username: body.username, email: body.email })) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must not contain your username or email',
      });
    }
  });

const verificationToken = z
  .string({ error: 'Verification is required' })
  .min(1, 'Verification is required')
  .max(512, 'Invalid verification token');

/**
 * Signup with ONE verified contact: a phone number (no password), or an email
 * address with a password. `verificationToken` comes from
 * POST /auth/register/verify-otp for that same contact.
 */
export const signupBody = z.discriminatedUnion(
  'method',
  [
    z.object({
      method: z.literal('phone'),
      fullName: fullNameSchema,
      phone: phoneSchema,
      verificationToken,
      deviceName: deviceNameSchema,
    }),
    z
      .object({
        method: z.literal('email'),
        fullName: fullNameSchema,
        email: emailSchema,
        password: passwordSchema,
        verificationToken,
        deviceName: deviceNameSchema,
      })
      .refine((body) => passwordAvoidsIdentity(body.password, { email: body.email }), {
        path: ['password'],
        message: 'Password must not contain your email',
      }),
  ],
  { error: 'Signup method must be "phone" or "email"' },
);

/** Request a sign-in code for a phone number. */
export const loginOtpSendBody = z.object({ phone: phoneSchema });

/** Sign in with the code sent to the phone. */
export const loginOtpBody = z.object({
  verificationId: z.uuid({ error: 'Invalid verification id' }),
  otp: otpCodeSchema,
  deviceName: deviceNameSchema,
});

/** Login accepts an email address or an Indian mobile number. */
export const loginBody = z.object({
  identifier: z
    .string({ error: 'Email or phone number is required' })
    .trim()
    .min(1, 'Email or phone number is required')
    .max(254, 'Enter a valid email address or 10-digit mobile number')
    .transform((value, ctx) => {
      if (value.includes('@')) {
        const email = z.email().safeParse(value);
        if (email.success) return { kind: 'email' as const, value: normalizeEmail(value) };
      } else {
        const phone = normalizeIndianPhone(value);
        if (phone) return { kind: 'phone' as const, value: phone };
      }
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address or 10-digit mobile number' });
      return z.NEVER;
    }),
  password: z
    .string({ error: 'Password is required' })
    .min(1, 'Password is required')
    .max(128, 'Password must be at most 128 characters'),
  deviceName: deviceNameSchema,
});

export const mobileRefreshBody = z.object({
  refreshToken: z
    .string({ error: 'Refresh token is required' })
    .min(1, 'Refresh token is required')
    .max(512, 'Invalid refresh token'),
});

export const forgotPasswordBody = z.object({ email: emailSchema });

export const resetPasswordBody = z
  .object({
    resetToken: z
      .string({ error: 'Reset token is required' })
      .min(1, 'Reset token is required')
      .max(512, 'Invalid reset token'),
    newPassword: passwordSchema,
    confirmPassword: z.string({ error: 'Confirm password is required' }),
  })
  .refine((body) => body.newPassword === body.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
