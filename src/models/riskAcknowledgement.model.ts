import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type {
  RiskAcknowledgementLevel,
  RiskAcknowledgementSource,
  RiskBasis,
  RiskNoticeStatus,
} from './enums.js';

/**
 * A disclaimer the user accepted for a risk choice above the suggested or the
 * maximum level. Append-only (DB trigger). Only ever call `create`.
 */
export class RiskAcknowledgement extends Model<
  InferAttributes<RiskAcknowledgement>,
  InferCreationAttributes<RiskAcknowledgement>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare segmentId: string;
  declare riskProfileId: string;
  declare ruleSetId: string;
  declare source: RiskAcknowledgementSource;
  declare level: RiskAcknowledgementLevel;
  declare riskBasis: RiskBasis;
  declare currency: string;
  declare capital: string;
  declare riskPercent: string;
  declare riskAmount: string;
  declare bandCapitalFrom: string;
  declare bandMinPercent: string;
  declare bandSuggestedPercent: string;
  declare bandMaxPercent: string;
  declare previousCapital: string | null;
  declare previousRiskPercent: string | null;
  declare policyDocumentId: string;
  declare policyContentSha256: string;
  declare statement: string;
  declare statementSha256: string;
  declare typedConfirmation: string | null;
  declare ipAddress: string | null;
  declare userAgent: string | null;
  declare requestId: string | null;
  declare createdAt: CreationOptional<Date>;
}

/** A risk-limit change notice the user accepted, exactly as shown. Append-only. */
export class RiskNoticeAcceptance extends Model<
  InferAttributes<RiskNoticeAcceptance>,
  InferCreationAttributes<RiskNoticeAcceptance>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare riskProfileId: string;
  declare notice: Record<string, unknown>;
  declare noticeSha256: string;
  declare policyDocumentId: string;
  declare policyContentSha256: string;
  declare statement: string;
  declare ipAddress: string | null;
  declare userAgent: string | null;
  declare requestId: string | null;
  declare createdAt: CreationOptional<Date>;
}

/** One segment covered by an accepted notice. Append-only. */
export class RiskNoticeAcceptanceSegment extends Model<
  InferAttributes<RiskNoticeAcceptanceSegment>,
  InferCreationAttributes<RiskNoticeAcceptanceSegment>
> {
  declare id: CreationOptional<string>;
  declare acceptanceId: string;
  declare userId: string;
  declare segmentId: string;
  declare fromRuleSetId: string | null;
  declare toRuleSetId: string;
  declare toVersion: number;
  declare status: RiskNoticeStatus;
  declare valuesChanged: boolean;
  declare riskAcknowledgementId: string | null;
  declare createdAt: CreationOptional<Date>;
}

const money = () => ({ type: DataTypes.DECIMAL(18, 2), allowNull: false });
const percent = () => ({ type: DataTypes.DECIMAL(9, 4), allowNull: false });

RiskAcknowledgement.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    segmentId: { type: DataTypes.UUID, allowNull: false },
    riskProfileId: { type: DataTypes.UUID, allowNull: false },
    ruleSetId: { type: DataTypes.UUID, allowNull: false },
    source: { type: DataTypes.STRING(20), allowNull: false },
    level: { type: DataTypes.STRING(20), allowNull: false },
    riskBasis: { type: DataTypes.STRING(30), allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    capital: money(),
    riskPercent: percent(),
    riskAmount: money(),
    bandCapitalFrom: money(),
    bandMinPercent: percent(),
    bandSuggestedPercent: percent(),
    bandMaxPercent: percent(),
    previousCapital: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
    previousRiskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: true },
    policyDocumentId: { type: DataTypes.UUID, allowNull: false },
    policyContentSha256: { type: DataTypes.CHAR(64), allowNull: false },
    statement: { type: DataTypes.TEXT, allowNull: false },
    statementSha256: { type: DataTypes.CHAR(64), allowNull: false },
    typedConfirmation: { type: DataTypes.STRING(100), allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    requestId: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'risk_acknowledgements', modelName: 'RiskAcknowledgement', updatedAt: false },
);

RiskNoticeAcceptance.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    riskProfileId: { type: DataTypes.UUID, allowNull: false },
    notice: { type: DataTypes.JSONB, allowNull: false },
    noticeSha256: { type: DataTypes.CHAR(64), allowNull: false },
    policyDocumentId: { type: DataTypes.UUID, allowNull: false },
    policyContentSha256: { type: DataTypes.CHAR(64), allowNull: false },
    statement: { type: DataTypes.TEXT, allowNull: false },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    requestId: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'risk_notice_acceptances', modelName: 'RiskNoticeAcceptance', updatedAt: false },
);

RiskNoticeAcceptanceSegment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    acceptanceId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    segmentId: { type: DataTypes.UUID, allowNull: false },
    fromRuleSetId: { type: DataTypes.UUID, allowNull: true },
    toRuleSetId: { type: DataTypes.UUID, allowNull: false },
    toVersion: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    valuesChanged: { type: DataTypes.BOOLEAN, allowNull: false },
    riskAcknowledgementId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'risk_notice_acceptance_segments',
    modelName: 'RiskNoticeAcceptanceSegment',
    updatedAt: false,
  },
);
