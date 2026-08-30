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

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Overlay native modules (better-sqlite3) compiled for the target platform
COPY --from=prod-deps /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=prod-deps /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=prod-deps /app/node_modules/node-addon-api ./node_modules/node-addon-api
COPY --from=prod-deps /app/node_modules/node-gyp-build ./node_modules/node-gyp-build

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server.js"]
