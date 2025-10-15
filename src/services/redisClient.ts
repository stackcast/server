import { Redis } from '@upstash/redis';

// Redis client configuration using Upstash
const redis = Redis.fromEnv();

if (process.env.NODE_ENV !== 'test') {
  console.log('✅ Redis client configured with Upstash');
}

export { redis };
