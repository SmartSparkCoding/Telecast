FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm typecheck && pnpm build

# The build bundles everything, so the runtime image is just Node and dist/.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
# The control panel PIN. 000000 until you set your own, so override it when you run this.
ENV TELECAST_PIN=000000

COPY --from=build /app/dist ./dist

# What's on screen and the cookie-signing key are saved here.
# Mount a volume so they survive a redeploy.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/server.cjs"]
