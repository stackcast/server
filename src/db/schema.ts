import {
  pgTable,
  text,
  doublePrecision,
  bigint,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

export const markets = pgTable("markets", {
  marketId: text("market_id").primaryKey(),
  conditionId: text("condition_id").notNull(),
  question: text("question").notNull(),
  creator: text("creator").notNull(),
  yesPositionId: text("yes_position_id").notNull(),
  noPositionId: text("no_position_id").notNull(),
  yesPrice: doublePrecision("yes_price").notNull(),
  noPrice: doublePrecision("no_price").notNull(),
  volume24h: doublePrecision("volume_24h").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  resolved: boolean("resolved").notNull(),
  outcome: integer("outcome"),
});

export const orders = pgTable("orders", {
  orderId: text("order_id").primaryKey(),
  maker: text("maker").notNull(),
  marketId: text("market_id")
    .notNull()
    .references(() => markets.marketId, { onDelete: "cascade" }),
  conditionId: text("condition_id").notNull(),
  makerPositionId: text("maker_position_id").notNull(),
  takerPositionId: text("taker_position_id").notNull(),
  side: text("side").notNull(),
  price: doublePrecision("price").notNull(),
  size: doublePrecision("size").notNull(),
  filledSize: doublePrecision("filled_size").notNull(),
  remainingSize: doublePrecision("remaining_size").notNull(),
  status: text("status").notNull(),
  salt: text("salt"),
  expiration: bigint("expiration", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  signature: text("signature"),
  publicKey: text("public_key"),
});

export type MarketRow = typeof markets.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
