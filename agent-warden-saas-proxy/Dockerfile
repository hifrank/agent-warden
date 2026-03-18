FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

USER 65534
EXPOSE 9090
CMD ["node", "dist/proxy.js"]
