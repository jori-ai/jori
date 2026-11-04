import { requireAllowedUser } from "@/lib/auth";
import { getSailingIndex, getFavorites } from "@/lib/sailings";
import SignOutButton from "@/components/SignOutButton";
import CruiseBrowser from "@/components/CruiseBrowser";
import { parseDeepLink } from "@/lib/deep-link";
import { SITE_TZ } from "@/lib/config";

// Always fresh: the corpus is rewritten by the Monday cruise-watch run, and a
// cached page would show last week's prices on a site whose entire purpose is
// current prices.
export const dynamic = "force-dynamic";

function asOf(iso: string | null): string | null {
  if (!iso) return null;
  // The site's display zone (SITE_TZ) — the data is written by the host in
  // UTC and read here; only the display layer converts.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SITE_TZ,
    timeZoneName: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Preserve the deep link across a sign-in. This is a one-page site, so the
  // destination is "/" plus whatever the email put in the query string.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, one);
  }
  const here = qs.toString() ? `/?${qs.toString()}` : "/";
  const { email } = await requireAllowedUser(here);

  // The weekly email links in here pointing at a specific sailing or bucket —
  // see lib/deep-link.ts for the contract.
  const link = parseDeepLink(sp);
  const [index, favorites] = await Promise.all([getSailingIndex(), getFavorites()]);
  const stamp = asOf(index.lastRunAt);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span>🚢 Cruises</span>
          {stamp && <span className="asof">prices as of {stamp}</span>}
        </div>
        <SignOutButton />
      </header>
      <main className="wrap">
        <CruiseBrowser index={index} link={link} favorites={favorites} email={email} />
      </main>
    </>
  );
}
