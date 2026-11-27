/**
 * Model registry. Importing this module registers every model on the shared
 * Sequelize instance and wires associations exactly once.
 *
 * Application code imports models from here, never from individual files, so
 * associations are always in place.
 */
import { Admin } from './admin.model.js';
import { AdminRole, AdminRoleAssignment, AdminRolePermission } from './adminRole.model.js';
import { AuditLog } from './auditLog.model.js';
import { AuthSession } from './authSession.model.js';
import { Broker, BrokerConnection, BrokerFundSnapshot } from './broker.model.js';
import { Notification } from './notification.model.js';
import { PolicyAcceptance, PolicyDocument } from './policy.model.js';
import { RefreshToken } from './refreshToken.model.js';
import {
  RiskAcknowledgement,
  RiskNoticeAcceptance,
  RiskNoticeAcceptanceSegment,
} from './riskAcknowledgement.model.js';
import { RiskProfile, RiskProfileSegment } from './riskProfile.model.js';
import { RiskBand, RiskRuleSet } from './riskRule.model.js';
import { Segment } from './segment.model.js';
import { User } from './user.model.js';
import { VerificationRequest } from './verificationRequest.model.js';

// Users & sessions
User.hasMany(AuthSession, { foreignKey: 'userId', as: 'sessions' });
AuthSession.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Admin.hasMany(AuthSession, { foreignKey: 'adminId', as: 'sessions' });
AuthSession.belongsTo(Admin, { foreignKey: 'adminId', as: 'admin' });
AuthSession.hasMany(RefreshToken, { foreignKey: 'sessionId', as: 'refreshTokens' });
RefreshToken.belongsTo(AuthSession, { foreignKey: 'sessionId', as: 'session' });

// Staff hierarchy, roles
Admin.belongsTo(Admin, { foreignKey: 'createdByAdminId', as: 'creator' });
Admin.hasMany(Admin, { foreignKey: 'createdByAdminId', as: 'directReports' });
AdminRole.belongsTo(Admin, { foreignKey: 'createdByAdminId', as: 'owner' });
AdminRole.hasMany(AdminRolePermission, { foreignKey: 'roleId', as: 'permissions' });
AdminRolePermission.belongsTo(AdminRole, { foreignKey: 'roleId', as: 'role' });
AdminRole.hasMany(AdminRoleAssignment, { foreignKey: 'roleId', as: 'assignments' });
AdminRoleAssignment.belongsTo(AdminRole, { foreignKey: 'roleId', as: 'role' });
AdminRoleAssignment.belongsTo(Admin, { foreignKey: 'adminId', as: 'admin' });

// Risk profiles
User.hasMany(RiskProfile, { foreignKey: 'userId', as: 'riskProfiles' });
RiskProfile.belongsTo(User, { foreignKey: 'userId', as: 'user' });
RiskProfile.hasMany(RiskProfileSegment, { foreignKey: 'riskProfileId', as: 'segments' });
RiskProfileSegment.belongsTo(RiskProfile, { foreignKey: 'riskProfileId', as: 'riskProfile' });
RiskProfileSegment.belongsTo(Segment, { foreignKey: 'segmentId', as: 'segment' });
Segment.hasMany(RiskProfileSegment, { foreignKey: 'segmentId', as: 'riskProfileSegments' });

// Risk bands, acknowledgements and change notices
Segment.hasMany(RiskRuleSet, { foreignKey: 'segmentId', as: 'riskRuleSets' });
RiskRuleSet.belongsTo(Segment, { foreignKey: 'segmentId', as: 'segment' });
RiskRuleSet.hasMany(RiskBand, { foreignKey: 'ruleSetId', as: 'bands' });
RiskBand.belongsTo(RiskRuleSet, { foreignKey: 'ruleSetId', as: 'ruleSet' });
RiskRuleSet.belongsTo(Admin, { foreignKey: 'createdByAdminId', as: 'createdBy' });
RiskProfileSegment.belongsTo(RiskRuleSet, { foreignKey: 'ruleSetId', as: 'ruleSet' });
RiskProfileSegment.belongsTo(RiskAcknowledgement, { foreignKey: 'riskAcknowledgementId', as: 'riskAcknowledgement' });
RiskAcknowledgement.belongsTo(Segment, { foreignKey: 'segmentId', as: 'segment' });
RiskAcknowledgement.belongsTo(RiskRuleSet, { foreignKey: 'ruleSetId', as: 'ruleSet' });
RiskAcknowledgement.belongsTo(PolicyDocument, { foreignKey: 'policyDocumentId', as: 'policyDocument' });
RiskNoticeAcceptance.hasMany(RiskNoticeAcceptanceSegment, { foreignKey: 'acceptanceId', as: 'segments' });
RiskNoticeAcceptanceSegment.belongsTo(RiskNoticeAcceptance, { foreignKey: 'acceptanceId', as: 'acceptance' });
RiskNoticeAcceptance.belongsTo(PolicyDocument, { foreignKey: 'policyDocumentId', as: 'policyDocument' });

// Policies
PolicyDocument.hasMany(PolicyAcceptance, { foreignKey: 'policyDocumentId', as: 'acceptances' });
PolicyAcceptance.belongsTo(PolicyDocument, { foreignKey: 'policyDocumentId', as: 'policyDocument' });
User.hasMany(PolicyAcceptance, { foreignKey: 'userId', as: 'policyAcceptances' });
PolicyAcceptance.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Brokers
User.hasMany(BrokerConnection, { foreignKey: 'userId', as: 'brokerConnections' });
BrokerConnection.belongsTo(User, { foreignKey: 'userId', as: 'user' });
BrokerConnection.belongsTo(Broker, { foreignKey: 'brokerId', as: 'broker' });
Broker.hasMany(BrokerConnection, { foreignKey: 'brokerId', as: 'connections' });
BrokerConnection.hasMany(BrokerFundSnapshot, { foreignKey: 'brokerConnectionId', as: 'fundSnapshots' });
BrokerFundSnapshot.belongsTo(BrokerConnection, { foreignKey: 'brokerConnectionId', as: 'connection' });

// Notifications
User.hasMany(Notification, { foreignKey: 'userId', as: 'notifications' });
Notification.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Verification
User.hasMany(VerificationRequest, { foreignKey: 'userId', as: 'verificationRequests' });
VerificationRequest.belongsTo(User, { foreignKey: 'userId', as: 'user' });

export {
  Admin,
  AdminRole,
  AdminRoleAssignment,
  AdminRolePermission,
  AuditLog,
  AuthSession,
  Broker,
  BrokerConnection,
  BrokerFundSnapshot,
  Notification,
  PolicyAcceptance,
  PolicyDocument,
  RefreshToken,
  RiskAcknowledgement,
  RiskBand,
  RiskNoticeAcceptance,
  RiskNoticeAcceptanceSegment,
  RiskProfile,
  RiskProfileSegment,
  RiskRuleSet,
  Segment,
  User,
  VerificationRequest,
};
