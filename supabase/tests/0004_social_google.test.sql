-- Database tests for 0004_social_google.sql: Google connections, Search Console properties and imports.
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

-- Fixtures: workspaces A and B, each with one Google connection and one discovered property.
-- The token values are well-formed ciphertext envelopes, not real tokens.
insert into workspaces (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'Workspace B');
insert into google_connections (id, workspace_id, google_sub, google_email, scopes, access_token_enc, refresh_token_enc, access_token_expires_at, connected_by) values
  ('aaaaaaaa-0000-0000-0000-0000000004c1', 'aaaaaaaa-0000-0000-0000-000000000004', 'sub-a', 'a@example.com', '{openid}', 'v1:aaaa:bbbb:cccc', 'v1:dddd:eeee:ffff', now() + interval '1 hour', 'owner-a@example.com'),
  ('bbbbbbbb-0000-0000-0000-0000000004c1', 'bbbbbbbb-0000-0000-0000-000000000004', 'sub-b', 'b@example.com', '{openid}', null, 'v1:dddd:eeee:ffff', null, 'owner-b@example.com');
insert into gsc_properties (id, workspace_id, connection_id, site_url, property_type, permission_level) values
  ('aaaaaaaa-0000-0000-0000-0000000004a1', 'aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000004c1', 'sc-domain:example.com', 'domain', 'siteOwner'),
  ('bbbbbbbb-0000-0000-0000-0000000004a1', 'bbbbbbbb-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-0000000004c1', 'https://b.example.com/', 'url_prefix', 'siteFullUser');

-- Credentials are only ever stored encrypted.
select pg_temp.expect_error('plaintext refresh token is rejected',
  $$insert into google_connections (workspace_id, google_sub, google_email, refresh_token_enc, connected_by)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'sub-x', 'x@example.com', '1//plain-refresh-token', 'x')$$, '23514');
select pg_temp.expect_error('plaintext access token is rejected',
  $$update google_connections set access_token_enc = 'ya29.plain' where id = 'aaaaaaaa-0000-0000-0000-0000000004c1'$$, '23514');
select pg_temp.expect_error('access token needs an expiry',
  $$update google_connections set access_token_expires_at = null where id = 'aaaaaaaa-0000-0000-0000-0000000004c1'$$, '23514');
select pg_temp.expect_error('google email must be lowercase',
  $$update google_connections set google_email = 'A@Example.com' where id = 'aaaaaaaa-0000-0000-0000-0000000004c1'$$, '23514');
select pg_temp.expect_error('same Google account twice in one workspace is rejected',
  $$insert into google_connections (workspace_id, google_sub, google_email, refresh_token_enc, connected_by)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'sub-a', 'a@example.com', 'v1:a:b:c', 'x')$$, '23505');
select pg_temp.expect_ok('same Google account may connect to another workspace',
  $$insert into google_connections (workspace_id, google_sub, google_email, refresh_token_enc, connected_by)
    values ('bbbbbbbb-0000-0000-0000-000000000004', 'sub-a', 'a@example.com', 'v1:a:b:c', 'x')$$);
select pg_temp.expect_error('status outside the allowed values is rejected',
  $$update google_connections set status = 'connected' where id = 'aaaaaaaa-0000-0000-0000-0000000004c1'$$, '23514');

-- Properties: shape and tenant isolation.
select pg_temp.expect_error('property cannot belong to another workspace''s connection',
  $$insert into gsc_properties (workspace_id, connection_id, site_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-0000000004c1', 'sc-domain:x.com', 'domain', 'siteOwner')$$, '23503');
select pg_temp.expect_error('domain property must use sc-domain:',
  $$insert into gsc_properties (workspace_id, connection_id, site_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000004c1', 'https://x.com/', 'domain', 'siteOwner')$$, '23514');
select pg_temp.expect_error('URL-prefix property cannot use sc-domain:',
  $$insert into gsc_properties (workspace_id, connection_id, site_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000004c1', 'sc-domain:x.com', 'url_prefix', 'siteOwner')$$, '23514');
select pg_temp.expect_error('URL-prefix property must end with a slash',
  $$insert into gsc_properties (workspace_id, connection_id, site_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000004c1', 'https://x.com', 'url_prefix', 'siteOwner')$$, '23514');
select pg_temp.expect_error('unknown permission level is rejected',
  $$insert into gsc_properties (workspace_id, connection_id, site_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000004c1', 'https://x.com/', 'url_prefix', 'owner')$$, '23514');
select pg_temp.expect_error('same property twice for one connection is rejected',
  $$insert into gsc_properties (workspace_id, connection_id, site_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000004c1', 'sc-domain:example.com', 'domain', 'siteOwner')$$, '23505');

-- Imported websites.
select pg_temp.expect_ok('domain property imports as a verified website when Google reports siteOwner',
  $$insert into workspace_websites (id, workspace_id, url, domain, gsc_property_url, property_type, permission_level, google_connection_id, verification_status, verification_method, verified_at)
    values ('aaaaaaaa-0000-0000-0000-0000000004d1', 'aaaaaaaa-0000-0000-0000-000000000004', 'https://example.com', 'example.com', 'sc-domain:example.com', 'domain', 'siteOwner',
            'aaaaaaaa-0000-0000-0000-0000000004c1', 'verified', 'search_console', now())$$);
select pg_temp.expect_ok('URL-prefix property for the same domain imports as a separate website',
  $$insert into workspace_websites (workspace_id, url, domain, gsc_property_url, property_type, permission_level, google_connection_id)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'https://www.example.com', 'example.com', 'https://www.example.com/', 'url_prefix', 'siteFullUser', 'aaaaaaaa-0000-0000-0000-0000000004c1')$$);
select pg_temp.expect_ok('a manually added website for the same domain can coexist',
  $$insert into workspace_websites (workspace_id, url, domain) values ('aaaaaaaa-0000-0000-0000-000000000004', 'https://example.com', 'example.com')$$);
select pg_temp.expect_error('two manual websites with the same domain are rejected',
  $$insert into workspace_websites (workspace_id, url, domain) values ('aaaaaaaa-0000-0000-0000-000000000004', 'https://example.com/x', 'example.com')$$, '23505');
select pg_temp.expect_error('importing the same property twice into a workspace is rejected',
  $$insert into workspace_websites (workspace_id, url, domain, gsc_property_url, property_type, permission_level)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'https://example.com', 'example.com', 'sc-domain:example.com', 'domain', 'siteOwner')$$, '23505');
select pg_temp.expect_ok('another workspace can import the same property',
  $$insert into workspace_websites (workspace_id, url, domain, gsc_property_url, property_type, permission_level)
    values ('bbbbbbbb-0000-0000-0000-000000000004', 'https://example.com', 'example.com', 'sc-domain:example.com', 'domain', 'siteFullUser')$$);
select pg_temp.expect_error('website cannot link to another workspace''s Google connection',
  $$update workspace_websites set google_connection_id = 'bbbbbbbb-0000-0000-0000-0000000004c1' where id = 'aaaaaaaa-0000-0000-0000-0000000004d1'$$, '23503');
select pg_temp.expect_error('search_console verification needs siteOwner',
  $$insert into workspace_websites (workspace_id, url, domain, gsc_property_url, property_type, permission_level, verification_status, verification_method, verified_at)
    values ('aaaaaaaa-0000-0000-0000-000000000004', 'https://full.example.com', 'full.example.com', 'https://full.example.com/', 'url_prefix', 'siteFullUser', 'verified', 'search_console', now())$$, '23514');
select pg_temp.expect_error('verification cannot survive a downgrade from siteOwner',
  $$update workspace_websites set permission_level = 'siteRestrictedUser' where id = 'aaaaaaaa-0000-0000-0000-0000000004d1'$$, '23514');
select pg_temp.expect_error('property URL and property type go together',
  $$update workspace_websites set property_type = null where id = 'aaaaaaaa-0000-0000-0000-0000000004d1'$$, '23514');

-- Disconnecting deletes properties but keeps imported websites, unlinked.
delete from google_connections where id = 'aaaaaaaa-0000-0000-0000-0000000004c1';
select pg_temp.check('disconnect removes the connection''s properties',
  not exists (select 1 from gsc_properties where connection_id = 'aaaaaaaa-0000-0000-0000-0000000004c1'));
select pg_temp.check('disconnect keeps imported websites with no connection',
  (select google_connection_id is null and workspace_id = 'aaaaaaaa-0000-0000-0000-000000000004' and gsc_property_url = 'sc-domain:example.com'
     from workspace_websites where id = 'aaaaaaaa-0000-0000-0000-0000000004d1'));
select pg_temp.check('disconnect in A leaves B''s connection and property',
  exists (select 1 from gsc_properties where id = 'bbbbbbbb-0000-0000-0000-0000000004a1'));

\echo 'All Google connection database tests passed.'
rollback;
