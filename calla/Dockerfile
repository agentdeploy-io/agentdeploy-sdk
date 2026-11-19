# Calla brain (Mastra) — build context: packages/calla (per apps/brain/fly.toml).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY apps/edge/package.json ./apps/edge/
COPY apps/brain/package.json ./apps/brain/
COPY apps/ui/package.json ./apps/ui/
# devDeps (tsc) needed for the build stage
RUN npm ci
COPY shared ./shared
COPY apps/brain ./apps/brain
RUN npm run build --workspace @calla/shared && npm run build --workspace @calla/brain

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY apps/brain/package.json ./apps/brain/
# plain install (not ci): only brain's manifest is present, not the full workspace set
RUN npm install --omit=dev --workspace @calla/brain --include-workspace-root
COPY --from=build /app/shared ./shared
COPY --from=build /app/apps/brain ./apps/brain

# Persistent user/audit store: LIBSQL_URL=file:/data/local.db (Fly volume).
VOLUME /data
EXPOSE 3000
CMD ["node", "apps/brain/dist/server.js"]
