-- RnR Os · Meta (Facebook Pages and Instagram) connections and real publishing.
-- Run after 0006. Safe to re-run.

-- A Facebook login connected to a workspace. The long-lived user token is kept only as AES-256-GCM
-- ciphertext in meta_connection_credentials; this table holds what the app may show.
create table if not exists meta_connections (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  meta_user_id        text not null check (length(meta_user_id) between 1 and 100),
  meta_user_name      text check (length(meta_user_name) <= 200),
  scopes              text[] not null default '{}',
  declined_scopes     text[] not null default '{}',
  token_expires_at    timestamptz,
  status              text not null default 'active' check (status in ('active', 'needs_reconnect', 'revoked')),
  last_error          text check (length(last_error) <= 1000),
  last_discovered_at  timestamptz,
  connected_by        text not null,
  connected_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, meta_user_id)
);

create table if not exists meta_connection_credentials (
  connection_id   uuid primary key,
  workspace_id    uuid not null,
  user_token_enc  text not null check (user_token_enc ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  updated_at      timestamptz not null default now(),
  foreign key (connection_id, workspace_id) references meta_connections (id, workspace_id) on delete cascade
);

-- Pages and Instagram professional accounts a connection can reach, as Meta reported them.
-- They become social accounts only when someone adds one to a brand.
create table if not exists meta_assets (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  connection_id        uuid not null,
  platform             text not null check (platform in ('facebook_page', 'instagram')),
  external_account_id  text not null check (length(external_account_id) between 1 and 100),
  page_id              text not null check (length(page_id) between 1 and 100),
  name                 text not null check (length(name) between 1 and 200),
  username             text check (length(username) <= 200),
  picture_url          text check (picture_url ~ '^https://'),
  tasks                text[] not null default '{}',
  discovered_at        timestamptz not null default now(),
  unique (id, workspace_id),
  unique (connection_id, platform, external_account_id),
  foreign key (connection_id, workspace_id) references meta_connections (id, workspace_id) on delete cascade
);

-- The Page access token for each discovered Page (Instagram publishing uses the linked Page's token).
create table if not exists meta_asset_credentials (
  asset_id        uuid primary key,
  workspace_id    uuid not null,
  page_token_enc  text not null check (page_token_enc ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  updated_at      timestamptz not null default now(),
  foreign key (asset_id, workspace_id) references meta_assets (id, workspace_id) on delete cascade
);

-- Social accounts remember where they came from and what the platform lets the app do.
alter table social_accounts add column if not exists meta_connection_id uuid;
alter table social_accounts add column if not exists username text check (length(username) <= 200);
alter table social_accounts add column if not exists permitted_actions text[] not null default '{}';
alter table social_accounts add column if not exists rate_limited_until timestamptz;
alter table social_accounts add column if not exists connected_by text;
do $$ begin
  alter table social_accounts add constraint social_accounts_meta_connection_fk foreign key (meta_connection_id, workspace_id)
    references meta_connections (id, workspace_id) on delete set null (meta_connection_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table social_accounts add constraint social_accounts_permitted_actions_check
    check (permitted_actions <@ array['publish_text', 'publish_link', 'publish_image', 'read_metrics']::text[]);
exception when duplicate_object then null; end $$;

-- Images are attached by public https URL and checked before publishing (type, size, dimensions).
alter table post_variants add column if not exists image_url text;
alter table post_variants add column if not exists image_check jsonb;
alter table post_variants add column if not exists metrics jsonb;
alter table post_variants add column if not exists metrics_fetched_at timestamptz;
do $$ begin
  alter table post_variants add constraint post_variants_image_url_check check (image_url ~ '^https://' and length(image_url) <= 2000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table post_variants add constraint post_variants_external_url_check check (external_url is null or external_url ~ '^https://');
exception when duplicate_object then null; end $$;
-- At most one assigned variant per platform account per post was already enforced; one unassigned per platform too (0006).

-- Jobs: "needs_check" means the platform's answer was ambiguous (timeout, 5xx after sending) and the
-- job must not be retried until someone checks whether the original post went out.
alter table scheduled_jobs drop constraint if exists scheduled_jobs_status_check;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_status_check
    check (status in ('pending', 'claimed', 'succeeded', 'failed', 'needs_check', 'cancelled'));
exception when duplicate_object then null; end $$;
alter table scheduled_jobs add column if not exists social_account_id uuid;
alter table scheduled_jobs add column if not exists requested_by text;
alter table scheduled_jobs add column if not exists external_post_id text;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_account_fk foreign key (social_account_id, workspace_id)
    references social_accounts (id, workspace_id) on delete set null (social_account_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table scheduled_jobs add constraint scheduled_jobs_success_check check (status <> 'succeeded' or external_post_id is not null);
exception when duplicate_object then null; end $$;

alter table publish_attempts drop constraint if exists publish_attempts_outcome_check;
do $$ begin
  alter table publish_attempts add constraint publish_attempts_outcome_check check (outcome in ('success', 'error', 'ambiguous', 'reconciled'));
exception when duplicate_object then null; end $$;
alter table publish_attempts add column if not exists external_post_id text;
alter table publish_attempts add column if not exists error_kind text;
do $$ begin
  alter table publish_attempts add constraint publish_attempts_error_kind_check
    check (error_kind in ('auth', 'permission', 'rate_limit', 'validation', 'policy', 'media', 'transient', 'ambiguous', 'unknown'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table publish_attempts add constraint publish_attempts_success_check check (outcome is distinct from 'success' or external_post_id is not null);
exception when duplicate_object then null; end $$;

drop trigger if exists meta_connections_touch on meta_connections;
create trigger meta_connections_touch before update on meta_connections for each row execute function social_touch_updated_at();
drop trigger if exists meta_connection_credentials_touch on meta_connection_credentials;
create trigger meta_connection_credentials_touch before update on meta_connection_credentials for each row execute function social_touch_updated_at();
drop trigger if exists meta_asset_credentials_touch on meta_asset_credentials;
create trigger meta_asset_credentials_touch before update on meta_asset_credentials for each row execute function social_touch_updated_at();

-- Server-only, like every social table: no policies, so the anon and authenticated roles see nothing.
alter table meta_connections            enable row level security;
alter table meta_connection_credentials enable row level security;
alter table meta_assets                 enable row level security;
alter table meta_asset_credentials      enable row level security;
