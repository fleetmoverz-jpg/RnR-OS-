-- Database tests for 0005_social_analysis.sql: website scans, sourced facts and profile approval.
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
  ('aaaaaaaa-0000-0000-0000-000000000005', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'Workspace B');
insert into brands (id, workspace_id, name, slug) values
  ('aaaaaaaa-0000-0000-0000-0000000005b1', 'aaaaaaaa-0000-0000-0000-000000000005', 'Brand A', 'brand-a'),
  ('bbbbbbbb-0000-0000-0000-0000000005b1', 'bbbbbbbb-0000-0000-0000-000000000005', 'Brand B', 'brand-b');
insert into workspace_websites (id, workspace_id, brand_id, url, domain) values
  ('aaaaaaaa-0000-0000-0000-0000000005c1', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'https://a.example.com', 'a.example.com'),
  ('bbbbbbbb-0000-0000-0000-0000000005c1', 'bbbbbbbb-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-0000000005b1', 'https://b.example.com', 'b.example.com');
insert into website_scans (id, workspace_id, website_id, brand_id, requested_by) values
  ('aaaaaaaa-0000-0000-0000-0000000005d1', 'aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005c1', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'a@example.com');

-- Scans
select pg_temp.expect_error('scan cannot point at another workspace''s website',
  $$insert into website_scans (workspace_id, website_id, requested_by) values ('aaaaaaaa-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-0000000005c1', 'x')$$, '23503');
select pg_temp.expect_error('only one running scan per website',
  $$insert into website_scans (workspace_id, website_id, requested_by) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005c1', 'x')$$, '23505');
select pg_temp.expect_error('a finished scan needs finished_at',
  $$update website_scans set status = 'succeeded' where id = 'aaaaaaaa-0000-0000-0000-0000000005d1'$$, '23514');
select pg_temp.expect_ok('finishing a scan',
  $$update website_scans set status = 'succeeded', finished_at = now() where id = 'aaaaaaaa-0000-0000-0000-0000000005d1'$$);
select pg_temp.expect_ok('a new scan can start once the last one finished',
  $$insert into website_scans (workspace_id, website_id, requested_by) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005c1', 'x')$$);

-- Facts
select pg_temp.expect_ok('website fact with a source',
  $$insert into brand_facts (workspace_id, brand_id, website_id, scan_id, kind, value, source_url, source_quote, origin, confidence)
    values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'aaaaaaaa-0000-0000-0000-0000000005c1', 'aaaaaaaa-0000-0000-0000-0000000005d1',
            'phone', '(254) 555-0142', 'https://a.example.com/contact', '<a href="tel:+12545550142">', 'website', 0.9)$$);
select pg_temp.expect_error('website fact without a source is rejected',
  $$insert into brand_facts (workspace_id, brand_id, kind, value, origin) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'email', 'a@a.com', 'website')$$, '23514');
select pg_temp.expect_error('the same value twice for one brand is rejected (case and spaces ignored)',
  $$insert into brand_facts (workspace_id, brand_id, kind, value, source_url, origin) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'phone', ' (254) 555-0142 ', 'https://a.example.com/', 'website')$$, '23505');
select pg_temp.expect_ok('AI may suggest an industry',
  $$insert into brand_facts (workspace_id, brand_id, kind, value, origin) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'industry', 'Roofing', 'ai_suggestion')$$);
select pg_temp.expect_error('AI may not supply a phone number',
  $$insert into brand_facts (workspace_id, brand_id, kind, value, origin) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'phone', '555', 'ai_suggestion')$$, '23514');
select pg_temp.expect_error('AI may not supply a certification',
  $$insert into brand_facts (workspace_id, brand_id, kind, value, origin) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'certification', 'Certified', 'ai_suggestion')$$, '23514');
select pg_temp.expect_error('AI suggestion can''t be marked verified',
  $$update brand_facts set status = 'verified', source_url = 'https://a.example.com/', source_quote = 'x' where kind = 'industry' and brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$, '23514');
select pg_temp.expect_error('confidence must be between 0 and 1',
  $$update brand_facts set confidence = 1.5 where kind = 'phone' and brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$, '23514');
select pg_temp.expect_error('fact cannot reference another workspace''s website',
  $$update brand_facts set website_id = 'bbbbbbbb-0000-0000-0000-0000000005c1' where kind = 'phone' and brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$, '23503');
select pg_temp.expect_error('unknown fact kind is rejected',
  $$insert into brand_facts (workspace_id, brand_id, kind, value) values ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-0000000005b1', 'review', 'Great!')$$, '23514');

-- Profiles
insert into brand_profiles (brand_id, workspace_id, business_name) values ('aaaaaaaa-0000-0000-0000-0000000005b1', 'aaaaaaaa-0000-0000-0000-000000000005', 'Brand A');
select pg_temp.expect_error('approved profile needs who and when',
  $$update brand_profiles set status = 'approved' where brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$, '23514');
select pg_temp.expect_ok('approving with who and when',
  $$update brand_profiles set status = 'approved', approved_at = now(), approved_by = 'a@example.com' where brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$);
select pg_temp.expect_error('logo must be https',
  $$update brand_profiles set logo_url = 'http://a.example.com/logo.png' where brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$, '23514');
select pg_temp.expect_error('profile source website must be in the same workspace',
  $$update brand_profiles set source_website_id = 'bbbbbbbb-0000-0000-0000-0000000005c1' where brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'$$, '23503');

-- Deleting a website keeps the brand's facts and profile, unlinked.
delete from workspace_websites where id = 'aaaaaaaa-0000-0000-0000-0000000005c1';
select pg_temp.check('facts survive website removal, unlinked',
  (select count(*) = 2 and bool_and(website_id is null and scan_id is null) from brand_facts where brand_id = 'aaaaaaaa-0000-0000-0000-0000000005b1'));
select pg_temp.check('scans are removed with their website',
  not exists (select 1 from website_scans where website_id = 'aaaaaaaa-0000-0000-0000-0000000005c1'));

\echo 'All website analysis database tests passed.'
rollback;
