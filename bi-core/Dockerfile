FROM node:22-alpine
WORKDIR /workspace
COPY package*.json ./
RUN npm ci --production
COPY . .
VOLUME /data
EXPOSE 4111
CMD ["node", "dist/server.js"]
