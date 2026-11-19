/**
 * Domain value sets. Each mirrors a CHECK constraint in the migrations — keep
 * both in sync when adding values (add a migration that alters the CHECK).
 */

export const USER_STATUSES = ['active', 'blocked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ADMIN_STATUSES = ['active', 'disabled'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export const ONBOARDING_STATUSES = ['pending', 'completed'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const CLIENT_TYPES = ['web', 'mobile'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const SESSION_REVOKE_REASONS = [
  'logout',
  'logout_all',
  'revoked_by_user',
  'password_changed',
  'password_reset',
  'token_reuse_detected',
  'account_blocked',
  'account_deleted',
  'expired',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

export const VERIFICATION_PURPOSES = ['registration', 'password_reset', 'login', 'contact_verification'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

export const VERIFICATION_CHANNELS = ['email', 'sms'] as const;
export type VerificationChannel = (typeof VERIFICATION_CHANNELS)[number];

export const RISK_BASES = ['total_capital', 'daily_loss'] as const;
export type RiskBasis = (typeof RISK_BASES)[number];

export const MARKET_EXPERIENCES = ['new', 'beginner', 'intermediate', 'experienced'] as const;
export type MarketExperience = (typeof MARKET_EXPERIENCES)[number];

export const RISK_PROFILE_STATUSES = ['draft', 'active', 'superseded'] as const;
export type RiskProfileStatus = (typeof RISK_PROFILE_STATUSES)[number];

export const RISK_PROFILE_SOURCES = ['onboarding', 'profile_update'] as const;
export type RiskProfileSource = (typeof RISK_PROFILE_SOURCES)[number];

export const BROKER_STEP_STATUSES = ['skipped', 'connected'] as const;
export type BrokerStepStatus = (typeof BROKER_STEP_STATUSES)[number];

export const POLICY_TYPES = ['terms_and_conditions', 'risk_policy'] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

export const POLICY_STATUSES = ['draft', 'published'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const BROKER_CONNECTION_STATUSES = ['pending', 'connected', 'expired', 'revoked', 'error'] as const;
export type BrokerConnectionStatus = (typeof BROKER_CONNECTION_STATUSES)[number];

export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system', 'anonymous'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export const AUDIT_OUTCOMES = ['success', 'failure'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
