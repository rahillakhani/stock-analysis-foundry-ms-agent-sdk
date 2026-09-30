import { Router } from 'express';

/**
 * `/healthz`: liveness (the process is up). `/readyz`: readiness (dependencies such as the database answer); returns
 * 503 without detail when the check fails, so load balancers stop routing traffic here.
 */
export function healthRouter(readiness?: () => Promise<void>): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  router.get('/readyz', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await readiness?.();
      res.json({ status: 'ready' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}
