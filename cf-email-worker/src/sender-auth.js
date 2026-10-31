// Sender authentication, from the Authentication-Results header Cloudflare's
// MX (authserv-id mx.cloudflare.net) PREPENDS on receipt. Only the topmost
// header with that authserv-id counts — a sender can inject their own
// "Authentication-Results: mx.cloudflare.net; dkim=pass" lower down, but not
// above the receiving server's. `aligned` = DMARC pass for the From domain, or
// a DKIM pass signed by the From domain itself. A path that releases private
// figures by email (e.g. a family Q&A) refuses any message that is not
// aligned; a From header alone is forgeable.
const AUTHSERV = "mx.cloudflare.net";
export function senderAuth(headers, fromAddr) {
  const fromDomain = String(fromAddr || "").split("@").pop().toLowerCase();
  const results = (headers || [])
    .filter((h) => /^(arc-)?authentication-results$/i.test(h.key))
    .map((h) => String(h.value).replace(/\s+/g, " "));
  // Only the TOPMOST result counts, and it must be Cloudflare's. This relies on
  // Cloudflare's MX actually prepending one — VERIFY with a real message after
  // deploy (payload.auth.raw); if it does not, an injected header would sit on
  // top and this check must be replaced by real DKIM verification (mailauth).
  // ARC-Authentication-Results starts with "i=N;" before the authserv-id.
  const top = results[0] || "";
  const ours = top.replace(/^i=\d+;\s*/, "").trim().toLowerCase().startsWith(AUTHSERV) ? top : null;
  if (!ours) return { aligned: false, from_domain: fromDomain, raw: results.slice(0, 3) };
  const pick = (method) => {
    const m = ours.match(new RegExp(`\\b${method}=(\\w+)([^;]*)`, "i"));
    return m ? { result: m[1].toLowerCase(), props: m[2] } : null;
  };
  const prop = (r, name) => (r && (r.props.match(new RegExp(`${name}=([^\\s;]+)`, "i")) || [])[1] || "").toLowerCase().replace(/^@/, "");
  const dkim = pick("dkim"), dmarc = pick("dmarc"), spf = pick("spf");
  const dkimDomain = prop(dkim, "header\\.d") || prop(dkim, "header\\.i").split("@").pop();
  const dmarcFrom = prop(dmarc, "header\\.from");
  const aligned =
    (dmarc?.result === "pass" && dmarcFrom === fromDomain) ||
    (dkim?.result === "pass" && dkimDomain === fromDomain);
  return { aligned, from_domain: fromDomain, dkim: dkim?.result || null, dkim_domain: dkimDomain || null, dmarc: dmarc?.result || null, spf: spf?.result || null, raw: [ours] };
}
