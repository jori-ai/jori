"use client";

import { useState } from "react";
import { PEOPLE, VERDICTS, type Person, type Verdict } from "@/lib/types";

/** One row per viewer, each picking how much they liked it. */
export default function RatePanel({
  initial = {},
  busy,
  onSave,
  onCancel,
}: {
  initial?: Partial<Record<Person, Verdict>>;
  busy?: boolean;
  onSave: (r: Partial<Record<Person, Verdict>>) => void;
  onCancel?: () => void;
}) {
  const [r, setR] = useState<Partial<Record<Person, Verdict>>>(initial);
  return (
    <div className="rate">
      {PEOPLE.map(({ p, name }) => (
        <div className="rate-row" key={p}>
          <span className="rate-who">{name}</span>
          <div className="chips">
            {VERDICTS.map(({ v, label, emoji }) => (
              <button key={v} type="button" className={`chip${r[p] === v ? " on" : ""}`} onClick={() => setR({ ...r, [p]: v })}>
                <span aria-hidden>{emoji}</span> {label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="rate-actions">
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}
        <button type="button" className="primary" disabled={busy || !PEOPLE.some(({ p }) => r[p])} onClick={() => onSave(r)}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
