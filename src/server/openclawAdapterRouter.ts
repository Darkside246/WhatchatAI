import { Router } from 'express';
import { handleOpenClawToolInvokeRequest } from '../services/openclawAdapterService.js';

/**
 * The HTTP surface an actual OpenClaw cell calls into. Deliberately a
 * thin wrapper - all real logic (Bearer-token auth, request validation,
 * authorization) lives in `openclawAdapterService.ts`, already covered by
 * its own tests; this file only translates an Express request/response
 * into that function's plain input/output.
 *
 * Mounted at `/api/openclaw` in `server/index.ts`, outside the
 * session-cookie `requireAuth` gate that guards `/api/workspace` - a
 * Fleet cell has no browser session, it authenticates with its own
 * callback token instead.
 */
export const openclawAdapterRouter = Router();

openclawAdapterRouter.post('/tools/invoke', async (req, res) => {
  const { httpStatus, body } = await handleOpenClawToolInvokeRequest(req.headers.authorization, req.body);
  res.status(httpStatus).json(body);
});
