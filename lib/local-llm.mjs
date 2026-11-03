// Local LLM helper — wraps Ollama running on the same host.
// Default model: gemma3:1b (~815MB on disk; lowered from gemma4:e2b on
// 2026-06-19 to reclaim ~6GB of RAM on the host — see DEFAULT_MODEL note).
// Use for quick, low-stakes tasks where the Max/API path would be wasteful
// (short acks, classifications, one-shot rewrites). Long-running or
// high-quality work still belongs on the agents.
//
// Ollama runs at http://127.0.0.1:11434 by default. Install with
// `brew install ollama` and pull the model with `ollama pull gemma3:1b`.
// Set OLLAMA_URL or LOCAL_LLM_MODEL env vars to override.
//
// keep_alive controls how long Ollama keeps the model resident after a call.
// Lowered from "24h" to "15m" on 2026-06-17 (cost re-architecture): the 24h pin
// held gemma4:e2b (~7.7GB) in RAM around the clock, starving the three Claude
// supervisors (ops/ops-light/ops-haiku) on the RAM-constrained host. 15m keeps
// the model warm through normal daytime gaps — acks and the frequent per-inbound
// email local-classify both reset the timer — but lets it unload during genuine
// idle, notably the overnight heavy-job window (01:30–08:00) when email is quiet
// and the Opus jobs want the RAM. Cold-load after idle is graceful by design:
// the phone-channel ack layer falls back to its canned rotation on timeout, and
// local-classify fail-opens to a normal dispatch. Override via OLLAMA_KEEP_ALIVE.
//
// think: left unset here so Ollama's per-model default wins (Gemma 4 ships
// with thinking on, which is fine — inference is local/free and reasoning
// helps quality). Callers on a tight token budget (e.g. 40-token acks)
// should pass `think: false` explicitly, otherwise the thinking preamble
// eats the whole budget and `content` comes back empty.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
// gemma3:1b (~815MB on disk, ~1.5GB resident) replaced gemma4:e2b (~7.7GB
// resident) on 2026-06-19 to reclaim RAM on the swap-constrained host — the
// E2B model was pinning ~7.7GB around the clock for what is overwhelmingly
// short phone-ack generation + a rare location-confirm JSON classify, both of
// which the 1B handles fine (verified). Override via LOCAL_LLM_MODEL.
const DEFAULT_MODEL = process.env.LOCAL_LLM_MODEL || "gemma3:1b";
// How long Ollama keeps the model resident after a call (see header note).
const DEFAULT_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "15m";

// Gemma 4 recommended sampling (from model card on ollama.com/library/gemma4).
const GEMMA_DEFAULTS = { temperature: 1.0, topP: 0.95, topK: 64 };

export async function localLlmChat({
  system,
  messages,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 200,
  numCtx = 8192,
  temperature = GEMMA_DEFAULTS.temperature,
  topP = GEMMA_DEFAULTS.topP,
  topK = GEMMA_DEFAULTS.topK,
  timeoutMs = 5000,
  keepAlive = DEFAULT_KEEP_ALIVE,
  think,
} = {}) {
  const chat = [];
  if (system) chat.push({ role: "system", content: system });
  if (messages) chat.push(...messages);
  if (user) chat.push({ role: "user", content: user });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: chat,
        stream: false,
        keep_alive: keepAlive,
        ...(think !== undefined ? { think } : {}),
        options: {
          num_ctx: numCtx,
          num_predict: maxTokens,
          temperature,
          top_p: topP,
          top_k: topK,
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json?.message?.content || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export const LOCAL_LLM_DEFAULT_MODEL = DEFAULT_MODEL;

// Embedding helper — Ollama's /api/embeddings. Default model: nomic-embed-text
// (768 dims), which is fast and good enough for semantic recall over short
// conversational messages. Matches the pgvector column dimension in
// data/migrations/20260417_jori_messages_pgvector.sql — keep the two
// in sync if the model changes. Returns a plain Array<number>, or throws.
const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || "nomic-embed-text";

// nomic-embed-text is an UNCASED model (bert-base-uncased WordPiece vocab), and
// its reference tokenizer lowercases and strips accents before lookup. Ollama
// (seen on 0.20.7) does neither, so every word with a capital letter became
// [UNK]: two different two-word names embedded to the SAME vector, as did any
// two capitalised single words, and heading cues of the form
// "<Title> — <Heading>" collapsed onto a handful of vectors. Names, titles
// and headings carried no meaning at all, so a question naming one person
// ranked every page sharing a first name above that person's own page (see
// system/changelog.md, 2026-11-03). Normalising here, the one
// call every embedder in the repo goes through, is the reference tokenizer's
// own first step; it is the same for documents and queries, so stored vectors
// and query vectors stay comparable once re-embedded.
const UNCASED_EMBED_MODELS = /^(nomic-embed-text|all-minilm)(:|$)/; // lang-regex-ok: model id
export function embedText(input, model = EMBED_MODEL) {
  const s = String(input ?? "");
  if (!UNCASED_EMBED_MODELS.test(String(model))) return s;
  return s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, ""); // lang-regex-ok: BERT uncased accent strip
}

// Ollama answers 500 "the input length exceeds the context length" when the
// text is too long for the model. Normalised text tokenises LONGER than raw
// text did (a capitalised word used to be one [UNK]; now it is its real word
// pieces), so this is common. The head of a text carries its retrievable gist,
// so halve and retry rather than fail the row.
const CONTEXT_OVERFLOW = /context length|input length|too (long|large)/i; // lang-regex-ok: Ollama error string
export async function localLlmEmbed(input, opts = {}) {
  let text = String(input ?? "");
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedOnce(text, opts);
    } catch (e) {
      if (!CONTEXT_OVERFLOW.test(String(e?.message || "")) || attempt >= 6 || text.length <= 256) throw e; // lang-regex-ok: matches an Ollama HTTP error string
      text = text.slice(0, Math.floor(text.length / 2));
    }
  }
}

async function embedOnce(input, { model = EMBED_MODEL, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: embedText(input, model) }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama embeddings ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json?.embedding)) {
      throw new Error("ollama embeddings: missing embedding array");
    }
    return json.embedding;
  } finally {
    clearTimeout(timer);
  }
}

export const LOCAL_EMBED_DEFAULT_MODEL = EMBED_MODEL;

// The label a store should record next to a vector: the model plus the
// revision of the text normalisation above (t2 = embedText). A stored vector
// with any other label was made from differently-prepared text and is not
// comparable with today's query vectors, so stores re-embed rows whose label
// differs.
export const LOCAL_EMBED_TEXT_REV = "t2";
export const localEmbedLabel = (model = EMBED_MODEL) => `${model}+${LOCAL_EMBED_TEXT_REV}`;
export const LOCAL_EMBED_LABEL = localEmbedLabel(EMBED_MODEL);

// ── Query-embedding cache ─────────────────────────────────────────────────
//
// Deliberately NOT applied inside localLlmEmbed: that function also embeds page
// and message BODIES during backfills, where every input is distinct and
// caching would just grow unboundedly for no hits.
//
// Query text is the opposite shape — hum re-checks the same subjects tick after
// tick, and auto-recall re-embeds whatever the user retypes — so a small LRU
// removes an Ollama round trip from the front of those calls. Cache the vector
// only on success; a failure must stay retryable.
const EMBED_CACHE_MAX = Number(process.env.LOCAL_EMBED_CACHE_MAX || 256);
const _embedCache = new Map();

export async function localLlmEmbedCached(input, opts = {}) {
  const key = `${opts.model || EMBED_MODEL} ${String(input || "").trim()}`;
  if (_embedCache.has(key)) {
    // Refresh recency: delete + set moves the entry to the end of the Map's
    // insertion order, which is what makes the first key an LRU victim.
    const hit = _embedCache.get(key);
    _embedCache.delete(key);
    _embedCache.set(key, hit);
    return hit;
  }
  const vec = await localLlmEmbed(input, opts);
  if (Array.isArray(vec) && vec.length) {
    _embedCache.set(key, vec);
    if (_embedCache.size > EMBED_CACHE_MAX) {
      _embedCache.delete(_embedCache.keys().next().value);
    }
  }
  return vec;
}

export function clearLocalLlmEmbedCache() {
  _embedCache.clear();
}
