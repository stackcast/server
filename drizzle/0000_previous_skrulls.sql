CREATE TABLE "markets" (
	"market_id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"question" text NOT NULL,
	"creator" text NOT NULL,
	"yes_position_id" text NOT NULL,
	"no_position_id" text NOT NULL,
	"yes_price" double precision NOT NULL,
	"no_price" double precision NOT NULL,
	"volume_24h" double precision NOT NULL,
	"created_at" bigint NOT NULL,
	"resolved" boolean NOT NULL,
	"outcome" integer
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"maker" text NOT NULL,
	"market_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"maker_position_id" text NOT NULL,
	"taker_position_id" text NOT NULL,
	"side" text NOT NULL,
	"price" double precision NOT NULL,
	"size" double precision NOT NULL,
	"filled_size" double precision NOT NULL,
	"remaining_size" double precision NOT NULL,
	"status" text NOT NULL,
	"salt" text,
	"expiration" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"signature" text,
	"public_key" text
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_markets_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("market_id") ON DELETE cascade ON UPDATE no action;