import type { NotificationType } from '../../models/enums.js';
import type { Notification } from '../../models/index.js';

export interface SerializedNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app path to open, e.g. "/risk-notice". */
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

/** The same shape over REST and over the socket. */
export function serializeNotification(notification: Notification): SerializedNotification {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    data: notification.data,
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  };
}
