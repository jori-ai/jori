"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CONFIGURED } from "@/lib/config";

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/`,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setBusy(false);
      setError(error.message);
    }
    // otherwise the browser is redirecting to Google
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-mark">🧭</div>
        <h1>Trip Itinerary</h1>
        <p>Sign in to view your daily plans.</p>
        <button onClick={signIn} disabled={busy || !CONFIGURED}>
          {busy ? "Opening Google…" : "Sign in with Google"}
        </button>
        {!CONFIGURED && <p className="login-error">This site is not configured yet.</p>}
        {error && <p className="login-error">{error}</p>}
      </div>
    </main>
  );
}
