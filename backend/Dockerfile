FROM node:20-alpine

WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 5000
CMD ["node", "src/server.js"]
