# syntax=docker/dockerfile:1.7

# Build stage: compile SvelteKit into build/
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 compiles a native addon
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime stage: only what we need to run node build/
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# Non-root user for the process
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
# Persistent data (SQLite DB, AES key, bulk downloads). Mount a volume here.
RUN mkdir -p /app/data && chown app:app /app/data
VOLUME /app/data
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "build/index.js"]
