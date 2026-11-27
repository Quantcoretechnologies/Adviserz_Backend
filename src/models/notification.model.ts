import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { NotificationType } from './enums.js';

/**
 * An in-app notification for a customer. Never deleted; the only change the
 * database allows is setting `readAt` on an unread notification.
 */
export class Notification extends Model<InferAttributes<Notification>, InferCreationAttributes<Notification>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare type: NotificationType;
  declare title: string;
  declare body: string;
  /** In-app path to open, e.g. "/risk-notice". */
  declare link: string | null;
  declare data: Record<string, unknown> | null;
  declare readAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
}

Notification.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.STRING(50), allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    link: { type: DataTypes.STRING(200), allowNull: true },
    data: { type: DataTypes.JSONB, allowNull: true },
    readAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'notifications', modelName: 'Notification', timestamps: false },
);
