"use client";

import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  async function signOut() {
    await createClient().auth.signOut();
    window.location.assign("/login");
  }
  return (
    <button className="signout" onClick={signOut}>
      Sign out
    </button>
  );
}
