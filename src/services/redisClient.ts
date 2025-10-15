import { Redis } from '@upstash/redis';

// Redis client configuration using Upstash
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

console.log('✅ Redis client configured with Upstash');

export { redis };
