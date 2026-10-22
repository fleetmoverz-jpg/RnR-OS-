-- Database tests for 0003_social.sql: tenant isolation and data constraints.
-- Runs inside one transaction and rolls back, so it leaves nothing behind.
-- Run with: npm run test:db  (see scripts/test-db.sh)

begin;

-- expect_error runs a statement and passes only if it fails with the given SQLSTATE.
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

-- Fixtures: two workspaces, A and B, each with one brand, one website and one account.
insert into workspaces (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Workspace B');
insert into workspace_members (workspace_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'owner-a@example.com', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'owner-b@example.com', 'owner');
insert into brands (id, workspace_id, name, slug) values
  ('aaaaaaaa-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Brand A', 'brand-a'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Brand B', 'brand-b');
insert into workspace_websites (id, workspace_id, brand_id, url, domain) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'https://a.example.com', 'a.example.com'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'https://b.example.com', 'b.example.com');
insert into social_accounts (id, workspace_id, brand_id, platform, external_account_id, display_name) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'facebook_page', 'test-page-a', 'TEST Page A'),
  ('bbbbbbbb-0000-0000-0000-0000000000d1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'linkedin_page', 'test-page-b', 'TEST Page B');
insert into posts (id, workspace_id, brand_id, title, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'Post A', 'owner-a@example.com');

-- Tenant isolation: nothing in A can point at anything in B.
select pg_temp.expect_error('website cannot belong to another workspace''s brand',
  $$update workspace_websites set brand_id = 'bbbbbbbb-0000-0000-0000-0000000000b1' where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'$$, '23503');
select pg_temp.expect_error('brand cannot use another workspace''s website as primary',
  $$update brands set primary_website_id = 'bbbbbbbb-0000-0000-0000-0000000000c1' where id = 'aaaaaaaa-0000-0000-0000-0000000000b1'$$, '23503');
select pg_temp.expect_error('social account cannot attach to another workspace''s brand',
  $$insert into social_accounts (workspace_id, brand_id, platform, external_account_id, display_name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'instagram', 'x1', 'X')$$, '23503');
select pg_temp.expect_error('website-to-account mapping cannot cross workspaces',
  $$insert into website_social_accounts (workspace_id, website_id, social_account_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-0000000000d1')$$, '23503');
select pg_temp.expect_error('post cannot be created for another workspace''s brand',
  $$insert into posts (workspace_id, brand_id, title, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'Leak', 'owner-a@example.com')$$, '23503');
select pg_temp.expect_error('variant cannot target another workspace''s account',
  $$insert into post_variants (workspace_id, post_id, social_account_id, platform, body)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-0000000000d1', 'linkedin_page', 'Hi')$$, '23503');
select pg_temp.expect_error('credentials cannot attach to another workspace''s account',
  $$insert into social_account_credentials (social_account_id, workspace_id, access_token_enc)
    values ('bbbbbbbb-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'v1:aaaa:bbbb:cccc')$$, '23503');
select pg_temp.expect_error('brand profile cannot attach to another workspace''s brand',
  $$insert into brand_profiles (brand_id, workspace_id) values ('bbbbbbbb-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001')$$, '23503');
select pg_temp.expect_error('topic cannot attach to another workspace''s brand',
  $$insert into content_topics (workspace_id, brand_id, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'T')$$, '23503');
select pg_temp.expect_error('media cannot attach to another workspace''s brand',
  $$insert into media_assets (workspace_id, brand_id, kind, source, storage_path, mime_type)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'image', 'uploaded', 'x/1.jpg', 'image/jpeg')$$, '23503');

-- Same-workspace links work, including several accounts per brand and several websites per workspace.
select pg_temp.expect_ok('second website in the same workspace',
  $$insert into workspace_websites (id, workspace_id, url, domain) values
    ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'https://a2.example.com', 'a2.example.com')$$);
select pg_temp.expect_ok('second account for the same brand',
  $$insert into social_accounts (id, workspace_id, brand_id, platform, external_account_id, display_name) values
    ('aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'instagram', 'test-ig-a', 'TEST IG A')$$);
select pg_temp.expect_ok('map one website to two accounts',
  $$insert into website_social_accounts (workspace_id, website_id, social_account_id) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d2')$$);
select pg_temp.expect_ok('same domain is allowed in a different workspace',
  $$insert into workspace_websites (workspace_id, url, domain) values ('bbbbbbbb-0000-0000-0000-000000000001', 'https://a.example.com', 'a.example.com')$$);

-- Constraints and validation.
select pg_temp.expect_error('duplicate domain in one workspace',
  $$insert into workspace_websites (workspace_id, url, domain) values ('aaaaaaaa-0000-0000-0000-000000000001', 'https://a.example.com', 'a.example.com')$$, '23505');
select pg_temp.expect_error('domain must be lower case',
  $$insert into workspace_websites (workspace_id, url, domain) values ('aaaaaaaa-0000-0000-0000-000000000001', 'https://Up.example.com', 'Up.example.com')$$, '23514');
select pg_temp.expect_error('verified website needs a method and timestamp',
  $$update workspace_websites set verification_status = 'verified' where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'$$, '23514');
select pg_temp.expect_ok('verified website with method and timestamp',
  $$update workspace_websites set verification_status = 'verified', verification_method = 'search_console', verified_at = now() where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'$$);
select pg_temp.expect_error('brand slug must be kebab-case',
  $$insert into brands (workspace_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Bad', 'Bad Slug')$$, '23514');
select pg_temp.expect_error('brand slug unique per workspace',
  $$insert into brands (workspace_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Again', 'brand-a')$$, '23505');
select pg_temp.expect_error('member email must be lower case',
  $$insert into workspace_members (workspace_id, email, role) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Someone@Example.com', 'viewer')$$, '23514');
select pg_temp.expect_error('member role must be known',
  $$insert into workspace_members (workspace_id, email, role) values ('aaaaaaaa-0000-0000-0000-000000000001', 'x@example.com', 'god')$$, '23514');
select pg_temp.expect_error('plaintext tokens are rejected',
  $$insert into social_account_credentials (social_account_id, workspace_id, access_token_enc)
    values ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'EAAB-plain-access-token')$$, '23514');
select pg_temp.expect_error('unknown platform is rejected',
  $$insert into social_accounts (workspace_id, brand_id, platform, external_account_id, display_name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'myspace', 'm', 'M')$$, '23514');
select pg_temp.expect_error('same external account cannot be connected twice',
  $$insert into social_accounts (workspace_id, brand_id, platform, external_account_id, display_name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'facebook_page', 'test-page-a', 'Dup')$$, '23505');
select pg_temp.expect_error('verified fact needs a source URL and quote',
  $$insert into brand_facts (workspace_id, brand_id, kind, value, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'phone', '555-0100', 'verified')$$, '23514');
select pg_temp.expect_error('variant platform must match the account',
  $$insert into post_variants (workspace_id, post_id, social_account_id, platform, body)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'instagram', 'Hi')$$, '23503');
select pg_temp.expect_ok('variant for a matching account',
  $$insert into post_variants (id, workspace_id, post_id, social_account_id, platform, body)
    values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'facebook_page', 'Hi')$$);
select pg_temp.expect_error('published variant needs the platform post id',
  $$update post_variants set status = 'published', published_at = now() where id = 'aaaaaaaa-0000-0000-0000-0000000000f1'$$, '23514');
select pg_temp.expect_error('approved post needs who approved it',
  $$update posts set approved_at = now() where id = 'aaaaaaaa-0000-0000-0000-0000000000e1'$$, '23514');
select pg_temp.expect_ok('scheduled job',
  $$insert into scheduled_jobs (id, workspace_id, variant_id, run_at, idempotency_key)
    values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', now() + interval '1 day', 'variant-f1-1')$$);
select pg_temp.expect_error('idempotency key is unique',
  $$insert into scheduled_jobs (workspace_id, variant_id, run_at, idempotency_key)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', now(), 'variant-f1-1')$$, '23505');
select pg_temp.expect_error('claimed job must record its lock',
  $$update scheduled_jobs set status = 'claimed' where id = 'aaaaaaaa-0000-0000-0000-0000000000a1'$$, '23514');
select pg_temp.expect_error('attempts cannot exceed max_attempts',
  $$update scheduled_jobs set attempts = 4 where id = 'aaaaaaaa-0000-0000-0000-0000000000a1'$$, '23514');
select pg_temp.expect_error('attempt numbers are unique per job',
  $$insert into publish_attempts (workspace_id, job_id, attempt_no) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 1),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 1)$$, '23505');
select pg_temp.expect_error('finished attempt needs an outcome',
  $$insert into publish_attempts (workspace_id, job_id, attempt_no, finished_at) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 2, now())$$, '23514');
select pg_temp.expect_error('schedule days are 0 to 6',
  $$insert into publish_schedules (workspace_id, brand_id, name, days_of_week, times)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'Bad', '{1,7}', '{09:00}')$$, '23514');
select pg_temp.expect_error('audit action must look like entity.verb',
  $$insert into audit_events (workspace_id, actor_email, action, entity_type) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com', 'Created!', 'brand')$$, '23514');
select pg_temp.expect_ok('attach media to a variant',
  $$insert into media_assets (id, workspace_id, brand_id, kind, source, storage_path, mime_type)
      values ('aaaaaaaa-0000-0000-0000-0000000000aa', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'image', 'uploaded', 'a/1.jpg', 'image/jpeg');
    insert into post_variant_media (workspace_id, variant_id, media_id)
      values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000aa')$$);
select pg_temp.expect_error('media in use cannot be deleted',
  $$delete from media_assets where id = 'aaaaaaaa-0000-0000-0000-0000000000aa'$$, '23503');

-- updated_at moves on update.
update brands set updated_at = now() - interval '1 day' where id = 'aaaaaaaa-0000-0000-0000-0000000000b1';
update brands set niche = 'Plumbing' where id = 'aaaaaaaa-0000-0000-0000-0000000000b1';
select pg_temp.check('updated_at trigger', (select updated_at > now() - interval '1 minute' from brands where id = 'aaaaaaaa-0000-0000-0000-0000000000b1'));

-- RLS is on for every social table, so the public API keys can read nothing.
select pg_temp.check('RLS enabled on all social tables', not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    and c.relname in ('workspaces', 'workspace_members', 'workspace_websites', 'brands', 'brand_profiles', 'brand_facts',
                      'social_accounts', 'social_account_credentials', 'website_social_accounts', 'research_runs',
                      'content_topics', 'posts', 'post_variants', 'media_assets', 'post_variant_media',
                      'publish_schedules', 'scheduled_jobs', 'publish_attempts', 'audit_events')));

-- Deleting a website clears the brand's primary website instead of failing.
update brands set primary_website_id = 'aaaaaaaa-0000-0000-0000-0000000000c2' where id = 'aaaaaaaa-0000-0000-0000-0000000000b1';
delete from workspace_websites where id = 'aaaaaaaa-0000-0000-0000-0000000000c2';
select pg_temp.check('deleting a website clears primary_website_id only',
  (select primary_website_id is null and workspace_id = 'aaaaaaaa-0000-0000-0000-000000000001' from brands where id = 'aaaaaaaa-0000-0000-0000-0000000000b1'));

-- Deleting workspace B removes all of B and none of A.
delete from workspaces where id = 'bbbbbbbb-0000-0000-0000-000000000001';
select pg_temp.check('workspace delete cascades to its own rows',
  not exists (select 1 from brands where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001')
  and not exists (select 1 from social_accounts where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001')
  and not exists (select 1 from workspace_websites where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001'));
select pg_temp.check('workspace delete leaves other workspaces intact',
  (select count(*) from brands where workspace_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1);

\echo 'All database tests passed.'
rollback;
