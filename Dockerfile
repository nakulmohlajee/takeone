# TakeOne — production image (Vite build + Express API + FFmpeg)
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --legacy-peer-deps && npm install tsx --legacy-peer-deps

COPY --from=build /app/dist ./dist
COPY server.ts ./server.ts
COPY server ./server
COPY src ./src
COPY public ./public
COPY tsconfig.json ./tsconfig.json

EXPOSE 8080
# API service. Cloud Run Job takeone-worker uses Dockerfile.worker instead:
#   node dist-worker/worker.mjs --kind=render|director-edit --id=...
CMD ["npx", "tsx", "server.ts"]
