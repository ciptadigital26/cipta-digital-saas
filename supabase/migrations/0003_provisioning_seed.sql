-- =====================================================================
-- Fasa 1 / Migration 0003: Provisioning tenant + data pakej asas
-- =====================================================================

-- Pakej contoh (Super Admin boleh ubah nama/harga/tempoh/had melalui dashboard)
insert into public.subscription_plans
  (code, name, description, price_cents, billing_days, trial_days, max_websites, max_staff,
   allow_custom_domain, full_branding, analytics_level, sort_order, features)
values
  ('starter','STARTER','1 website, 1 admin, subdomain percuma, fungsi asas', 4900, 30, 14, 1, 0,
   false, false, 'none', 1, '{"premium":false}'),
  ('pro','PRO','1 website, 5 staff, custom domain, branding penuh, analytics', 12900, 30, 14, 1, 5,
   true, true, 'basic', 2, '{"premium":false}'),
  ('business','BUSINESS','3 website, 15 staff, custom domain, fungsi premium, advanced analytics', 29900, 30, 14, 3, 15,
   true, true, 'advanced', 3, '{"premium":true}')
on conflict (code) do nothing;

-- Templat halaman lalai
create or replace function public.default_pages() returns table(slug text, title text, template public.page_template, sort_order int)
language sql immutable as $$
  values ('', 'Home', 'home'::public.page_template, 0),
         ('about', 'About Us', 'about', 1),
         ('services', 'Services', 'services', 2),
         ('products', 'Products', 'products', 3),
         ('gallery', 'Gallery', 'gallery', 4),
         ('contact', 'Contact', 'contact', 5),
         ('faq', 'FAQ', 'faq', 6);
$$;

-- Provision tenant penuh dalam SATU transaksi. Hanya Super Admin.
create or replace function public.provision_tenant(
  p_slug text, p_business_name text, p_plan_code text, p_admin_user uuid,
  p_contact_email text default null, p_root_domain text default 'ciptadigital.my'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_site uuid; v_plan subscription_plans;
begin
  if not public.is_super_admin() and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Hanya Super Admin boleh mendaftar tenant';
  end if;
  select * into v_plan from subscription_plans where code = p_plan_code and is_active;
  if v_plan.id is null then raise exception 'Pakej % tidak wujud', p_plan_code; end if;

  insert into tenants(slug, business_name, contact_email, created_by)
    values (lower(p_slug), p_business_name, p_contact_email, auth.uid()) returning id into v_tenant;

  insert into tenant_subscriptions(tenant_id, plan_id, status, starts_at, ends_at)
    values (v_tenant, v_plan.id, 'trial', now(), now() + make_interval(days => v_plan.trial_days));

  insert into websites(tenant_id, name) values (v_tenant, p_business_name) returning id into v_site;

  insert into website_settings(website_id, tenant_id, business_name, site_title)
    values (v_site, v_tenant, p_business_name, p_business_name);

  insert into website_pages(website_id, tenant_id, slug, title, template, sort_order, seo_title)
    select v_site, v_tenant, d.slug, d.title, d.template, d.sort_order, left(d.title || ' | ' || p_business_name, 70)
    from public.default_pages() d;

  insert into domains(tenant_id, website_id, hostname, type, status, ssl_status, verified_at, is_primary)
    values (v_tenant, v_site, lower(p_slug) || '.' || p_root_domain, 'subdomain', 'active', 'active', now(), true);

  if p_admin_user is not null then
    insert into tenant_users(tenant_id, user_id, role) values (v_tenant, p_admin_user, 'tenant_admin');
  end if;

  insert into activity_logs(tenant_id, actor_id, action, entity, entity_id, details)
    values (v_tenant, auth.uid(), 'tenant.provision', 'tenants', v_tenant::text,
            jsonb_build_object('plan', p_plan_code, 'slug', p_slug));
  return v_tenant;
end $$;
revoke all on function public.provision_tenant(text,text,text,uuid,text,text) from public, anon;
grant execute on function public.provision_tenant(text,text,text,uuid,text,text) to authenticated;

-- Langkah manual SEKALI sahaja selepas mendaftar akaun Super Admin di Supabase Auth:
--   insert into public.user_roles(user_id, role) values ('<UUID-AKAUN-ANDA>', 'super_admin');
