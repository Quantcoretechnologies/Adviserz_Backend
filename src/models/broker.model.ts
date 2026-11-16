import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { BrokerConnectionStatus } from './enums.js';

export class Broker extends Model<InferAttributes<Broker>, InferCreationAttributes<Broker>> {
  declare id: CreationOptional<string>;
  declare code: string;
  declare name: string;
  declare isActive: CreationOptional<boolean>;
  declare displayOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class BrokerConnection extends Model<
  InferAttributes<BrokerConnection>,
  InferCreationAttributes<BrokerConnection>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare brokerId: string;
  declare status: CreationOptional<BrokerConnectionStatus>;
  declare brokerClientId: CreationOptional<string | null>;
  declare accessTokenEncrypted: CreationOptional<string | null>;
  declare refreshTokenEncrypted: CreationOptional<string | null>;
  declare tokenExpiresAt: CreationOptional<Date | null>;
  declare connectedAt: CreationOptional<Date | null>;
  declare disconnectedAt: CreationOptional<Date | null>;
  declare lastSyncedAt: CreationOptional<Date | null>;
  declare lastError: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class BrokerFundSnapshot extends Model<
  InferAttributes<BrokerFundSnapshot>,
  InferCreationAttributes<BrokerFundSnapshot>
> {
  declare id: CreationOptional<string>;
  declare brokerConnectionId: string;
  declare availableMargin: string;
  declare usedMargin: CreationOptional<string>;
  declare totalBalance: string;
  declare currency: CreationOptional<string>;
  declare capturedAt: Date;
  declare createdAt: CreationOptional<Date>;
}

Broker.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    code: { type: DataTypes.STRING(50), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    displayOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'brokers', modelName: 'Broker' },
);

BrokerConnection.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    brokerId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    brokerClientId: { type: DataTypes.STRING(100), allowNull: true },
    accessTokenEncrypted: { type: DataTypes.TEXT, allowNull: true },
    refreshTokenEncrypted: { type: DataTypes.TEXT, allowNull: true },
    tokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    connectedAt: { type: DataTypes.DATE, allowNull: true },
    disconnectedAt: { type: DataTypes.DATE, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'broker_connections',
    modelName: 'BrokerConnection',
    defaultScope: { attributes: { exclude: ['accessTokenEncrypted', 'refreshTokenEncrypted'] } },
  },
);

BrokerFundSnapshot.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    brokerConnectionId: { type: DataTypes.UUID, allowNull: false },
    availableMargin: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    usedMargin: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: '0' },
    totalBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'INR' },
    capturedAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'broker_fund_snapshots', modelName: 'BrokerFundSnapshot', updatedAt: false },
);
