import { OrderManagerRedis } from '../services/orderManagerRedis';
import { MatchingEngine } from '../services/matchingEngine';
import { StacksSettlementService } from '../services/stacksSettlement';

declare global {
  namespace Express {
    interface Request {
      orderManager: OrderManagerRedis;
      matchingEngine: MatchingEngine;
      settlementService?: StacksSettlementService;
    }
  }
}
