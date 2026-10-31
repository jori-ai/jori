import { redirect } from "next/navigation";
import { requireAllowedUser } from "@/lib/auth";
import { listReservoirs, defaultArea } from "@/lib/reservoirs";

export const dynamic = "force-dynamic";

export default async function ReservoirIndex() {
  await requireAllowedUser();
  const areas = await listReservoirs();
  if (!areas.length) {
    return (
      <main className="empty">
        <h2>No reservoirs yet</h2>
        <p>Area guides will show up here once they&apos;re built.</p>
      </main>
    );
  }
  // The per-area page carries the full area nav; land on the leg that's current
  // (or next upcoming), not always the first.
  redirect(`/reservoir/${defaultArea(areas)}`);
}
