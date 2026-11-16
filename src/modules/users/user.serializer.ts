import type { User } from '../../models/index.js';

/** The only shape in which a user record leaves the API. Never includes secrets. */
export function serializeUser(user: User) {
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    phone: user.phone,
    status: user.status,
    onboardingStatus: user.onboardingStatus,
    onboardingCompletedAt: user.onboardingCompletedAt,
    emailVerifiedAt: user.emailVerifiedAt,
    phoneVerifiedAt: user.phoneVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export type SerializedUser = ReturnType<typeof serializeUser>;
