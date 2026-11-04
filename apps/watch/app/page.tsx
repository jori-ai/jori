import Link from "next/link";
import { requireAllowedUser } from "@/lib/auth";
import { getCounts, getNotForUs, getRated, getWatchNow } from "@/lib/data";
import WatchNow from "@/components/WatchNow";
import { nextBatch } from "@/lib/model";
import SignOutButton from "@/components/SignOutButton";
import BatchMarker from "@/components/BatchMarker";
import Search from "@/components/Search";
import RatedList from "@/components/RatedList";
import NotForUsList from "@/components/NotForUsList";

export const dynamic = "force-dynamic";

const TABS = [
  { id: "mark", label: "Mark films" },
  { id: "watch", label: "Watch now" },
  { id: "search", label: "Search" },
  { id: "rated", label: "What we've seen" },
  { id: "skip", label: "Not our thing" },
] as const;

async function Mark() {
  const { picks, labels, acc } = await nextBatch();
  return (
    <>
      <div className="model-line">
        Learning from {labels} titles{acc.n >= 5 ? ` · guessed ${Math.round((100 * acc.hit) / acc.n)}% of your last ${acc.n} marks` : ""}
      </div>
      <BatchMarker picks={picks} labels={labels} />
    </>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: raw } = await searchParams;
  const tab = TABS.some((t) => t.id === raw) ? raw! : "mark";
  await requireAllowedUser(tab === "mark" ? "/" : `/?tab=${tab}`);
  const counts = await getCounts();

  return (
    <>
      <header className="topbar">
        <div className="brand">🎬 What we watched</div>
        <SignOutButton />
      </header>
      <main className={`wrap${tab === "mark" ? " wide" : ""}`}>
        <div className="stats">{counts.seen} seen · {counts.notSeen} not seen · {counts.notForUs} not our thing · {counts.left} left to mark</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <Link key={t.id} href={t.id === "mark" ? "/" : `/?tab=${t.id}`} className={t.id === tab ? "on" : ""}>{t.label}</Link>
          ))}
        </nav>
        {tab === "mark" && <Mark />}
        {tab === "watch" && <WatchNow films={await getWatchNow()} />}
        {tab === "search" && <Search />}
        {tab === "rated" && <RatedList films={await getRated()} />}
        {tab === "skip" && <NotForUsList films={await getNotForUs()} />}
      </main>
    </>
  );
}
