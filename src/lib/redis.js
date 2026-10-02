import IORedis from 'ioredis';

let redis = null;

export function getRedis() {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('[redis] REDIS_URL not set - queue/worker disabled, API still works');
    return null;
  }
  redis = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  redis.on('error', (e) => console.warn('[redis] error:', e.message));
  return redis;
}

export function isRedisEnabled() {
  return !!process.env.REDIS_URL;
}
