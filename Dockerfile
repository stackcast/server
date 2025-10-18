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

# Install only production dependencies
RUN bun install --production

# Copy source code
COPY . .

# --- SECURITY HARDENING START ---
# Create and use a non-root user inside container
RUN adduser -D appuser
USER appuser
# --- SECURITY HARDENING END ---

# Expose application port
EXPOSE 3000

# Run app as non-root user
CMD ["bun", "src/index.ts"]
