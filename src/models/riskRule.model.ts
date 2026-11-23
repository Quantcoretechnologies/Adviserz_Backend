import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { RiskRuleSetSource, SuggestedRiskMode } from './enums.js';

/**
 * One version of a segment's capital-band risk limits. Append-only (DB
 * trigger): a change is always a new version. The highest version is in force.
 */
export class RiskRuleSet extends Model<InferAttributes<RiskRuleSet>, InferCreationAttributes<RiskRuleSet>> {
  declare id: CreationOptional<string>;
  declare segmentId: string;
  declare version: number;
  declare suggestedMode: SuggestedRiskMode;
  declare source: RiskRuleSetSource;
  declare notifyUsers: boolean;
  declare changeSummary: CreationOptional<Record<string, unknown> | null>;
  declare createdByAdminId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;

  declare bands?: NonAttribute<RiskBand[]>;
}

/** One capital band of a rule set. NUMERIC columns are strings end-to-end. */
export class RiskBand extends Model<InferAttributes<RiskBand>, InferCreationAttributes<RiskBand>> {
  declare id: CreationOptional<string>;
  declare ruleSetId: string;
  declare capitalFrom: string;
  declare minRiskPercent: string;
  declare suggestedRiskPercent: string;
  declare maxRiskPercent: string;
  declare createdAt: CreationOptional<Date>;
}

RiskRuleSet.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    segmentId: { type: DataTypes.UUID, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    suggestedMode: { type: DataTypes.STRING(20), allowNull: false },
    source: { type: DataTypes.STRING(20), allowNull: false },
    notifyUsers: { type: DataTypes.BOOLEAN, allowNull: false },
    changeSummary: { type: DataTypes.JSONB, allowNull: true },
    createdByAdminId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'segment_risk_rule_sets', modelName: 'RiskRuleSet', updatedAt: false },
);

RiskBand.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    ruleSetId: { type: DataTypes.UUID, allowNull: false },
    capitalFrom: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    minRiskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: false },
    suggestedRiskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: false },
    maxRiskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'segment_risk_bands', modelName: 'RiskBand', updatedAt: false },
);
