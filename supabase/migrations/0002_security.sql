-- =====================================================================
-- Fasa 1 / Migration 0002: Tenant isolation, RBAC & Row Level Security
-- Prinsip: tenant_id TIDAK PERNAH dipercayai daripada browser.
-- Keahlian disemak daripada auth.uid() (sesi JWT) -> tenant_users.
-- =====================================================================

-- ---------- Fungsi pembantu (SECURITY DEFINER, search_path dikunci) ----------
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = 'super_admin');
$$;

create or replace function public.tenant_role(p_tenant uuid) returns public.app_role
language sql stable security definer set search_path = public as $$
  select tu.role from tenant_users tu
  join tenants t on t.id = tu.tenant_id
  where tu.tenant_id = p_tenant and tu.user_id = auth.uid()
    and tu.is_active and t.status = 'active';
$$;

create or replace function public.is_tenant_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tenant_role(p_tenant) is not null;
$$;

create or replace function public.is_tenant_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tenant_role(p_tenant) = 'tenant_admin';
$$;

-- Admin ada semua kebenaran; staff hanya yang diberi.
create or replace function public.has_perm(p_tenant uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tenant_users tu join tenants t on t.id = tu.tenant_id
    where tu.tenant_id = p_tenant and tu.user_id = auth.uid() and tu.is_active
      and t.status = 'active'
      and (tu.role = 'tenant_admin' or p_perm = any(tu.permissions))
  );
$$;

-- Pelan semasa tenant
create or replace function public.current_plan(p_tenant uuid) returns public.subscription_plans
language sql stable security definer set search_path = public as $$
  select p.* from tenant_subscriptions s join subscription_plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant and s.status in ('trial','active')
  order by s.starts_at desc limit 1;
$$;

revoke all on function public.current_plan(uuid) from public, anon;
grant execute on function public.is_super_admin(), public.tenant_role(uuid), public.is_tenant_member(uuid),
  public.is_tenant_admin(uuid), public.has_perm(uuid,text), public.current_plan(uuid) to authenticated;

-- ---------- Penguatkuasaan had pakej (server-side, di dalam DB) ----------
create or replace function public.enforce_plan_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare plan subscription_plans; n int;
begin
  plan := public.current_plan(new.tenant_id);
  if plan.id is null then raise exception 'Tenant tiada langganan aktif'; end if;

  if tg_table_name = 'websites' then
    select count(*) into n from websites where tenant_id = new.tenant_id;
    if n >= plan.max_websites then raise exception 'Had website pakej % dicapai (%)', plan.name, plan.max_websites; end if;
  elsif tg_table_name = 'tenant_users' then
    if to_jsonb(new)->>'role' = 'tenant_staff' then
      select count(*) into n from tenant_users where tenant_id = new.tenant_id and role = 'tenant_staff' and is_active;
      if n >= plan.max_staff then raise exception 'Had staff pakej % dicapai (%)', plan.name, plan.max_staff; end if;
    end if;
  elsif tg_table_name = 'domains' then
    if to_jsonb(new)->>'type' = 'custom' and not plan.allow_custom_domain then
      raise exception 'Pakej % tidak membenarkan custom domain', plan.name;
    end if;
  end if;
  return new;
end $$;

create trigger websites_plan_limit     before insert on public.websites     for each row execute function public.enforce_plan_limits();
create trigger tenant_users_plan_limit before insert on public.tenant_users for each row execute function public.enforce_plan_limits();
create trigger domains_plan_limit      before insert on public.domains      for each row execute function public.enforce_plan_limits();

-- Tenant tidak boleh menukar status domain/SSL sendiri (hanya Worker/service role atau super admin)
create or replace function public.protect_domain_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() and coalesce(auth.role(),'') <> 'service_role' then
    new.status := old.status; new.ssl_status := old.ssl_status;
    new.verified_at := old.verified_at; new.last_error := old.last_error;
    new.verification_token := old.verification_token; new.tenant_id := old.tenant_id;
  end if;
  return new;
end $$;
create trigger domains_protect before update on public.domains for each row execute function public.protect_domain_status();

-- Staff tidak boleh menaikkan peranan sendiri / menukar tenant
create or replace function public.protect_tenant_users() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tenant_id <> old.tenant_id or new.user_id <> old.user_id then
    raise exception 'tenant_id/user_id tidak boleh diubah';
  end if;
  if old.user_id = auth.uid() and not public.is_super_admin()
     and (new.role <> old.role or new.is_active <> old.is_active) then
    raise exception 'Tidak boleh menukar peranan atau status akaun sendiri';
  end if;
  return new;
end $$;
create trigger tenant_users_protect before update on public.tenant_users for each row execute function public.protect_tenant_users();

-- ---------- Aktifkan RLS pada SEMUA jadual ----------
do $$
declare t text;
begin
  foreach t in array array['tenants','tenant_users','user_roles','websites','website_settings','website_pages',
    'media_files','products','subscription_plans','tenant_subscriptions','payment_records','domains',
    'api_integrations','support_tickets','activity_logs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    -- Super Admin: akses penuh
    execute format('create policy %I on public.%I for all to authenticated
                    using (public.is_super_admin()) with check (public.is_super_admin())',
                   t || '_super_admin_all', t);
  end loop;
end $$;

-- tenants: ahli boleh baca tenant sendiri; tiada INSERT/DELETE oleh tenant
create policy tenants_member_read on public.tenants for select to authenticated
  using (public.is_tenant_member(id));

-- user_roles: pengguna boleh lihat peranan sendiri sahaja
create policy user_roles_self_read on public.user_roles for select to authenticated
  using (user_id = auth.uid());

-- tenant_users
create policy tenant_users_member_read on public.tenant_users for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy tenant_users_admin_insert on public.tenant_users for insert to authenticated
  with check (public.is_tenant_admin(tenant_id) and role = 'tenant_staff');
create policy tenant_users_admin_update on public.tenant_users for update to authenticated
  using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy tenant_users_admin_delete on public.tenant_users for delete to authenticated
  using (public.is_tenant_admin(tenant_id) and role = 'tenant_staff');

-- websites
create policy websites_member_read on public.websites for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy websites_admin_write on public.websites for update to authenticated
  using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));

-- website_settings: tetapan kritikal (branding) = tenant_admin atau staff dengan 'branding.edit'
create policy settings_member_read on public.website_settings for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy settings_edit on public.website_settings for update to authenticated
  using (public.has_perm(tenant_id,'branding.edit')) with check (public.has_perm(tenant_id,'branding.edit'));

-- website_pages
create policy pages_member_read on public.website_pages for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy pages_insert on public.website_pages for insert to authenticated
  with check (public.has_perm(tenant_id,'pages.edit'));
create policy pages_update on public.website_pages for update to authenticated
  using (public.has_perm(tenant_id,'pages.edit')) with check (public.has_perm(tenant_id,'pages.edit'));
create policy pages_delete on public.website_pages for delete to authenticated
  using (public.is_tenant_admin(tenant_id));

-- media_files
create policy media_member_read on public.media_files for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy media_insert on public.media_files for insert to authenticated
  with check (public.has_perm(tenant_id,'media.upload'));
create policy media_delete on public.media_files for delete to authenticated
  using (public.has_perm(tenant_id,'media.delete'));

-- products
create policy products_member_read on public.products for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy products_insert on public.products for insert to authenticated
  with check (public.has_perm(tenant_id,'products.edit'));
create policy products_update on public.products for update to authenticated
  using (public.has_perm(tenant_id,'products.edit')) with check (public.has_perm(tenant_id,'products.edit'));
create policy products_delete on public.products for delete to authenticated
  using (public.has_perm(tenant_id,'products.edit'));

-- subscription_plans: semua pengguna log masuk boleh lihat pelan aktif
create policy plans_read on public.subscription_plans for select to authenticated using (is_active);

-- tenant_subscriptions & payment_records: tenant admin baca sahaja
create policy subs_admin_read on public.tenant_subscriptions for select to authenticated
  using (public.is_tenant_admin(tenant_id));
create policy payments_admin_read on public.payment_records for select to authenticated
  using (public.is_tenant_admin(tenant_id));

-- domains: tenant admin boleh tambah/padam jika pakej benarkan (trigger), status dilindungi
create policy domains_member_read on public.domains for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy domains_admin_insert on public.domains for insert to authenticated
  with check (public.is_tenant_admin(tenant_id) and type = 'custom' and status = 'pending');
create policy domains_admin_update on public.domains for update to authenticated
  using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy domains_admin_delete on public.domains for delete to authenticated
  using (public.is_tenant_admin(tenant_id) and type = 'custom');

-- api_integrations: tenant admin baca integrasi tenant sendiri (tiada rahsia dalam jadual)
create policy integrations_admin_read on public.api_integrations for select to authenticated
  using (tenant_id is not null and public.is_tenant_admin(tenant_id));

-- support_tickets
create policy tickets_member_read on public.support_tickets for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy tickets_member_insert on public.support_tickets for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and opened_by = auth.uid() and status = 'open');

-- activity_logs: tenant admin baca log tenant sendiri; penulisan hanya melalui fungsi
create policy logs_admin_read on public.activity_logs for select to authenticated
  using (tenant_id is not null and public.is_tenant_admin(tenant_id));

create or replace function public.log_activity(p_tenant uuid, p_action text, p_entity text,
  p_entity_id text, p_details jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant is not null and not (public.is_tenant_member(p_tenant) or public.is_super_admin()) then
    raise exception 'Tiada akses ke tenant ini';
  end if;
  insert into activity_logs(tenant_id, actor_id, action, entity, entity_id, details)
  values (p_tenant, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details,'{}'::jsonb));
end $$;
revoke all on function public.log_activity(uuid,text,text,text,jsonb) from public, anon;
grant execute on function public.log_activity(uuid,text,text,text,jsonb) to authenticated;

-- anon TIDAK mendapat akses terus ke mana-mana jadual.
-- Laman awam tenant dihidangkan oleh Worker (service role) selepas domain resolution.
revoke all on all tables in schema public from anon;
