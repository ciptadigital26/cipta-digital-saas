# CIPTA DIGITAL SDN BHD — White Label Control Hub

Platform SaaS multi-tenant: setiap pelanggan mendapat website, dashboard, branding, domain dan pengguna sendiri, dikawal dari satu sistem pusat.

## Status fasa

| Fasa | Skop | Status |
|---|---|---|
| 1 | Database, authentication, tenant isolation | **Siap & diuji** (lihat "Ujian yang telah dijalankan") |
| 2 | Super Admin Dashboard | UI prototaip sahaja. Belum disambung ke API |
| 3 | Tenant Admin Dashboard | UI prototaip sahaja |
| 4 | White Label Branding Engine | API siap (`PUT /api/websites/:id/settings`). UI prototaip |
| 5 | Website Page Builder | API CRUD + susunan siap. UI prototaip |
| 6 | Domain & subscription | API domain/verify + pelan siap. Pembayaran: integrasi berasingan |
| 7 | Testing, security audit, deployment | Belum |

## Projek dalam repo ini

| Folder | Projek | Hosting |
|---|---|---|
| `/` (`index.html`) | CIPTA DIGITAL White Label Control Hub (prototaip dashboard) | GitHub Pages |
| `opr-smasid-express/` | **OPR SMASID EXPRESS** — sistem One Page Report sekolah (Cloudflare D1 + R2 + Functions) | Cloudflare Pages, *Root directory* `opr-smasid-express` |

Arahan penuh OPR SMASID EXPRESS: [`opr-smasid-express/README.md`](opr-smasid-express/README.md).

## Struktur folder

```
cipta-digital-saas/
├── index.html                       Prototaip dashboard (GitHub Pages)
├── supabase/migrations/
│   ├── 0001_schema.sql              16 jadual, enum, FK, index, constraint, trigger
│   ├── 0002_security.sql            Fungsi RBAC, RLS semua jadual, had pakej, perlindungan medan
│   └── 0003_provisioning_seed.sql   Pakej STARTER/PRO/BUSINESS + provision_tenant()
├── workers/api/                     Cloudflare Worker (API + domain resolution)
│   ├── src/index.ts                 Router & semua endpoint
│   ├── src/lib/auth.ts              Pengesahan JWT, semakan keahlian tenant
│   ├── src/lib/supabase.ts          Klien PostgREST (JWT pengguna / service role)
│   └── wrangler.toml
└── apps/web/                        React + TypeScript + Tailwind (Cloudflare Pages)
    └── src/lib/{supabase,api,auth}.ts(x), components/RequireRole.tsx, pages/Login.tsx
```

## Model keselamatan

1. **Tenant ID tidak dipercayai dari browser.** Worker mengesahkan JWT melalui Supabase Auth, kemudian mengambil keahlian dari `tenant_users`. Untuk setiap operasi, `tenant_id` diambil dari rekod website/halaman dalam DB, bukan dari body request.
2. **RLS pada semua 15 jadual awam** (`force row level security`). Walaupun API dipintas, Postgres sendiri menolak akses rentas tenant.
3. **Tiga lapisan peranan:** `super_admin` (jadual `user_roles`), `tenant_admin` dan `tenant_staff` (jadual `tenant_users`, staff mendapat senarai `permissions` seperti `pages.edit`, `media.upload`, `products.edit`, `branding.edit`).
4. **Had pakej dikuatkuasakan dalam DB** (trigger): bilangan website, staff, dan kebenaran custom domain.
5. **Medan sensitif dilindungi:** tenant tidak boleh menukar status/SSL domain sendiri, menaikkan peranan sendiri, atau mengubah/memadam `activity_logs` (append-only).
6. **Rahsia:** service role key dan kunci API pembayaran hanya disimpan sebagai Worker secrets. `api_integrations.config` menolak kunci bernama `api_key/secret/password/token`.
7. **Mass assignment disekat:** setiap endpoint menapis medan dengan senarai putih (`pick`).
8. **Anon tiada akses jadual.** Laman awam tenant dihidangkan melalui `/public/site`, yang menentukan tenant daripada header Host (server-side domain resolution).

## Live configuration tanpa deploy semula

`Save Changes` → `PUT /api/websites/:id/settings` → simpan ke `website_settings` (versi dinaikkan) → cache KV untuk semua hostname website itu dipadam → permintaan seterusnya ke `/public/site` membaca tetapan baharu.

## Ujian yang telah dijalankan (PostgreSQL 16, stub `auth` ala Supabase)

- Ketiga-tiga migration berjalan tanpa ralat.
- Super Admin provision 2 tenant (STARTER & PRO): 7 halaman templat, subdomain aktif, langganan trial.
- Admin A hanya nampak 1 tenant & 7 halaman sendiri; 0 halaman tenant B.
- Admin A cuba ubah warna tenant B → tetapan B kekal `#0F766E`, versi 1.
- STARTER: tambah staff ditolak; custom domain ditolak.
- PRO: tambah staff & custom domain (status `pending`) berjaya.
- Admin cuba tukar status domain sendiri → kekal `active`.
- Padam `activity_logs` → ditolak.
- Bukan super admin panggil `provision_tenant` → ditolak.
- Staff (`pages.edit`) boleh edit halaman; tidak boleh tukar branding, naikkan peranan sendiri, atau padam halaman.
- Peranan `anon` → `permission denied` pada `tenants`.
- Kod Worker lulus `tsc --strict`. **Belum diuji terhadap Supabase/Cloudflare sebenar.**

## Deployment

1. **Supabase:** cipta projek → SQL Editor → jalankan `0001`, `0002`, `0003` mengikut urutan (atau `supabase db push`).
2. **Super Admin pertama:** daftar akaun di Authentication → jalankan
   `insert into public.user_roles(user_id, role) values ('<UUID>', 'super_admin');`
3. **Cloudflare:**
   ```bash
   cd workers/api && npm install
   npx wrangler r2 bucket create cipta-digital-media
   npx wrangler kv namespace create SITE_CACHE     # salin id ke wrangler.toml
   npx wrangler secret put SUPABASE_ANON_KEY
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler deploy
   ```
4. **Domain tenant:** gunakan Cloudflare for SaaS (Custom Hostnames) supaya domain pelanggan menghala ke Worker dan SSL dikeluarkan secara automatik. Tenant menambah rekod TXT `_ciptadigital.<domain>` dan CNAME ke `sites.ciptadigital.my`.
5. **Frontend:** `cd apps/web && npm install && npm run build` → Cloudflare Pages (output `dist`). Tetapkan `VITE_*` dalam Pages environment.

## Prototaip dashboard (`index.html`)

Satu fail HTML lengkap (logo, tema putih-biru-ungu, 1 syarikat contoh). Data disimpan dalam pelayar sahaja.

Untuk paparkan melalui GitHub Pages: repo → Settings → Pages → Source: branch `main`, folder `/ (root)`, kemudian buka `https://ciptadigital26.github.io/cipta-digital-saas/`.

## Fasa seterusnya

Fasa 2 akan membina Super Admin Dashboard dalam React, disambung terus ke endpoint `/api/admin/*`, berdasarkan reka bentuk prototaip yang disertakan.
