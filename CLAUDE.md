# CLAUDE.md — ChatPile App Project Reference

This file is the persistent development log and reference for Claude Code sessions in this project.

---

## Project Overview

A self-hosted web app that aggregates, indexes, and searches AI conversations from multiple platforms (ChatGPT, Claude AI, Gemini, Copilot, DeepSeek, Perplexity, Grok, Mistral, HuggingChat, Poe). Conversations are captured by a Tampermonkey browser script and pushed directly to the app's API, stored in PostgreSQL.

**Production domain:** chatpile.powerbyte.app
**Staging domain:** chatpile-staging.powerbyte.app
**GitHub:** github.com/bonitobonita24/ChatPile

---

## Stack

- **Backend:** Node.js 18, Express 4, express-session, helmet, crypto (scrypt), pg, nodemailer
- **Frontend:** Vanilla JS (no framework), HTML5, CSS3 dark theme
- **Database:** PostgreSQL (pg driver) — connection via `DATABASE_URL`
- **Storage:** S3-compatible (MinIO or AWS S3) via `@aws-sdk/client-s3`
- **Payments:** Xendit (recurring subscriptions for storage tiers)
- **Deployment:** Docker (multi-stage), Docker Compose, Traefik + Let's Encrypt, GitHub Actions CI/CD

---

## Key Files & Roles

| File | Role |
|------|------|
| `server.js` | Express server — auth, conversation API, webhooks, sessions, static serving, rate limiting |
| `db.js` | PostgreSQL database module — schema, migrations, CRUD, code snippet extraction, full-text search |
| `storage.js` | S3/MinIO file storage abstraction — upload, download, delete, file categorization |
| `xendit.js` | Xendit payment API — subscription plans, tier upgrades, cancellation |
| `app/app.js` | Frontend SPA logic — state, API calls, filtering, search, rendering, export |
| `app/index.html` | Landing page + three-panel dashboard UI + auth overlays |
| `app/styles.css` | Dark theme, platform badges, landing page, layout |
| `tampermonkey-script.example.md` | Tampermonkey browser script template (users fill in API_URL) |
| `.env.example` | Environment variable template |

---

## API Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/health` | No | Docker health check |
| GET | `/api/auth/session` | No | Check auth status |
| POST | `/api/auth/login` | No | Authenticate (email + password) |
| POST | `/api/auth/logout` | Session | Clear session |
| POST | `/api/auth/register` | No | Register new account (sends 6-digit code) |
| POST | `/api/auth/verify-email` | No | Verify email with 6-digit code, auto-login |
| POST | `/api/auth/resend-verification` | No | Resend verification code |
| POST | `/api/auth/forgot-password` | No | Send password reset link (1hr token) |
| POST | `/api/auth/reset-password` | No | Reset password with URL token |
| POST | `/api/auth/change-password` | Session | Update password (logged-in users) |
| GET | `/api/auth/api-key` | Session | Get user's Tampermonkey API key |
| POST | `/api/auth/regenerate-api-key` | Session | Regenerate API key |
| POST | `/api/webhook/xendit` | Callback token | Xendit payment webhook |
| POST | `/api/subscription/create` | Session | Create new subscription plan |
| POST | `/api/subscription/activate` | Session | Activate subscription |
| POST | `/api/subscription/cancel` | Session | Cancel subscription |
| POST | `/api/subscription/upgrade-storage` | Session | Upgrade storage tier |
| POST | `/api/conversations` | API Key | Ingest conversation (Tampermonkey → app) |
| GET | `/api/conversations` | Session | List user's conversations (filterable) |
| GET | `/api/conversations/:id` | Session | Get conversation with messages + code snippets |
| DELETE | `/api/conversations/:id` | Session | Delete conversation + attachments |
| GET | `/api/files/:attachmentId` | Session | Stream file attachment from S3 |
| GET | `/api/account` | Session | Get user account details (tier, storage usage) |
| GET | `/api/stats` | Session | Get user's conversation/message/snippet counts |
| GET | `/api/search` | Session | Full-text search across user's messages |
| GET | `*` | No | SPA fallback — serves `app/index.html` |

---

## Environment Variables

| Var | Default | Notes |
|-----|---------|-------|
| `NODE_ENV` | development | |
| `PORT` | 4173 | |
| `SESSION_SECRET` | fallback string | MUST override in production |
| `COOKIE_SECURE` | true | Set false for local HTTP |
| `COOKIE_DOMAIN` | (none) | Optional domain restriction |
| `DATABASE_URL` | `postgresql://aichats:aichats@localhost:5432/aichats` | PostgreSQL connection string |
| `PG_USER` | aichats | PostgreSQL username (for Docker Compose) |
| `PG_PASSWORD` | (see .env) | PostgreSQL password (for Docker Compose) |
| `APP_ADMIN_USERNAME` | admin | Username for initial admin |
| `APP_ADMIN_EMAIL` | admin@localhost | Email for initial admin |
| `APP_ADMIN_PASSWORD` | (see .env) | Password for initial admin seeded on first run |
| `SMTP_HOST` | (none) | SMTP server host — if unset, emails log to console |
| `SMTP_PORT` | 587 | SMTP port (use 465 for SSL) |
| `SMTP_USER` | (none) | SMTP username |
| `SMTP_PASS` | (none) | SMTP password |
| `SMTP_FROM` | SMTP_USER | From address for outbound emails |
| `APP_URL` | `http://localhost:PORT` | Base URL used in password reset links |
| `S3_ACCESS_KEY` | (none) | S3/MinIO access key |
| `S3_SECRET_KEY` | (none) | S3/MinIO secret key |
| `S3_BUCKET` | aichats | S3 bucket name |
| `XENDIT_SECRET_KEY` | (none) | Xendit API secret key |
| `XENDIT_CALLBACK_TOKEN` | (none) | Xendit webhook verification token |
| `XENDIT_PLAN_AMOUNT` | 200 | Subscription price per tier (in currency units) |
| `XENDIT_PLAN_CURRENCY` | PHP | Subscription currency |
| `DOCKER_IMAGE` | (none) | Docker Hub image tag (for production compose) |

---

## Database Schema (PostgreSQL)

**Core tables:**
- `users` — id (UUID), email, username, salt, hash, verified, role, api_key, tier, storage_used_bytes, storage_limit_bytes, xendit_plan_id, subscription_status, subscription_expires_at, storage_tier
- `conversations` — id + user_id (composite PK), title, platform, url, captured, timestamps
- `messages` — id (SERIAL), conversation_id, user_id, role, text, sort_order
- `code_snippets` — id (SERIAL), conversation_id, user_id, message_index, role, language, code, detected
- `attachments` — id (UUID), conversation_id, user_id, message_index, file_name, file_type, file_category, file_size, storage_path

**Auth tables (persistent, replaces in-memory Maps):**
- `pending_verifications` — email (PK), code, username, salt, hash, attempts, expires_at
- `password_reset_tokens` — token (PK), email, user_id, expires_at
- `login_attempts` — ip (PK), failed_count, lock_until

**Search indexes:** GIN indexes on `messages.text` and `conversations.title` using `to_tsvector('english', ...)`

---

## Docker Compose Variants

| File | Use |
|------|-----|
| `docker-compose.dev.yml` | Dev — builds `development` target, port `4287:4173`, PostgreSQL container, volume `chatpile-dev-pgdata` |
| `docker-compose.staging.yml` | Staging — Traefik + SSL, PostgreSQL, MinIO, volume `chatpile-staging-pgdata` |
| `docker-compose.komodo.yml` | Production — pulls from Docker Hub, Traefik + SSL, PostgreSQL, volume `chatpile-prod-pgdata` |

**Example files** (gitignored originals, copy to use):
- `docker-compose.dev.example.yml` → `docker-compose.dev.yml`
- `docker-compose.staging.example.yml` → `docker-compose.staging.yml`
- `docker-compose.komodo.example.yml` → `docker-compose.komodo.yml`

**Makefile commands:**
- `make setup` — copy example files to real ones (first-time setup)
- `make dev` — start dev container (builds locally)
- `make dev-down` — stop dev container
- `make dev-logs` — stream dev logs
- `make dev-restart` — restart without rebuilding
- `make release` — build production image, push to Docker Hub (tagged with git SHA + latest)
- `make test` — run Playwright smoke tests

**Container setup:**
- Dev container: `chatpile-dev` | port `4287` | volume `chatpile-dev-pgdata` | network `chatpile-dev-net`
- Prod container: `chatpile-prod` | no port (Traefik) | volume `chatpile-prod-pgdata` | network `chatpile-prod-net`
- Production: non-root user (`nodejs:1001`), Node.js 18 Alpine, healthcheck via `wget /health`

---

## Auth & Security Design

- **Multi-user**: open registration with email verification (6-digit code, stored in `pending_verifications` table)
- **Forgot password**: 64-char hex token, 1hr TTL, stored in `password_reset_tokens` table, sent as `APP_URL/?reset=TOKEN`
- **Password hashing**: scrypt with random salt, timing-safe comparison
- **Session TTL**: 12 hours, HTTP-only SameSite cookies
- **Rate limiting**: IP-based, stored in `login_attempts` table, exponential backoff (30s → 10min max)
- **Email**: nodemailer; if `SMTP_HOST` unset, emails printed to console (dev-friendly)
- **Xendit webhooks**: verified via `XENDIT_CALLBACK_TOKEN` header comparison
- Helmet.js security headers (CSP currently disabled — known issue)

---

## Subscription & Storage Tiers

- **Payment provider:** Xendit (recurring monthly billing)
- **Storage model:** 5GB increments at $2/tier (configurable via `XENDIT_PLAN_AMOUNT`/`XENDIT_PLAN_CURRENCY`)
- **Max storage:** 100GB (20 tiers)
- **Free tier:** text file attachments only, no S3 storage
- **Paid tiers:** all file types (text, image, audio, video)
- **S3 path structure:** `{userId}/{conversationId}/{randomUUID}.{ext}`
- **Operations:** create plan, activate, cancel (deactivate), upgrade storage (increases tier + plan amount)

---

## CI/CD

**GitHub Actions** (`.github/workflows/deploy.yml`):
- **Trigger:** push to `main` (ignores `logs/`, `.specstory/`, `.claude/`, `*.md` except `CLAUDE.md`)
- **Steps:** checkout → Docker Buildx → login to Docker Hub → build + push production target → trigger Komodo staging redeploy
- **Secrets:** `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `KOMODO_STAGING_WEBHOOK_URL`

---

## Known Issues / Technical Debt

1. **CSP disabled** — `server.js` disables Content-Security-Policy in helmet config.
2. **Memory-only session store** — sessions lost on restart; no Redis/persistent store.
3. **CORS allows any localhost origin** — fine for dev, but not environment-scoped.
4. **No DB migration versioning** — uses `ADD COLUMN IF NOT EXISTS` with try/catch (fragile pattern).
5. **package.json build script outdated** — still says "No build step needed — data served from SQLite".
6. **No unit/integration tests** — only Playwright smoke tests exist.

---

## Change Log

### 2026-04-01
- **Docs:** Updated CLAUDE.md to reflect current state — PostgreSQL, Xendit payments, S3 storage, new API endpoints, updated schema.
- **Repo:** Moved GitHub remote from `rudolfochua23/AI-Chats` to `bonitobonita24/ChatPile`.

### 2026-03-31
- **Database:** Migrated from SQLite (better-sqlite3) to PostgreSQL (pg driver).
- **Storage:** Added S3/MinIO file storage layer (`storage.js`, `@aws-sdk/client-s3`).
- **Payments:** Added Xendit subscription integration (`xendit.js`) — tiered storage plans.
- **Schema:** Added `attachments` table, user subscription fields (tier, storage, xendit_plan_id).
- **Auth:** Moved pending verifications, reset tokens, login attempts from in-memory Maps to PostgreSQL tables.
- **Search:** Added PostgreSQL full-text search with GIN indexes on messages and conversation titles.
- **API:** New endpoints — `/api/subscription/*`, `/api/files/:id`, `/api/account`, `/api/webhook/xendit`.

### 2026-03-28
- **Feature:** Multi-user auth system — open registration, email verification (6-digit code), forgot/reset password (URL token).
- **Backend:** `server.js` fully rewritten. New routes: `/api/auth/register`, `/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/forgot-password`, `/api/auth/reset-password`. Login now uses email.
- **Email:** nodemailer added (`^6.10.1`). Falls back to console.log when `SMTP_HOST` unset.
- **Frontend:** 4 new auth overlays (register, verify-email, forgot-password, reset-password). `?reset=TOKEN` URL auto-triggers reset overlay.
- **New env vars:** `APP_ADMIN_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `APP_URL`

### 2026-03-27
- **Docs:** Created this `CLAUDE.md` as the persistent project reference and dev log.
- **Dev workflow:** All development/testing now runs via Docker Compose (`make dev`), not on the host directly.
- **Docker:** Restructured Docker Compose setup with dev/staging/production variants, named volumes, Makefile commands.
