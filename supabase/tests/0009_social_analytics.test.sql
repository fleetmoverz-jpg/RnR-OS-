-- Database tests for 0009_social_analytics.sql: link tracking and request limits.
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
  ('aaaaaaaa-0000-0000-0000-000000000009', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000009', 'Workspace B');
insert into brands (id, workspace_id, name, slug) values
  ('aaaaaaaa-0000-0000-0000-0000000009b1', 'aaaaaaaa-0000-0000-0000-000000000009', 'Brand A', 'brand-a'),
  ('bbbbbbbb-0000-0000-0000-0000000009b1', 'bbbbbbbb-0000-0000-0000-000000000009', 'Brand B', 'brand-b');
insert into posts (id, workspace_id, brand_id, title, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000009d1', 'aaaaaaaa-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-0000000009b1', 'Post', 'a@example.com');
insert into post_variants (id, workspace_id, post_id, platform, body) values
  ('aaaaaaaa-0000-0000-0000-0000000009e1', 'aaaaaaaa-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-0000000009d1', 'facebook_page', 'Hello');

-- Link tracking
select pg_temp.expect_ok('tracking with defaults',
  $$insert into brand_link_tracking (brand_id, workspace_id, enabled) values ('aaaaaaaa-0000-0000-0000-0000000009b1', 'aaaaaaaa-0000-0000-0000-000000000009', true)$$);
select pg_temp.check('defaults tag by platform', (select utm_source = '{platform}' and utm_medium = 'social' from brand_link_tracking where brand_id = 'aaaaaaaa-0000-0000-0000-0000000009b1'));
select pg_temp.expect_error('UTM values are plain words',
  $$update brand_link_tracking set utm_campaign = 'spring sale<script>' where brand_id = 'aaaaaaaa-0000-0000-0000-0000000009b1'$$, '23514');
select pg_temp.expect_error('tracking can''t point at another workspace''s brand',
  $$insert into brand_link_tracking (brand_id, workspace_id) values ('bbbbbbbb-0000-0000-0000-0000000009b1', 'aaaaaaaa-0000-0000-0000-000000000009')$$, '23503');
select pg_temp.expect_error('the sent link must be a web link',
  $$update post_variants set sent_link_url = 'javascript:alert(1)' where id = 'aaaaaaaa-0000-0000-0000-0000000009e1'$$, '23514');

-- Request limits
select pg_temp.check('within the limit', (select bool_and(social_rate_limit('t:a', 3, 60, '2026-10-22 12:00:10+00')) from generate_series(1, 3)));
select pg_temp.check('over the limit', not social_rate_limit('t:a', 3, 60, '2026-10-22 12:00:20+00'));
select pg_temp.check('other keys are separate', social_rate_limit('t:b', 3, 60, '2026-10-22 12:00:20+00'));
select pg_temp.check('a new window starts fresh', social_rate_limit('t:a', 3, 60, '2026-10-22 12:01:00+00'));
select pg_temp.check('new tables have row level security',
  (select bool_and(relrowsecurity) from pg_class where relname in ('brand_link_tracking', 'request_limits')));

\echo 'All analytics database tests passed.'
rollback;
