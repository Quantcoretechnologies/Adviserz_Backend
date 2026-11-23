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

/** `risk_notice`: the user changed values while accepting a risk-limit change notice. */
export const RISK_PROFILE_SOURCES = ['onboarding', 'profile_update', 'risk_notice'] as const;
export type RiskProfileSource = (typeof RISK_PROFILE_SOURCES)[number];

/**
 * How a band's suggested risk is set: `midpoint` = (min + max) / 2, worked out
 * by the server; `manual` = typed by the admin.
 */
export const SUGGESTED_RISK_MODES = ['midpoint', 'manual'] as const;
export type SuggestedRiskMode = (typeof SUGGESTED_RISK_MODES)[number];

/** Where a version of a segment's risk bands came from. */
export const RISK_RULE_SET_SOURCES = ['migration', 'seed', 'admin'] as const;
export type RiskRuleSetSource = (typeof RISK_RULE_SET_SOURCES)[number];

/** A risk choice that needs the user's written acknowledgement. */
export const RISK_ACKNOWLEDGEMENT_LEVELS = ['above_suggested', 'above_maximum'] as const;
export type RiskAcknowledgementLevel = (typeof RISK_ACKNOWLEDGEMENT_LEVELS)[number];

/** Where the user acknowledged a risk choice. */
export const RISK_ACKNOWLEDGEMENT_SOURCES = ['onboarding', 'profile_update', 'risk_notice'] as const;
export type RiskAcknowledgementSource = (typeof RISK_ACKNOWLEDGEMENT_SOURCES)[number];

/** What a risk-limit change means for one of the user's segments. */
export const RISK_NOTICE_STATUSES = ['ok', 'needs_caution_ack', 'needs_strict_ack', 'must_change'] as const;
export type RiskNoticeStatus = (typeof RISK_NOTICE_STATUSES)[number];

export const BROKER_STEP_STATUSES = ['skipped', 'connected'] as const;
export type BrokerStepStatus = (typeof BROKER_STEP_STATUSES)[number];

/**
 * Consent policies: every user must accept the current version of each.
 * Disclaimer texts: shown at the moment a risk choice or a risk-limit change
 * needs acknowledging. A new disclaimer version does NOT ask users to accept
 * again; it is used for acknowledgements from then on.
 */
export const CONSENT_POLICY_TYPES = ['terms_and_conditions', 'risk_policy'] as const;
export const DISCLAIMER_POLICY_TYPES = [
  'risk_disclaimer_above_suggested',
  'risk_disclaimer_above_maximum',
  'risk_limits_change_notice',
] as const;
export type DisclaimerPolicyType = (typeof DISCLAIMER_POLICY_TYPES)[number];

export const POLICY_TYPES = [...CONSENT_POLICY_TYPES, ...DISCLAIMER_POLICY_TYPES] as const;
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
