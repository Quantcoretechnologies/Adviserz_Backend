import { Op, type Transaction } from 'sequelize';
import { toPagination } from '../../common/utils/validation.js';
import type { NotificationType } from '../../models/enums.js';
import { Notification } from '../../models/index.js';
import { afterCommitPush, emitToUser } from '../realtime/realtime.emitter.js';
import { serializeNotification } from './notification.serializer.js';

export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Save notifications as part of the caller's transaction, and push each one
 * live only once that transaction has committed — a rolled-back change never
 * notifies anyone. Customers who are offline see them in the bell later.
 */
export async function createNotifications(items: readonly NewNotification[], transaction: Transaction): Promise<void> {
  if (items.length === 0) return;
  const rows = await Notification.bulkCreate(
    items.map((item) => ({ ...item, data: item.data ?? null })),
    { transaction, returning: true },
  );
  afterCommitPush(transaction, 'notification:new', () => {
    for (const row of rows) emitToUser(row.userId, 'notification:new', { notification: serializeNotification(row) });
  });
}

export async function countUnread(userId: string, transaction?: Transaction): Promise<number> {
  return Notification.count({ where: { userId, readAt: null }, transaction });
}

/** The bell: newest first, with the unread count for the badge. */
export async function listNotifications(userId: string, page: number, pageSize: number) {
  const [{ rows, count }, unreadCount] = await Promise.all([
    Notification.findAndCountAll({
      where: { userId },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    countUnread(userId),
  ]);
  return {
    items: rows.map(serializeNotification),
    unreadCount,
    pagination: toPagination(page, pageSize, count),
  };
}

/** Tell the customer's other tabs and devices to refresh their badge. */
async function announceRead(userId: string): Promise<number> {
  const unreadCount = await countUnread(userId);
  emitToUser(userId, 'notification:read', { unreadCount });
  return unreadCount;
}

/**
 * Mark some of the customer's notifications read. Ids that are not theirs,
 * unknown or already read are ignored, so the call is safe to repeat.
 */
export async function markRead(userId: string, ids: readonly string[]) {
  const [updated] = await Notification.update(
    { readAt: new Date() },
    { where: { userId, id: { [Op.in]: [...ids] }, readAt: null } },
  );
  const unreadCount = updated > 0 ? await announceRead(userId) : await countUnread(userId);
  return { updated, unreadCount };
}

export async function markAllRead(userId: string) {
  const [updated] = await Notification.update({ readAt: new Date() }, { where: { userId, readAt: null } });
  const unreadCount = updated > 0 ? await announceRead(userId) : 0;
  return { updated, unreadCount };
}

/**
 * Mark read the unread risk alerts about one segment for customers who no
 * longer have anything to accept there, inside the caller's transaction.
 * Their open devices are told once it commits.
 */
export async function settleRiskAlerts(
  userIds: readonly string[],
  segmentId: string,
  transaction: Transaction,
): Promise<void> {
  if (userIds.length === 0) return;
  const [, rows] = await Notification.update(
    { readAt: new Date() },
    {
      where: {
        userId: { [Op.in]: [...userIds] },
        type: 'risk_notice.required',
        readAt: null,
        data: { segmentId },
      },
      transaction,
      returning: true,
    },
  );
  const affected = [...new Set(rows.map((row) => row.userId))];
  if (affected.length === 0) return;
  afterCommitPush(transaction, 'notification:read', async () => {
    for (const userId of affected) await announceRead(userId);
  });
}

/**
 * Mark every unread notification of one type read, inside the caller's
 * transaction — e.g. risk-notice alerts once the customer accepts the notice.
 */
export async function markTypeRead(userId: string, type: NotificationType, transaction: Transaction): Promise<void> {
  const [updated] = await Notification.update(
    { readAt: new Date() },
    { where: { userId, type, readAt: null }, transaction },
  );
  if (updated > 0) {
    afterCommitPush(transaction, 'notification:read', async () => {
      await announceRead(userId);
    });
  }
}
