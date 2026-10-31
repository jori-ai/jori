import Link from "next/link";
import { requireAllowedUser } from "@/lib/auth";
import { listReservoirs, getReservoir, formatRange, type ReservoirSummary } from "@/lib/reservoirs";
import SignOutButton from "@/components/SignOutButton";
import ReservoirList from "@/components/ReservoirList";

export const dynamic = "force-dynamic";

// Areas are listed in the order the trip visits them, each with its dates
// (e.g. 7/10-7/19). The order
// and the dates both come from the travel timeline (travel_segments), synced
// onto each row's date_range by trip-reservoir-mark-done; listReservoirs() sorts
// on it, so a re-booked leg re-orders the nav on its own.
function AreaNav({ areas, current }: { areas: ReservoirSummary[]; current: string }) {
  return (
    <nav className="datenav" aria-label="Areas">
      {areas.map((a) => {
        const range = formatRange(a.date_range);
        return (
          <Link
            key={a.area}
            href={`/reservoir/${a.area}`}
            className={`chip${a.area === current ? " active" : ""}`}
          >
            <div className="loc">{a.label}</div>
            {range && <div className="date">{range}</div>}
          </Link>
        );
      })}
    </nav>
  );
}

export default async function ReservoirPage({
  params,
}: {
  params: Promise<{ area: string }>;
}) {
  await requireAllowedUser();
  const { area } = await params;

  const [areas, reservoir] = await Promise.all([listReservoirs(), getReservoir(area)]);
  const range = formatRange(reservoir?.date_range);

  return (
    <>
      {/* No "Daily plan" link: the generated daily itinerary was retired
          2026-07-17 and the guides are now the whole site. */}
      <header className="topbar">
        <Link href="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="dot">🧭</span> Travel Guide
        </Link>
        <SignOutButton />
      </header>

      {areas.length > 0 && <AreaNav areas={areas} current={area} />}

      {reservoir?.structured ? (
        <main className="daywrap daywrap-wide">
          <div className="day-frame">
            <h1 style={{ fontSize: "1.5rem", margin: "0.2rem 0 0.1rem" }}>{reservoir.label}</h1>
            {range && <div className="res-range">{range}</div>}
            <ReservoirList structured={reservoir.structured} />
          </div>
        </main>
      ) : (
        <main className="empty">
          <h2>No guide for this area</h2>
          <p>Pick another area above.</p>
        </main>
      )}
    </>
  );
}
