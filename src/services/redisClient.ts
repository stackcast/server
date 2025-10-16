import { createClient } from 'redis';

// Redis client - works with both local Docker Redis and remote Redis
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = createClient({
  url: redisUrl
});

redis.on('error', (err) => console.error('❌ Redis Client Error:', err));
redis.on('connect', () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log('✅ Connected to Redis at', redisUrl);
  }
});

// Connect to Redis
(async () => {
  try {
    await redis.connect();
  } catch (err) {
    console.error('❌ Failed to connect to Redis:', err);
  }
})();

export { redis };
