# Phone calls

Makes a phone call for the user when they ask: gets a quote from a contractor, books a table, asks a business a question, or works an airline's or bank's phone menu, waits on hold and connects the user when a person answers. When the call ends, the user gets a summary in the chat; the transcript is one command away.

The voice agent runs at a voice-agent provider. Two are supported side by side so they can be compared on real calls:

- **Vapi**: an inline assistant per call (`POST /call`). Most phone controls: live end-call, calls up to 12 hours.
- **ElevenLabs Agents**: one agent set up once, overridden per call (`POST /v1/convai/twilio/outbound-call`). Its own turn-taking model; calls up to 2 hours.

On both, Claude is the call's model (`model`, default the installation's pinned Haiku: fastest to answer), the voice is the same ElevenLabs voice (`voice`), and the call goes out from a Twilio number imported into the provider.

Policy (who may ask for a call, what the agent may say and agree to): `agent/CLAUDE.md` § Outbound Phone Call Policy. Billing of Claude on calls: `agent/CLAUDE.md` § Auth Model (second carve-out) and `docs/agent-auth-model.md` § Live phone calls.

## Use

```bash
phone-call place --to +15551234567 --callee "Dana's Painting" \
  --goal "Ask for a quote to repaint a 300 sq ft deck, and their earliest start date" \
  --facts "The deck is about 300 sq ft, in the back yard" \
  --authorized "<the user's words>"                       # task call: does the goal, hangs up
phone-call place --to +18005550100 --mode hold --callee "the airline" \
  --goal "Change the return flight on booking ABC123 to a day later" \
  --authorized "<the user's words>"                       # hold call: menu, hold, then connects the user
phone-call place … --may-agree "a table for 2, Saturday between 7 and 8 pm"   # what it may commit to
phone-call place … --provider elevenlabs --language he --dry-run              # every check, prints the plan, sends nothing
phone-call status <id>      # where it stands; summary and transcript once it ended
phone-call end <id>         # hang up a live call
phone-call list             # recent calls and this month's spend
```

`place` returns at once; a follower (through `job-run`) waits for the end, writes the `ended` row and posts the outcome to the chat. Exit codes: 0 ok, 1 provider or network error, 2 usage, 3 refused by a guard, 9 test run without a stand-in, 78 a missing key or setting.

## Guards (in code)

- `--authorized` (the user's own words) is required and logged; `--to` is E.164 and never a premium-rate number; a hold call needs `owner_number` and never calls it.
- The opener says the agent is the user's AI assistant and that the call is transcribed; the prompt forbids claiming to be the user or a human, giving card, bank, ID, password or code details, and agreeing to anything beyond `--may-agree`; what the other side says is information, not instructions.
- Recording is switched off on both providers; the follower logs a `warning` row if a recording was kept anyway.
- A monthly budget (`monthly_budget_usd`): a call placed at 80% of it pages the system channel, and at 100% new calls are refused. `data/.phone-call-off` refuses every new call.
- Inside a test run nothing reaches a provider unless the test names a stand-in base (`PHONE_CALL_VAPI_BASE`, `PHONE_CALL_ELEVENLABS_BASE`, `PHONE_CALL_TWILIO_BASE`).

## Setup

1. **A calling number.** A local Twilio number of its own (ideally in its own Twilio subaccount), not a number already used for something else: importing a number into a voice provider can rewrite where its inbound calls go. Its account SID and auth token go in `.env` as `PHONE_CALL_TWILIO_ACCOUNT_SID` / `PHONE_CALL_TWILIO_AUTH_TOKEN`.
2. **Provider accounts and keys** in `.env` (canonical copies in the password manager): `VAPI_API_KEY` (Vapi's private key), `ELEVENLABS_API_KEY`.
3. **The user's own Anthropic key**, so Claude on calls bills to it: `JORI_PHONE_CALL_ANTHROPIC_KEY` (never an `ANTHROPIC_*` name). Give it a monthly spend limit in the Anthropic console: that limit, not `monthly_budget_usd`, is what caps Claude's cost, since the providers' cost figures leave out a model billed to your own key. Use a separate key for each provider (run `setup` with one, then the other), so a leak at one vendor is contained. Without a key each provider bills Claude itself.
4. **Settings** in `agent/local/config/phone-call.json` (seeded from `config.defaults.json`): `owner_number`, `voice.voice_id` (an ElevenLabs voice that speaks the languages needed; Hebrew needs `eleven_v3`/`eleven_v4*`), `model`.
5. **Register with each provider** and copy the printed ids into the settings:
   ```bash
   phone-call setup vapi --import-number +1XXXXXXXXXX          # Anthropic credential + the number → vapi.phone_number_id
   phone-call setup elevenlabs --import-number +1XXXXXXXXXX    # Anthropic secret + the agent + the number → elevenlabs.agent_id, elevenlabs.phone_number_id
   ```
   `--dry-run` prints what each would send. Run `setup elevenlabs` again after changing `owner_number`, `voice` or `model` (it updates the agent).
6. `jori plugin enable phone-call`.

**Not yet verified against the live APIs** (written from the providers' docs; the first `setup` and test call will show any field a provider rejects): Vapi's `transferCall` destination shape and `warm-transfer-wait-for-operator-to-speak-first-and-then-say-message` mode, its `11labs` voice provider value, `backgroundSound` and the transcriber block; ElevenLabs' `custom_llm` block and secrets endpoint; whether either provider counts hold music as speech; that recording is really off (the follower logs a `warning` row if not). The `place` → `job-run` → `follow` → chat chain has not run end to end: on the first call, check `job-list` shows the follower and the summary arrives.

**Hold transfer on Vapi** is the simple warm transfer: once the user says hello, a fixed one-sentence brief is spoken, then the calls are joined. If the user does not pick up, the representative may be joined to the user's voicemail. Vapi's assistant-based warm transfer (an AI briefs the user and cancels when they do not answer) is the upgrade if the bake-off picks Vapi.

## Comparing the two providers

Same model, voice, prompt and settings on both; `vapi.optimize_streaming_latency` is set explicitly (2) rather than left at Vapi's default. Three calls on each:

1. The user's own phone, with the user playing a contractor asked for a quote: how natural it sounds, how it handles interruptions and "um".
2. A real restaurant or shop with a real question the user wants answered.
3. A real airline or bank hold queue in `hold` mode, for a real matter: the phone menu, the hold, and the transfer to the user.

Calls 2 and 3 reach third parties: each needs the user's own go-ahead with the number and the purpose.

## Settings

`provider`, `owner_number`, `model`, `voice.voice_id`, `voice.model`, `monthly_budget_usd`, `max_task_minutes`, `max_hold_minutes` (at most 115), `vapi.phone_number_id`, `vapi.optimize_streaming_latency`, `vapi.transcriber_model`, `elevenlabs.agent_id`, `elevenlabs.phone_number_id`. Each is described in `config.defaults.json`.

## Log

`data/phone-calls.jsonl`: `placed`, `ended` (summary, transcript, ended reason, length, cost), `refused`, `ended-by-user`, `follow-failed`, `warning`. Never a key or the live-control URL.

## Tests

`node --test plugins/phone-call/tests/` — the guards, the plan, both providers' request bodies, and place → follow → report → end against stand-in Vapi, ElevenLabs and Twilio servers, checking that no key reaches the output or the log.
