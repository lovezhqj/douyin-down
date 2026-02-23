# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build frontend
RUN npm run build

# Compile server TypeScript
RUN npx tsc -p tsconfig.server.json

# ---- Production stage ----
FROM node:20-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy Vite build output
COPY --from=build /app/dist ./dist

# Copy compiled server
COPY --from=build /app/dist-server ./dist-server

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist-server/server.js"]
