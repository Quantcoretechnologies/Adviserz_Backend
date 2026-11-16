import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { AdminRole, AdminStatus } from './enums.js';

export class Admin extends Model<InferAttributes<Admin>, InferCreationAttributes<Admin>> {
  declare id: CreationOptional<string>;
  declare fullName: string;
  declare email: string;
  declare passwordHash: string;
  declare role: CreationOptional<AdminRole>;
  declare status: CreationOptional<AdminStatus>;
  declare failedLoginAttempts: CreationOptional<number>;
  declare lockedUntil: CreationOptional<Date | null>;
  declare lastLoginAt: CreationOptional<Date | null>;
  declare passwordChangedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Admin.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    fullName: { type: DataTypes.STRING(100), allowNull: false },
    email: { type: DataTypes.STRING(254), allowNull: false },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'super_admin' },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    failedLoginAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lockedUntil: { type: DataTypes.DATE, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
    passwordChangedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'admins',
    modelName: 'Admin',
    defaultScope: { attributes: { exclude: ['passwordHash'] } },
    scopes: { withSecrets: { attributes: { include: ['passwordHash'] } } },
  },
);
