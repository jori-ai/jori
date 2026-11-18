import Link from "next/link";
import { requireAllowedUser } from "@/lib/auth";
import { listRibbon, getReservoir, formatItemRange, type RibbonItem } from "@/lib/reservoirs";
import { focusItem, prettyMetro } from "@/lib/trip-stays.mjs";
import SignOutButton from "@/components/SignOutButton";
import ReservoirList from "@/components/ReservoirList";

export const dynamic = "force-dynamic";

// The location ribbon: one chip per stay, in the order the trip makes them,
// each with its dates (e.g. 12/5-12/13). Stays and dates come live from the
// travel timeline (travel_segments) through lib/trip-stays.mjs, so a city
// visited twice gets two chips (home before and after another city) and a
// multi-stop loop shows every stop, out of its gateway city and back. A stop with no
// guide yet still shows, dimmed, so the route reads whole.
//
// Past stays are hidden by default; "Show past" (?past=1) brings them back and
// the choice rides along on every chip link. The chip of the page being viewed
// always shows, even when it is past.
function AreaNav({
  items,
  current,
  focusKey,
  showPast,
}: {
  items: RibbonItem[];
  current: string;
  focusKey: string | null;
  showPast: boolean;
}) {
  const visible = items.filter((it) => showPast || !it.past || it.key === focusKey);
  const pastCount = items.filter((it) => it.past).length;
  const q = showPast ? "?past=1" : "";
  return (
    <nav className="datenav" aria-label="Areas">
      {pastCount > 0 && (
        <Link
          href={`/reservoir/${current}${showPast ? "" : "?past=1"}`}
          className="chip toggle"
          aria-pressed={showPast}
        >
          <div className="loc">{showPast ? "Hide past" : "Show past"}</div>
          <div className="date">{showPast ? "upcoming only" : `${pastCount} trip${pastCount === 1 ? "" : "s"}`}</div>
        </Link>
      )}
      {visible.map((it) => {
        const range = formatItemRange(it);
        const cls = ["chip", it.key === focusKey ? "active" : "", it.past ? "past" : "", it.hasGuide ? "" : "noguide"]
          .filter(Boolean)
          .join(" ");
        return (
          <Link key={it.key} href={`/reservoir/${it.area}${q}`} className={cls} title={it.label}>
            <div className="loc">{it.label}</div>
            {range && <div className="date">{range}</div>}
          </Link>
        );
      })}
    </nav>
  );
}

export default async function ReservoirPage({
  params,
  searchParams,
}: {
  params: Promise<{ area: string }>;
  searchParams: Promise<{ past?: string }>;
}) {
  await requireAllowedUser();
  const { area } = await params;
  const showPast = (await searchParams).past === "1";

  const [{ items, today }, reservoir] = await Promise.all([listRibbon(), getReservoir(area)]);
  const focus = focusItem(items, area, today) as RibbonItem | null;
  // Every stay this guide covers ("City A 3/1-3/10 · City B 3/10-3/15 · …").
  const mine = items.filter((it) => it.area === area);
  const visits = mine
    .filter((it) => showPast || !it.past || mine.every((m) => m.past))
    .map((it) => {
      const r = formatItemRange(it);
      const name = reservoir && it.label !== reservoir.label ? `${it.label} ` : "";
      return r ? `${name}${r}` : null;
    })
    .filter(Boolean)
    .join(" · ");

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

      {items.length > 0 && (
        <AreaNav items={items} current={area} focusKey={focus?.key ?? null} showPast={showPast} />
      )}

      {reservoir?.structured ? (
        <main className="daywrap daywrap-wide">
          <div className="day-frame">
            <h1 style={{ fontSize: "1.5rem", margin: "0.2rem 0 0.1rem" }}>{reservoir.label}</h1>
            {visits && <div className="res-range">{visits}</div>}
            <ReservoirList structured={reservoir.structured} />
          </div>
        </main>
      ) : focus ? (
        <main className="empty">
          <h2>{prettyMetro(area)}</h2>
          {visits && <p>{visits}</p>}
          <p>
            The guide for this stop isn&apos;t built yet. Guides are researched automatically about a
            month before arrival.
          </p>
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
