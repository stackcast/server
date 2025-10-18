/**
 * Database Migration Script
 *
 * Applies Drizzle migrations to the database.
 * Run this in Docker startup or manually with: bun run db:migrate
 */
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";

dotenv.config();

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("❌ DATABASE_URL not set. Cannot run migrations.");
    process.exit(1);
  }

  console.log("🔄 Running database migrations...");

  const sql = neon(connectionString);
  const db = drizzle(sql);

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✅ Migrations completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

runMigrations();
