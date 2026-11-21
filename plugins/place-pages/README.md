# Place pages

A wiki page for every public place you spend time at (cafés, restaurants, bars,
lounges, hotels and rentals, shops, museums, theaters, parks…), with every visit,
who came, and every photo you took there.

## What it does

Every morning (11:17) it re-reads the last week of your days as you corrected
them (`live-day day <date>`) and takes every stop of 15 minutes or more whose name
is settled: you named it, it was booked, it is one of your saved places, the sign
in your photo read it, or the map was at least 90% sure (those visits say
"name from the map"). Each stop is matched to a place:

- the same name within 400 m is the same place (code);
- anything else goes to a model, in batches: is it a place already known under
  another name nearby, what kind of place it is, and is there already a wiki
  page about it. Homes (yours and other people's), offices, doctors, transit and
  things that are not one place never get a page; they are remembered so they are
  not asked about again.

A restaurant or museum keeps the shows-seen tracker's page (created through the
tracker when shows-seen is on). Anything else adopts the existing page the model
found, or gets `place_<slug>`. The plugin writes only between
`<!-- place-pages:start -->` and `<!-- place-pages:end -->`.

**Photos are linked, never copied.** A photo lives once in the photo repository
(its `photos` row and one thumbnail); `photo_links` records each page that shows
it. The photos of a visit are your own camera shots the day attached to that
stop, minus screenshots, received photos, documents and receipts. The cover is the
one you pinned, else a favorite, else the newest without people.

Because each run re-sweeps the past week, renaming a stop moves that day's photos
to the right page on the next run. A stop that runs through the small hours
(2–5am local) at a daytime kind of place (café, bakery, restaurant, shop…) is not
counted as a visit: it is a night nearby that the day named after the place.

## Using the photos

- "Where was this?" cards show each candidate place's cover beside its option
  (`bin/choice`, through `bin/photo-repo place-covers`).
- "How was it?" cards about a restaurant or museum show its cover
  (`bin/decision-ask`); `hum-ask --page <id>` does the same for a hum question.
- The chat agent shows a place with `place-pages cover "<name>"`.

## Commands

```bash
place-pages sweep [--date D | --from D --to D] [--apply]   # dry run without --apply
place-pages backfill --apply                                # the whole archive, once
place-pages list [--kind cafe] [--private]
place-pages show "<name or page id>"
place-pages cover "<name>" [--near LAT,LON]
place-pages render <place id|page id>
place-pages set-kind <place id> <kind>
place-pages rename <place id> "<name>"                     # the old name stays an alias
photo-repo for <page id> | uses <uuid> | pin-cover <page id> <uuid>
```

## Turning it on

Needs the `0191_places_photo_links` migration (`jori-migrate --only 0191 --apply --project <ref>`).
Then `jori plugin enable place-pages`, put your homes and properties in
`agent/local/config/place-pages.json` → `exclude_names`, and run
`place-pages backfill --apply` once.

## Settings

`agent/local/config/place-pages.json`; every key is described in
`config.defaults.json` (`_doc`).
