/**
 * Every auditable action, namespaced `<area>.<event>`. Stored verbatim in
 * audit_logs.action — never rename an existing value (it would break history
 * queries); add new ones instead.
 */
export const AuditAction = {
  // Verification / OTP
  OTP_SENT: 'verification.otp_sent',
  OTP_DELIVERY_FAILED: 'verification.otp_delivery_failed',
  OTP_VERIFIED: 'verification.otp_verified',
  OTP_VERIFY_FAILED: 'verification.otp_verify_failed',

  // User auth
  USER_REGISTERED: 'auth.user_registered',
  USER_LOGIN_SUCCEEDED: 'auth.login_succeeded',
  USER_LOGIN_FAILED: 'auth.login_failed',
  USER_ACCOUNT_LOCKED: 'auth.account_locked',
  USER_LOGGED_OUT: 'auth.logged_out',
  SESSION_REFRESHED: 'auth.session_refreshed',
  REFRESH_TOKEN_REUSE_DETECTED: 'auth.refresh_token_reuse_detected',
  LOGIN_OTP_REQUESTED: 'auth.login_otp_requested',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',

  // User self-service
  PROFILE_UPDATED: 'user.profile_updated',
  PASSWORD_CHANGED: 'user.password_changed',
  SESSION_REVOKED: 'user.session_revoked',
  SESSIONS_REVOKED: 'user.sessions_revoked',

  // Onboarding / risk profile / policies
  ONBOARDING_CONTACT_VERIFIED: 'onboarding.contact_verified',
  ONBOARDING_SEGMENTS_SAVED: 'onboarding.segments_saved',
  ONBOARDING_EXPERIENCE_SAVED: 'onboarding.experience_saved',
  ONBOARDING_CAPITAL_SAVED: 'onboarding.capital_saved',
  ONBOARDING_RISK_SAVED: 'onboarding.risk_saved',
  ONBOARDING_BROKER_SKIPPED: 'onboarding.broker_skipped',
  ONBOARDING_COMPLETED: 'onboarding.completed',
  RISK_PROFILE_UPDATED: 'risk_profile.updated',
  POLICIES_ACCEPTED: 'policy.accepted',

  // Admin
  ADMIN_LOGIN_SUCCEEDED: 'admin.login_succeeded',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_LOGGED_OUT: 'admin.logged_out',
  ADMIN_USER_BLOCKED: 'admin.user_blocked',
  ADMIN_USER_UNBLOCKED: 'admin.user_unblocked',
  ADMIN_SEGMENT_CREATED: 'admin.segment_created',
  ADMIN_SEGMENT_UPDATED: 'admin.segment_updated',
  ADMIN_POLICY_DRAFT_CREATED: 'admin.policy_draft_created',
  ADMIN_POLICY_DRAFT_UPDATED: 'admin.policy_draft_updated',
  ADMIN_POLICY_PUBLISHED: 'admin.policy_published',
  ADMIN_PERMISSION_DENIED: 'admin.permission_denied',
  ADMIN_PASSWORD_CHANGED: 'admin.password_changed',

  // Staff and roles
  STAFF_CREATED: 'staff.created',
  STAFF_UPDATED: 'staff.updated',
  STAFF_BLOCKED: 'staff.blocked',
  STAFF_UNBLOCKED: 'staff.unblocked',
  STAFF_PASSWORD_RESET: 'staff.password_reset',
  STAFF_ROLES_CHANGED: 'staff.roles_changed',
  STAFF_DELETED: 'staff.deleted',
  /** A deleted super admin's staff and roles were moved under the admin who deleted them. */
  STAFF_TRANSFERRED: 'staff.transferred',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  /** Permissions removed from a role because its owner no longer holds them. */
  ROLE_PERMISSIONS_CASCADE_REVOKED: 'role.permissions_cascade_revoked',

  // System
  SUPER_ADMIN_SEEDED: 'system.super_admin_seeded',
  PERMISSION_CATALOG_SYNCED: 'system.permission_catalog_synced',
  EXPIRED_AUTH_DATA_PURGED: 'system.expired_auth_data_purged',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
