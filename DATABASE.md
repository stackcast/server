# Database Setup Guide

This project uses **Drizzle ORM** with **Neon Postgres** for state-of-the-art database management.

## Quick Start

### 1. Get Your Neon Database

1. Create a free account at [neon.tech](https://neon.tech)
2. Create a new project
3. Copy your connection string (looks like: `postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`)

### 2. Configure Environment

Add your Neon connection string to `.env`:

```bash
DATABASE_URL=postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
```

### 3. Generate and Run Migrations

```bash
# Generate migration files from schema
bun run db:generate

# Apply migrations to your Neon database
bun run db:migrate
```

### 4. Start Developing

```bash
# Development mode with hot reload
bun run dev

# Or with Docker
docker compose up
```

## Available Commands

| Command | Description |
|---------|-------------|
| `bun run db:generate` | Generate SQL migration files from schema changes |
| `bun run db:migrate` | Apply pending migrations to database |
| `bun run db:push` | Push schema changes directly (dev only, skips migration files) |
| `bun run db:studio` | Open Drizzle Studio (visual database browser) |

## Schema Changes Workflow

1. **Edit your schema** in `src/db/schema.ts`
2. **Generate migration**: `bun run db:generate`
3. **Review** the generated SQL in `drizzle/` folder
4. **Apply migration**: `bun run db:migrate`

## Development vs Production

- **Development**: Use Neon's free tier with a dev database
- **Production**: Use Neon's production database (set `DATABASE_URL` in prod env)

Both use the same Drizzle setup - no Docker Postgres needed!

## How It Works

### Connection (`src/db/client.ts`)
- Uses `neon-http` driver for serverless compatibility
- Automatically handles connection pooling
- Gracefully falls back if `DATABASE_URL` not set

### Schema (`src/db/schema.ts`)
- Type-safe table definitions
- Automatic TypeScript types via `$inferSelect` and `$inferInsert`

### Migrations (`drizzle/`)
- Generated SQL files track schema evolution
- Applied via `src/db/migrate.ts`
- Migration history stored in `__drizzle_migrations` table

### Persistence Layer (`src/services/databasePersistence.ts`)
- Upserts for markets and orders
- Type-safe queries with Drizzle
- Redis for hot data, Postgres for durability

## Why Neon + Drizzle?

✅ **Serverless-native** - No connection limits, scales to zero
✅ **Type-safe** - Full TypeScript inference
✅ **Migration-first** - Track all schema changes
✅ **Developer experience** - Drizzle Studio, SQL-like syntax
✅ **Production-ready** - Branching, point-in-time recovery, read replicas

## Troubleshooting

### "DATABASE_URL not set"
Make sure you've added `DATABASE_URL` to your `.env` file.

### Migration fails
- Check your Neon database is accessible
- Verify the connection string format
- Ensure you have network connectivity

### Schema out of sync
```bash
# Reset and regenerate (DEV ONLY - destroys data!)
bun run db:push
```

## Learn More

- [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview)
- [Neon Docs](https://neon.tech/docs/introduction)
- [Drizzle + Neon Guide](https://orm.drizzle.team/docs/get-started/neon-new)
