# Base stage - shared dependencies
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lockb* ./

# Development stage
FROM base AS development
RUN bun install
COPY . .
EXPOSE 3000
CMD ["bun", "--watch", "src/index.ts"]

# Production stage
FROM base AS production
WORKDIR /app
ENV NODE_ENV=production
RUN bun install --production
COPY . .
EXPOSE 3000
CMD ["bun", "src/index.ts"]
