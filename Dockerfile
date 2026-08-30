# syntax=docker/dockerfile:1

# ---- deps: install all dependencies (incl. dev) for build ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile Next.js (standalone output) ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod-deps: production-only dependencies ----
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: slim image with only what's needed to run ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy prod node_modules first (native modules compiled for Alpine)
COPY --from=prod-deps /app/node_modules ./node_modules
# Then copy standalone output on top (server.js, .next/, package.json)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server.js"]
