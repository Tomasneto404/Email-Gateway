# syntax=docker/dockerfile:1.7
# Authored by Tomás Neto (TN 2026)
# One image for api + worker (different commands). Separate `migrate` target keeps the
# Prisma CLI (and dev deps) out of the runtime image.
# Build runners can use a restrictive umask, and COPY keeps the checkout's file modes. Files the
# non-root `node` user reads are made world-readable in the layer that creates them (a later
# recursive chmod would duplicate them into a new layer). CI checks this as `node`:
# scripts/check-runtime-image.mjs.
ARG NODE_IMAGE=node:22-alpine

# ---- all deps (build tooling) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY ui/package.json ui/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund \
 # only the Prisma CLI needs its install script (downloads the schema engine for migrations)
 && npm rebuild prisma @prisma/engines

# ---- build backend ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY scripts/copy-docs-assets.mjs ./scripts/copy-docs-assets.mjs
RUN npm run build && chmod -R a+rX dist

# ---- build admin UI (static assets served by the API at /ui) ----
FROM deps AS ui-build
COPY openapi.json ./
COPY ui ./ui
RUN npm run gen:api -w ui && npm run build -w ui && chmod -R a+rX ui/dist

# ---- production deps only ----
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY ui/package.json ui/package.json
# @prisma/client lists the Prisma CLI + typescript as peers; drop devDependencies from the
# manifest and prune peers so none of that tooling reaches the runtime image.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm pkg delete devDependencies workspaces && rm -rf ui node_modules/@mail-gateway \
 && npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
 && find node_modules/@prisma/client/runtime -type f \( -name '*cockroachdb*' -o -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' \) -delete \
 && find node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && npm cache clean --force

# ---- Prisma CLI only (for the migrations image) ----
# Installs just the CLI at the exact version pinned in package-lock.json, instead of copying every
# dev dependency (Vite, Playwright, …) into the image. Install scripts run so the schema engine
# used by `migrate deploy` is downloaded.
FROM ${NODE_IMAGE} AS migrate-deps
WORKDIR /app
COPY package-lock.json ./
RUN PRISMA_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")" \
 && echo '{"name":"mail-gateway-migrate","private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund "prisma@${PRISMA_VERSION}" \
 && find node_modules -type f \( -name '*.map' -o -name '*.md' \) -delete \
 && npm cache clean --force

# ---- hardened base for the shipped images ----
# Latest Alpine security fixes, and no package managers: npm/npx/corepack/yarn are never used at
# runtime and bundle their own (often vulnerable) dependencies.
FROM ${NODE_IMAGE} AS base
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# ---- one-shot migrations (docker compose `migrate` service) ----
FROM base AS migrate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=migrate-deps /app/node_modules ./node_modules
COPY --chmod=644 package.json prisma.config.ts ./
COPY prisma ./prisma
RUN chmod -R a+rX prisma
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# ---- runtime ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=ui-build /app/ui/dist ./ui/dist
COPY --chmod=644 package.json ./
USER node
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
CMD ["node", "dist/main.api.js"]
