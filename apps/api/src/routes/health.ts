import { Router } from 'express';

/** Liveness only. A readiness check that includes the database is added with persistence (Phase 6). */
export function healthRouter(): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  return router;
}
