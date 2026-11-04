import { redirect } from "next/navigation";
import { requireAllowedUser } from "@/lib/auth";
import { listReservoirs, defaultArea } from "@/lib/reservoirs";

export const dynamic = "force-dynamic";

// The area guides ARE the site. The generated daily itinerary was retired: the
// travel guide by destination is the main view, so / lands on the guides rather
// than on a generated day plan.
export default async function Home() {
  await requireAllowedUser();
  const areas = await listReservoirs();
  if (!areas.length) {
    return (
      <main className="empty">
        <h2>No area guides yet</h2>
        <p>Guides will show up here once they&apos;re built.</p>
      </main>
    );
  }
  redirect(`/reservoir/${defaultArea(areas)}`);
}
