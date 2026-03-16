# ── Stage 1: Build admin frontend ──
FROM node:20-alpine AS frontend

WORKDIR /build
COPY admin-ui/package.json admin-ui/package-lock.json* ./
RUN npm ci
COPY admin-ui/ ./
RUN npm run build

# ── Stage 2: Production server ──
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY --from=frontend /build/dist ./admin-ui/dist/

RUN mkdir -p /app/uploads

EXPOSE 3600

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
