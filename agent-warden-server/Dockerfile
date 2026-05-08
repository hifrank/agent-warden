FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache curl \
    && curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl && mv kubectl /usr/local/bin/ \
    && apk del curl
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

USER 65534
CMD ["node", "--import", "@opentelemetry/instrumentation/hook.mjs", "--import", "./dist/telemetry.js", "dist/index.js"]
