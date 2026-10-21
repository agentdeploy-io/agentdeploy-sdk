FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY apps/brain/package.json ./apps/brain/

RUN npm install --omit=dev --workspace @calla/brain --include-workspace-root || npm install --omit=dev

COPY shared ./shared
COPY apps/brain ./apps/brain

RUN npm run build --workspace @calla/shared && npm run build --workspace @calla/brain

EXPOSE 3000

CMD ["node", "apps/brain/dist/server.js"]
