# Build stage
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY . .

# Build frontend
RUN bun run build

# Production stage
FROM oven/bun:1.3-alpine

WORKDIR /app

# Copy built app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src

# Railway injects PORT, default to 8080
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "run", "src/server/index.ts"]
