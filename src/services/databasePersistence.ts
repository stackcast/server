import { eq } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { Market, Order } from "../types/order";
import { OrderStatus, OrderSide } from "../types/order";
import type * as schema from "../db/schema";
import { markets, orders } from "../db/schema";

export class DatabasePersistence {
  constructor(private readonly db?: NeonHttpDatabase<typeof schema>) {}

  /**
   * Database initialization is now handled by Drizzle migrations.
   * Run migrations using: bun run db:generate && bun run db:migrate
   */
  async init(): Promise<void> {
    if (!this.db) return;
    // Tables are created via Drizzle migrations, not here
  }

  async upsertMarket(market: Market): Promise<void> {
    if (!this.db) return;

    await this.db
      .insert(markets)
      .values({
        marketId: market.marketId,
        conditionId: market.conditionId,
        question: market.question,
        creator: market.creator,
        yesPositionId: market.yesPositionId,
        noPositionId: market.noPositionId,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        volume24h: market.volume24h ?? 0,
        createdAt: market.createdAt,
        resolved: market.resolved,
        outcome:
          typeof market.outcome === "number" ? market.outcome : null,
      })
      .onConflictDoUpdate({
        target: markets.marketId,
        set: {
          conditionId: market.conditionId,
          question: market.question,
          creator: market.creator,
          yesPositionId: market.yesPositionId,
          noPositionId: market.noPositionId,
          yesPrice: market.yesPrice,
          noPrice: market.noPrice,
          volume24h: market.volume24h ?? 0,
          createdAt: market.createdAt,
          resolved: market.resolved,
          outcome:
            typeof market.outcome === "number" ? market.outcome : null,
        },
      });
  }

  async updateMarketPrices(
    marketId: string,
    yesPrice: number,
    noPrice: number
  ): Promise<void> {
    if (!this.db) return;

    await this.db
      .update(markets)
      .set({
        yesPrice,
        noPrice,
      })
      .where(eq(markets.marketId, marketId));
  }

  async getAllMarkets(): Promise<Market[]> {
    if (!this.db) return [];

    const rows = await this.db.select().from(markets);

    return rows.map((row) => ({
      marketId: row.marketId,
      conditionId: row.conditionId,
      question: row.question,
      creator: row.creator,
      yesPositionId: row.yesPositionId,
      noPositionId: row.noPositionId,
      yesPrice: Number(row.yesPrice ?? 0),
      noPrice: Number(row.noPrice ?? 0),
      volume24h: Number(row.volume24h ?? 0),
      createdAt: Number(row.createdAt ?? Date.now()),
      resolved: Boolean(row.resolved),
      outcome:
        typeof row.outcome === "number" || row.outcome === null
          ? row.outcome ?? undefined
          : undefined,
    }));
  }

  async upsertOrder(order: Order): Promise<void> {
    if (!this.db) return;

    await this.db
      .insert(orders)
      .values({
        orderId: order.orderId,
        maker: order.maker,
        marketId: order.marketId,
        conditionId: order.conditionId,
        makerPositionId: order.makerPositionId,
        takerPositionId: order.takerPositionId,
        side: order.side,
        price: order.price,
        size: order.size,
        filledSize: order.filledSize,
        remainingSize: order.remainingSize,
        status: order.status,
        salt: order.salt ?? null,
        expiration:
          typeof order.expiration === "number" ? order.expiration : null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        signature: order.signature ?? null,
        publicKey: order.publicKey ?? null,
      })
      .onConflictDoUpdate({
        target: orders.orderId,
        set: {
          maker: order.maker,
          marketId: order.marketId,
          conditionId: order.conditionId,
          makerPositionId: order.makerPositionId,
          takerPositionId: order.takerPositionId,
          side: order.side,
          price: order.price,
          size: order.size,
          filledSize: order.filledSize,
          remainingSize: order.remainingSize,
          status: order.status,
          salt: order.salt ?? null,
          expiration:
            typeof order.expiration === "number" ? order.expiration : null,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          signature: order.signature ?? null,
          publicKey: order.publicKey ?? null,
        },
      });
  }

  async getAllOrders(): Promise<Order[]> {
    if (!this.db) return [];

    const rows = await this.db.select().from(orders);

    return rows.map((row) => ({
      orderId: row.orderId,
      maker: row.maker,
      marketId: row.marketId,
      conditionId: row.conditionId,
      makerPositionId: row.makerPositionId,
      takerPositionId: row.takerPositionId,
      side: (row.side as OrderSide) ?? OrderSide.BUY,
      price: Number(row.price ?? 0),
      size: Number(row.size ?? 0),
      filledSize: Number(row.filledSize ?? 0),
      remainingSize: Number(row.remainingSize ?? 0),
      status: (row.status as OrderStatus) ?? OrderStatus.OPEN,
      salt: row.salt ?? "",
      expiration: typeof row.expiration === "number" ? row.expiration : 0,
      createdAt: Number(row.createdAt ?? Date.now()),
      updatedAt: Number(row.updatedAt ?? Date.now()),
      signature: row.signature ?? undefined,
      publicKey: row.publicKey ?? undefined,
    }));
  }
}
