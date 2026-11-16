import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { VerificationChannel, VerificationPurpose } from './enums.js';

export class VerificationRequest extends Model<
  InferAttributes<VerificationRequest>,
  InferCreationAttributes<VerificationRequest>
> {
  declare id: CreationOptional<string>;
  declare purpose: VerificationPurpose;
  declare channel: VerificationChannel;
  declare destination: string;
  declare userId: CreationOptional<string | null>;
  declare otpHash: string;
  declare otpExpiresAt: Date;
  declare attempts: CreationOptional<number>;
  declare maxAttempts: number;
  declare verifiedAt: CreationOptional<Date | null>;
  declare tokenHash: CreationOptional<string | null>;
  declare tokenExpiresAt: CreationOptional<Date | null>;
  declare consumedAt: CreationOptional<Date | null>;
  declare invalidatedAt: CreationOptional<Date | null>;
  declare ipAddress: CreationOptional<string | null>;
  declare userAgent: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

VerificationRequest.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    purpose: { type: DataTypes.STRING(30), allowNull: false },
    channel: { type: DataTypes.STRING(10), allowNull: false },
    destination: { type: DataTypes.STRING(254), allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: true },
    otpHash: { type: DataTypes.CHAR(64), allowNull: false },
    otpExpiresAt: { type: DataTypes.DATE, allowNull: false },
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.SMALLINT, allowNull: false },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: true },
    tokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    invalidatedAt: { type: DataTypes.DATE, allowNull: true },
    ipAddress: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'verification_requests',
    modelName: 'VerificationRequest',
    defaultScope: { attributes: { exclude: ['otpHash', 'tokenHash'] } },
    scopes: { withSecrets: { attributes: { include: ['otpHash', 'tokenHash'] } } },
  },
);
