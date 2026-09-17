# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-alpine

# ---------- base ----------
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV npm_config_update_notifier=false

# ---------- deps ----------
# better-sqlite3 ships a linuxmusl prebuild, but npm inside the base image is older
# than the host's and still runs the implicit `node-gyp rebuild` for any package with
# a binding.gyp - so the toolchain has to be here. It stays in this builder stage and
# never reaches the runtime image.
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json     apps/server/
COPY apps/web/package.json        apps/web/
RUN npm ci

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server     apps/server
COPY apps/web        apps/web
RUN npm run build

# ---------- production dependency tree ----------
# npm's --omit=dev skips the ROOT devDependencies but not a workspace's, which is why
# all build tooling (typescript, tsx, @types/*) lives in the root package.json. The
# -w flags also keep the web workspace's runtime deps out: Vite bundles them into
# apps/web/dist at build time, so nothing needs them at runtime.
FROM deps AS prod-deps
RUN npm ci --omit=dev --include-workspace-root -w @fleetarr/server -w @fleetarr/shared \
 && npm cache clean --force

# ---------- runtime ----------
FROM base AS runtime
RUN apk add --no-cache su-exec tzdata

# Empty default: the process then reads the version from package.json. CI passes
# a hashed or released value so /api/health matches the image tag.
ARG APP_VERSION=
ARG GIT_SHA=unknown

ENV NODE_ENV=production \
    PORT=8586 \
    HOST=0.0.0.0 \
    CONFIG_DIR=/config \
    WEB_ROOT=/app/apps/web/dist \
    MIGRATIONS_DIR=/app/apps/server/migrations \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    TZ=Etc/UTC \
    APP_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.title="Fleetarr" \
      org.opencontainers.image.description="Mass-editing for a fleet of Radarr and Sonarr instances" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

# node_modules contains symlinks to the workspaces, so the link targets have to
# exist in the runtime image too - hence the shared package.json + dist below.
COPY --from=prod-deps /app/node_modules                  ./node_modules
COPY --from=build     /app/package.json                  ./package.json
COPY --from=build     /app/packages/shared/package.json  ./packages/shared/package.json
COPY --from=build     /app/packages/shared/dist          ./packages/shared/dist
COPY --from=build     /app/apps/server/package.json      ./apps/server/package.json
COPY --from=build     /app/apps/server/dist              ./apps/server/dist
COPY --from=build     /app/apps/server/migrations        ./apps/server/migrations
COPY --from=build     /app/apps/web/dist                 ./apps/web/dist

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/config"]
EXPOSE 8586

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
