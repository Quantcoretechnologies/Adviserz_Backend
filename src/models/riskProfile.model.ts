import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type {
  BrokerStepStatus,
  MarketExperience,
  RiskBasis,
  RiskProfileSource,
  RiskProfileStatus,
} from './enums.js';
import type { Segment } from './segment.model.js';

export class RiskProfile extends Model<InferAttributes<RiskProfile>, InferCreationAttributes<RiskProfile>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare version: number;
  declare status: RiskProfileStatus;
  declare source: RiskProfileSource;
  declare marketExperience: CreationOptional<MarketExperience | null>;
  declare brokerStepStatus: CreationOptional<BrokerStepStatus | null>;
  declare confirmedAt: CreationOptional<Date | null>;
  declare supersededAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare segments?: NonAttribute<RiskProfileSegment[]>;
}

export class RiskProfileSegment extends Model<
  InferAttributes<RiskProfileSegment>,
  InferCreationAttributes<RiskProfileSegment>
> {
  declare id: CreationOptional<string>;
  declare riskProfileId: ForeignKey<RiskProfile['id']>;
  declare segmentId: string;
  declare riskBasis: RiskBasis;
  declare currency: CreationOptional<string>;
  declare capital: CreationOptional<string | null>;
  declare riskPercent: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare segment?: NonAttribute<Segment>;
}

RiskProfile.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    source: { type: DataTypes.STRING(20), allowNull: false },
    marketExperience: { type: DataTypes.STRING(20), allowNull: true },
    brokerStepStatus: { type: DataTypes.STRING(20), allowNull: true },
    confirmedAt: { type: DataTypes.DATE, allowNull: true },
    supersededAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'risk_profiles', modelName: 'RiskProfile' },
);

RiskProfileSegment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    riskProfileId: { type: DataTypes.UUID, allowNull: false },
    segmentId: { type: DataTypes.UUID, allowNull: false },
    riskBasis: { type: DataTypes.STRING(30), allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'INR' },
    capital: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
    riskPercent: { type: DataTypes.DECIMAL(9, 4), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'risk_profile_segments', modelName: 'RiskProfileSegment' },
);
