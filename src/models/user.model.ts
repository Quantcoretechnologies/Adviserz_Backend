import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { OnboardingStatus, UserStatus } from './enums.js';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare fullName: string;
  declare username: string;
  declare email: string;
  declare phone: string;
  declare passwordHash: string;
  declare emailVerifiedAt: Date;
  declare phoneVerifiedAt: Date;
  declare status: CreationOptional<UserStatus>;
  declare blockedAt: CreationOptional<Date | null>;
  declare blockedReason: CreationOptional<string | null>;
  declare blockedByAdminId: CreationOptional<string | null>;
  declare onboardingStatus: CreationOptional<OnboardingStatus>;
  declare onboardingCompletedAt: CreationOptional<Date | null>;
  declare failedLoginAttempts: CreationOptional<number>;
  declare lockedUntil: CreationOptional<Date | null>;
  declare lastLoginAt: CreationOptional<Date | null>;
  declare passwordChangedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

User.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    fullName: { type: DataTypes.STRING(100), allowNull: false },
    username: { type: DataTypes.STRING(30), allowNull: false },
    email: { type: DataTypes.STRING(254), allowNull: false },
    phone: { type: DataTypes.STRING(13), allowNull: false },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: false },
    phoneVerifiedAt: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    blockedAt: { type: DataTypes.DATE, allowNull: true },
    blockedReason: { type: DataTypes.STRING(500), allowNull: true },
    blockedByAdminId: { type: DataTypes.UUID, allowNull: true },
    onboardingStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    onboardingCompletedAt: { type: DataTypes.DATE, allowNull: true },
    failedLoginAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lockedUntil: { type: DataTypes.DATE, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    passwordChangedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'users',
    modelName: 'User',
    defaultScope: { attributes: { exclude: ['passwordHash'] } },
    scopes: { withSecrets: { attributes: { include: ['passwordHash'] } } },
  },
);
