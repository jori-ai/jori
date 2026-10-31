import Link from "next/link";
import { CONFIGURED } from "@/lib/config";

export default function NotAuthorized() {
  if (!CONFIGURED) {
    // A fresh install: no Supabase URL/key in the environment, so the site is off.
    return (
      <main className="login">
        <div className="login-card">
          <div className="login-mark">🔒</div>
          <h1>Not configured</h1>
          <p>This site has no Supabase project set (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).</p>
        </div>
      </main>
    );
  }
  return (
    <main className="login">
      <div className="login-card">
        <div className="login-mark">🔒</div>
        <h1>Not authorized</h1>
        <p>This account can&apos;t view the cruise list.</p>
        <Link className="login-link" href="/login">
          Try a different account
        </Link>
      </div>
    </main>
  );
}
