"use server";

import { revalidatePath } from "next/cache";
import { requireAllowedUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ReservoirEntry, ReservoirStructured } from "@/lib/reservoirs";

// Set one entry's state — "open" | "done" | "skipped" — from the site.
//
// Why this exists: the nightly `trip-reservoir-mark-done` sweep can't be
// complete. Food specialties are a dish, not a place, so no proximity rule can
// ever mark them; and the sweep both misses visits and over-strikes drive-bys
// (it's deliberately tuned loose). So each entry has a done/undone button for
// when the automatic sweep missed it or marked it wrongly, plus a red "Skip" pill
// for a place or activity the travellers don't want to visit — that's state
// "skipped", which the guide keeps but greys out, and which the research
// carry-forward preserves so a skipped place never gets re-suggested.
//
// Anything set here is stamped `manual: true`, which the sweep treats as
// authoritative and never overrides — otherwise un-marking a false positive
// would silently revert on the next run and the button would look broken.
//
// Auth: runs server-side with the user's own JWT (never the service-role key),
// so the trip_reservoirs RLS policies are what actually authorize the write.
// requireAllowedUser() is belt-and-braces on top of that.

type EntryState = "open" | "done" | "skipped";

function entryKey(e: ReservoirEntry): string {
  return e.id || e.name || e.dish || e.best_place || "";
}

export async function setEntryState(area: string, key: string, state: EntryState) {
  await requireAllowedUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("trip_reservoirs")
    .select("structured")
    .eq("area", area)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "area not found" };

  const structured = data.structured as ReservoirStructured;
  let hit: ReservoirEntry | null = null;
  for (const arr of Object.values(structured.buckets || {})) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (entryKey(e) === key) { hit = e; break; }
    }
    if (hit) break;
  }
  if (!hit) return { ok: false, error: "entry not found" };

  // manual:true on every set so the nightly sweep never overrides a choice made
  // here (an un-mark that reverted overnight would read as a broken button).
  hit.manual = true;
  if (state === "done") {
    hit.state = "done";
    hit.done_at = new Date().toISOString();
    hit.done_date = new Date().toISOString().slice(0, 10);
    hit.done_source = "manual";
    hit.done_evidence = "marked done on the site";
    delete hit.skip_reason;
  } else if (state === "skipped") {
    hit.state = "skipped";
    hit.skip_reason = "skipped on the site";
    delete hit.done_at;
    delete hit.done_date;
    delete hit.done_source;
    delete hit.done_evidence;
  } else {
    hit.state = "open";
    delete hit.done_at;
    delete hit.done_date;
    delete hit.done_source;
    delete hit.done_evidence;
    delete hit.skip_reason;
  }

  const { error: upErr } = await supabase
    .from("trip_reservoirs")
    .update({ structured, updated_at: new Date().toISOString() })
    .eq("area", area);
  if (upErr) return { ok: false, error: upErr.message };

  revalidatePath(`/reservoir/${area}`);
  return { ok: true };
}
