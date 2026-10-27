# Scheduling and automation

Scheduled posts, the publishing queue, and per-brand automation. Nothing is automatic until you switch it on for a brand on the **Automation** page. The **Pause everything** switch stops all publishing and draft writing at once.

## How it works

- **Queue.** Each scheduled post version is one row in `scheduled_jobs`. The row holds `run_at` (UTC), the brand's IANA time zone (`timezone`), and the local time it was planned for (`local_time`). The idempotency key `publish:{version}:{account}` means a version can never be queued twice for the same account. A unique index also allows only one queued post per account per minute.
- **Worker.** `GET/POST /api/cron/social` runs one pass. It needs `Authorization: Bearer $CRON_SECRET`.
  1. **Crash recovery.** A job claimed more than 5 minutes ago belongs to a worker that died.
     - If an attempt had started, the job becomes **Needs check**. The post may have gone out, so it is never simply retried.
     - If no attempt had started, nothing was sent and the job goes back to **Pending**.
  2. **Per workspace.** Paused workspaces are skipped entirely.
     - Settle unclear jobs. After 2 minutes, the worker looks for the post on the platform. If it is found, the job is marked published. If it is not, the job goes back in the queue.
     - Raise alerts for disconnected accounts that have posts due in the next 24 hours, and for Facebook logins that expire within 7 days.
     - Check the daily and monthly post limits.
     - Plan each brand that has automation on (see the modes below).
  3. **Publish what is due.** Jobs are claimed with `FOR UPDATE SKIP LOCKED` through `social_claim_due_jobs`, so two overlapping runs split the work and never share a job.
     - Every job runs the same checks as **Publish now**: approval, validation, account status, permissions, rate limit, and the image fetched again.
     - A job that fails these checks is never sent. It ends as **Dead** with the reasons, and an alert is raised.
- **Retries.**
  - Rate limits and temporary errors are retried with backoff: 2, 4, 8 minutes and so on, up to 6 hours, or whatever wait Meta asks for. This continues up to 5 attempts, then the job is **Dead**.
  - Any other error (auth, permission, content, media, policy) ends as **Dead** straight away, with an alert.
  - An unclear answer (a timeout or 5xx while posting) becomes **Needs check** and is never retried until the platform has been checked.
- **No silent switching.** A job always posts to the account it was queued for. If that account is disconnected, the job fails with an alert. It is never moved to another account or brand.

## Automation modes (per brand)

| Mode | Writes drafts | Queues approved posts | Approves on its own |
| --- | --- | --- | --- |
| Draft only | yes | no | no |
| Generate, then wait for approval | yes | yes | no |
| Publish approved posts | no | yes | no |
| Fully automatic | yes | yes | only drafts that pass every check |

- **Slots.** Slots come from the brand's posting days, times and posts per week, in the brand's time zone (set on the brand page).
  - A slot skipped by a daylight-saving change moves forward by the gap.
  - A time that occurs twice when the clocks go back uses its first occurrence.
  - The posts-per-week count includes posts you schedule by hand.
- **Queue order.** Approved posts fill free slots in the next 7 days, oldest approval first.
  - A version with no account is assigned automatically only when the brand has exactly one connected account for that platform. Otherwise an alert asks you to choose.
  - A post you **skip** or **cancel** is not queued again unless it is approved again.
  - Editing or rejecting a scheduled post takes it out of the queue.
- **Fully automatic opt-in.** This mode needs an explicit opt-in. Tick the box on the Automation page; the database refuses the mode without a recorded `full_auto_confirmed_by`.
  - Drafts with any validation error, or with no clear account, stay as drafts and raise a "needs your review" alert.
  - Switching to another mode clears the opt-in.
- **Draft writing.** Drafts are written at most every 3 hours per brand and at most 3 at a time. Writing stops when the daily AI spending limit or the monthly AI limits (Social Settings) are reached.

## Limits

- **Posts per day / per month.** These cover all brands together and count posts the platform confirmed. Days and months are UTC. When a limit is reached, due posts wait and an alert is raised. Posts you publish by hand with **Publish now** are not blocked.
- **AI spending per day (USD).** Draft writing stops for the rest of the UTC day.

## Setting up the scheduler (Supabase pg_cron)

Vercel's Hobby plan only allows daily cron jobs, so the 5-minute schedule runs from Supabase.

1. Make sure `CRON_SECRET` is set in Vercel. It already is for the daily Search Console sync.
2. In Supabase, go to **Database → Extensions** and enable **pg_cron** and **pg_net**.
3. In the Supabase **SQL Editor**, run the SQL below. Replace `PASTE-CRON-SECRET-HERE` with the same value as in Vercel. The secret is stored in Supabase Vault, not in the job text.

```sql
select vault.create_secret('PASTE-CRON-SECRET-HERE', 'rnr_cron_secret');

select cron.schedule(
  'rnr-social-queue',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://rn-r-os.vercel.app/api/cron/social',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'rnr_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
```

To stop it: `select cron.unschedule('rnr-social-queue');`
If you change `CRON_SECRET`: `select vault.update_secret((select id from vault.secrets where name = 'rnr_cron_secret'), 'NEW-VALUE');`

The **Run now** button on the Publishing Queue page runs one pass for your workspace, which is useful for testing without waiting.

## Monitoring

- **Publishing Queue** shows:
  - when the scheduler last ran, with a warning if it hasn't run for 15 minutes;
  - posts published today and this month against the limits;
  - unread alerts;
  - the queue, split into upcoming, needs attention and done.
- **`worker_runs`** holds one row per run (start, finish, counts, scrubbed errors), kept for 14 days. These queries help:

  ```sql
  -- recent runs
  select started_at, finished_at, stats, error from worker_runs order by started_at desc limit 20;
  -- runs that failed or never finished
  select * from worker_runs where error is not null or finished_at is null order by started_at desc;
  -- jobs waiting for a person
  select status, count(*) from scheduled_jobs where status in ('needs_check', 'dead') group by status;
  -- pg_cron's own log of the HTTP calls
  select * from cron.job_run_details order by start_time desc limit 20;
  ```
- **`audit_events`** records every schedule, pause, resume, skip, cancel, limit change, opt-in, approval by automation, and publish result. The actor is `automation@rnr-os` for the worker.
- Error text in logs and alerts is scrubbed of anything that looks like a token.

## Manual test checklist

- [ ] Run the scheduler SQL. Within 5 minutes, the Publishing Queue shows "Scheduler ran … ago" and the warning disappears.
- [ ] Approve a post, then **Schedule** it 10 minutes ahead. It appears under Upcoming with the brand's local time and the UTC time.
- [ ] **Pause** it, wait past its time: nothing is posted. **Resume**: it goes out at the next run and the View link opens it.
- [ ] Schedule another, then **Reschedule**, **Skip** and **Cancel** it. Each change shows in the queue and in the audit log.
- [ ] Turn on **Pause everything**. Schedule a post 5 minutes ahead and wait: nothing is posted. Turn it off: the post goes out.
- [ ] Set **Posts per day** to 1 and schedule two posts: one goes out, the other waits with a "Post limit reached" alert.
- [ ] On Automation, choose **Generate, then wait for approval** for a brand with an approved profile and one Facebook Page. Drafts appear in Content Studio. Approve one: it is queued into the next slot.
- [ ] Try **Fully automatic** without ticking the box: it is refused. Tick it: the opt-in is recorded with your email.
- [ ] Remove the app from Facebook (Settings → Business integrations) and let a queued post come due. It ends as **Dead** with "needs to be reconnected", an alert appears, and nothing is posted to another Page.

## Tests

- `tests/automation-time.test.ts` covers time zones, daylight-saving gaps and overlaps, weekly slots, backoff and log scrubbing. It needs no database.
- `tests/automation.test.ts` runs against a real database, with Meta and the model mocked. It covers:
  - scheduling, and two workers at once;
  - pause, resume, reschedule, skip and cancel, and pause-all and the per-brand and per-account switches;
  - retries with backoff, the attempt limit and the dead letter;
  - unclear results, and worker crash recovery;
  - a disconnected account with no switching, and validation and edits;
  - the daily limit;
  - approval-required and fully automatic modes;
  - workspace isolation.
- `supabase/tests/0008_social_automation.test.sql` covers constraints, the claim function (paused workspaces, brands and accounts, limits), crash recovery and alert de-duplication.
