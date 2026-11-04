"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/config";

/**
 * Starred sailings — the list the weekly email watches.
 *
 * Written from the browser with the signed-in user's own JWT rather than
 * through a server action, because a star has to feel instant: the toggle is
 * optimistic and this call settles behind it. RLS on `cruise_favorites` is what
 * actually authorizes the write (per-user, per-email), so the anon key here
 * grants nothing the policy does not already allow — and a user can only ever
 * touch their own rows, which is deliberate: each person keeps a separate
 * list, because "watch this one" is a per-person opinion.
 */
function client() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/** @returns true if the write landed; false if it was rejected or the network failed. */
export async function setFavorite(sailingId: string, email: string, on: boolean): Promise<boolean> {
  const supabase = client();
  try {
    if (on) {
      const { error } = await supabase
        .from("cruise_favorites")
        .upsert({ sailing_id: sailingId, user_email: email }, { onConflict: "sailing_id,user_email" });
      return !error;
    }
    const { error } = await supabase
      .from("cruise_favorites")
      .delete()
      .eq("sailing_id", sailingId)
      .eq("user_email", email);
    return !error;
  } catch {
    return false;
  }
}
