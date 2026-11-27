import { Env, HttpError, userDb, Db, enc } from "./supabase";

export interface Membership { tenant_id: string; role: "tenant_admin" | "tenant_staff"; permissions: string[] }
export interface Session {
  userId: string;
  email: string;
  jwt: string;
  db: Db;               // klien dengan JWT pengguna (RLS aktif)
  isSuperAdmin: boolean;
  memberships: Membership[];
}

// Sahkan JWT dengan Supabase Auth (server-side). Token tidak dipercayai tanpa semakan ini.
export async function requireSession(req: Request, env: Env): Promise<Session> {
  const h = req.headers.get("Authorization") ?? "";
  const jwt = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!jwt) throw new HttpError(401, "Sila log masuk");

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new HttpError(401, "Sesi tidak sah atau tamat tempoh");
  const user = (await res.json()) as { id: string; email: string };

  const db = userDb(env, jwt);
  const [roles, memberships] = await Promise.all([
    db.select<{ role: string }>(`user_roles?select=role&user_id=eq.${enc(user.id)}`),
    db.select<Membership>(`tenant_users?select=tenant_id,role,permissions&user_id=eq.${enc(user.id)}&is_active=is.true`),
  ]);
  return { userId: user.id, email: user.email, jwt, db, isSuperAdmin: roles.some(r => r.role === "super_admin"), memberships };
}

export function requireSuperAdmin(s: Session) {
  if (!s.isSuperAdmin) throw new HttpError(403, "Akses Super Admin diperlukan");
}

// tenant_id dari URL hanya diterima jika ia ada dalam keahlian sesi (atau super admin).
export function requireTenant(s: Session, tenantId: string, perm?: string): Membership | null {
  if (s.isSuperAdmin) return null;
  const m = s.memberships.find(x => x.tenant_id === tenantId);
  if (!m) throw new HttpError(404, "Tenant tidak dijumpai");      // 404: jangan dedahkan kewujudan
  if (perm && m.role !== "tenant_admin" && !m.permissions.includes(perm)) {
    throw new HttpError(403, `Kebenaran '${perm}' diperlukan`);
  }
  return m;
}

export function requireTenantAdmin(s: Session, tenantId: string) {
  const m = requireTenant(s, tenantId);
  if (m && m.role !== "tenant_admin") throw new HttpError(403, "Hanya Tenant Admin");
}
