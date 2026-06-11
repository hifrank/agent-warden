FROM node:22-alpine AS build
WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev
COPY openclaw.plugin.json ./
COPY src/ ./src/

FROM node:22-alpine
RUN addgroup -S plugin && adduser -S plugin -G plugin
WORKDIR /plugin
COPY --from=build /build/ ./
USER plugin
CMD ["echo", "Plugin image — use as init container"]
