# Rental cars

Finds the best-value rental car for one rental when the user asks ("find me a car at the airport for the week before the flight home"). It reads the user's rental-car preferences from memory, searches the comparison sites first (carrentals.com, rentalcars.com; kernel-guard-ok: public sites this plugin reads), then the rental companies directly, compares **all-in** totals for the preferred classes at mainstream companies, and replies with one pick, the runners-up and the link. It never reserves.

- **Turn on:** `jori plugin enable car-rental` (or the control room's Plugins page).
- **Run:** `jori dispatch car-rental --task "DEN, pickup Mar 5 9pm, return Mar 15 9am"`. From chat: point the chat agent at that command in its local rules (`jori tasks match` does not list plugin tasks yet, and `jori tasks run` would drop the place and dates).
- **Preferences:** in memory, not here: the wiki page named by `preferences_page` (default `travel_car_rental_preferences`) holds the car classes, the companies that count and how loyalty status weighs.
- **Settings:** `agent/local/config/car-rental.json` (defaults in `config.defaults.json`): the preferences page, the order of aggregators and direct sites, fallback company/class filters, the driver age entered on forms, the late-return grace.
- **Needs:** the ops agent's Chrome (`"chrome": true` pins the job to ops), `bin/wiki`.
- **Command:** `plugins/car-rental/bin/car-rental settings | days … | links …` builds the billing-day count and the filtered, price-sorted aggregator links; the playbook (`jobs/car-rental.md`) does the reading and the choice.
- **Tests:** `node --test plugins/car-rental/tests/`.

Things the playbook guards against: off-brand operators that undercut everyone and are filtered out; direct prices shown before taxes and airport fees (Avis's "vehicle total rate") next to totals that include them (Hertz, the aggregators); and an aggregator's pay-later rate that can beat the company's own pay-now rate.
