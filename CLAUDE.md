# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Eight Sleep temperature control app that allows users to set custom sleep temperature schedules. Uses reverse-engineered Eight Sleep APIs to control mattress heating/cooling. Built on the T3 Stack (Next.js + tRPC + Drizzle + Tailwind).

## Commands

```bash
pnpm dev          # Start dev server (Next.js with Turbo)
pnpm build        # Production build
pnpm lint         # ESLint check
pnpm db:push      # Push schema changes to database (preferred for dev)
pnpm db:generate  # Generate Drizzle migrations
pnpm db:migrate   # Run migrations
pnpm db:studio    # Open Drizzle Studio GUI
```

**Database changes:** Use `pnpm db:push` for development. Requires `POSTGRES_URL` in `.env.local`.

## Architecture

```
src/
├── app/                    # Next.js App Router
│   ├── api/trpc/          # tRPC endpoint
│   └── api/temperatureCron/# Cron job (called externally every 30min)
├── components/            # React components (client-side marked with "use client")
├── server/
│   ├── api/routers/       # tRPC procedures (user.ts has all mutations/queries)
│   ├── db/schema.ts       # Drizzle schema (tables prefixed with 8slp_)
│   └── eight/             # Eight Sleep API integration
│       ├── auth.ts        # Token management
│       ├── eight.ts       # Device control (setHeatingLevel, setPreheat, etc.)
│       └── user.ts        # Status queries
└── trpc/                  # tRPC client/server config
```

## Key Flows

**Authentication:** User logs in with Eight Sleep credentials → backend exchanges for access/refresh tokens → JWT session stored in HTTP-only cookie → tokens stored in Postgres for cron access.

**Temperature Control:** External cron hits `/api/temperatureCron` → fetches all user profiles → calculates sleep stage based on user's timezone and schedule → calls Eight Sleep API to set temperature.

**Sleep Cycle:** Pre-heating starts 1h before bedtime, then initial → mid → final phases, then auto-off at wakeup. The cron determines the current stage on every run and sets the correct temperature using `setPreheat()`.

**Preheat-Only Mode:** Activates heating once at the configured preheat time (45-min activation window), with a 12-hour duration. The cron never turns off the bed — manual control is fully respected after activation.

## Eight Sleep API Primitives

All temperature control goes through `PUT {APP_API_URL}v1/users/{userId}/temperature` (see `src/server/eight/eight.ts`).

| Function | Payload | Effect |
|---|---|---|
| `setPreheat(token, userId, level, durationSeconds)` | `currentState.type: "timeBased"`, level, duration | **Primary control method.** Sets bed to a specific temperature level (-100 to 100) for a countdown duration. Used by both preheat-only and sleep cycle modes. |
| `turnOffSide(token, userId)` | `currentState.type: "off"` | Turns the bed side off completely. |
| `turnOnSide(token, userId)` | `currentState.type: "smart"` | Turns on smart/autopilot mode (not currently used by cron). |
| `setHeatingLevel(token, userId, level, duration)` | `timeBased.level`, `currentLevel` | Updates heating level without changing state type (not currently used by cron). |
| `setSmartHeatingLevel(token, userId, level, stage)` | `smart: { [stage]: level }` | Sets a specific smart mode stage level (not currently used). |

**Temperature level range:** -100 (coolest, ~13°C/55°F) to +100 (warmest, ~44°C/111°F). See `RAW_TO_CELSIUS_MAP` / `RAW_TO_FAHRENHEIT_MAP` in `constants.ts`.

**Reading status:** `getCurrentHeatingStatus(token)` returns `{ isHeating, heatingLevel, heatingDuration, targetHeatingLevel }` from the device. `getBedStateType(token, userId)` returns `"smart" | "off"`.

**Level scaling note:** Sleep levels are stored in DB as -100 to 100 (UI displays -10 to 10, form multiplies by 10 before saving). Preheat level is stored as -10 to 10 in DB (UI matches), so it must be multiplied by 10 at the API call site in the cron.

## Environment Variables

Required in `.env.local`:
- `POSTGRES_URL` - Neon/Vercel Postgres connection string
- `CRON_SECRET` - Bearer token for `/api/temperatureCron` endpoint
- `JWT_SECRET` - Session token signing
- `APPROVED_EMAILS` - Comma-separated whitelist of allowed users

## Database

Two tables in schema.ts:
- `users` - Eight Sleep auth tokens (email is PK)
- `userTemperatureProfile` - Sleep schedule settings (one per user)

Path alias: `~/*` maps to `./src/*`
