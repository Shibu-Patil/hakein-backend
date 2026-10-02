import { Router } from 'express';

export const healthRoutes = Router();

healthRoutes.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});