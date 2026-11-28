// =====================================================================
// OPR SMASID EXPRESS — API (Cloudflare Pages Functions)
// Semua laluan /api/* dikendalikan oleh fail ini.
//
// Bindings (Cloudflare Pages → Settings → Bindings):
//   DB     → pangkalan data D1   (jalankan schema.sql sekali)
//   FILES  → bucket R2           (gambar aktiviti & logo)
// Variables & Secrets (Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (Secret)
//   ANTHROPIC_API_KEY                      (Secret, untuk AI OCR)
//   AI_MODEL                               (pilihan, default claude-sonnet-5-5)
// =====================================================================

const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000;            // had maksimum Cloudflare Workers
const MAX_FILE = 10 * 1024 * 1024;     // 10 MB setiap gambar
const MAX_OPR_JSON = 900 * 1024;       // had saiz data OPR
const KATS = ["akademik", "hem", "koku", "ulul"];
const STATUSES = ["draft", "pending", "confirmed", "sent"];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
const now = () => new Date().toISOString();
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function body(req) { try { return await req.json(); } catch { throw new HttpError(400, "JSON tidak sah"); } }
const isAdminUser = (u) => !!u && (u.role === "admin" || u.can_manage_all === 1);
const publicUser = (u) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, can_manage_all: !!u.can_manage_all, created_at: u.created_at });

// ---------------- sesi ----------------
async function createSession(env, userId) {
  const token = randHex(32);
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 864e5).run();
  return token;
}
async function getUser(req, env) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    "SELECT u.* , s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(await sha256(token)).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}
async function requireUser(req, env) {
  const u = await getUser(req, env);
  if (!u) throw new HttpError(401, "Sila log masuk semula");
  return u;
}
async function requireAdmin(req, env) {
  const u = await requireUser(req, env);
  if (!isAdminUser(u)) throw new HttpError(403, "Hanya admin dibenarkan");
  return u;
}

// ---------------- auth ----------------
async function register(req, env) {
  const b = await body(req);
  const email = String(b.email || "").trim().toLowerCase();
  const name = String(b.full_name || "").trim().slice(0, 120);
  const password = String(b.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "E-mel tidak sah");
  if (!name) throw new HttpError(400, "Sila isi nama penuh");
  if (password.length < 6) throw new HttpError(400, "Kata laluan sekurang-kurangnya 6 aksara");
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) {
    throw new HttpError(409, "E-mel ini sudah didaftarkan. Sila log masuk.");
  }
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n;
  const id = crypto.randomUUID();
  const salt = randHex(16);
  await env.DB.prepare("INSERT INTO users(id,email,full_name,pass_hash,pass_salt,role) VALUES (?,?,?,?,?,?)")
    .bind(id, email, name, await hashPassword(password, salt), salt, count === 0 ? "admin" : "guru").run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return json({ ok: true, token: await createSession(env, id), user: publicUser(user), first_admin: count === 0 });
}

async function login(req, env) {
  const b = await body(req);
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  const fail = await env.DB.prepare("SELECT * FROM login_fail WHERE email = ?").bind(email).first();
  if (fail && fail.until > Date.now()) {
    throw new HttpError(429, `Terlalu banyak cubaan. Cuba lagi dalam ${Math.ceil((fail.until - Date.now()) / 60000)} minit.`);
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  const ok = user && safeEqual(await hashPassword(password, user.pass_salt), user.pass_hash);
  if (!ok) {
    const n = (fail?.count || 0) + 1;
    await env.DB.prepare("INSERT INTO login_fail(email,count,until) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET count=excluded.count, until=excluded.until")
      .bind(email, n >= 5 ? 0 : n, n >= 5 ? Date.now() + 10 * 60000 : 0).run();
    throw new HttpError(401, "E-mel atau kata laluan salah.");
  }
  await env.DB.prepare("DELETE FROM login_fail WHERE email = ?").bind(email).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(user.id, Date.now()).run();
  return json({ ok: true, token: await createSession(env, user.id), user: publicUser(user) });
}

async function logout(req, env) {
  const h = req.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(h.slice(7).trim())).run();
  return json({ ok: true });
}

// ---------------- OPR ----------------
const oprOut = (r) => ({ id: r.id, author_id: r.author_id, status: r.status, data: JSON.parse(r.data || "{}"), created_at: r.created_at });

async function listOprs(req, env) {
  const u = await requireUser(req, env);
  const q = isAdminUser(u)
    ? env.DB.prepare("SELECT id,author_id,status,data,created_at FROM oprs ORDER BY created_at DESC")
    : env.DB.prepare("SELECT id,author_id,status,data,created_at FROM oprs WHERE author_id = ? ORDER BY created_at DESC").bind(u.id);
  const { results } = await q.all();
  return json({ ok: true, data: results.map(oprOut) });
}

async function upsertOpr(req, env, id) {
  const u = await requireUser(req, env);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new HttpError(400, "ID OPR tidak sah");
  const b = await body(req);
  const kategori = b.kategori && KATS.includes(b.kategori) ? b.kategori : null;
  const status = STATUSES.includes(b.status) ? b.status : "draft";
  const data = JSON.stringify(b.data ?? {});
  if (data.length > MAX_OPR_JSON) throw new HttpError(413, "Data OPR terlalu besar");
  const existing = await env.DB.prepare("SELECT author_id FROM oprs WHERE id = ?").bind(id).first();
  if (existing) {
    if (existing.author_id !== u.id && !isAdminUser(u)) throw new HttpError(403, "Tiada kebenaran untuk mengubah OPR ini");
    await env.DB.prepare("UPDATE oprs SET kategori=?, status=?, nama=?, data=?, updated_at=? WHERE id=?")
      .bind(kategori, status, b.nama ? String(b.nama).slice(0, 300) : null, data, now(), id).run();
  } else {
    await env.DB.prepare("INSERT INTO oprs(id,author_id,kategori,status,nama,data) VALUES (?,?,?,?,?,?)")
      .bind(id, u.id, kategori, status, b.nama ? String(b.nama).slice(0, 300) : null, data).run();
  }
  return json({ ok: true });
}

async function deleteOpr(req, env, id) {
  const u = await requireUser(req, env);
  const r = await env.DB.prepare("SELECT author_id FROM oprs WHERE id = ?").bind(id).first();
  if (!r) throw new HttpError(404, "OPR tidak dijumpai");
  if (r.author_id !== u.id && !isAdminUser(u)) throw new HttpError(403, "Tiada kebenaran untuk memadam");
  await env.DB.prepare("DELETE FROM oprs WHERE id = ?").bind(id).run();
  if (env.FILES) {   // padam gambar berkaitan
    const listed = await env.FILES.list({ prefix: `${r.author_id}/${id}/` });
    await Promise.all(listed.objects.map((o) => env.FILES.delete(o.key)));
  }
  return json({ ok: true });
}

// ---------------- pengguna (admin) ----------------
async function listProfiles(req, env) {
  await requireAdmin(req, env);
  const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at").all();
  return json({ ok: true, data: results.map(publicUser) });
}

async function patchProfile(req, env, id) {
  const admin = await requireAdmin(req, env);
  const b = await body(req);
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new HttpError(404, "Pengguna tidak dijumpai");
  if (typeof b.password === "string") {                       // set semula kata laluan
    if (b.password.length < 6) throw new HttpError(400, "Kata laluan sekurang-kurangnya 6 aksara");
    const salt = randHex(16);
    await env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(await hashPassword(b.password, salt), salt, id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (id === admin.id) throw new HttpError(400, "Tidak boleh menukar peranan sendiri");
  if ("role" in b) {
    if (!["guru", "admin"].includes(b.role)) throw new HttpError(400, "Peranan tidak sah");
    await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(b.role, id).run();
  }
  if ("can_manage_all" in b) await env.DB.prepare("UPDATE users SET can_manage_all=? WHERE id=?").bind(b.can_manage_all ? 1 : 0, id).run();
  return json({ ok: true });
}

// ---------------- tetapan ----------------
async function getSettings(req, env) {
  await requireUser(req, env);
  const s = await env.DB.prepare("SELECT * FROM settings WHERE id = 1").first();
  return json({ ok: true, data: s || {} });
}
async function putSettings(req, env) {
  await requireAdmin(req, env);
  const b = await body(req);
  const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
  const logo = b.logo_path && /^settings\/[A-Za-z0-9._-]+$/.test(b.logo_path) ? b.logo_path : null;
  await env.DB.prepare(`INSERT INTO settings(id,school_name,slogan,logo_path,tg_group,updated_at) VALUES (1,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET school_name=excluded.school_name, slogan=excluded.slogan, logo_path=excluded.logo_path,
    tg_group=excluded.tg_group, updated_at=excluded.updated_at`)
    .bind(clip(b.school_name, 160), clip(b.slogan, 300), logo, clip(b.tg_group, 120), now()).run();
  return json({ ok: true });
}

// ---------------- fail (R2) ----------------
// Kunci: <author_id>/<opr_id>/<nama>  atau  settings/<nama>
async function canTouchKey(u, env, key, write) {
  const [a, b] = key.split("/");
  if (a === "settings") return write ? isAdminUser(u) : true;
  if (a === u.id) return true;
  if (isAdminUser(u)) return true;
  // guru membuka OPR milik sendiri yang gambarnya dimuat naik oleh admin
  if (!write && b) {
    const r = await env.DB.prepare("SELECT 1 FROM oprs WHERE id = ? AND author_id = ?").bind(b, u.id).first();
    return !!r;
  }
  return false;
}
async function uploadFile(req, env) {
  const u = await requireUser(req, env);
  if (!env.FILES) throw new HttpError(500, "Bucket R2 (FILES) belum disambung");
  const form = await req.formData();
  const file = form.get("file");
  const folder = String(form.get("folder") || "");
  if (!file || typeof file.arrayBuffer !== "function") throw new HttpError(400, "Tiada fail");
  if (file.size > MAX_FILE) throw new HttpError(413, "Fail melebihi 10 MB");
  const type = String(file.type || "");
  const ext = type.includes("png") ? "png" : type.includes("svg") ? "svg" : type.includes("webp") ? "webp" : "jpg";
  if (!/^image\//.test(type) && type !== "") throw new HttpError(415, "Hanya fail gambar dibenarkan");
  if (!/^(settings|[0-9a-f-]{36}\/[A-Za-z0-9_-]{4,64})$/.test(folder)) throw new HttpError(400, "Folder tidak sah");
  const key = `${folder}/${Date.now().toString(36)}${randHex(3)}.${ext}`;
  if (!(await canTouchKey(u, env, key, true))) throw new HttpError(403, "Tiada kebenaran memuat naik ke folder ini");
  await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type || "image/jpeg" } });
  return json({ ok: true, path: key });
}
async function getFile(req, env, key) {
  const u = await requireUser(req, env);
  if (!env.FILES) throw new HttpError(500, "Bucket R2 (FILES) belum disambung");
  if (key.includes("..") || !(await canTouchKey(u, env, key, false))) throw new HttpError(403, "Tiada kebenaran");
  const obj = await env.FILES.get(key);
  if (!obj) throw new HttpError(404, "Fail tidak dijumpai");
  const type = obj.httpMetadata?.contentType || "application/octet-stream";
  return new Response(obj.body, { headers: {
    "Content-Type": type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
    ...(type.includes("svg") ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
  } });
}

// ---------------- Telegram ----------------
async function telegramSend(req, env) {
  const miss = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter((n) => !env[n]);
  if (miss.length) throw new HttpError(500, `Variable belum ditetapkan di Cloudflare: ${miss.join(", ")}`);
  const u = await requireUser(req, env);
  let form;
  try { form = await req.formData(); } catch { throw new HttpError(400, "Format permintaan tidak sah"); }
  const tg = async (method, fd) => {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: fd });
    return r.json().catch(() => ({ ok: false, description: `Telegram HTTP ${r.status}` }));
  };
  if (form.get("action") === "test") {
    if (!isAdminUser(u)) throw new HttpError(403, "Hanya admin boleh menguji sambungan");
    const m = new FormData(); m.append("chat_id", env.TELEGRAM_CHAT_ID);
    m.append("text", "✅ Ujian sambungan OPR SMASID EXPRESS berjaya.");
    const out = await tg("sendMessage", m);
    return out.ok ? json({ ok: true }) : json({ ok: false, error: out.description || "Telegram menolak permintaan" }, 502);
  }
  const file = form.get("file");
  const caption = String(form.get("caption") ?? "").slice(0, 1000);
  const isPdf = form.get("format") === "pdf";
  const oprId = String(form.get("opr_id") ?? "");
  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) throw new HttpError(400, "Fail OPR tiada");
  const opr = await env.DB.prepare("SELECT id,author_id,status FROM oprs WHERE id = ?").bind(oprId).first();
  if (!opr || (opr.author_id !== u.id && !isAdminUser(u))) throw new HttpError(404, "OPR tidak dijumpai atau tiada kebenaran");
  if (opr.status !== "confirmed" && opr.status !== "sent") throw new HttpError(409, "OPR belum disahkan (CONFIRM)");

  const name = file.name || (isPdf ? "OPR.pdf" : "OPR.jpg");
  const send = (field, method) => {
    const m = new FormData(); m.append("chat_id", env.TELEGRAM_CHAT_ID); m.append("caption", caption); m.append(field, file, name);
    return tg(method, m);
  };
  let out = isPdf ? await send("document", "sendDocument") : await send("photo", "sendPhoto");
  if (!out.ok && !isPdf) out = await send("document", "sendDocument");
  await env.DB.prepare("UPDATE oprs SET status=?, tg_status=?, tg_sent_at=?, tg_error=?, updated_at=? WHERE id=?")
    .bind(out.ok ? "sent" : opr.status, out.ok ? "SENT SUCCESSFULLY" : "FAILED", now(), out.ok ? null : out.description || "unknown", now(), oprId).run();
  return out.ok ? json({ ok: true, status: "SENT SUCCESSFULLY" })
    : json({ ok: false, status: "FAILED", error: out.description || "Telegram menolak permintaan" }, 502);
}

// ---------------- AI (Claude) ----------------
function parseJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.search(/[\[{]/), z = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch {} }
  return null;
}
async function aiExtract(req, env) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, "Variable belum ditetapkan di Cloudflare: ANTHROPIC_API_KEY");
  await requireUser(req, env);
  const b = await body(req);
  const prompt = String(b?.prompt ?? "").slice(0, 60000);
  if (!prompt) throw new HttpError(400, "Prompt kosong");
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).filter((i) => i && i.data);
  const content = images.map((i) => ({ type: "image", source: { type: "base64",
    media_type: ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(i.type) ? i.type : "image/jpeg", data: i.data } }));
  content.push({ type: "text", text: prompt + "\n\nBalas dengan JSON sahaja, tanpa teks lain." });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.AI_MODEL || "claude-sonnet-5-5", max_tokens: 2000, messages: [{ role: "user", content }] }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ ok: false, error: out?.error?.message || `AI ralat ${r.status}` }, r.status === 429 ? 429 : 502);
  const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const parsed = parseJson(text);
  if (parsed === null) return json({ ok: false, error: "AI tidak memberi JSON yang sah", text }, 502);
  return json({ ok: true, json: parsed, text });
}

// ---------------- router ----------------
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const m = request.method;
  try {
    if (!env.DB) throw new HttpError(500, "Pangkalan data D1 (DB) belum disambung di Cloudflare Pages");
    if (path === "health") {
      const s = await env.DB.prepare("SELECT school_name FROM settings WHERE id = 1").first().catch(() => null);
      return json({ ok: true, db: !!s, school: s?.school_name || null, files: !!env.FILES, telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), ai: !!env.ANTHROPIC_API_KEY });
    }
    if (path === "auth/register" && m === "POST") return await register(request, env);
    if (path === "auth/login" && m === "POST") return await login(request, env);
    if (path === "auth/logout" && m === "POST") return await logout(request, env);
    if (path === "me" && m === "GET") { const u = await requireUser(request, env); return json({ ok: true, user: publicUser(u) }); }
    if (path === "oprs" && m === "GET") return await listOprs(request, env);
    let x;
    if ((x = path.match(/^oprs\/([^/]+)$/))) {
      if (m === "PUT") return await upsertOpr(request, env, decodeURIComponent(x[1]));
      if (m === "DELETE") return await deleteOpr(request, env, decodeURIComponent(x[1]));
    }
    if (path === "profiles" && m === "GET") return await listProfiles(request, env);
    if ((x = path.match(/^profiles\/([0-9a-f-]{36})$/)) && m === "PATCH") return await patchProfile(request, env, x[1]);
    if (path === "settings" && m === "GET") return await getSettings(request, env);
    if (path === "settings" && m === "PUT") return await putSettings(request, env);
    if (path === "files" && m === "POST") return await uploadFile(request, env);
    if (path.startsWith("files/") && m === "GET") return await getFile(request, env, decodeURIComponent(path.slice(6)));
    if (path === "telegram-send") {
      if (m === "GET") return json({ ok: true, service: "telegram-send", configured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) });
      if (m === "POST") return await telegramSend(request, env);
    }
    if (path === "ai-extract") {
      if (m === "GET") return json({ ok: true, service: "ai-extract", configured: !!env.ANTHROPIC_API_KEY });
      if (m === "POST") return await aiExtract(request, env);
    }
    return json({ ok: false, error: "Laluan API tidak dijumpai" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
    console.error(e);
    return json({ ok: false, error: "Ralat dalaman pelayan" }, 500);
  }
}
