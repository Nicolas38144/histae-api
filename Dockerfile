# syntax=docker/dockerfile:1.7

# Version commune à tous les stages pour conserver la compatibilité des modules natifs.
ARG NODE_IMAGE=node:22.22.1-bookworm-slim

FROM ${NODE_IMAGE} AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@11.22.0 --activate

# Cache des dépendances invalidé uniquement lorsque les manifestes changent.
FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=histae-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Outils TypeScript/Nest inclus uniquement pour le développement et le build.
FROM dependencies AS development

ENV NODE_ENV=development

COPY --chown=node:node . .
RUN chown node:node /app

USER node

CMD ["pnpm", "run", "start:dev"]

# Compile également migrations et workers avant de retirer les dépendances de test.
FROM dependencies AS build

COPY . .

RUN pnpm run build:container \
    && pnpm prune --prod

# Image finale : code compilé, SQL et dépendances runtime, sans secrets ni sources.
FROM base AS production

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/container-dist ./container-dist
COPY --from=build --chown=node:node /app/db ./db

USER node

EXPOSE 8080 9091

STOPSIGNAL SIGTERM

CMD ["pnpm", "run", "container:start"]
