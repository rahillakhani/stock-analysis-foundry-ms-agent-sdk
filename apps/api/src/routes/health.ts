import { Router } from 'express';

/**
 * `/healthz`: liveness (the process is up). `/readyz`: readiness (dependencies such as the database answer); returns
 * 503 without detail when the check fails, so load balancers stop routing traffic here.
 */
const READINESS_TIMEOUT_MS = 2_000;

export function healthRouter(readiness?: () => Promise<void>, timeoutMs = READINESS_TIMEOUT_MS): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  router.get('/readyz', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      // A hung dependency must still produce a fast 503 for load-balancer probes.
      await Promise.race([
        readiness?.(),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs).unref();
        }),
      ]);
      res.json({ status: 'ready' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });
  return router;
}
