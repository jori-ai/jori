// The deployment's configuration. Every value comes from the environment (the
// Vercel project's env vars, or .env.local in development); `bin/app-env <app>`
// prints this installation's values from its instance and local config. Nothing
// personal is compiled in: with no Supabase URL and key the site is OFF (every
// page says it is not configured), and with no ALLOWED_EMAILS nobody gets in.
//
// The anon key is public by design (row-level security protects the data); it is
// the same project and key the agent's other clients use, so the sign-in here is
// the same identity system.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** Both halves of the Supabase config are present; without them the site is off. */
export const CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Parse a comma-separated email list (lower-cased, blanks dropped). */
export function parseEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Who may use the site. RLS enforces this server-side too; this is the app-layer
// gate (redirect to /not-authorized).
export const ALLOWED_EMAILS = parseEmails(process.env.ALLOWED_EMAILS);

export function isAllowed(email: string | null | undefined, allowed: string[] = ALLOWED_EMAILS): boolean {
  return !!email && allowed.includes(email.toLowerCase());
}

/** The IANA zone dates are shown in ("today", "prices as of"); UTC when unset. */
export const SITE_TZ = process.env.NEXT_PUBLIC_SITE_TZ || "UTC";
