// vapi.mjs — the Vapi adapter of the phone-call plugin: a call plan becomes a
// POST /call body with an inline (transient) assistant, and a Vapi call record
// becomes the plugin's normalized result. Pure: no network, no secrets.
//
// Claude is the assistant's model (provider "anthropic"); with the user's own
// Anthropic key registered as a Vapi credential (`phone-call setup vapi`), Vapi
// bills the model to that key. API reference: docs.vapi.ai/api-reference.

export const NAME = "vapi";
export const BASE = "https://api.vapi.ai";

// How the agent stays quiet while on hold (Vapi's IVR guide: reply with a space).
export const SILENCE = "To stay silent, reply with a single space and nothing else.";

export function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

// callBody(plan, cfg) → the JSON body of POST /call.
//   cfg: the merged settings (model, voice, vapi.*).
export function callBody(plan, cfg) {
  const v = cfg.vapi || {};
  const tools = [{ type: "endCall" }, { type: "dtmf" }];
  if (plan.mode === "hold") {
    tools.push({
      type: "transferCall",
      destinations: [{
        type: "number",
        number: plan.ownerNumber,
        message: "One moment please, I'm connecting them now.",
        description: "The user, once a live representative is on the line.",
        transferPlan: { mode: "warm-transfer-wait-for-operator-to-speak-first-and-then-say-message", message: plan.transferBrief },
      }],
    });
  }
  const assistant = {
    name: "phone-call",
    firstMessage: plan.firstMessage || "",
    // Always let the other side speak first: a person says hello, a phone menu
    // starts talking. With no fixed first message the model opens per the prompt.
    firstMessageMode: "assistant-waits-for-user",
    model: {
      provider: "anthropic",
      model: cfg.model,
      temperature: 0.3,
      messages: [{ role: "system", content: plan.prompt }],
      tools,
    },
    voice: {
      provider: "11labs",
      voiceId: cfg.voice.voice_id,
      model: cfg.voice.model,
      // Set on purpose, not left at Vapi's default (3), so a bake-off compares
      // platforms rather than a latency trade-off.
      optimizeStreamingLatency: Number.isInteger(v.optimize_streaming_latency) ? v.optimize_streaming_latency : 2,
    },
    transcriber: { provider: "deepgram", model: v.transcriber_model || "nova-3", language: plan.language },
    maxDurationSeconds: plan.maxSeconds,
    silenceTimeoutSeconds: plan.mode === "hold" ? 3600 : 45,
    backgroundSound: "off",
    artifactPlan: { recordingEnabled: false },
  };
  if (plan.mode === "task") {
    assistant.voicemailDetection = { provider: "vapi" };
    assistant.voicemailMessage = plan.voicemail;
  }
  return {
    name: `phone-call ${plan.mode}`.slice(0, 40),
    phoneNumberId: v.phone_number_id,
    customer: { number: plan.to, ...(plan.callee ? { name: plan.callee.slice(0, 40) } : {}) },
    assistant,
  };
}

const STATUS = { scheduled: "queued", queued: "queued", ringing: "ringing", "in-progress": "in-progress", forwarding: "in-progress", ended: "ended" };
const NOT_ANSWERED = new Set(["customer-did-not-answer", "customer-busy", "voicemail", "call.forwarding.no-answer"]);

// normalize(call) → { id, provider, status, ended, answered, ended_reason, transcript, summary, duration_s, cost, recording, control_url }
export function normalize(c) {
  const started = c.startedAt ? Date.parse(c.startedAt) : null;
  const ended = c.endedAt ? Date.parse(c.endedAt) : null;
  const artifact = c.artifact || {};
  const status = STATUS[c.status] || c.status || "unknown";
  return {
    id: c.id,
    provider: NAME,
    status,
    ended: status === "ended",
    answered: status === "ended" ? !NOT_ANSWERED.has(c.endedReason) && !!started : null,
    ended_reason: c.endedReason || null,
    transcript: artifact.transcript || c.transcript || "",
    summary: (c.analysis && c.analysis.summary) || c.summary || "",
    duration_s: started && ended ? Math.round((ended - started) / 1000) : null,
    cost: typeof c.cost === "number" ? c.cost : null,
    recording: !!(artifact.recordingUrl || artifact.stereoRecordingUrl || c.recordingUrl),
    control_url: (c.monitor && c.monitor.controlUrl) || null,
  };
}

// Setup bodies: the user's Anthropic key as Vapi's credential for the model,
// and a Twilio number imported for outbound calls.
export function credentialBody(anthropicKey) {
  return { provider: "anthropic", apiKey: anthropicKey, name: "phone-call" };
}

export function importNumberBody({ number, accountSid, authToken }) {
  return { provider: "twilio", number, twilioAccountSid: accountSid, twilioAuthToken: authToken, name: "phone-call", smsEnabled: false };
}
