-- Database tests for 0006_social_content.sql: strategies, AI usage, research sources and draft variants.
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
  ('aaaaaaaa-0000-0000-0000-000000000006', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000006', 'Workspace B');
insert into brands (id, workspace_id, name, slug) values
  ('aaaaaaaa-0000-0000-0000-0000000006b1', 'aaaaaaaa-0000-0000-0000-000000000006', 'Brand A', 'brand-a'),
  ('bbbbbbbb-0000-0000-0000-0000000006b1', 'bbbbbbbb-0000-0000-0000-000000000006', 'Brand B', 'brand-b');
insert into content_topics (id, workspace_id, brand_id, title) values
  ('aaaaaaaa-0000-0000-0000-0000000006a1', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'Topic A'),
  ('bbbbbbbb-0000-0000-0000-0000000006a1', 'bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-0000000006b1', 'Topic B');
insert into posts (id, workspace_id, brand_id, title, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000006c1', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'Post A', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-0000000006c1', 'bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-0000000006b1', 'Post B', 'b@example.com');

-- Strategy
select pg_temp.expect_ok('strategy with defaults',
  $$insert into content_strategies (brand_id, workspace_id) values ('aaaaaaaa-0000-0000-0000-0000000006b1', 'aaaaaaaa-0000-0000-0000-000000000006')$$);
select pg_temp.expect_error('strategy must use its brand''s workspace',
  $$insert into content_strategies (brand_id, workspace_id) values ('bbbbbbbb-0000-0000-0000-0000000006b1', 'aaaaaaaa-0000-0000-0000-000000000006')$$, '23503');
select pg_temp.expect_error('unknown category',
  $$update content_strategies set categories = array['gossip'] where brand_id = 'aaaaaaaa-0000-0000-0000-0000000006b1'$$, '23514');
select pg_temp.expect_error('unknown platform',
  $$update content_strategies set platforms = array['medium'] where brand_id = 'aaaaaaaa-0000-0000-0000-0000000006b1'$$, '23514');
select pg_temp.expect_error('weekday out of range',
  $$update content_strategies set preferred_days = array[7]::smallint[] where brand_id = 'aaaaaaaa-0000-0000-0000-0000000006b1'$$, '23514');
select pg_temp.expect_error('posts per week capped at 21',
  $$update content_strategies set posts_per_week = 22 where brand_id = 'aaaaaaaa-0000-0000-0000-0000000006b1'$$, '23514');

-- Limits and usage
select pg_temp.expect_ok('limits row',
  $$insert into workspace_ai_limits (workspace_id) values ('aaaaaaaa-0000-0000-0000-000000000006')$$);
select pg_temp.check('limit defaults', (select monthly_generation_limit = 300 and monthly_research_limit = 100 and monthly_cost_limit_usd = 25 from workspace_ai_limits where workspace_id = 'aaaaaaaa-0000-0000-0000-000000000006'));
select pg_temp.expect_error('negative spend cap',
  $$update workspace_ai_limits set monthly_cost_limit_usd = -1 where workspace_id = 'aaaaaaaa-0000-0000-0000-000000000006'$$, '23514');
select pg_temp.expect_ok('generation record',
  $$insert into ai_generations (id, workspace_id, brand_id, purpose, capability, provider, model, prompt_version, input_tokens, output_tokens, cost_usd, status, created_by)
    values ('aaaaaaaa-0000-0000-0000-0000000006e1', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'drafts', 'text', 'xai', 'grok', 'drafts-v1', 10, 5, 0.0001, 'succeeded', 'a@example.com')$$);
select pg_temp.expect_error('unknown generation status',
  $$insert into ai_generations (workspace_id, purpose, capability, provider, status, created_by) values ('aaaaaaaa-0000-0000-0000-000000000006', 'drafts', 'text', 'xai', 'maybe', 'a')$$, '23514');
select pg_temp.expect_error('negative tokens',
  $$insert into ai_generations (workspace_id, purpose, capability, provider, status, input_tokens, created_by) values ('aaaaaaaa-0000-0000-0000-000000000006', 'drafts', 'text', 'xai', 'failed', -1, 'a')$$, '23514');
select pg_temp.expect_error('a post can''t cite another workspace''s generation',
  $$update posts set generation_id = 'aaaaaaaa-0000-0000-0000-0000000006e1' where id = 'bbbbbbbb-0000-0000-0000-0000000006c1'$$, '23503');

-- Research sources
select pg_temp.expect_ok('source with url, retrieval date and excerpt',
  $$insert into research_sources (id, workspace_id, brand_id, topic_id, url, retrieved_at, excerpt)
    values ('aaaaaaaa-0000-0000-0000-0000000006f1', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'aaaaaaaa-0000-0000-0000-0000000006a1', 'https://news.example/a', now(), 'Snippet')$$);
select pg_temp.expect_error('source needs a retrieval date',
  $$insert into research_sources (workspace_id, brand_id, url, excerpt) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'https://news.example/b', 'x')$$, '23502');
select pg_temp.expect_error('source url must be http(s)',
  $$insert into research_sources (workspace_id, brand_id, url, retrieved_at, excerpt) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'javascript:alert(1)', now(), 'x')$$, '23514');
select pg_temp.expect_error('same url once per topic',
  $$insert into research_sources (workspace_id, brand_id, topic_id, url, retrieved_at, excerpt) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'aaaaaaaa-0000-0000-0000-0000000006a1', 'https://news.example/a', now(), 'x')$$, '23505');
select pg_temp.expect_error('source can''t attach to another workspace''s topic',
  $$insert into research_sources (workspace_id, brand_id, topic_id, url, retrieved_at, excerpt) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006b1', 'bbbbbbbb-0000-0000-0000-0000000006a1', 'https://news.example/c', now(), 'x')$$, '23503');

insert into research_sources (id, workspace_id, brand_id, url, retrieved_at, excerpt)
  values ('bbbbbbbb-0000-0000-0000-0000000006f1', 'bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-0000000006b1', 'https://news.example/b', now(), 'B');

-- Topics
select pg_temp.expect_error('unknown topic category',
  $$update content_topics set category = 'gossip' where id = 'aaaaaaaa-0000-0000-0000-0000000006a1'$$, '23514');
select pg_temp.expect_ok('topic category and planned date',
  $$update content_topics set category = 'seasonal', planned_for = '2026-11-03', needs_research = true where id = 'aaaaaaaa-0000-0000-0000-0000000006a1'$$);

-- Draft variants (no social account yet)
select pg_temp.expect_ok('draft variant without an account',
  $$insert into post_variants (id, workspace_id, post_id, platform, body) values ('aaaaaaaa-0000-0000-0000-000000000671', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006c1', 'x', 'Hello')$$);
select pg_temp.expect_error('one unassigned draft per platform per post',
  $$insert into post_variants (workspace_id, post_id, platform, body) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006c1', 'x', 'Again')$$, '23505');
select pg_temp.expect_error('unknown variant platform',
  $$insert into post_variants (workspace_id, post_id, platform, body) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-0000000006c1', 'medium', 'Hi')$$, '23514');
select pg_temp.expect_error('similarity between 0 and 1',
  $$update post_variants set similarity = 1.5 where id = 'aaaaaaaa-0000-0000-0000-000000000671'$$, '23514');
select pg_temp.expect_ok('variant cites a source',
  $$insert into post_variant_sources (workspace_id, variant_id, source_id) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000671', 'aaaaaaaa-0000-0000-0000-0000000006f1')$$);
select pg_temp.expect_error('variant can''t cite through another workspace',
  $$insert into post_variant_sources (workspace_id, variant_id, source_id) values ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000671', 'bbbbbbbb-0000-0000-0000-0000000006f1')$$, '23503');
select pg_temp.expect_ok('rejected is a post status',
  $$update posts set status = 'rejected', rejected_reason = 'Off brand' where id = 'aaaaaaaa-0000-0000-0000-0000000006c1'$$);

-- Clean-up cascades
delete from content_topics where id = 'aaaaaaaa-0000-0000-0000-0000000006a1';
select pg_temp.check('sources and citations go with their topic',
  not exists (select 1 from research_sources where id = 'aaaaaaaa-0000-0000-0000-0000000006f1')
  and not exists (select 1 from post_variant_sources where variant_id = 'aaaaaaaa-0000-0000-0000-000000000671'));
select pg_temp.check('new tables have row level security',
  (select bool_and(relrowsecurity) from pg_class where relname in ('content_strategies', 'workspace_ai_limits', 'ai_generations', 'research_sources', 'post_variant_sources')));

\echo 'All content database tests passed.'
rollback;
