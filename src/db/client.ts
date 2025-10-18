import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

let db: NeonHttpDatabase<typeof schema> | undefined;

if (connectionString) {
  try {
    const neonClient = neon(connectionString, {
      fetchOptions: {
        keepalive: true,
      },
    });
    db = drizzle(neonClient, { schema });
    console.log("✅ Drizzle ORM initialized with Neon");
  } catch (error) {
    console.error("❌ Failed to initialize Drizzle ORM:", error);
    db = undefined;
  }
} else {
  console.warn(
    "⚠️  DATABASE_URL not set. Postgres persistence is disabled. Set DATABASE_URL in your .env file."
  );
}

export { db, schema };
