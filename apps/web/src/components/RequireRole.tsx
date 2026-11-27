import { Navigate } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../lib/auth";

// Pengawal UI sahaja (UX). Keselamatan sebenar dikuatkuasakan oleh Worker + RLS.
export function RequireRole({ role, children }: { role: "super_admin" | "tenant"; children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div className="p-8 text-sm text-slate-500">Memuatkan…</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (role === "super_admin" && !me.isSuperAdmin) return <Navigate to="/app" replace />;
  if (role === "tenant" && !me.memberships.length && !me.isSuperAdmin) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
