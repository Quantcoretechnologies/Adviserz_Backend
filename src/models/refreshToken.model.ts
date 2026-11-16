import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export class RefreshToken extends Model<InferAttributes<RefreshToken>, InferCreationAttributes<RefreshToken>> {
  declare id: CreationOptional<string>;
  declare sessionId: string;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare rotatedAt: CreationOptional<Date | null>;
  declare replacedById: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

RefreshToken.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    sessionId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    rotatedAt: { type: DataTypes.DATE, allowNull: true },
    replacedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'refresh_tokens', modelName: 'RefreshToken', updatedAt: false },
);
