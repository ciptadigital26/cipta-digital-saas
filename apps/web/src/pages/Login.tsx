import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError("E-mel atau kata laluan salah"); else nav("/app");
  }
  return (
    <form onSubmit={submit} className="mx-auto mt-24 max-w-sm space-y-4 rounded-2xl border p-8">
      <h1 className="text-xl font-semibold">CIPTA DIGITAL Control Hub</h1>
      <input className="w-full rounded-lg border px-3 py-2" type="email" placeholder="E-mel" value={email} onChange={e => setEmail(e.target.value)} required />
      <input className="w-full rounded-lg border px-3 py-2" type="password" placeholder="Kata laluan" value={password} onChange={e => setPassword(e.target.value)} required />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-teal-700 py-2 font-medium text-white">{busy ? "Sedang masuk…" : "Log masuk"}</button>
    </form>
  );
}
