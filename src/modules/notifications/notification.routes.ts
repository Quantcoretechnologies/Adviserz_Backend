import { Router } from 'express';
import * as controller from './notification.controller.js';

/**
 * Mounted at {API_PREFIX}/users/me/notifications, behind authenticateUser.
 * Always available — like /policies — so a customer who is blocked by a
 * pending risk notice or policy can still see why.
 *
 *   GET  /?page=&pageSize=     newest first, with unreadCount
 *   GET  /unread-count
 *   POST /read                 { ids: [uuid] }  ignores ids that are not the user's or already read
 *   POST /read-all
 */
export const notificationsRouter = Router();

notificationsRouter.get('/', controller.listNotifications);
notificationsRouter.get('/unread-count', controller.getUnreadCount);
notificationsRouter.post('/read', controller.markRead);
notificationsRouter.post('/read-all', controller.markAllRead);
