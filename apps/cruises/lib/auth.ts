import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CONFIGURED, isAllowed } from "@/lib/config";

/**
 * Server-side gate for protected pages: must be signed in AND on the
 * allowlist, else redirect. Returns the authenticated, allowed user's email.
 *
 * `next` is where to land AFTER signing in, and passing it matters more here
 * than on most sites: every link in the weekly cruise email is a deep link
 * into a filtered view or a single sailing, and a session that has expired
 * would otherwise swallow it and drop the user on the front page — the one outcome
 * deep links exist to prevent.
 */
export async function requireAllowedUser(next?: string): Promise<{ email: string }> {
  if (!CONFIGURED) redirect("/not-authorized");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  if (!isAllowed(user.email)) redirect("/not-authorized");

  return { email: user.email! };
}
