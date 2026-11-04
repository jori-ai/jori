import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CONFIGURED, isAllowed } from "@/lib/config";

// Server-side gate for protected pages: must be signed in AND on the allowlist,
// else redirect. Returns the authenticated, allowed user's email.
export async function requireAllowedUser(): Promise<{ email: string }> {
  if (!CONFIGURED) redirect("/not-authorized");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  if (!isAllowed(user.email)) redirect("/not-authorized");

  return { email: user.email! };
}
