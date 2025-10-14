import { OrderManagerRedis } from '../services/orderManagerRedis';
import { MatchingEngine } from '../services/matchingEngine';

declare global {
  namespace Express {
    interface Request {
      orderManager: OrderManagerRedis;
      matchingEngine: MatchingEngine;
    }
  }
}
