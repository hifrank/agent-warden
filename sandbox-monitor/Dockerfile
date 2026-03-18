FROM node:22-alpine AS builder
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
RUN npm run build

FROM node:22-alpine
RUN addgroup -g 10002 -S sandbox && adduser -u 10002 -S sandbox -G sandbox
WORKDIR /usr/local/lib/sandbox-monitor
COPY --from=builder /build/dist/ ./dist/
# Symlink as entrypoint
RUN ln -s /usr/local/lib/sandbox-monitor/dist/monitor.js /usr/local/bin/sandbox-monitor && \
    chmod +x /usr/local/bin/sandbox-monitor
USER sandbox
ENTRYPOINT ["node", "/usr/local/bin/sandbox-monitor"]
