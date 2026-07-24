FROM node:20-slim AS build

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/sessions

ENV SESSION_DIR=/app/sessions

EXPOSE 3001

CMD ["node", "dist/index.js"]