import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { PolicyStatus, PolicyType } from './enums.js';

export class PolicyDocument extends Model<InferAttributes<PolicyDocument>, InferCreationAttributes<PolicyDocument>> {
  declare id: CreationOptional<string>;
  declare type: PolicyType;
  declare version: number;
  declare title: string;
  declare content: string;
  declare contentSha256: string;
  declare status: CreationOptional<PolicyStatus>;
  declare publishedAt: CreationOptional<Date | null>;
  declare createdByAdminId: CreationOptional<string | null>;
  declare publishedByAdminId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class PolicyAcceptance extends Model<
  InferAttributes<PolicyAcceptance>,
  InferCreationAttributes<PolicyAcceptance>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare policyDocumentId: string;
  declare acceptedAt: CreationOptional<Date>;
  declare ipAddress: CreationOptional<string | null>;
  declare userAgent: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

PolicyDocument.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    type: { type: DataTypes.STRING(40), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    contentSha256: { type: DataTypes.CHAR(64), allowNull: false, field: 'content_sha256' },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
    createdByAdminId: { type: DataTypes.UUID, allowNull: true },
    publishedByAdminId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'policy_documents', modelName: 'PolicyDocument' },
);

PolicyAcceptance.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    policyDocumentId: { type: DataTypes.UUID, allowNull: false },
    acceptedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'policy_acceptances', modelName: 'PolicyAcceptance', updatedAt: false },
);
