import express from 'express';

import type { createClientDiagnosticsService } from './client-diagnostics.service.js';
import type { createSystemUpdateService } from './system.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

/** Creates thin system routes that delegate update execution and diagnostics logging to their services. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  clientDiagnosticsService: ReturnType<typeof createClientDiagnosticsService>,
): express.Router {
  const router = express.Router();

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  // One browser diagnostics report (a fullscreen outcome, a system-notification decision) becomes one server log line.
  router.post('/client-diagnostics', (request, response) => {
    const result = clientDiagnosticsService.record({
      userId: (request as AuthenticatedRequest).user?.id ?? null,
      userAgent: request.get('user-agent'),
      body: request.body,
    });
    if (result.status === 204) {
      response.status(204).end();
      return;
    }
    response.status(result.status).json({ success: false, error: { code: result.code, message: result.message } });
  });

  return router;
}
