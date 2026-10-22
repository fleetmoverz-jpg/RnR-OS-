# RnR Os

A personal SEO workspace, built in phases:

1. **Search Console dashboard** (this release): daily sync of Google Search Console data, insights and Claude-written recommendations per site.
2. **Social Automation** (foundation built): workspaces, brands, websites, business details and the data model for accounts, posts and publishing. Connecting accounts, AI content and publishing come next.
3. Citation builder. *(placeholder in the nav)*

Stack: Next.js (App Router) + Tailwind, Supabase Postgres, hosted on Vercel, Claude API for recommendations.

## What Phase 1 does

- **Sign in with Google**, limited to one account (`ALLOWED_EMAIL`). The same sign-in grants read-only Search Console access.
- **Daily sync** at 06:00 UTC through Vercel Cron, plus a **Sync now** button per site. The first sync backfills 180 days; later syncs re-fetch the last 5 days, because Google revises recent data.
- **Insights** per site, comparing the last 28 days with the 28 before:
  - improving and declining queries
  - pages losing clicks
  - high-impression, low-CTR queries (CTR under half of what the position usually earns)
  - page-2 striking distance queries (position 11–20)
  - cannibalization (two or more of your pages each taking ≥10% of a query's impressions)
  - indexing issues from the URL Inspection API (your top pages, about 40 a day per site, each rechecked weekly)
- **Recommendations** from Claude in plain English, refreshed weekly after a sync or on demand.

## Setup

You need accounts on Google Cloud (you already have an OAuth client), Supabase, Vercel and the Claude API console.

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run each file in [`supabase/migrations/`](supabase/migrations) in order: paste the whole of `0001_gsc.sql` and run it, then the same for `0002_country_device.sql`, `0003_social.sql`, `0004_social_google.sql` and `0005_social_analysis.sql`.
3. From **Project Settings → API**, copy the **Project URL** (`SUPABASE_URL`) and the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`).

Every table has row-level security switched on with no policies, so the public anon key can read nothing. Only the server, using the service role key, can.

### 2. Google Cloud (your existing OAuth client)

In the same Google Cloud project as your OAuth client:

1. **APIs & Services → Library**: enable **Google Search Console API**.
2. **APIs & Services → Credentials →** your OAuth 2.0 Client ID (type *Web application*). Under **Authorized redirect URIs** add:
   - `https://<your-vercel-domain>/api/auth/callback`
   - `https://<your-vercel-domain>/api/social/google/callback` (Social: Connect Google account)
   - `http://localhost:3000/api/auth/callback` and `http://localhost:3000/api/social/google/callback` (only for local development)
3. **OAuth consent screen (Google Auth Platform)**:
   - Under **Data access**, add the scope `https://www.googleapis.com/auth/webmasters.readonly` (plus `openid` and `email`).
   - Under **Audience**, set the publishing status to **In production**. In *Testing* mode Google expires refresh tokens after 7 days and the daily sync would stop. The app doesn't need Google verification for your own use. On first sign-in Google shows an "unverified app" screen; click **Advanced → Go to (app)**.
4. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 3. Claude API

Create a key at [console.anthropic.com](https://console.anthropic.com) and set it as `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5`. Override it with `ANTHROPIC_MODEL` if you like.

### 4. Vercel

1. **Add New → Project**, import this GitHub repo. The framework is detected as Next.js.
2. Add the environment variables from [`.env.example`](.env.example). Generate `SESSION_SECRET` and `CRON_SECRET` with `openssl rand -base64 32`, and set `APP_URL` to the production URL (for example `https://rnr-os.vercel.app`).
3. Deploy. The daily cron comes from [`vercel.json`](vercel.json) and is sent with `CRON_SECRET`, so the sync endpoint rejects anyone else. Check it under **Settings → Cron Jobs**.
4. If the final domain differs from what you put in `APP_URL` or the Google redirect URI, update both and redeploy.

### 5. First run

1. Open the app and click **Continue with Google** with `ALLOWED_EMAIL`'s account.
2. Your Search Console properties load automatically. Use **Refresh property list** if one is missing.
3. Click **Sync now** on each site for the first backfill. It can take a few minutes on large sites. After that, the daily cron keeps everything current. **Pause** a site to leave it out of the daily sync.

## Local development

```bash
cp .env.example .env.local   # fill in the values, APP_URL=http://localhost:3000
npm install
npm run dev
```

Trigger the cron by hand with `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync`.

## Social Automation (foundation)

- Everything lives in a **workspace**. The app owner (`ALLOWED_EMAIL`) gets one automatically on the first visit to `/social`. Members have a role: owner, admin, editor or viewer (`src/lib/social/policy.ts`).
- **Isolation:** every Social table carries `workspace_id`, and every link between rows is a composite foreign key on `(id, workspace_id)`, so the database refuses to connect a brand, website, account or post to anything in another workspace. All reads and writes go through `src/lib/social/repo.ts`, which scopes every query to the active workspace and checks the role.
- **Websites** imported from Search Console count as verified only when Google lists you as the property's owner. Websites added by address stay unverified.
- **Tokens** will be stored only as AES-256-GCM ciphertext (`src/lib/social/crypto.ts`, key in `TOKEN_ENCRYPTION_KEY`). The database rejects anything that isn't in the encrypted format.
- Nothing is posted yet, and no social account shows as connected unless a real sign-in creates it.

### Google accounts and Search Console discovery

**Social → Websites & Search Console** connects one or more Google accounts to the workspace and lists the Search Console properties each one can access, using the official [Sites API](https://developers.google.com/webmaster-tools/v1/sites/list).

- **Flow:** `/api/social/google/connect` → Google consent → `/api/social/google/callback`. It's the authorization code flow with PKCE and a signed, httpOnly, 10-minute state cookie. Only workspace owners and admins can connect, and the Google account doesn't have to be the one you sign in with.
- **Scopes:** `openid`, `email` and `https://www.googleapis.com/auth/webmasters.readonly` only. If the read-only Search Console box is unticked on the consent screen, the connection is refused with a clear message.
- **Tokens** stay on the server. The access and refresh tokens are saved only as AES-256-GCM ciphertext in `google_connections`, refreshed a minute before expiry, and never sent to the browser. **Disconnect** revokes the grant at Google, then deletes the tokens and discovered properties. Imported websites stay, unlinked.
- **Properties** keep Google's exact property URL, so `sc-domain:example.com` (domain property) and `https://www.example.com/` (URL prefix) stay separate. Each shows Google's permission level. Only `siteOwner` is shown and stored as a verified owner; full, restricted and unverified users are not. Every refresh re-checks this, so a lost ownership removes the verified mark.
- **Import** selected properties into the workspace, optionally assigned to a brand. A property already in the workspace is skipped rather than duplicated.
- **Errors:** revoked or expired consent (`invalid_grant`, 401) marks the connection *Needs reconnect*. Missing Search Console access is reported as such. Rate limits and server errors are retried once, then shown without disconnecting. An account with no properties shows an empty state.
- Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the same OAuth client as sign-in), `TOKEN_ENCRYPTION_KEY` and `APP_URL`, plus the extra redirect URI above. Without them the page says what's missing and doesn't offer the Connect button.

### Website analysis and brand profiles

Importing or adding a website starts an analysis in the background. **Analyse website** / **Rescan** on the Websites page, and **Rescan website** on a brand's profile, run it on demand.

- **Crawler** (`src/lib/social/crawler.ts`): reads robots.txt first (a 5xx stops the crawl), then the homepage, the sitemap and up to 11 of the most useful internal pages (contact, about, services, areas, a few articles). 3 requests at a time, 8 seconds and 1.5 MB per page, 40 seconds in total. It identifies itself as `RnROsBot`.
- **Network safety** (`src/lib/social/safeFetch.ts`): only http/https on ports 80/443, no credentials in URLs, no localhost, `.local`/`.internal` names or cloud metadata hosts. Every hostname is resolved inside the socket connect, and private, loopback, link-local, CGNAT, multicast and reserved IPv4/IPv6 addresses are refused, which also stops DNS rebinding. Redirects are re-checked at every hop.
- **Extraction** (`src/lib/social/extract.ts`): JSON-LD structured data, metadata, `tel:`/`mailto:` links, `<address>` elements, social profile links, service and article pages, and claims, certifications and offers quoted word for word. Each fact keeps its source page, the supporting text and a confidence. Addresses only come from structured data or an `<address>` element, and reviews and ratings are never extracted.
- **AI suggestions** (optional, needs `ANTHROPIC_API_KEY`): industry, niche, tone, value proposition and description only, always labelled as suggestions and never auto-filled. The database refuses AI-sourced phone numbers, addresses, credentials or claims.
- **Review** (`/social/brands/[id]/profile`): each field shows its candidates with source and confidence. Use or Reject them, or edit the profile directly. Conflicting values must be resolved before approval (admins only). A rescan only fills fields that are empty and unconfirmed, so nothing the user confirmed is overwritten.

### Content planning and drafts

Content Studio (`/social/content`) plans topics, researches them and drafts posts per platform for brands whose profile is approved. **Nothing is published**: approval only marks a post as ready for the publishing phase.

- **Strategy** (`/social/content/strategy?brand=`): categories (educational, customer questions, maintenance tips, seasonal, industry updates, service explainers, local relevance), platforms, posts per week, posting days, audience, goals, tone and topics to avoid. Planned topics appear on the Publishing Calendar.
- **Only confirmed facts reach the model**: the approved profile and confirmed facts of that one brand. Model output is never stored as fact. Every variant is checked against platform limits (X counts links as 23 characters, Google Business Profile allows no hashtags, links or phone numbers, and so on) and for unconfirmed phone numbers, links outside the brand's site or cited sources, credentials not in the profile, statistics without a source, testimonials, engagement bait and keyword stuffing. Errors block approval.
- **Research**: seasonal, industry and local topics are searched first. Each source keeps its URL, title, publisher, publish date, retrieval date and excerpt; the model cites sources by number and only cited sources are attached to a variant.
- **Duplicates**: near-identical topics are dropped when planning, and a variant too similar to a recent post (3-word shingle overlap of 50% or more) can't be approved until it's edited or regenerated.
- **Tracking and limits**: every model or search call is stored in `ai_generations` with provider, model, prompt version, tokens and estimated cost (left empty when prices aren't set). Monthly generation, research and spend limits per workspace are set in Social Settings.

Environment variables (Vercel):

| Variable | Needed for |
| --- | --- |
| `CONTENT_AI_PROVIDER` | `anthropic` (default, uses `ANTHROPIC_API_KEY`), `xai` or `openai_compatible` |
| `CONTENT_AI_MODEL` | Model id. Required for `xai` (a Grok model from console.x.ai) and `openai_compatible`; optional for Anthropic |
| `XAI_API_KEY`, `XAI_BASE_URL` | xAI (base URL defaults to `https://api.x.ai/v1`) |
| `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` | Any other provider with an OpenAI-compatible Chat Completions API and JSON-schema output |
| `RESEARCH_PROVIDER` | `brave` (`BRAVE_SEARCH_API_KEY`) or `tavily` (`TAVILY_API_KEY`). Without it, time-sensitive topics are drafted without dated claims |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `RESEARCH_PRICE_PER_CALL` | Optional, in USD, for cost estimates and the spend cap |

### Publishing to Facebook Pages and Instagram

Connected Accounts (`/social/accounts`) connects Facebook Pages and linked Instagram professional accounts through Facebook Login. In Content Studio, an admin chooses the account for each approved platform version and presses **Publish now**.

- A post counts as published only when Meta returns its id. One job per version and account (idempotency key) means a post is never sent twice.
- An unclear answer (a timeout or a 5xx while posting) parks the job as **Needs check**. It is not retried until **Check if it posted** confirms the post is missing.
- Expired tokens mark the account **Needs reconnect**, and rate limits pause it. Publishing never falls back to another account.
- Images are attached by public https link and checked for type, size and shape at save time and again before publishing.
- Adapters live in `src/lib/social/publish/` (`types.ts` is the shared interface, `meta.ts` the Meta implementation). X, LinkedIn, Google Business Profile and WordPress are planned. Medium isn't possible (no new API access).

Setup, permissions, app review and a manual test checklist: [docs/meta-setup.md](docs/meta-setup.md). Variables: `META_APP_ID`, `META_APP_SECRET`, optional `META_GRAPH_VERSION`, and `TOKEN_ENCRYPTION_KEY`.

### Scheduling and automation

Run `supabase/migrations/0008_social_automation.sql` after 0007. An approved version can be scheduled from Content Studio at a local time in its brand's time zone. The **Publishing Queue** (`/social/queue`) shows upcoming, failed and finished posts, with pause, resume, reschedule, skip and cancel, plus alerts and the scheduler's last run. **Automation** (`/social/automation`) holds the per-brand modes (draft only, generate then wait for approval, publish approved posts, fully automatic with an explicit opt-in), the per-account switches, the pause-everything switch, and the daily and monthly limits.

The worker is `/api/cron/social`, called every 5 minutes by Supabase pg_cron with `CRON_SECRET`. It claims due jobs with `FOR UPDATE SKIP LOCKED`, runs every publishing check again, retries only rate limits and temporary errors (with backoff), and parks unclear results until the platform has been checked. Setup SQL, monitoring queries and a manual test checklist: [docs/automation.md](docs/automation.md).

## Tests

```bash
npm test                      # roles, validation, encryption, content rules, AI providers, Meta Graph API and Google APIs with mocked responses
# Workspace-boundary and Google connection tests (mocked Google, real database) against a disposable Supabase/PostgREST with all migrations applied:
SOCIAL_TEST_SUPABASE_URL=http://localhost:54321 SOCIAL_TEST_SUPABASE_KEY=<service role key> npm test
# Database constraint tests (needs psql and a disposable Postgres 15+; never production):
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres npm run test:db
```

With the Supabase CLI, `supabase start` gives you both: API on port 54321 and Postgres on 54322.

## Project layout

```
src/app/(app)/            signed-in area (sidebar + top bar in layout.tsx)
  overview, analytics,    SEO Intelligence pages; the top-bar website and
  queries, pages,         date range (cookies) drive all of them
  opportunities
  websites, integrations, management and account pages
  settings, help
  social/                 Social Automation: overview, brands, accounts, content
                          studio, calendar, history, settings
  citations               planned module (Phase 3), marked "Soon"
  actions.ts              server actions (sync, recommendations, selection)
src/app/api/              Google OAuth, daily cron, CSV export
src/components/           design system (ui/), shell, charts, tables
src/lib/google/           OAuth tokens and Search Console API client
src/lib/gsc/              sync, date windows, insight rules
src/lib/ai/               Claude recommendations
src/lib/social/           workspaces, roles, validation, encryption, data access
tests/                    node:test suites (npm test)
supabase/migrations/      database schema, run in order
supabase/tests/           SQL tests for the schema (npm run test:db)
```

## Limits worth knowing

- One cron run has 5 minutes (the Vercel function limit). Sites are synced oldest-first, and any that don't fit wait for the next day. With many large sites, add a second cron entry in `vercel.json`.
- Google allows 2,000 URL inspections per site per day. `GSC_INSPECT_LIMIT` (40 by default) keeps each run short.
- Search Console data lags about 2 days, so the latest window ends on the newest day Google has published.
