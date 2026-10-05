# syntax = docker/dockerfile:1

# Node, not Alpine: better-sqlite3 ships prebuilt glibc binaries, and musl
# (Alpine) often forces a slow from-source compile or fails outright.
FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:client

FROM node:24-slim
WORKDIR /app
# Node runs the server straight from .ts source (see tsconfig.json) via its
# native type-stripping, so node_modules — including dev deps used only to
# build the client bundle above — ship as-is rather than a separate prod
# install; only the client needs a build step.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./package.json
COPY src ./src
COPY public ./public
COPY README.md ./README.md
ENV PORT=8080
CMD ["node", "src/server/index.ts"]
