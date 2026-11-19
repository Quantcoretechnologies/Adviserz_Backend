import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';

/** Columns shared by everything that is soft-deleted (never removed). */
const softDeleteColumns = {
  isDeleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  deletedAt: { type: DataTypes.DATE, allowNull: true },
  deletedByAdminId: { type: DataTypes.UUID, allowNull: true },
} as const;

/** A custom staff role. Owned by the admin who created it; the name is free text. */
export class AdminRole extends Model<InferAttributes<AdminRole>, InferCreationAttributes<AdminRole>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare createdByAdminId: string;
  declare isDeleted: CreationOptional<boolean>;
  declare deletedAt: CreationOptional<Date | null>;
  declare deletedByAdminId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AdminRole.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    name: { type: DataTypes.STRING(80), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    createdByAdminId: { type: DataTypes.UUID, allowNull: false },
    ...softDeleteColumns,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'admin_roles', modelName: 'AdminRole' },
);

/** One ticked permission on a role. Unticking marks the row deleted. */
export class AdminRolePermission extends Model<
  InferAttributes<AdminRolePermission>,
  InferCreationAttributes<AdminRolePermission>
> {
  declare id: CreationOptional<string>;
  declare roleId: string;
  declare permissionKey: string;
  declare grantedByAdminId: string;
  declare isDeleted: CreationOptional<boolean>;
  declare deletedAt: CreationOptional<Date | null>;
  declare deletedByAdminId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AdminRolePermission.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    roleId: { type: DataTypes.UUID, allowNull: false },
    permissionKey: { type: DataTypes.STRING(100), allowNull: false },
    grantedByAdminId: { type: DataTypes.UUID, allowNull: false },
    ...softDeleteColumns,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'admin_role_permissions', modelName: 'AdminRolePermission' },
);

/** A role held by a staff member. Taking it away marks the row deleted. */
export class AdminRoleAssignment extends Model<
  InferAttributes<AdminRoleAssignment>,
  InferCreationAttributes<AdminRoleAssignment>
> {
  declare id: CreationOptional<string>;
  declare adminId: string;
  declare roleId: string;
  declare assignedByAdminId: string;
  declare isDeleted: CreationOptional<boolean>;
  declare deletedAt: CreationOptional<Date | null>;
  declare deletedByAdminId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AdminRoleAssignment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    adminId: { type: DataTypes.UUID, allowNull: false },
    roleId: { type: DataTypes.UUID, allowNull: false },
    assignedByAdminId: { type: DataTypes.UUID, allowNull: false },
    ...softDeleteColumns,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'admin_role_assignments', modelName: 'AdminRoleAssignment' },
);
