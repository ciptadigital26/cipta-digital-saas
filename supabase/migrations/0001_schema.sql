-- =====================================================================
-- CIPTA DIGITAL SDN BHD — WHITE LABEL CONTROL HUB
-- Fasa 1 / Migration 0001: Schema teras (jadual, FK, index, constraint)
-- Sasaran: Supabase PostgreSQL 15+
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------- ENUM ----------
create type public.app_role            as enum ('super_admin','tenant_admin','tenant_staff');
create type public.tenant_status       as enum ('active','inactive','suspended');
create type public.subscription_status as enum ('trial','active','expired','suspended','cancelled');
create type public.domain_type         as enum ('subdomain','custom');
create type public.domain_status       as enum ('pending','verifying','active','error','disabled');
create type public.ssl_status          as enum ('none','pending','active','error');
create type public.ticket_status       as enum ('open','in_progress','resolved','closed');
create type public.ticket_priority     as enum ('low','normal','high','urgent');
create type public.payment_status      as enum ('pending','paid','failed','refunded');
create type public.page_template       as enum ('home','about','services','products','gallery','contact','faq','custom');

-- ---------- updated_at helper ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ---------- subscription_plans ----------
create table public.subscription_plans (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[a-z0-9_]{2,32}$'),
  name             text not null,
  description      text,
  price_cents      integer not null default 0 check (price_cents >= 0),
  currency         char(3) not null default 'MYR',
  billing_days     integer not null default 30 check (billing_days > 0),
  trial_days       integer not null default 14 check (trial_days >= 0),
  max_websites     integer not null default 1 check (max_websites >= 0),
  max_staff        integer not null default 1 check (max_staff >= 0),
  max_storage_mb   integer not null default 500 check (max_storage_mb >= 0),
  allow_custom_domain boolean not null default false,
  full_branding    boolean not null default false,
  analytics_level  text not null default 'none' check (analytics_level in ('none','basic','advanced')),
  features         jsonb not null default '{}'::jsonb,
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- tenants ----------
create table public.tenants (
  id             uuid primary key default gen_random_uuid(),
  slug           citext not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$'),
  business_name  text not null check (length(business_name) between 2 and 120),
  contact_email  citext,
  contact_phone  text,
  status         public.tenant_status not null default 'active',
  notes          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index tenants_status_idx on public.tenants(status);

-- ---------- user_roles (peranan global/platform) ----------
-- Hanya super_admin disimpan di sini. Peranan tenant disimpan di tenant_users.
create table public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       public.app_role not null check (role = 'super_admin'),
  created_at timestamptz not null default now()
);

-- ---------- tenant_users (keahlian + peranan dalam tenant) ----------
create table public.tenant_users (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         public.app_role not null check (role in ('tenant_admin','tenant_staff')),
  permissions  text[] not null default '{}',  -- cth: {pages.edit,media.upload,products.edit}
  display_name text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index tenant_users_user_idx on public.tenant_users(user_id);

-- ---------- websites ----------
create table public.websites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  is_published boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, tenant_id)
);
create index websites_tenant_idx on public.websites(tenant_id);

-- ---------- website_settings (Branding Engine) ----------
create table public.website_settings (
  website_id       uuid primary key,
  tenant_id        uuid not null,
  business_name    text,
  site_title       text,
  logo_url         text,
  favicon_url      text,
  primary_color    text not null default '#0F766E' check (primary_color   ~* '^#[0-9a-f]{6}$'),
  secondary_color  text not null default '#F59E0B' check (secondary_color ~* '^#[0-9a-f]{6}$'),
  background_color text not null default '#FFFFFF' check (background_color ~* '^#[0-9a-f]{6}$'),
  font_family      text not null default 'Inter',
  header_layout    text not null default 'left'     check (header_layout in ('left','center','split')),
  footer_layout    text not null default 'simple'   check (footer_layout in ('simple','columns','minimal')),
  banner           jsonb not null default '{}'::jsonb,   -- {title, subtitle, image_url, cta_label, cta_href}
  nav_menu         jsonb not null default '[]'::jsonb,   -- [{label, page_id|href}]
  contact          jsonb not null default '{}'::jsonb,   -- {email, phone, address, whatsapp}
  social_links     jsonb not null default '{}'::jsonb,   -- {facebook, instagram, tiktok, ...}
  version          integer not null default 1,
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  foreign key (website_id, tenant_id) references public.websites(id, tenant_id) on delete cascade
);
create index website_settings_tenant_idx on public.website_settings(tenant_id);

-- ---------- website_pages ----------
create table public.website_pages (
  id               uuid primary key default gen_random_uuid(),
  website_id       uuid not null,
  tenant_id        uuid not null,
  slug             text not null check (slug ~ '^[a-z0-9-]{0,80}$'),  -- '' = home
  title            text not null,
  template         public.page_template not null default 'custom',
  content          jsonb not null default '{"blocks":[]}'::jsonb,
  seo_title        text check (length(seo_title) <= 70),
  meta_description text check (length(meta_description) <= 170),
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (website_id, slug),
  foreign key (website_id, tenant_id) references public.websites(id, tenant_id) on delete cascade
);
create index website_pages_site_order_idx on public.website_pages(website_id, sort_order);
create index website_pages_tenant_idx on public.website_pages(tenant_id);

-- ---------- media_files ----------
create table public.media_files (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  website_id   uuid references public.websites(id) on delete set null,
  storage_key  text not null unique,     -- kunci R2: tenants/<tenant_id>/<uuid>.<ext>
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0),
  alt_text     text,
  uploaded_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (storage_key like 'tenants/' || tenant_id::text || '/%')
);
create index media_files_tenant_idx on public.media_files(tenant_id, created_at desc);

-- ---------- products ----------
create table public.products (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  website_id   uuid not null,
  kind         text not null default 'product' check (kind in ('product','service')),
  name         text not null,
  description  text,
  price_cents  integer check (price_cents >= 0),
  currency     char(3) not null default 'MYR',
  image_url    text,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (website_id, tenant_id) references public.websites(id, tenant_id) on delete cascade
);
create index products_tenant_idx on public.products(tenant_id);

-- ---------- tenant_subscriptions ----------
create table public.tenant_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  plan_id       uuid not null references public.subscription_plans(id) on delete restrict,
  status        public.subscription_status not null default 'trial',
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,
  cancelled_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
-- Satu langganan "hidup" sahaja bagi setiap tenant
create unique index tenant_subscriptions_one_live
  on public.tenant_subscriptions(tenant_id) where status in ('trial','active','suspended');
create index tenant_subscriptions_status_idx on public.tenant_subscriptions(status);

-- ---------- payment_records ----------
create table public.payment_records (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  subscription_id  uuid references public.tenant_subscriptions(id) on delete set null,
  amount_cents     integer not null check (amount_cents >= 0),
  currency         char(3) not null default 'MYR',
  status           public.payment_status not null default 'pending',
  provider         text,              -- cth: toyyibpay, billplz, stripe (integrasi berasingan)
  provider_ref     text,
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index payment_records_tenant_idx on public.payment_records(tenant_id, created_at desc);

-- ---------- domains ----------
create table public.domains (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  website_id         uuid not null,
  hostname           citext not null unique check (hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  type               public.domain_type not null,
  status             public.domain_status not null default 'pending',
  ssl_status         public.ssl_status not null default 'none',
  verification_token text not null default encode(gen_random_bytes(16),'hex'),
  verified_at        timestamptz,
  last_error         text,
  is_primary         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (website_id, tenant_id) references public.websites(id, tenant_id) on delete cascade
);
create index domains_tenant_idx on public.domains(tenant_id);
create unique index domains_one_primary on public.domains(website_id) where is_primary;

-- ---------- api_integrations (rujukan sahaja; rahsia di Worker secrets) ----------
create table public.api_integrations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade, -- null = global
  provider      text not null,
  display_name  text not null,
  config        jsonb not null default '{}'::jsonb,  -- TIADA kunci rahsia di sini
  secret_ref    text,          -- nama secret dalam Cloudflare Worker, cth: PAYMENT_API_KEY
  is_enabled    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (not (config ?| array['api_key','secret','secret_key','password','token']))
);

-- ---------- support_tickets ----------
create table public.support_tickets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  opened_by   uuid references auth.users(id) on delete set null,
  subject     text not null,
  body        text not null,
  status      public.ticket_status not null default 'open',
  priority    public.ticket_priority not null default 'normal',
  assigned_to uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index support_tickets_tenant_idx on public.support_tickets(tenant_id, status);

-- ---------- activity_logs (append-only) ----------
create table public.activity_logs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants(id) on delete set null,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,          -- cth: tenant.create, settings.update
  entity      text,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index activity_logs_tenant_idx on public.activity_logs(tenant_id, created_at desc);
create index activity_logs_created_idx on public.activity_logs(created_at desc);

-- ---------- triggers updated_at ----------
do $$
declare t text;
begin
  foreach t in array array['subscription_plans','tenants','tenant_users','websites','website_settings',
                           'website_pages','products','tenant_subscriptions','domains',
                           'api_integrations','support_tickets']
  loop
    execute format('create trigger %I_updated before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- website_settings: naikkan versi setiap kali disimpan (untuk cache-busting di edge)
create or replace function public.bump_settings_version() returns trigger
language plpgsql as $$ begin new.version = old.version + 1; return new; end $$;
create trigger website_settings_version before update on public.website_settings
  for each row execute function public.bump_settings_version();

-- activity_logs: larang UPDATE/DELETE walaupun oleh service role melalui API biasa
create or replace function public.forbid_log_mutation() returns trigger
language plpgsql as $$ begin raise exception 'activity_logs is append-only'; end $$;
create trigger activity_logs_immutable before update or delete on public.activity_logs
  for each row execute function public.forbid_log_mutation();
