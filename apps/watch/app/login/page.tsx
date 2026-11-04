"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CONFIGURED } from "@/lib/config";

function LoginCard() {
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where the gate wanted to send us — a deep link, when
  // the session had expired. Only same-site paths: a value starting "//" is a
  // full URL in disguise and would make this an open redirect.
  const raw = params.get("next") ?? "/";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  async function signIn() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
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
        <div className="login-mark">🎬</div>
        <h1>What we watched</h1>
        <p>Sign in to mark what you've watched.</p>
        <button onClick={signIn} disabled={busy || !CONFIGURED}>
          {busy ? "Opening Google…" : "Sign in with Google"}
        </button>
        {!CONFIGURED && <p className="login-error">This site is not configured yet.</p>}
        {error && <p className="login-error">{error}</p>}
      </div>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to prerender at build time.
  return (
    <Suspense fallback={null}>
      <LoginCard />
    </Suspense>
  );
}
