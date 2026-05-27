# AGENTS.md

This repository contains an incident management platform with multiple services.

## Package Management

This monorepo uses **pnpm** as the package manager and **turbo** for task orchestration.

Run commands from the repo root:

```bash
pnpm install

# Development
pnpm run dev
pnpm run dev:dashboard
pnpm run dev:incidentd
pnpm run dev:status-page

# Build and checks
pnpm run build
pnpm run check
pnpm run lint:fix

# Database workflow (@fire/db)
pnpm run db:generate
pnpm run db:migrate
```

Notes:
- `pnpm run dev` regenerates `services/dashboard/src/routeTree.gen.ts`. Do not edit that file manually.
- Service-level `lint` scripts are placeholders; linting runs from root (`pnpm run check` / `pnpm run lint:fix`).
- `pnpm run db:generate` uses Drizzle Kit to generate migrations from `packages/db/src/schema` changes. Do not hand-write migration folders.

## Project Structure

```text
fire/
├── services/
│   ├── dashboard/      # SolidJS SPA (TanStack Start)
│   ├── incidentd/      # Cloudflare Workers backend (DO + Workflows)
│   └── status-page/    # Next.js public status pages (HTML responses)
└── packages/
    ├── common/         # Shared types/utilities
    └── db/             # Drizzle schema, relations, migrations
```

## Code Style

- TypeScript strict mode
- Biome for linting and formatting
- Prefer existing local patterns over inventing new structure

## Service-Specific Guidelines

- `services/dashboard/AGENTS.md`
- `services/incidentd/AGENTS.md`
- `services/status-page/AGENTS.md`

Dashboard-specific requirements, including demo mode expectations, are documented in `services/dashboard/AGENTS.md`.
