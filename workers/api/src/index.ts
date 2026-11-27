// CIPTA DIGITAL SDN BHD — White Label Control Hub API (Cloudflare Worker)
import { Env, HttpError, serviceDb, enc } from "./lib/supabase";
import { requireSession, requireSuperAdmin, requireTenant, requireTenantAdmin, Session } from "./lib/auth";

type Handler = (ctx: { req: Request; env: Env; params: Record<string, string>; url: URL }) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([0-9a-zA-Z-]+)"; }) + "$");
  routes.push({ method, pattern, keys, handler });
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "JSON tidak sah"); }
}
// Hanya medan yang dibenarkan diterima — tenant_id/website_id dari browser DIBUANG.
function pick(src: Record<string, unknown>, allowed: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in src) out[k] = src[k];
  return out;
}
const UUID = /^[0-9a-f-]{36}$/i;
function uuid(v: string) { if (!UUID.test(v)) throw new HttpError(400, "ID tidak sah"); return v; }

async function audit(s: Session, tenantId: string | null, action: string, entity: string, entityId: string, details = {}) {
  await s.db.rpc("log_activity", { p_tenant: tenantId, p_action: action, p_entity: entity, p_entity_id: entityId, p_details: details });
}

// Dapatkan website & sahkan ia milik tenant — tenant_id diambil dari DB, bukan dari browser.
async function websiteOf(s: Session, websiteId: string) {
  const rows = await s.db.select<{ id: string; tenant_id: string }>(`websites?select=id,tenant_id&id=eq.${enc(uuid(websiteId))}`);
  if (!rows[0]) throw new HttpError(404, "Website tidak dijumpai");
  return rows[0];
}

async function purgeSiteCache(env: Env, websiteId: string) {
  const hosts = await serviceDb(env).select<{ hostname: string }>(`domains?select=hostname&website_id=eq.${enc(websiteId)}`);
  await Promise.all(hosts.map(h => env.SITE_CACHE.delete(`site:${h.hostname}`)));
}

// ===================== PUBLIC: server-side domain resolution =====================
// Laman tenant memanggil /public/site; Host header menentukan tenant (bukan parameter).
route("GET", "/public/site", async ({ req, env }) => {
  const host = (req.headers.get("X-Forwarded-Host") ?? new URL(req.url).hostname).toLowerCase().replace(/^www\./, "");
  const cached = await env.SITE_CACHE.get(`site:${host}`);
  if (cached) return new Response(cached, { headers: { "Content-Type": "application/json", "X-Cache": "HIT" } });

  const db = serviceDb(env);
  const d = (await db.select<{ website_id: string; tenant_id: string }>(
    `domains?select=website_id,tenant_id&status=eq.active&or=(hostname.eq.${enc(host)},hostname.eq.www.${enc(host)})`))[0];
  if (!d) throw new HttpError(404, "Domain tidak didaftarkan");
  const t = (await db.select<{ status: string }>(`tenants?select=status&id=eq.${d.tenant_id}`))[0];
  if (!t || t.status !== "active") throw new HttpError(403, "Website ini digantung");

  const [settings, pages, products] = await Promise.all([
    db.select(`website_settings?website_id=eq.${d.website_id}&select=business_name,site_title,logo_url,favicon_url,primary_color,secondary_color,background_color,font_family,header_layout,footer_layout,banner,nav_menu,contact,social_links,version`),
    db.select(`website_pages?website_id=eq.${d.website_id}&is_active=is.true&order=sort_order&select=slug,title,template,content,seo_title,meta_description`),
    db.select(`products?website_id=eq.${d.website_id}&is_active=is.true&order=sort_order&select=kind,name,description,price_cents,currency,image_url`),
  ]);
  const payload = JSON.stringify({ settings: settings[0], pages, products });
  await env.SITE_CACHE.put(`site:${host}`, payload, { expirationTtl: 300 });
  return new Response(payload, { headers: { "Content-Type": "application/json", "X-Cache": "MISS" } });
});

// ===================== SESI =====================
route("GET", "/api/me", async ({ req, env }) => {
  const s = await requireSession(req, env);
  const tenants = s.memberships.length
    ? await s.db.select(`tenants?select=id,slug,business_name,status&id=in.(${s.memberships.map(m => m.tenant_id).join(",")})`)
    : [];
  return json({ user: { id: s.userId, email: s.email }, isSuperAdmin: s.isSuperAdmin, memberships: s.memberships, tenants });
});

// ===================== SUPER ADMIN =====================
route("GET", "/api/admin/overview", async ({ req, env }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  const [tenants, websites, subs, paid, logs] = await Promise.all([
    s.db.select<{ status: string }>("tenants?select=status"),
    s.db.select("websites?select=id"),
    s.db.select<{ status: string }>("tenant_subscriptions?select=status"),
    s.db.select<{ amount_cents: number }>("payment_records?select=amount_cents&status=eq.paid"),
    s.db.select("activity_logs?select=*&order=created_at.desc&limit=10"),
  ]);
  return json({
    tenants_total: tenants.length,
    tenants_active: tenants.filter(t => t.status === "active").length,
    tenants_inactive: tenants.filter(t => t.status !== "active").length,
    websites_total: websites.length,
    subscriptions_live: subs.filter(x => x.status === "active" || x.status === "trial").length,
    revenue_cents: paid.reduce((a, p) => a + p.amount_cents, 0),
    recent_activity: logs,
  });
});

route("GET", "/api/admin/tenants", async ({ req, env, url }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  const q = url.searchParams.get("q");
  const filter = q ? `&business_name=ilike.*${enc(q.replace(/[*,()]/g, ""))}*` : "";
  return json(await s.db.select(`tenants?select=*,tenant_subscriptions(status,ends_at,subscription_plans(name))&order=created_at.desc${filter}`));
});

route("POST", "/api/admin/tenants", async ({ req, env }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  const b = await body<{ slug: string; business_name: string; plan_code: string; admin_user_id?: string; contact_email?: string }>(req);
  const id = await s.db.rpc<string>("provision_tenant", {
    p_slug: b.slug, p_business_name: b.business_name, p_plan_code: b.plan_code,
    p_admin_user: b.admin_user_id ?? null, p_contact_email: b.contact_email ?? null, p_root_domain: env.ROOT_DOMAIN,
  });
  return json({ id }, 201);
});

route("PATCH", "/api/admin/tenants/:id", async ({ req, env, params }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  const patch = pick(await body(req), ["business_name", "contact_email", "contact_phone", "status", "notes"]);
  const [row] = await s.db.update(`tenants?id=eq.${enc(uuid(params.id))}`, patch);
  await audit(s, params.id, "tenant.update", "tenants", params.id, patch);
  return json(row);
});

route("DELETE", "/api/admin/tenants/:id", async ({ req, env, params }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  await audit(s, null, "tenant.delete", "tenants", params.id);
  await s.db.remove(`tenants?id=eq.${enc(uuid(params.id))}`);
  return json({ ok: true });
});

route("GET", "/api/admin/plans", async ({ req, env }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  return json(await s.db.select("subscription_plans?select=*&order=sort_order"));
});
const PLAN_FIELDS = ["code", "name", "description", "price_cents", "currency", "billing_days", "trial_days", "max_websites",
  "max_staff", "max_storage_mb", "allow_custom_domain", "full_branding", "analytics_level", "features", "is_active", "sort_order"];
route("POST", "/api/admin/plans", async ({ req, env }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  return json((await s.db.insert("subscription_plans", pick(await body(req), PLAN_FIELDS)))[0], 201);
});
route("PATCH", "/api/admin/plans/:id", async ({ req, env, params }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  const patch = pick(await body(req), PLAN_FIELDS);
  await audit(s, null, "plan.update", "subscription_plans", params.id, patch);
  return json((await s.db.update(`subscription_plans?id=eq.${enc(uuid(params.id))}`, patch))[0]);
});

route("PATCH", "/api/admin/subscriptions/:id", async ({ req, env, params }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  const patch = pick(await body(req), ["plan_id", "status", "ends_at"]);
  return json((await s.db.update(`tenant_subscriptions?id=eq.${enc(uuid(params.id))}`, patch))[0]);
});

route("GET", "/api/admin/logs", async ({ req, env }) => {
  const s = await requireSession(req, env); requireSuperAdmin(s);
  return json(await s.db.select("activity_logs?select=*&order=created_at.desc&limit=200"));
});

// ===================== TENANT: Branding Engine =====================
const SETTINGS_FIELDS = ["business_name", "site_title", "logo_url", "favicon_url", "primary_color", "secondary_color",
  "background_color", "font_family", "header_layout", "footer_layout", "banner", "nav_menu", "contact", "social_links"];

route("GET", "/api/websites/:wid/settings", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id);
  return json((await s.db.select(`website_settings?website_id=eq.${w.id}`))[0]);
});

route("PUT", "/api/websites/:wid/settings", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id, "branding.edit");
  const patch = { ...pick(await body(req), SETTINGS_FIELDS), updated_by: s.userId };
  const [row] = await s.db.update(`website_settings?website_id=eq.${w.id}`, patch);
  if (!row) throw new HttpError(403, "Tiada kebenaran menyimpan tetapan");
  await purgeSiteCache(env, w.id);            // laman tenant terus guna tetapan baharu — tiada deploy semula
  await audit(s, w.tenant_id, "settings.update", "website_settings", w.id, { fields: Object.keys(patch) });
  return json(row);
});

// ===================== TENANT: Page Builder =====================
const PAGE_FIELDS = ["slug", "title", "template", "content", "seo_title", "meta_description", "sort_order", "is_active"];

route("GET", "/api/websites/:wid/pages", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id);
  return json(await s.db.select(`website_pages?website_id=eq.${w.id}&order=sort_order`));
});
route("POST", "/api/websites/:wid/pages", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id, "pages.edit");
  const [row] = await s.db.insert<{ id: string }>("website_pages", { ...pick(await body(req), PAGE_FIELDS), website_id: w.id, tenant_id: w.tenant_id });
  await purgeSiteCache(env, w.id); await audit(s, w.tenant_id, "page.create", "website_pages", row.id);
  return json(row, 201);
});
route("PATCH", "/api/pages/:id", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const [p] = await s.db.select<{ website_id: string; tenant_id: string }>(`website_pages?select=website_id,tenant_id&id=eq.${enc(uuid(params.id))}`);
  if (!p) throw new HttpError(404, "Halaman tidak dijumpai");
  requireTenant(s, p.tenant_id, "pages.edit");
  const [row] = await s.db.update(`website_pages?id=eq.${params.id}`, pick(await body(req), PAGE_FIELDS));
  await purgeSiteCache(env, p.website_id); await audit(s, p.tenant_id, "page.update", "website_pages", params.id);
  return json(row);
});
route("DELETE", "/api/pages/:id", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const [p] = await s.db.select<{ website_id: string; tenant_id: string }>(`website_pages?select=website_id,tenant_id&id=eq.${enc(uuid(params.id))}`);
  if (!p) throw new HttpError(404, "Halaman tidak dijumpai");
  requireTenantAdmin(s, p.tenant_id);
  await s.db.remove(`website_pages?id=eq.${params.id}`);
  await purgeSiteCache(env, p.website_id); await audit(s, p.tenant_id, "page.delete", "website_pages", params.id);
  return json({ ok: true });
});
route("POST", "/api/websites/:wid/pages/reorder", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id, "pages.edit");
  const { order } = await body<{ order: string[] }>(req);
  await Promise.all(order.map((id, i) => s.db.update(`website_pages?id=eq.${enc(uuid(id))}&website_id=eq.${w.id}`, { sort_order: i })));
  await purgeSiteCache(env, w.id);
  return json({ ok: true });
});

// ===================== TENANT: Produk =====================
const PRODUCT_FIELDS = ["kind", "name", "description", "price_cents", "currency", "image_url", "is_active", "sort_order"];
route("GET", "/api/websites/:wid/products", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id);
  return json(await s.db.select(`products?website_id=eq.${w.id}&order=sort_order`));
});
route("POST", "/api/websites/:wid/products", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id, "products.edit");
  const [row] = await s.db.insert("products", { ...pick(await body(req), PRODUCT_FIELDS), website_id: w.id, tenant_id: w.tenant_id });
  await purgeSiteCache(env, w.id);
  return json(row, 201);
});

// ===================== TENANT: Media (R2) =====================
const MAX_UPLOAD = 5 * 1024 * 1024;
const MIME_OK = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/gif"];
route("POST", "/api/websites/:wid/media", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenant(s, w.tenant_id, "media.upload");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Tiada fail");
  if (file.size > MAX_UPLOAD) throw new HttpError(413, "Fail melebihi 5MB");
  if (!MIME_OK.includes(file.type)) throw new HttpError(415, "Jenis fail tidak dibenarkan");
  const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const key = `tenants/${w.tenant_id}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  const [row] = await s.db.insert("media_files", {
    tenant_id: w.tenant_id, website_id: w.id, storage_key: key, file_name: file.name.slice(0, 200),
    mime_type: file.type, size_bytes: file.size, uploaded_by: s.userId,
  });
  return json(row, 201);
});

// ===================== TENANT: Domain =====================
route("POST", "/api/websites/:wid/domains", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const w = await websiteOf(s, params.wid); requireTenantAdmin(s, w.tenant_id);
  const { hostname } = await body<{ hostname: string }>(req);
  const [row] = await s.db.insert<{ id: string; verification_token: string }>("domains", {
    tenant_id: w.tenant_id, website_id: w.id, hostname: String(hostname).toLowerCase().trim(), type: "custom", status: "pending",
  });
  return json({ ...row, instructions: {
    txt: { name: `_ciptadigital.${hostname}`, value: row.verification_token },
    cname: { name: hostname, value: `sites.${env.ROOT_DOMAIN}` },
  } }, 201);
});

// Semakan TXT melalui DNS-over-HTTPS; status dikemas kini oleh service role sahaja.
route("POST", "/api/domains/:id/verify", async ({ req, env, params }) => {
  const s = await requireSession(req, env);
  const [d] = await s.db.select<{ id: string; tenant_id: string; website_id: string; hostname: string; verification_token: string }>(
    `domains?select=id,tenant_id,website_id,hostname,verification_token&id=eq.${enc(uuid(params.id))}`);
  if (!d) throw new HttpError(404, "Domain tidak dijumpai");
  requireTenantAdmin(s, d.tenant_id);
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=_ciptadigital.${enc(d.hostname)}&type=TXT`,
    { headers: { Accept: "application/dns-json" } });
  const dns = (await r.json()) as { Answer?: { data: string }[] };
  const ok = (dns.Answer ?? []).some(a => a.data.replace(/"/g, "") === d.verification_token);
  const patch = ok
    ? { status: "active", ssl_status: "pending", verified_at: new Date().toISOString(), last_error: null }
    : { status: "error", last_error: "Rekod TXT tidak dijumpai atau tidak sepadan" };
  await serviceDb(env).update(`domains?id=eq.${d.id}`, patch);
  await purgeSiteCache(env, d.website_id);
  await audit(s, d.tenant_id, "domain.verify", "domains", d.id, { ok });
  return json({ verified: ok, ...patch });
});

// ===================== Sokongan =====================
route("POST", "/api/tenants/:tid/tickets", async ({ req, env, params }) => {
  const s = await requireSession(req, env); requireTenant(s, uuid(params.tid));
  const b = pick(await body(req), ["subject", "body", "priority"]);
  return json((await s.db.insert("support_tickets", { ...b, tenant_id: params.tid, opened_by: s.userId, status: "open" }))[0], 201);
});

// ===================== Router =====================
function cors(req: Request, env: Env, res: Response) {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map(x => x.trim());
  const h = new Headers(res.headers);
  if (allowed.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    h.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    h.set("Vary", "Origin");
  }
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return cors(req, env, new Response(null, { status: 204 }));
    const url = new URL(req.url);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        return cors(req, env, await r.handler({ req, env, params, url }));
      }
      return cors(req, env, json({ error: "Tidak dijumpai" }, 404));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : "Ralat dalaman";
      if (!(e instanceof HttpError)) console.error(e);
      return cors(req, env, json({ error: message }, status));
    }
  },
};
