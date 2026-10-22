# RnR Os

A personal SEO workspace, built in phases:

1. **Search Console dashboard** (this release): daily sync of Google Search Console data, insights and Claude-written recommendations per site.
2. Social posting: connect accounts, pick a niche and area, AI images and posts. *(placeholder in the nav)*
3. Citation builder. *(placeholder in the nav)*

Stack: Next.js (App Router) + Tailwind, Supabase Postgres, hosted on Vercel, Claude API for recommendations.

## What Phase 1 does

- **Sign in with Google**, limited to one account (`ALLOWED_EMAIL`). The same sign-in grants read-only Search Console access.
- **Daily sync** at 06:00 UTC through Vercel Cron, plus a **Sync now** button per site. The first sync backfills 90 days; later syncs re-fetch the last 5 days, because Google revises recent data.
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
2. Open **SQL Editor**, paste the whole of [`supabase/migrations/0001_gsc.sql`](supabase/migrations/0001_gsc.sql) and run it.
3. From **Project Settings → API**, copy the **Project URL** (`SUPABASE_URL`) and the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`).

Every table has row-level security switched on with no policies, so the public anon key can read nothing. Only the server, using the service role key, can.

### 2. Google Cloud (your existing OAuth client)

In the same Google Cloud project as your OAuth client:

1. **APIs & Services → Library**: enable **Google Search Console API**.
2. **APIs & Services → Credentials →** your OAuth 2.0 Client ID (type *Web application*). Under **Authorized redirect URIs** add:
   - `https://<your-vercel-domain>/api/auth/callback`
   - `http://localhost:3000/api/auth/callback` (only for local development)
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

## Project layout

```
src/app/(app)/            signed-in area: nav for all modules
  search-console/         Phase 1 pages
  social/, citations/     Phase 2 and 3 placeholders
  actions.ts              server actions (sync, recommendations, pause)
src/app/api/auth/         Google OAuth start and callback
src/app/api/cron/sync     daily sync entry point
src/lib/google/           OAuth tokens and Search Console API client
src/lib/gsc/              sync, date windows, insight rules
src/lib/ai/               Claude recommendations
supabase/migrations/      database schema
```

## Limits worth knowing

- One cron run has 5 minutes (the Vercel function limit). Sites are synced oldest-first, and any that don't fit wait for the next day. With many large sites, add a second cron entry in `vercel.json`.
- Google allows 2,000 URL inspections per site per day. `GSC_INSPECT_LIMIT` (40 by default) keeps each run short.
- Search Console data lags about 2 days, so the latest window ends on the newest day Google has published.
