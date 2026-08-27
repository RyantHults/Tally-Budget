# Tally Budget (self-hosted)

A self-hosted, read-and-categorize budgeting app.

## Stack

TypeScript everywhere · Fastify + Drizzle + Postgres · React + Vite + Tailwind · pnpm workspaces.

## Setup

```sh
corepack pnpm install          # or nix-shell -p pnpm
cp .env.example .env
docker compose up -d           # Postgres
corepack pnpm -r typecheck && corepack pnpm -r test
corepack pnpm --filter @tally/server dev   # API on :3001
corepack pnpm --filter @tally/web dev      # Web on :5173 (proxies /api)
```
