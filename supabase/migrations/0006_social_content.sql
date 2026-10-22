-- RnR Os · AI research, content planning and drafts. Run after 0005. Safe to re-run.
-- Nothing here publishes: every generated post stays a draft until a later publishing phase.

-- Each brand's content strategy: who it's for, which categories, which platforms and how often.
create table if not exists content_strategies (
  brand_id         uuid primary key,
  workspace_id     uuid not null,
  audience         text check (length(audience) <= 500),
  goals            text check (length(goals) <= 500),
  categories       text[] not null default '{educational,faq,maintenance_tips,seasonal,service_explainer}',
  platforms        text[] not null default '{facebook_page}',
  posts_per_week   smallint not null default 3 check (posts_per_week between 0 and 21),
  preferred_days   smallint[] not null default '{1,3,5}',
  tone_override    text check (length(tone_override) <= 200),
  avoid_topics     text[] not null default '{}',
  updated_by       text,
  updated_at       timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  check (categories <@ array['educational', 'faq', 'maintenance_tips', 'seasonal', 'industry_update', 'service_explainer', 'local_relevance']::text[]),
  check (platforms <@ array['facebook_page', 'instagram', 'linkedin_profile', 'linkedin_page', 'google_business', 'x', 'pinterest', 'threads']::text[]),
  check (preferred_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

-- Per-workspace usage limits for AI generation and research, counted per calendar month (UTC).
create table if not exists workspace_ai_limits (
  workspace_id               uuid primary key references workspaces(id) on delete cascade,
  monthly_generation_limit   integer not null default 300 check (monthly_generation_limit >= 0),
  monthly_research_limit     integer not null default 100 check (monthly_research_limit >= 0),
  monthly_cost_limit_usd     numeric(10, 2) not null default 25 check (monthly_cost_limit_usd >= 0),
  updated_at                 timestamptz not null default now()
);

-- Every model or research call: provider, model, prompt version, tokens and estimated cost.
create table if not exists ai_generations (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  brand_id         uuid,
  purpose          text not null check (purpose in ('topics', 'drafts', 'regenerate', 'research')),
  capability       text not null check (capability in ('text', 'research')),
  provider         text not null check (length(provider) between 1 and 40),
  model            text check (length(model) <= 120),
  prompt_version   text check (length(prompt_version) <= 40),
  input_tokens     integer check (input_tokens >= 0),
  output_tokens    integer check (output_tokens >= 0),
  cost_usd         numeric(12, 6) check (cost_usd >= 0),
  status           text not null check (status in ('succeeded', 'failed', 'blocked_by_limit')),
  error            text check (length(error) <= 1000),
  created_by       text not null,
  created_at       timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete set null (brand_id)
);
create index if not exists ai_generations_month on ai_generations (workspace_id, created_at desc);

-- Research runs now record the provider and query.
alter table research_runs drop constraint if exists research_runs_kind_check;
do $$ begin
  alter table research_runs add constraint research_runs_kind_check check (kind in ('website_crawl', 'niche_research', 'topic_research'));
exception when duplicate_object then null; end $$;
alter table research_runs add column if not exists provider text;
alter table research_runs add column if not exists query text check (length(query) <= 500);
alter table research_runs add column if not exists generation_id uuid;

-- Topics get a category, a planned date and whether time-sensitive facts need research first.
alter table content_topics add column if not exists category text;
alter table content_topics add column if not exists planned_for date;
alter table content_topics add column if not exists needs_research boolean not null default false;
alter table content_topics add column if not exists generation_id uuid;
do $$ begin
  alter table content_topics add constraint content_topics_category_check
    check (category is null or category in ('educational', 'faq', 'maintenance_tips', 'seasonal', 'industry_update', 'service_explainer', 'local_relevance'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table content_topics add constraint content_topics_generation_fk foreign key (generation_id, workspace_id)
    references ai_generations (id, workspace_id) on delete set null (generation_id);
exception when duplicate_object then null; end $$;
create index if not exists content_topics_planned on content_topics (brand_id, planned_for);

-- Sources found by research: where, when retrieved, and the text that supports a claim.
create table if not exists research_sources (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  research_run_id  uuid,
  topic_id         uuid,
  url              text not null check (url ~ '^https?://' and length(url) <= 2000),
  title            text check (length(title) <= 500),
  publisher        text check (length(publisher) <= 200),
  published_at     timestamptz,
  retrieved_at     timestamptz not null,
  excerpt          text not null check (length(excerpt) between 1 and 2000),
  created_at       timestamptz not null default now(),
  unique (id, workspace_id),
  unique (topic_id, url),
  foreign key (brand_id, workspace_id) references brands (id, workspace_id) on delete cascade,
  foreign key (research_run_id, workspace_id) references research_runs (id, workspace_id) on delete set null (research_run_id),
  foreign key (topic_id, workspace_id) references content_topics (id, workspace_id) on delete cascade
);
create index if not exists research_sources_topic on research_sources (topic_id);

-- Posts: AI drafts can be rejected, and remember their generation and category.
alter table posts drop constraint if exists posts_status_check;
do $$ begin
  alter table posts add constraint posts_status_check
    check (status in ('draft', 'in_review', 'approved', 'rejected', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'));
exception when duplicate_object then null; end $$;
alter table posts add column if not exists category text;
alter table posts add column if not exists generation_id uuid;
alter table posts add column if not exists rejected_reason text check (length(rejected_reason) <= 500);
do $$ begin
  alter table posts add constraint posts_generation_fk foreign key (generation_id, workspace_id)
    references ai_generations (id, workspace_id) on delete set null (generation_id);
exception when duplicate_object then null; end $$;

-- Variants can be drafted for a platform before any account is connected.
alter table post_variants alter column social_account_id drop not null;
alter table post_variants add column if not exists generation_id uuid;
alter table post_variants add column if not exists image_concept text check (length(image_concept) <= 1000);
alter table post_variants add column if not exists call_to_action text check (length(call_to_action) <= 200);
alter table post_variants add column if not exists validation jsonb not null default '{"errors": [], "warnings": []}';
alter table post_variants add column if not exists similar_to_variant_id uuid;
alter table post_variants add column if not exists similarity real check (similarity is null or similarity between 0 and 1);
alter table post_variants add column if not exists edited_by text;
do $$ begin
  alter table post_variants add constraint post_variants_platform_check
    check (platform in ('facebook_page', 'instagram', 'linkedin_profile', 'linkedin_page', 'google_business', 'x', 'pinterest', 'threads'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table post_variants add constraint post_variants_generation_fk foreign key (generation_id, workspace_id)
    references ai_generations (id, workspace_id) on delete set null (generation_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table post_variants add constraint post_variants_similar_fk foreign key (similar_to_variant_id, workspace_id)
    references post_variants (id, workspace_id) on delete set null (similar_to_variant_id);
exception when duplicate_object then null; end $$;
-- One unassigned draft per platform per post; assigned variants stay unique per account.
create unique index if not exists post_variants_unassigned_platform on post_variants (post_id, platform) where social_account_id is null;
create index if not exists post_variants_recent on post_variants (workspace_id, created_at desc);

-- Which research sources a variant relies on.
create table if not exists post_variant_sources (
  workspace_id  uuid not null,
  variant_id    uuid not null,
  source_id     uuid not null,
  primary key (variant_id, source_id),
  foreign key (variant_id, workspace_id) references post_variants (id, workspace_id) on delete cascade,
  foreign key (source_id, workspace_id) references research_sources (id, workspace_id) on delete cascade
);

drop trigger if exists content_strategies_touch on content_strategies;
create trigger content_strategies_touch before update on content_strategies for each row execute function social_touch_updated_at();
drop trigger if exists workspace_ai_limits_touch on workspace_ai_limits;
create trigger workspace_ai_limits_touch before update on workspace_ai_limits for each row execute function social_touch_updated_at();

alter table content_strategies   enable row level security;
alter table workspace_ai_limits  enable row level security;
alter table ai_generations       enable row level security;
alter table research_sources     enable row level security;
alter table post_variant_sources enable row level security;
