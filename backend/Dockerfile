# --- build stage ------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Drop dev dependencies once the compile is done - tsc, tsx and the @types
# packages have no place in the runtime image.
RUN npm prune --omit=dev

# --- runtime stage ----------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 5000
CMD ["node", "dist/server.js"]
