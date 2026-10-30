import express from 'express';
import type { Request, Response } from 'express';

import {
  listDispatchWaits,
  requestDispatchPass,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
}

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const userId = readUserId(req);
    res.json(createApiSuccessResponse(
      sessionId
        ? scheduledMessagesService.listForSession(userId, sessionId)
        : scheduledMessagesService.listPending(userId),
    ));
  }),
);

/**
 * Why the user's queued and scheduled messages for a session wait, as the
 * dispatcher last worked it out: `{ waits }` (see `DispatchWait`). The
 * `dispatch_waiting` frames say when it changes.
 */
router.get(
  '/waiting',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = readString(req.query.sessionId, 'sessionId');
    res.json(createApiSuccessResponse({ waits: listDispatchWaits(readUserId(req), sessionId) }));
  }),
);

/**
 * Sends the session's queued message with the settings of the process held
 * for its loops (`useProcessSettings`), on the next pass, which runs now.
 */
router.post(
  '/queued/use-process-settings',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    scheduledMessagesService.useProcessSettingsForQueued(readUserId(req), readString(body.sessionId, 'sessionId'));
    requestDispatchPass();
    res.json(createApiSuccessResponse({ useProcessSettings: true }));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = scheduledMessagesService.schedule({
      userId: readUserId(req),
      sessionId: readString(body.sessionId, 'sessionId'),
      content: readString(body.content, 'content'),
      options: body.options,
      scheduledFor: readString(body.scheduledFor, 'scheduledFor'),
    });
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

/**
 * Changes a pending message: `{ useProcessSettings: true }` sends it with the
 * settings of the process held for its session's loops, on the next pass,
 * which runs now. Nothing else can be changed.
 */
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.useProcessSettings !== true) {
      throw new AppError('Only useProcessSettings: true can be set.', {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }
    scheduledMessagesService.useProcessSettings(readUserId(req), readString(req.params.id, 'id'));
    requestDispatchPass();
    res.json(createApiSuccessResponse({ useProcessSettings: true }));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    scheduledMessagesService.cancel(readUserId(req), readString(req.params.id, 'id'));
    res.json(createApiSuccessResponse({ cancelled: true }));
  }),
);

export default router;
