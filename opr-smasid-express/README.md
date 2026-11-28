# OPR SMASID EXPRESS

Sistem One Page Report (OPR) untuk guru: upload pamphlet/kertas kerja → AI isi maklumat → gambar → impak → preview A4 → CONFIRM → hantar ke Telegram.

Backend **Cloudflare** sepenuhnya:

| Bahagian | Cloudflare |
|---|---|
| Laman web (`index.html`) | Pages |
| API (`functions/api/[[path]].js`) | Pages Functions |
| Pangkalan data (pengguna, OPR, tetapan) | D1 |
| Gambar aktiviti & logo | R2 |

```
index.html                   ← aplikasi
functions/api/[[path]].js    ← semua API /api/*
schema.sql                   ← jadual D1 (jalankan sekali)
wrangler.toml                ← pilihan, untuk deploy melalui CLI
logo.svg, logo.png           ← logo OPR SMASID EXPRESS
```

> **Penting:** GitHub Pages **tidak** boleh menjalankan sistem ini (tiada pangkalan data / API).
> Simpan kod di GitHub, kemudian sambungkan repo itu ke **Cloudflare Pages**.

## Langkah pemasangan (Dashboard Cloudflare, tanpa coding)

1. **GitHub** — kod sudah berada dalam repo `ciptadigital26/cipta-digital-saas`, folder `opr-smasid-express/`.
2. **D1** — Cloudflare Dashboard → *Storage & Databases* → *D1* → **Create** → nama `opr-smasid-db`.
   Buka pangkalan data → **Console** → tampal isi `schema.sql` → **Execute**.
3. **R2** — *Storage & Databases* → *R2* → **Create bucket** → nama `opr-smasid-files`.
4. **Pages** — *Workers & Pages* → **Create** → *Pages* → **Connect to Git** → pilih repo.
   Framework preset: **None**. Build command: *(kosong)*. Build output directory: `/`.
   **Root directory: `opr-smasid-express`** (kerana projek ini berada dalam folder repo `cipta-digital-saas`).
5. **Bindings** — projek Pages → *Settings* → *Bindings* → **Add**:
   - D1 database: nama variable `DB` → `opr-smasid-db`
   - R2 bucket: nama variable `FILES` → `opr-smasid-files`
6. **Variables and Secrets** — *Settings* → *Variables and Secrets* → tambah (jenis **Secret**):

| Nama | Nilai |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token daripada @BotFather |
| `TELEGRAM_CHAT_ID` | ID group, contoh `-1001234567890` |
| `ANTHROPIC_API_KEY` | `sk-ant-...` (untuk AI OCR & jana impak) |
| `AI_MODEL` | *(pilihan, jenis Text)* default `claude-sonnet-5-5` |

7. *Deployments* → **Retry deployment** (supaya bindings & secrets berkuat kuasa).
8. Buka `https://<projek>.pages.dev/api/health` — sepatutnya `"db":true,"files":true`.

## Admin pertama

**Akaun pertama yang mendaftar di aplikasi menjadi ADMIN secara automatik.** Daftar akaun anda dahulu sebelum berkongsi pautan dengan guru.
Dalam **Tetapan**: isi nama penuh sekolah, muat naik logo sekolah, nama group Telegram, kemudian **Uji sambungan Telegram**.

**Chat ID group:** tambah bot ke group dan jadikannya admin. Hantar satu mesej dalam group, buka
`https://api.telegram.org/bot<TOKEN>/getUpdates` dan salin `chat.id` (bermula `-100…`).

## Keselamatan

- Kata laluan disimpan sebagai hash PBKDF2-SHA256 (100,000 pusingan) dengan salt unik; tiada kata laluan teks biasa.
- Sesi log masuk 30 hari; hanya hash token disimpan dalam D1.
- 5 cubaan log masuk gagal → disekat 10 minit.
- Guru hanya boleh melihat/mengubah/memadam OPR dan gambar sendiri; admin boleh semua.
- Token Telegram & API key AI hanya dalam Cloudflare Secrets, tidak pernah sampai ke pelayar.
- **Lupa kata laluan:** tiada e-mel automatik. Admin tetapkan kata laluan baharu di *Tetapan → Pengguna & kebenaran → Set semula*.
