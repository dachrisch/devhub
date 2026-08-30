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
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy standalone first (server.js, .next/, package.json)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Then overlay prod node_modules (native modules compiled for Alpine/musl)
COPY --from=prod-deps /app/node_modules ./node_modules

EXPOSE 3000

USER node
CMD ["node", "server.js"]
