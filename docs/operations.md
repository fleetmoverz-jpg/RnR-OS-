# Operations: deployment, migrations, backups and incidents

This is the runbook for running RnR Os in production (Vercel and Supabase). The detailed guides are separate: [meta-setup.md](meta-setup.md) for Facebook and Instagram, and [automation.md](automation.md) for the scheduler.

## Deployment

- Vercel deploys `main` to production. Each pull request gets its own preview deployment.
- **Order for a release that contains a migration:**
  1. Run the migration in Supabase.
  2. Merge the pull request.
  3. Wait for the Vercel deployment to finish.

  New code expects the new columns, but old code keeps working on the new schema, because migrations only add things.
- Before merging, run every check in **Checks before a release** below.
- **To roll back:** in Vercel, open **Deployments**, choose the previous production deployment, and select **Promote to Production**. Migrations don't need undoing, because old code ignores the added tables and columns.

### Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Needed for | Notes |
| --- | --- | --- |
| `APP_URL` | everything | `https://rn-r-os.vercel.app`, with no trailing slash |
| `ALLOWED_EMAIL` | sign-in | The only Google account that can sign in |
| `SESSION_SECRET` | sign-in | `openssl rand -base64 32`. Changing it signs everyone out |
| `CRON_SECRET` | daily Search Console sync and the publishing queue | Must match the value stored in Supabase Vault (see automation.md) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | sign-in and Search Console | |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | everything | Server-only. Never use a `NEXT_PUBLIC_` name |
| `TOKEN_ENCRYPTION_KEY` | Google and social account tokens | 32 bytes, base64. **Changing it makes every stored token unreadable**, so all accounts have to be reconnected |
| `ANTHROPIC_API_KEY` | SEO recommendations and Content Studio AI | |
| `CONTENT_AI_*`, `XAI_*`, `OPENAI_COMPATIBLE_*`, `RESEARCH_PROVIDER`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` | optional AI and research providers | See the README |
| `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `RESEARCH_PRICE_PER_CALL` | cost tracking | Without them, AI costs show as "no price set" |
| `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` | Facebook and Instagram | See meta-setup.md |

## Migrations

- Files are in `supabase/migrations/`. Run them in number order, 0001 to 0009, in the Supabase **SQL Editor**.
- Every file is safe to run twice.
- Each one only adds tables, columns, indexes, constraints and functions. None of them deletes data.

| File | Adds |
| --- | --- |
| 0001, 0002 | Search Console data |
| 0003 | Workspaces, brands, accounts, posts and the queue tables |
| 0004 | Google connections |
| 0005 | Website analysis and brand profiles |
| 0006 | AI research, topics and drafts |
| 0007 | Facebook and Instagram connections and publishing |
| 0008 | Scheduling, automation, alerts and worker runs |
| 0009 | Link tracking, request limits and analytics indexes |

- **Testing a migration first:** apply every migration to a throwaway Postgres and run the database tests. Never point this at production.

  ```bash
  TEST_DATABASE_URL=postgres://… npm run test:db
  ```

- **Supabase's warning:** the SQL Editor may say a query has "destructive operations". That comes from `drop constraint if exists` and `drop trigger if exists`, which are used so the files can be re-run. No data is removed.

## Backups and restore

- **Check what your Supabase plan includes.** Database → Backups shows it. Paid plans keep daily backups, and point-in-time recovery is an add-on. The free plan keeps no backups you can restore yourself.
- **Your own copy (recommended weekly, and before any risky change).**
  1. Copy the connection string from Supabase → Project Settings → Database → Connection string, using the URI and the session pooler.
  2. Run this on your computer:

     ```bash
     pg_dump "postgresql://postgres.<project>:<password>@<host>:5432/postgres" --schema=public --no-owner --format=custom --file=rnr-$(date +%F).dump
     ```

  3. Keep the file somewhere private. It contains encrypted tokens, plus everything else in the database.
- **Restore into a new, empty Supabase project:**

  ```bash
  pg_restore --no-owner --dbname="<new connection string>" rnr-YYYY-MM-DD.dump
  ```

  Then point `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at the new project.
- **Tokens and the key.** Tokens can only be decrypted with the same `TOKEN_ENCRYPTION_KEY`, so keep a copy of that key in your password manager. Without it, a restored database still works, but every account must be reconnected.
- **Scheduler after a restore.** Set up the pg_cron schedule again in the new project (automation.md).

## Monitoring

- **Publishing Queue:**
  - shows when the scheduler last ran, with a warning after 15 minutes without a run;
  - shows unread alerts;
  - shows today's and this month's posts against the limits.
- **Social Analytics** shows the publishing success rate, errors by type, AI cost and quotas.
- **Audit Log** shows who did what, including actions by `automation@rnr-os`.
- **Vercel function logs:** errors are logged as one JSON line each, with `"level":"error"` and a `scope` such as `worker` or `social.action`. Tokens are scrubbed before anything is written.
- **Useful SQL:**

  ```sql
  select started_at, finished_at, stats, error from worker_runs order by started_at desc limit 20;
  select status, count(*) from scheduled_jobs group by status;
  select kind, title, created_at from notifications where read_at is null order by created_at desc;
  select * from cron.job_run_details order by start_time desc limit 20;
  ```

## Incidents

Use **Pause everything** first, then investigate.

| Situation | Do this |
| --- | --- |
| Something is posting that shouldn't | Automation → **Pause everything**. Then, on the Queue page, cancel the affected posts. Pause the brand or account if needed. |
| A Facebook or Instagram token may be exposed | Connected Accounts → **Disconnect & revoke**. That revokes at Meta and deletes the stored tokens. Then reset the app secret in Meta (App settings → Basic), update `META_APP_SECRET`, and reconnect. |
| `SUPABASE_SERVICE_ROLE_KEY` may be exposed | Supabase → Project Settings → API → roll the service role key, update Vercel, and redeploy. Check the audit log and `publish_attempts` for activity you don't recognise. |
| `CRON_SECRET` may be exposed | Set a new value in Vercel and redeploy, then run `vault.update_secret` (automation.md). Until then, someone could only trigger extra queue runs, which are safe to repeat. |
| `TOKEN_ENCRYPTION_KEY` may be exposed | Pause everything, revoke all connections, set a new key, redeploy, and reconnect every account. Old ciphertexts can't be re-encrypted without the old key. |
| Jobs stuck in **Needs check** | Use **Check if it posted** on the Queue page. Never re-publish before checking. The worker does this automatically for queued posts after 2 minutes. |
| The scheduler isn't running | Look at `cron.job_run_details` for HTTP errors. A 401 means the Vault secret doesn't match `CRON_SECRET`. Use **Run now** in the meantime. |
| Meta is rate limiting | Nothing to do. Accounts pause themselves until Meta's reported recovery time, and queued posts wait. |

After an incident, note what happened, what was posted or exposed, and what you changed. The audit log helps rebuild the timeline.

## Security model

- **Access.** A single owner signs in (`ALLOWED_EMAIL`).
  - The session is a signed, httpOnly, SameSite=Lax cookie, checked on every request.
  - Workspace roles (owner, admin, editor, viewer) are checked in every service call.
- **Workspace isolation.** Every row carries `workspace_id`, and every link between rows is a composite foreign key on `(id, workspace_id)`, so the database refuses cross-workspace references. Row level security is on with no policies, so only the server's service role can read anything. The integration tests check isolation for each feature.
- **CSRF.** Mutations are Next.js server actions, which reject requests whose Origin doesn't match the host. The OAuth flows use a signed state cookie scoped to the callback path, and PKCE for Google. The cron endpoints need a bearer secret. GET routes don't change data, except the OAuth callbacks, which require the matching state.
- **Request limits** are counted per person in the database:
  - AI calls: 20 per 10 minutes;
  - publish or schedule: 30 per 10 minutes;
  - OAuth sign-ins: 10 per 10 minutes;
  - manual queue runs: 6 per 10 minutes.
- **Validation.** Every form is parsed with zod, and the database has check constraints on every enum, URL, time and token format.
- **Headers.** Every response sends `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, HSTS and a restrictive permissions policy. There is no Content-Security-Policy yet, because Next.js inline scripts would need nonces.
- **Secrets.**
  - Tokens are encrypted with AES-256-GCM and never sent to the browser.
  - Error text is scrubbed before logging.
  - The cron endpoint returns counts only.

## Checks before a release

```bash
npm run lint && npx tsc --noEmit
npm test                                   # unit tests; database tests are skipped without the variables below
SOCIAL_TEST_SUPABASE_URL=… SOCIAL_TEST_SUPABASE_KEY=… npm test     # plus integration tests on a throwaway database
TEST_DATABASE_URL=… npm run test:db        # SQL constraint tests on a throwaway database
E2E_BASE_URL=https://<preview>.vercel.app E2E_SESSION_SECRET=… E2E_EMAIL=… E2E_CRON_SECRET=… npm test   # smoke test a deployment
npm run build
```

## Outstanding manual requirements

None of these can be done from the code. Until they are done, the matching feature stays off or shows what is missing.

1. Run migrations **0007, 0008 and 0009** in Supabase, in order.
2. **Meta app** (meta-setup.md):
   - create the app;
   - add the redirect URI;
   - set `META_APP_ID` and `META_APP_SECRET`;
   - for Pages whose managers have no role on the app: business verification, App Review for the five permissions, and Live mode.
3. **Scheduler:** enable pg_cron and pg_net in Supabase, store `CRON_SECRET` in Vault, and create the 5-minute job (automation.md).
4. **AI prices:** set `AI_PRICE_*` if you want costs counted.
5. **Backups:** confirm your Supabase plan's backups, or start the weekly `pg_dump`. Store `TOKEN_ENCRYPTION_KEY` in a password manager.
6. **Manual checks with real accounts:** run the checklists in meta-setup.md and automation.md. These integrations have only been tested against mocked APIs.
7. X, LinkedIn, Google Business Profile and WordPress are not built. Medium is not possible.
