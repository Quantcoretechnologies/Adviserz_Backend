import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { AuditActorType, AuditOutcome, AuditSeverity } from './enums.js';

/** Append-only (enforced by a DB trigger). Only ever call `create`. */
export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  /** BIGINT identity — returned by pg as a string. */
  declare id: CreationOptional<string>;
  declare occurredAt: CreationOptional<Date>;
  declare actorType: AuditActorType;
  declare actorId: CreationOptional<string | null>;
  declare action: string;
  declare entityType: CreationOptional<string | null>;
  declare entityId: CreationOptional<string | null>;
  declare subjectUserId: CreationOptional<string | null>;
  declare severity: CreationOptional<AuditSeverity>;
  declare outcome: CreationOptional<AuditOutcome>;
  declare beforeData: CreationOptional<Record<string, unknown> | null>;
  declare afterData: CreationOptional<Record<string, unknown> | null>;
  declare metadata: CreationOptional<Record<string, unknown> | null>;
  declare ipAddress: CreationOptional<string | null>;
  declare userAgent: CreationOptional<string | null>;
  declare requestId: CreationOptional<string | null>;
}

AuditLog.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    actorType: { type: DataTypes.STRING(20), allowNull: false },
    actorId: { type: DataTypes.UUID, allowNull: true },
    action: { type: DataTypes.STRING(100), allowNull: false },
    entityType: { type: DataTypes.STRING(50), allowNull: true },
    entityId: { type: DataTypes.STRING(64), allowNull: true },
    subjectUserId: { type: DataTypes.UUID, allowNull: true },
    severity: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'info' },
    outcome: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'success' },
    beforeData: { type: DataTypes.JSONB, allowNull: true },
    afterData: { type: DataTypes.JSONB, allowNull: true },
    metadata: { type: DataTypes.JSONB, allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    requestId: { type: DataTypes.STRING(64), allowNull: true },
  },
  { sequelize, tableName: 'audit_logs', modelName: 'AuditLog', timestamps: false },
);
