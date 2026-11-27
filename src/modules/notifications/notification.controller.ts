import type { Request, Response } from 'express';
import { requireUserAuth } from '../../common/middleware/authenticate.js';
import { sendSuccess } from '../../common/http/response.js';
import { paginationQuery, parseInput } from '../../common/utils/validation.js';
import { markReadBody } from './notification.schemas.js';
import * as service from './notification.service.js';

export async function listNotifications(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { page, pageSize } = parseInput(paginationQuery, req.query);
  sendSuccess(res, await service.listNotifications(userId, page, pageSize));
}

export async function getUnreadCount(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, { unreadCount: await service.countUnread(userId) });
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  const { ids } = parseInput(markReadBody, req.body);
  sendSuccess(res, await service.markRead(userId, ids));
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  const { userId } = requireUserAuth(req);
  sendSuccess(res, await service.markAllRead(userId));
}
