import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { ClientType, SessionRevokeReason } from './enums.js';

export class AuthSession extends Model<InferAttributes<AuthSession>, InferCreationAttributes<AuthSession>> {
  declare id: CreationOptional<string>;
  declare userId: CreationOptional<string | null>;
  declare adminId: CreationOptional<string | null>;
  declare clientType: ClientType;
  declare deviceName: CreationOptional<string | null>;
  declare userAgent: CreationOptional<string | null>;
  declare ipAddress: CreationOptional<string | null>;
  declare lastUsedAt: CreationOptional<Date>;
  declare expiresAt: Date;
  declare revokedAt: CreationOptional<Date | null>;
  declare revokedReason: CreationOptional<SessionRevokeReason | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  isActive(now: Date = new Date()): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > now.getTime();
  }
}

AuthSession.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: true },
    adminId: { type: DataTypes.UUID, allowNull: true },
    clientType: { type: DataTypes.STRING(10), allowNull: false },
    deviceName: { type: DataTypes.STRING(100), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    lastUsedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    revokedReason: { type: DataTypes.STRING(50), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'auth_sessions', modelName: 'AuthSession' },
);
