# Build context: packages/ (the fly.toml/seller build passes context = ".." from
# packages/bi-core) — bi-core's tsconfig extends ../core-sdk/tsconfig.json, so
# the context must contain both.
FROM node:22-alpine AS build
WORKDIR /packages/bi-core
COPY bi-core/package*.json ./
COPY core-sdk/tsconfig.json /packages/core-sdk/tsconfig.json
RUN npm ci
COPY bi-core/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /workspace
ENV NODE_ENV=production
COPY bi-core/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /packages/bi-core/dist ./dist
VOLUME /data
EXPOSE 4111
CMD ["node", "dist/server.js"]
