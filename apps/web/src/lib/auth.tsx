import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { api } from "./api";

export interface Me {
  user: { id: string; email: string };
  isSuperAdmin: boolean;
  memberships: { tenant_id: string; role: "tenant_admin" | "tenant_staff"; permissions: string[] }[];
  tenants: { id: string; slug: string; business_name: string; status: string }[];
}
interface Ctx { session: Session | null; me: Me | null; loading: boolean; signOut: () => Promise<void> }
const AuthCtx = createContext<Ctx>({ session: null, me: null, loading: true, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setMe(null); setLoading(false); return; }
    setLoading(true);
    // Peranan diambil dari server (/api/me), bukan dari localStorage atau JWT claims tersuai.
    api<Me>("/api/me").then(setMe).catch(() => setMe(null)).finally(() => setLoading(false));
  }, [session?.access_token]);

  return <AuthCtx.Provider value={{ session, me, loading, signOut: async () => { await supabase.auth.signOut(); } }}>
    {children}
  </AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);
