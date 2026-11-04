// email-inbound — Cloudflare Email Worker.
// Bound to the agent's own address(es) via Email Routing rules (the worker name
// and routes live in this installation's wrangler.toml). Parses incoming mail
// and POSTs structured JSON to the Jori supervisor's :9090 /email-inbound
// endpoint, reached via a Cloudflare Tunnel hostname (env.WEBHOOK_URL). The
// supervisor authenticates on the X-Inbound-Secret header.
import PostalMime from "postal-mime";
import { senderAuth } from "./sender-auth.js";

const MAX_RAW_BYTES = 512 * 1024;

function bulkHeaders(headers) {
  const get = (name) => {
    const h = (headers || []).find((x) => String(x.key || "").toLowerCase() === name);
    return h ? String(h.value || "").trim() : null;
  };
  return {
    list_unsubscribe: Boolean(get("list-unsubscribe")),
    list_id: Boolean(get("list-id")),
    auto_submitted: get("auto-submitted"),
    precedence: get("precedence"),
  };
}

export default {
  async email(message, env, ctx) {
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject(`message exceeds ${MAX_RAW_BYTES} bytes`);
      return;
    }
    const parsed = await new PostalMime().parse(message.raw);

    const payload = {
      message_id: parsed.messageId || null,
      from: parsed.from?.address || message.from,
      from_name: parsed.from?.name || null,
      to: (parsed.to || []).map((a) => a.address).filter(Boolean),
      cc: (parsed.cc || []).map((a) => a.address).filter(Boolean),
      subject: parsed.subject || "",
      text: parsed.text || "",
      in_reply_to: parsed.inReplyTo || null,
      references: parsed.references || null,
      received_at: new Date().toISOString(),
      envelope: { from: message.from, to: message.to },
      auth: senderAuth(parsed.headers, parsed.from?.address || message.from),
      // Bulk/automation header presence. The supervisor holds mail
      // from an unknown PERSON for the user to approve (lib/email-inbound-
      // gate.mjs § Held mail) and drops newsletters/robots as before; these
      // headers are how it tells them apart, never the content.
      bulk: bulkHeaders(parsed.headers),
    };

    const res = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Inbound-Secret": env.INBOUND_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`webhook ${res.status}: ${body.slice(0, 200)}`);
    }
  },
};
