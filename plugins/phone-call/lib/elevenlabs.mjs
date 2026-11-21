// elevenlabs.mjs — the ElevenLabs Agents adapter of the phone-call plugin. One
// agent is configured once (`phone-call setup elevenlabs`: tools, turn-taking,
// voice model, privacy, which fields a call may override); each call then
// overrides the prompt, first message, language and length. Pure: no network,
// no secrets. API reference: elevenlabs.io/docs/eleven-agents/api-reference.
//
// Claude is the agent's LLM. With the user's own Anthropic key (stored as an
// ElevenLabs workspace secret at setup) the agent calls Anthropic's
// OpenAI-compatible endpoint as a custom LLM, so the model is billed to that
// key; without one, ElevenLabs bills the same model itself.

export const NAME = "elevenlabs";
export const BASE = "https://api.elevenlabs.io";
export const ANTHROPIC_OPENAI_COMPAT = "https://api.anthropic.com/v1";

// How the agent stays quiet while on hold.
export const SILENCE = "Use the skip-turn tool to stay silent until a live person speaks.";

export function authHeaders(key) {
  return { "xi-api-key": key, "Content-Type": "application/json" };
}

const sys = (name, params = {}) => ({ type: "system", name, description: "", params: { system_tool_type: name, ...params } });

// agentBody({ cfg, secretId }) → the body of POST /v1/convai/agents/create (and PATCH).
//   secretId: the workspace secret holding the user's Anthropic key, or null.
export function agentBody({ cfg, secretId }) {
  const builtIn = {
    end_call: sys("end_call"),
    play_keypad_touch_tone: sys("play_keypad_touch_tone", { suppress_turn_after_dtmf: false, use_out_of_band_dtmf: true }),
    skip_turn: sys("skip_turn", { wait_timeout_secs: -1 }),
    voicemail_detection: sys("voicemail_detection", { voicemail_message: "{{voicemail}}" }),
  };
  if (cfg.owner_number) {
    builtIn.transfer_to_number = sys("transfer_to_number", {
      transfers: [],
      enable_client_message: true,
      transfer_rules: [{
        condition: "A live representative is on the line and ready, on a hold call.",
        provider_configs: [{ type: "twilio", config: { type: "twilio_warm_conference_transfer", transfer_destination: { type: "phone", destination: cfg.owner_number } } }],
      }],
    });
  }
  const prompt = { prompt: "You are a phone assistant. Your instructions arrive with each call.", temperature: 0.3, built_in_tools: builtIn };
  if (secretId) {
    prompt.llm = "custom-llm";
    prompt.custom_llm = { url: ANTHROPIC_OPENAI_COMPAT, model_id: cfg.model, api_key: { secret_id: secretId } };
  } else {
    prompt.llm = cfg.model;
  }
  return {
    name: "phone-call",
    conversation_config: {
      agent: { first_message: "", language: "en", prompt },
      tts: { model_id: cfg.voice.model, voice_id: cfg.voice.voice_id },
      turn: { turn_model: "turn_v3", turn_eagerness: "normal", turn_timeout: 7, silence_end_call_timeout: -1 },
      conversation: { max_duration_seconds: 600 },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: true },
          conversation: { max_duration_seconds: true },
        },
      },
      privacy: { record_voice: false },
    },
  };
}

// callBody(plan, cfg) → the body of POST /v1/convai/twilio/outbound-call.
export function callBody(plan, cfg) {
  const e = cfg.elevenlabs || {};
  return {
    agent_id: e.agent_id,
    agent_phone_number_id: e.phone_number_id,
    to_number: plan.to,
    call_recording_enabled: false,
    conversation_initiation_client_data: {
      conversation_config_override: {
        // The fixed opener is not sent as first_message: ElevenLabs would say it
        // the moment the line connects. The prompt tells the model to open with it
        // once the other side has spoken.
        agent: { prompt: { prompt: plan.prompt }, first_message: "", language: plan.language },
        tts: { voice_id: cfg.voice.voice_id },
        conversation: { max_duration_seconds: plan.maxSeconds },
      },
      dynamic_variables: { voicemail: plan.voicemail || "" },
    },
  };
}

const STATUS = { initiated: "ringing", "in-progress": "in-progress", processing: "ending", done: "ended", failed: "ended" };

// normalize(conversation) → the plugin's result shape (see vapi.mjs).
export function normalize(c, { assistant = "Assistant" } = {}) {
  const m = c.metadata || {};
  const phone = m.phone_call || {};
  const status = STATUS[c.status] || c.status || "unknown";
  const transcript = (c.transcript || [])
    .filter((t) => t && t.message)
    .map((t) => `${t.role === "agent" ? assistant : "Them"}: ${t.message}`)
    .join("\n");
  return {
    id: c.conversation_id,
    provider: NAME,
    status,
    ended: status === "ended",
    answered: status === "ended" ? (phone.call_result ? phone.call_result === "answered" : (c.transcript || []).some((t) => t.role === "user")) : null,
    ended_reason: m.termination_reason || phone.call_result || (c.status === "failed" ? "failed" : null),
    transcript,
    summary: (c.analysis && c.analysis.transcript_summary) || "",
    duration_s: typeof m.call_duration_secs === "number" ? m.call_duration_secs : null,
    cost: typeof m.cost_fiat === "number" ? m.cost_fiat : null,
    recording: c.has_audio === true,
    call_sid: phone.call_sid || null,
  };
}

export function secretBody(anthropicKey) {
  return { type: "new", name: "phone-call-anthropic", value: anthropicKey };
}

export function importNumberBody({ number, accountSid, authToken }) {
  return { provider: "twilio", label: "phone-call", phone_number: number, sid: accountSid, token: authToken, enable_sms: false };
}
