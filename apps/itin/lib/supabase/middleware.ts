import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_URL, SUPABASE_ANON_KEY, CONFIGURED } from "@/lib/config";

// Refreshes the Supabase auth session on every request and re-writes the
// rotated cookies onto the response, so Server Components always see a fresh
// session (the standard @supabase/ssr middleware pattern). Auth gating itself
// is done per-page (server components redirect to /login or /not-authorized).
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  // Not configured: the site is off, and there is no session to refresh.
  if (!CONFIGURED) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // IMPORTANT: getUser() (not getSession()) — it revalidates the token.
  await supabase.auth.getUser();

  return response;
}
