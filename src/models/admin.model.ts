import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { AdminStatus } from './enums.js';

/**
 * A staff account. Never hard-deleted: `isDeleted` hides it and keeps the row.
 * Queries that look an admin up for sign-in or authentication must filter on
 * `isDeleted` themselves — there is deliberately no default scope hiding
 * deleted rows, so history screens can still resolve their names.
 */
export class Admin extends Model<InferAttributes<Admin>, InferCreationAttributes<Admin>> {
  declare id: CreationOptional<string>;
  declare fullName: string;
  declare email: string;
  declare passwordHash: string;
  /** Holds every permission. Everyone else gets access from roles. */
  declare isSuperAdmin: CreationOptional<boolean>;
  /** The admin who created this account (their one parent). NULL only for a seeded super admin. */
  declare createdByAdminId: CreationOptional<string | null>;
  declare mustChangePassword: CreationOptional<boolean>;
  declare status: CreationOptional<AdminStatus>;
  declare disabledAt: CreationOptional<Date | null>;
  declare disabledReason: CreationOptional<string | null>;
  declare disabledByAdminId: CreationOptional<string | null>;
  declare isDeleted: CreationOptional<boolean>;
  declare deletedAt: CreationOptional<Date | null>;
  declare deletedByAdminId: CreationOptional<string | null>;
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
    isSuperAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdByAdminId: { type: DataTypes.UUID, allowNull: true },
    mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    disabledAt: { type: DataTypes.DATE, allowNull: true },
    disabledReason: { type: DataTypes.STRING(500), allowNull: true },
    disabledByAdminId: { type: DataTypes.UUID, allowNull: true },
    isDeleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
    deletedByAdminId: { type: DataTypes.UUID, allowNull: true },
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
