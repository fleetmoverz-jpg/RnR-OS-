-- Database tests for 0008_social_automation.sql: the queue, its claim and recovery functions, and automation settings.
-- Runs inside one transaction and rolls back, so it leaves nothing behind.
-- Run with: npm run test:db  (see scripts/test-db.sh)

begin;

create function pg_temp.expect_error(label text, stmt text, code text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = code then
      raise notice 'ok   %', label;
      return;
    end if;
    raise exception 'FAIL %: expected SQLSTATE % but got % (%)', label, code, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL %: statement succeeded but should have failed with %', label, code;
end $$;

create function pg_temp.expect_ok(label text, stmt text) returns void language plpgsql as $$
begin
  execute stmt;
  raise notice 'ok   %', label;
exception when others then
  raise exception 'FAIL %: % (%)', label, sqlerrm, sqlstate;
end $$;

create function pg_temp.check(label text, cond boolean) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL %', label; end if;
  raise notice 'ok   %', label;
end $$;
insert into workspaces (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000008', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000008', 'Workspace B');
insert into brands (id, workspace_id, name, slug, timezone) values
  ('aaaaaaaa-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-000000000008', 'Brand A', 'brand-a', 'America/New_York'),
  ('bbbbbbbb-0000-0000-0000-0000000008b1', 'bbbbbbbb-0000-0000-0000-000000000008', 'Brand B', 'brand-b', 'UTC');
insert into social_accounts (id, workspace_id, brand_id, platform, external_account_id, display_name) values
  ('aaaaaaaa-0000-0000-0000-0000000008a1', 'aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008b1', 'facebook_page', 'p1', 'Page A'),
  ('bbbbbbbb-0000-0000-0000-0000000008a1', 'bbbbbbbb-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-0000000008b1', 'facebook_page', 'p2', 'Page B');
insert into posts (id, workspace_id, brand_id, title, created_by, status) values
  ('aaaaaaaa-0000-0000-0000-0000000008d1', 'aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008b1', 'Post A', 'a@example.com', 'scheduled'),
  ('bbbbbbbb-0000-0000-0000-0000000008d1', 'bbbbbbbb-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-0000000008b1', 'Post B', 'b@example.com', 'scheduled');
insert into post_variants (id, workspace_id, post_id, platform, body, social_account_id) values
  ('aaaaaaaa-0000-0000-0000-0000000008e1', 'aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008d1', 'facebook_page', 'One', 'aaaaaaaa-0000-0000-0000-0000000008a1'),
  ('aaaaaaaa-0000-0000-0000-0000000008e2', 'aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008d1', 'facebook_page', 'Two', null),
  ('bbbbbbbb-0000-0000-0000-0000000008e1', 'bbbbbbbb-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-0000000008d1', 'facebook_page', 'Three', 'bbbbbbbb-0000-0000-0000-0000000008a1');

-- Settings
select pg_temp.expect_error('fully automatic needs a recorded opt-in',
  $$insert into brand_automation (brand_id, workspace_id, enabled, mode) values ('aaaaaaaa-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-000000000008', true, 'fully_automatic')$$, '23514');
select pg_temp.expect_error('times must be HH:MM',
  $$insert into brand_automation (brand_id, workspace_id, times) values ('aaaaaaaa-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-000000000008', '{25:00}')$$, '23514');
select pg_temp.expect_error('brand automation can''t point at another workspace''s brand',
  $$insert into brand_automation (brand_id, workspace_id) values ('bbbbbbbb-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-000000000008')$$, '23503');
select pg_temp.expect_ok('fully automatic with an opt-in',
  $$insert into brand_automation (brand_id, workspace_id, enabled, mode, times, full_auto_confirmed_by, full_auto_confirmed_at)
    values ('aaaaaaaa-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-000000000008', true, 'fully_automatic', '{09:00,18:30}', 'a@example.com', now())$$);
select pg_temp.expect_error('a paused workspace records when',
  $$insert into automation_settings (workspace_id, paused) values ('aaaaaaaa-0000-0000-0000-000000000008', true)$$, '23514');

-- Queue rows
select pg_temp.expect_ok('scheduled job in New York time',
  $$insert into scheduled_jobs (id, workspace_id, brand_id, variant_id, social_account_id, run_at, timezone, local_time, idempotency_key, source)
    values ('aaaaaaaa-0000-0000-0000-0000000008f1', 'aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-0000000008e1',
            'aaaaaaaa-0000-0000-0000-0000000008a1', '2026-10-27 13:00+00', 'America/New_York', '2026-10-27 09:00', 'publish:a1', 'schedule')$$);
select pg_temp.expect_error('unknown time zone',
  $$update scheduled_jobs set timezone = 'Mars/Base' where id = 'aaaaaaaa-0000-0000-0000-0000000008f1'$$, '22023');
select pg_temp.expect_error('one queued post per account per minute',
  $$insert into scheduled_jobs (workspace_id, brand_id, variant_id, social_account_id, run_at, idempotency_key)
    values ('aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008b1', 'aaaaaaaa-0000-0000-0000-0000000008e2', 'aaaaaaaa-0000-0000-0000-0000000008a1', '2026-10-27 13:00+00', 'publish:a2')$$, '23505');
select pg_temp.expect_error('unknown source',
  $$update scheduled_jobs set source = 'robot' where id = 'aaaaaaaa-0000-0000-0000-0000000008f1'$$, '23514');
select pg_temp.expect_error('a dead job says why',
  $$update scheduled_jobs set status = 'dead', last_error = null where id = 'aaaaaaaa-0000-0000-0000-0000000008f1'$$, '23514');
select pg_temp.expect_error('a job can''t point at another workspace''s brand',
  $$update scheduled_jobs set brand_id = 'bbbbbbbb-0000-0000-0000-0000000008b1' where id = 'aaaaaaaa-0000-0000-0000-0000000008f1'$$, '23503');
insert into scheduled_jobs (id, workspace_id, brand_id, variant_id, social_account_id, run_at, idempotency_key)
  values ('bbbbbbbb-0000-0000-0000-0000000008f1', 'bbbbbbbb-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-0000000008b1', 'bbbbbbbb-0000-0000-0000-0000000008e1', 'bbbbbbbb-0000-0000-0000-0000000008a1', '2026-10-27 12:00+00', 'publish:b1');

-- Claiming
select pg_temp.check('nothing is claimed before it is due',
  (select count(*) = 0 from social_claim_due_jobs('t', 10, '2026-10-27 11:00+00', '{}', array['aaaaaaaa-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-000000000008']::uuid[])));
insert into automation_settings (workspace_id, paused, paused_at) values ('aaaaaaaa-0000-0000-0000-000000000008', true, now());
select pg_temp.check('a paused workspace is skipped; the other is claimed once',
  (select array_agg(id) = array['bbbbbbbb-0000-0000-0000-0000000008f1']::uuid[] from social_claim_due_jobs('t', 10, '2026-10-27 14:00+00', '{}', array['aaaaaaaa-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-000000000008']::uuid[])));
select pg_temp.check('a claimed job is locked and counted',
  (select status = 'claimed' and attempts = 1 and locked_by = 't' from scheduled_jobs where id = 'bbbbbbbb-0000-0000-0000-0000000008f1'));
update automation_settings set paused = false, paused_at = null where workspace_id = 'aaaaaaaa-0000-0000-0000-000000000008';
update brand_automation set paused = true where brand_id = 'aaaaaaaa-0000-0000-0000-0000000008b1';
select pg_temp.check('a paused brand is skipped',
  (select count(*) = 0 from social_claim_due_jobs('t', 10, '2026-10-27 14:00+00', '{}', array['aaaaaaaa-0000-0000-0000-000000000008']::uuid[])));
update brand_automation set paused = false where brand_id = 'aaaaaaaa-0000-0000-0000-0000000008b1';
update social_accounts set automation_paused = true where id = 'aaaaaaaa-0000-0000-0000-0000000008a1';
select pg_temp.check('a paused account is skipped',
  (select count(*) = 0 from social_claim_due_jobs('t', 10, '2026-10-27 14:00+00', '{}', array['aaaaaaaa-0000-0000-0000-000000000008']::uuid[])));
update social_accounts set automation_paused = false where id = 'aaaaaaaa-0000-0000-0000-0000000008a1';
select pg_temp.check('a workspace at its limit is skipped',
  (select count(*) = 0 from social_claim_due_jobs('t', 10, '2026-10-27 14:00+00', array['aaaaaaaa-0000-0000-0000-000000000008']::uuid[], array['aaaaaaaa-0000-0000-0000-000000000008']::uuid[])));
select pg_temp.check('claimed when nothing is paused',
  (select count(*) = 1 from social_claim_due_jobs('t2', 10, '2026-10-27 14:00+00', '{}', array['aaaaaaaa-0000-0000-0000-000000000008']::uuid[])));

-- Recovering after a crash
insert into publish_attempts (workspace_id, job_id, attempt_no, started_at) values ('aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-0000000008f1', 1, '2026-10-27 14:00+00');
select pg_temp.check('fresh claims are left alone',
  (select count(*) = 0 from social_recover_stale_jobs(300, '2026-10-27 14:02+00', null)));
select pg_temp.check('a stale claim with a started attempt needs checking; one without goes back to pending',
  (select array_agg(outcome order by outcome) = array['needs_check', 'pending'] from social_recover_stale_jobs(300, '2026-10-27 14:10+00', array['aaaaaaaa-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-000000000008']::uuid[])));
select pg_temp.check('the open attempt is closed as unclear',
  (select outcome = 'ambiguous' and finished_at is not null from publish_attempts where job_id = 'aaaaaaaa-0000-0000-0000-0000000008f1'));
select pg_temp.check('the never-started job gives its attempt back',
  (select status = 'pending' and attempts = 0 and locked_at is null from scheduled_jobs where id = 'bbbbbbbb-0000-0000-0000-0000000008f1'));

-- Alerts
select pg_temp.expect_ok('alert', $$insert into notifications (workspace_id, kind, severity, title, dedupe_key) values ('aaaaaaaa-0000-0000-0000-000000000008', 'publish_failed', 'error', 'Failed', 'job:1')$$);
select pg_temp.expect_error('the same unread alert is raised once',
  $$insert into notifications (workspace_id, kind, severity, title, dedupe_key) values ('aaaaaaaa-0000-0000-0000-000000000008', 'publish_failed', 'error', 'Failed', 'job:1')$$, '23505');
update notifications set read_at = now(), read_by = 'a@example.com' where dedupe_key = 'job:1';
select pg_temp.expect_ok('once read, it can be raised again', $$insert into notifications (workspace_id, kind, severity, title, dedupe_key) values ('aaaaaaaa-0000-0000-0000-000000000008', 'publish_failed', 'error', 'Failed', 'job:1')$$);
select pg_temp.check('new tables have row level security',
  (select bool_and(relrowsecurity) from pg_class where relname in ('automation_settings', 'brand_automation', 'notifications', 'worker_runs')));

\echo 'All automation database tests passed.'
rollback;
