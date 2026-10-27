-- Database tests for 0007_social_publishing.sql: Meta connections, encrypted tokens and publishing jobs.
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
  ('aaaaaaaa-0000-0000-0000-000000000007', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000007', 'Workspace B');
insert into brands (id, workspace_id, name, slug) values
  ('aaaaaaaa-0000-0000-0000-0000000007b1', 'aaaaaaaa-0000-0000-0000-000000000007', 'Brand A', 'brand-a'),
  ('bbbbbbbb-0000-0000-0000-0000000007b1', 'bbbbbbbb-0000-0000-0000-000000000007', 'Brand B', 'brand-b');
insert into meta_connections (id, workspace_id, meta_user_id, connected_by) values
  ('aaaaaaaa-0000-0000-0000-0000000007c1', 'aaaaaaaa-0000-0000-0000-000000000007', 'u1', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-0000000007c1', 'bbbbbbbb-0000-0000-0000-000000000007', 'u2', 'b@example.com');
insert into social_accounts (id, workspace_id, brand_id, platform, external_account_id, display_name, meta_connection_id) values
  ('aaaaaaaa-0000-0000-0000-0000000007a1', 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007b1', 'facebook_page', 'p1', 'Page A', 'aaaaaaaa-0000-0000-0000-0000000007c1');
insert into posts (id, workspace_id, brand_id, title, created_by, status) values
  ('aaaaaaaa-0000-0000-0000-0000000007d1', 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007b1', 'Post A', 'a@example.com', 'approved');
insert into post_variants (id, workspace_id, post_id, platform, body, social_account_id) values
  ('aaaaaaaa-0000-0000-0000-0000000007e1', 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007d1', 'facebook_page', 'Hello', 'aaaaaaaa-0000-0000-0000-0000000007a1');

-- Connections and tokens
select pg_temp.expect_error('one connection per Facebook user per workspace',
  $$insert into meta_connections (workspace_id, meta_user_id, connected_by) values ('aaaaaaaa-0000-0000-0000-000000000007', 'u1', 'x')$$, '23505');
select pg_temp.expect_error('user token must be ciphertext',
  $$insert into meta_connection_credentials (connection_id, workspace_id, user_token_enc) values ('aaaaaaaa-0000-0000-0000-0000000007c1', 'aaaaaaaa-0000-0000-0000-000000000007', 'EAAGplaintexttoken')$$, '23514');
select pg_temp.expect_ok('encrypted user token',
  $$insert into meta_connection_credentials (connection_id, workspace_id, user_token_enc) values ('aaaaaaaa-0000-0000-0000-0000000007c1', 'aaaaaaaa-0000-0000-0000-000000000007', 'v1:aXY=:dGFn:ZGF0YQ==')$$);
select pg_temp.expect_error('credentials can''t point at another workspace''s connection',
  $$insert into meta_connection_credentials (connection_id, workspace_id, user_token_enc) values ('bbbbbbbb-0000-0000-0000-0000000007c1', 'aaaaaaaa-0000-0000-0000-000000000007', 'v1:aXY=:dGFn:ZGF0YQ==')$$, '23503');
select pg_temp.expect_ok('discovered page',
  $$insert into meta_assets (id, workspace_id, connection_id, platform, external_account_id, page_id, name) values ('aaaaaaaa-0000-0000-0000-0000000007f1', 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007c1', 'facebook_page', 'p1', 'p1', 'Page A')$$);
select pg_temp.expect_error('only Facebook Pages and Instagram are discovered',
  $$insert into meta_assets (workspace_id, connection_id, platform, external_account_id, page_id, name) values ('aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007c1', 'x', 'x1', 'p1', 'X')$$, '23514');
select pg_temp.expect_error('page token must be ciphertext',
  $$insert into meta_asset_credentials (asset_id, workspace_id, page_token_enc) values ('aaaaaaaa-0000-0000-0000-0000000007f1', 'aaaaaaaa-0000-0000-0000-000000000007', 'plain')$$, '23514');
select pg_temp.expect_error('unknown permitted action',
  $$update social_accounts set permitted_actions = array['delete_page'] where id = 'aaaaaaaa-0000-0000-0000-0000000007a1'$$, '23514');
select pg_temp.expect_error('account can''t link another workspace''s connection',
  $$update social_accounts set meta_connection_id = 'bbbbbbbb-0000-0000-0000-0000000007c1' where id = 'aaaaaaaa-0000-0000-0000-0000000007a1'$$, '23503');

-- Variants
select pg_temp.expect_error('image links must be https',
  $$update post_variants set image_url = 'http://cdn.example/a.jpg' where id = 'aaaaaaaa-0000-0000-0000-0000000007e1'$$, '23514');
select pg_temp.expect_error('post links must be https',
  $$update post_variants set external_url = 'javascript:alert(1)' where id = 'aaaaaaaa-0000-0000-0000-0000000007e1'$$, '23514');
select pg_temp.expect_error('published needs the platform''s post id',
  $$update post_variants set status = 'published', published_at = now() where id = 'aaaaaaaa-0000-0000-0000-0000000007e1'$$, '23514');

-- Jobs and attempts
select pg_temp.expect_ok('claimed job',
  $$insert into scheduled_jobs (id, workspace_id, variant_id, social_account_id, run_at, status, attempts, idempotency_key, locked_at)
    values ('aaaaaaaa-0000-0000-0000-0000000007a9', 'aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007e1', 'aaaaaaaa-0000-0000-0000-0000000007a1', now(), 'claimed', 1, 'publish:test', now())$$);
select pg_temp.expect_error('one job per idempotency key',
  $$insert into scheduled_jobs (workspace_id, variant_id, run_at, idempotency_key) values ('aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007e1', now(), 'publish:test')$$, '23505');
select pg_temp.expect_ok('first attempt',
  $$insert into publish_attempts (workspace_id, job_id, attempt_no) values ('aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-0000000007a9', 1)$$);
select pg_temp.expect_error('a successful attempt needs the platform''s post id',
  $$update publish_attempts set outcome = 'success', finished_at = now() where job_id = 'aaaaaaaa-0000-0000-0000-0000000007a9'$$, '23514');
select pg_temp.expect_ok('an ambiguous attempt',
  $$update publish_attempts set outcome = 'ambiguous', error_kind = 'ambiguous', finished_at = now() where job_id = 'aaaaaaaa-0000-0000-0000-0000000007a9'$$);
select pg_temp.expect_error('unknown error kind',
  $$update publish_attempts set error_kind = 'oops' where job_id = 'aaaaaaaa-0000-0000-0000-0000000007a9'$$, '23514');
select pg_temp.expect_ok('job waits for a check',
  $$update scheduled_jobs set status = 'needs_check', locked_at = null where id = 'aaaaaaaa-0000-0000-0000-0000000007a9'$$);
select pg_temp.expect_error('a succeeded job needs the platform''s post id',
  $$update scheduled_jobs set status = 'succeeded' where id = 'aaaaaaaa-0000-0000-0000-0000000007a9'$$, '23514');
select pg_temp.expect_ok('succeeded with the post id',
  $$update scheduled_jobs set status = 'succeeded', external_post_id = 'p1_1' where id = 'aaaaaaaa-0000-0000-0000-0000000007a9'$$);

-- Revoking
delete from meta_connections where id = 'aaaaaaaa-0000-0000-0000-0000000007c1';
select pg_temp.check('tokens and discovered pages go with the connection',
  not exists (select 1 from meta_connection_credentials where connection_id = 'aaaaaaaa-0000-0000-0000-0000000007c1')
  and not exists (select 1 from meta_assets where connection_id = 'aaaaaaaa-0000-0000-0000-0000000007c1'));
select pg_temp.check('accounts stay, unlinked', (select meta_connection_id is null from social_accounts where id = 'aaaaaaaa-0000-0000-0000-0000000007a1'));
select pg_temp.check('new tables have row level security',
  (select bool_and(relrowsecurity) from pg_class where relname in ('meta_connections', 'meta_connection_credentials', 'meta_assets', 'meta_asset_credentials')));

\echo 'All publishing database tests passed.'
rollback;
