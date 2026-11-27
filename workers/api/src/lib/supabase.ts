// Klien PostgREST minimum untuk Cloudflare Workers (tiada dependency).
// - userDb(): guna JWT pengguna -> RLS dikuatkuasakan oleh Postgres.
// - serviceDb(): guna service role -> HANYA untuk domain resolution & tugas sistem.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string; // wrangler secret put SUPABASE_SERVICE_ROLE_KEY
  ROOT_DOMAIN: string;               // cth: ciptadigital.my
  ALLOWED_ORIGINS: string;           // dipisah koma
  MEDIA: R2Bucket;
  SITE_CACHE: KVNamespace;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Db = ReturnType<typeof makeDb>;

function makeDb(env: Env, bearer: string) {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
  async function req<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message ?? text; } catch { /* teks mentah */ }
      throw new HttpError(res.status === 401 ? 401 : res.status >= 500 ? 502 : 400, msg);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  return {
    select: <T>(path: string) => req<T[]>("GET", path),
    insert: <T>(table: string, row: unknown) => req<T[]>("POST", table, row, "return=representation"),
    update: <T>(path: string, patch: unknown) => req<T[]>("PATCH", path, patch, "return=representation"),
    remove: (path: string) => req<null>("DELETE", path),
    rpc: <T>(fn: string, args: unknown) => req<T>("POST", `rpc/${fn}`, args),
  };
}

export const userDb = (env: Env, jwt: string) => makeDb(env, jwt);
export const serviceDb = (env: Env) => makeDb(env, env.SUPABASE_SERVICE_ROLE_KEY);

export const enc = encodeURIComponent;
