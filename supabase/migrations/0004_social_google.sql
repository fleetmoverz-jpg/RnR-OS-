-- RnR Os · Google connections and Search Console property discovery for Social workspaces.
-- Run after 0003. Safe to re-run.

-- A Google account connected to a workspace. Tokens are stored only as AES-256-GCM ciphertext.
-- Disconnecting revokes the grant at Google and deletes the row.
create table if not exists google_connections (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  google_sub               text not null check (length(google_sub) between 1 and 255),
  google_email             text not null check (google_email = lower(google_email)),
  scopes                   text[] not null default '{}',
  access_token_enc         text check (access_token_enc ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  refresh_token_enc        text not null check (refresh_token_enc ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'),
  access_token_expires_at  timestamptz,
  status                   text not null default 'active' check (status in ('active', 'needs_reconnect')),
  last_error               text,
  last_discovered_at       timestamptz,
  connected_by             text not null,
  connected_at             timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, google_sub),
  check ((access_token_enc is null) = (access_token_expires_at is null))
);

-- Properties the Search Console Sites API returned for a connection, exactly as Google reported them.
create table if not exists gsc_properties (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  connection_id     uuid not null,
  site_url          text not null check (site_url ~ '^(sc-domain:[a-z0-9.-]+|https?://\S+/)$'),
  property_type     text not null check (property_type in ('domain', 'url_prefix')),
  permission_level  text not null check (permission_level in ('siteOwner', 'siteFullUser', 'siteRestrictedUser', 'siteUnverifiedUser')),
  discovered_at     timestamptz not null default now(),
  unique (id, workspace_id),
  unique (connection_id, site_url),
  foreign key (connection_id, workspace_id) references google_connections (id, workspace_id) on delete cascade,
  check ((property_type = 'domain') = (site_url like 'sc-domain:%'))
);
create index if not exists gsc_properties_workspace on gsc_properties (workspace_id, site_url);

-- Websites imported from Search Console keep the exact property, its type and Google's permission level.
alter table workspace_websites add column if not exists gsc_property_url text;
alter table workspace_websites add column if not exists property_type text;
alter table workspace_websites add column if not exists permission_level text;
alter table workspace_websites add column if not exists google_connection_id uuid;

do $$ begin
  alter table workspace_websites add constraint workspace_websites_property_type_check
    check (property_type in ('domain', 'url_prefix'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table workspace_websites add constraint workspace_websites_permission_level_check
    check (permission_level in ('siteOwner', 'siteFullUser', 'siteRestrictedUser', 'siteUnverifiedUser'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table workspace_websites add constraint workspace_websites_property_fields_check
    check ((gsc_property_url is null) = (property_type is null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table workspace_websites add constraint workspace_websites_google_connection_fk
    foreign key (google_connection_id, workspace_id) references google_connections (id, workspace_id)
    on delete set null (google_connection_id);
exception when duplicate_object then null; end $$;
-- "Verified through Search Console" is only allowed when Google reports the user as the owner.
-- NOT VALID: rows from the Phase 1 import path are left as they are; new and updated rows are checked.
do $$ begin
  alter table workspace_websites add constraint workspace_websites_owner_verification_check
    check (verification_method is distinct from 'search_console' or permission_level = 'siteOwner') not valid;
exception when duplicate_object then null; end $$;

-- A domain property (sc-domain:example.com) and a URL-prefix property (https://www.example.com/) are
-- different Search Console properties for the same domain, so uniqueness moves to the property URL.
-- Websites added by hand stay unique per domain.
alter table workspace_websites drop constraint if exists workspace_websites_workspace_id_domain_key;
create unique index if not exists workspace_websites_manual_domain
  on workspace_websites (workspace_id, domain) where gsc_property_url is null;
create unique index if not exists workspace_websites_property
  on workspace_websites (workspace_id, gsc_property_url) where gsc_property_url is not null;

drop trigger if exists google_connections_touch on google_connections;
create trigger google_connections_touch before update on google_connections
  for each row execute function social_touch_updated_at();

alter table google_connections enable row level security;
alter table gsc_properties     enable row level security;
