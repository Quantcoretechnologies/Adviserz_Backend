import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { RiskBasis } from './enums.js';

/** NUMERIC columns are strings end-to-end; use common/utils/decimal.ts for math. */
export class Segment extends Model<InferAttributes<Segment>, InferCreationAttributes<Segment>> {
  declare id: CreationOptional<string>;
  declare code: string;
  declare name: string;
  declare description: CreationOptional<string | null>;
  declare riskBasis: RiskBasis;
  declare minCapital: CreationOptional<string>;
  declare minRiskPercent: CreationOptional<string>;
  declare maxRiskPercent: CreationOptional<string>;
  declare currency: CreationOptional<string>;
  declare isActive: CreationOptional<boolean>;
  declare displayOrder: CreationOptional<number>;
  declare createdByAdminId: CreationOptional<string | null>;
  declare updatedByAdminId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Segment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    code: { type: DataTypes.STRING(50), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    riskBasis: { type: DataTypes.STRING(30), allowNull: false },
    minCapital: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: '0' },
    minRiskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: false, defaultValue: '0.01' },
    maxRiskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: false, defaultValue: '100' },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'INR' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    displayOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdByAdminId: { type: DataTypes.UUID, allowNull: true },
    updatedByAdminId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'segments', modelName: 'Segment' },
);
