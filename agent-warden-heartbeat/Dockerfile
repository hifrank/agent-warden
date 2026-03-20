FROM node:22-alpine AS builder
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
RUN npm run build

FROM node:22-alpine
USER node
WORKDIR /usr/local/lib/heartbeat
COPY --from=builder /build/dist/ ./dist/
COPY --from=builder /build/node_modules/ ./node_modules/
USER heartbeat
ENTRYPOINT ["node", "dist/heartbeat.js"]
