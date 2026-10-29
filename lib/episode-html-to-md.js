// episode-html-to-md.js — convert the styled HTML narrative emitted by the
// daily-summary job into clean markdown suitable for a wiki page body.
//
// The daily/weekly/monthly summary jobs write `daily_summaries.narrative`
// (and weekly/monthly equivalents) as an HTML fragment styled for email
// rendering: an outer `<div style="…">` wrapper, `<h1>` / `<h2>` headings,
// `<div class="visit">` blocks for each stop, muted `<p style="color:#888">`
// travel-narration lines, inline `<img>` thumbnails, and a few utility
// tags (`<b>`, `<em>`, `<i>`, `<strong>`, `<code>`, `<ul>`, `<li>`).
//
// We ingest these into the wiki as `type: day | week | month` pages so
// they share the FTS index, `[[wikilink]]` graph, and revision history
// with permanent memories. The wiki renderer escapes raw HTML, so the
// narrative has to be markdown — that's also what makes wikilinks +
// auto-link-audit work cleanly.
//
// The converter is intentionally narrow: it handles exactly the tag set
// the summary job emits and treats anything unexpected as plain text.
// No DOM parser dep.

"use strict";

const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(s) {
  return String(s).replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip);/g,
    (m) => ENTITY_MAP[m] || m,
  );
}

// Strip every attribute from a tag, returning just the bare `<tag>` form.
function stripAttrs(open) {
  const m = open.match(/^<\s*([a-zA-Z0-9]+)\b/);
  return m ? `<${m[1].toLowerCase()}>` : open;
}

// Inline-only replacement: turns inline HTML tags into their markdown
// equivalents. Operates on a chunk that should NOT contain any block
// tags (the block walker peels those off first).
function inlineToMd(html) {
  let s = String(html);

  // <img src="…" alt="…"> → ![alt](src). Handle self-closing or not.
  s = s.replace(
    /<img\b([^>]*)\/?>/gi,
    (_, attrs) => {
      const src = (attrs.match(/\bsrc\s*=\s*"([^"]+)"/i) || attrs.match(/\bsrc\s*=\s*'([^']+)'/i) || [])[1] || "";
      const alt = (attrs.match(/\balt\s*=\s*"([^"]*)"/i) || attrs.match(/\balt\s*=\s*'([^']*)'/i) || [])[1] || "";
      return src ? `![${alt}](${src})` : "";
    },
  );

  // <a href="…">text</a> → [text](href). External links only — the wiki
  // renderer keeps them clickable.
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `[${text.replace(/<[^>]+>/g, "").trim()}](${href})`,
  );

  // Bold / strong → **…**.
  s = s.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**");
  // Italic / em → *…*.
  s = s.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*");
  // Inline code.
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  // <br> → newline.
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Drop any remaining unhandled inline tags (best-effort), keep their text.
  s = s.replace(/<\/?(?:span|small|font|u|s)\b[^>]*>/gi, "");

  return decodeEntities(s).replace(/[ \t]+/g, " ").trim();
}

// Pull the inner HTML of a balanced `<tag …>…</tag>` starting at `start`
// (the index of the opening `<`). Returns { inner, end } where `end` is
// the index just past the closing `</tag>`. Tolerant of identically-named
// nested tags (`<div>` inside `<div>` — the summary job nests `<div>`s
// once for the visit card inside the outer wrapper).
function takeBalanced(html, start, tag) {
  const openRe = new RegExp(`<${tag}\\b`, "i");
  const closeRe = new RegExp(`</${tag}\\s*>`, "i");
  let depth = 0;
  let i = start;
  // Skip the opening tag itself.
  const openMatch = html.slice(i).match(/^<[^>]+>/);
  if (!openMatch) return null;
  const innerStart = i + openMatch[0].length;
  depth = 1;
  i = innerStart;
  while (i < html.length && depth > 0) {
    const rest = html.slice(i);
    const nextOpen = rest.search(openRe);
    const nextClose = rest.search(closeRe);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Nested same-tag opens before the next close — count it.
      const nestedOpen = rest.slice(nextOpen).match(/^<[^>]+>/);
      if (!nestedOpen) return null;
      depth++;
      i += nextOpen + nestedOpen[0].length;
    } else {
      depth--;
      const closing = rest.slice(nextClose).match(/^<\/[^>]+>/);
      if (!closing) return null;
      const innerEnd = i + nextClose;
      i += nextClose + closing[0].length;
      if (depth === 0) {
        return { inner: html.slice(innerStart, innerEnd), end: i };
      }
    }
  }
  return null;
}

// Main entry — html (or markdown — passthrough if no `<` is present) → md.
function htmlToMarkdown(html) {
  if (!html) return "";
  const text = String(html);
  // Cheap passthrough: if there are no HTML tags at all, it's already
  // markdown (or plaintext). The weekly + monthly narratives often arrive
  // as plain prose.
  if (!/<[a-zA-Z]/.test(text)) {
    return text.replace(/\r\n/g, "\n").trim() + "\n";
  }

  // Strip full-document wrappers if the source is a complete HTML page
  // (the monthly-summary job emits `<!DOCTYPE html><html><head>…<style>
  // …</style></head><body>…</body></html>` rather than a bare fragment).
  let body = text.trim();
  body = body.replace(/<!DOCTYPE[^>]*>/gi, "");
  body = body.replace(/<head\b[\s\S]*?<\/head>/gi, "");
  body = body.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  body = body.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  // Pull body content out of any <html><body>…</body></html> wrapper.
  const bodyTagMatch = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyTagMatch) body = bodyTagMatch[1];
  body = body.replace(/<\/?(?:html|body)\b[^>]*>/gi, "").trim();

  // Trim a single outer `<div …>…</div>` wrapper if present (the daily-
  // summary template wraps everything in a styled div). Repeat once in
  // case of nesting.
  for (let pass = 0; pass < 2; pass++) {
    if (/^<div\b/i.test(body) && /<\/div>\s*$/i.test(body)) {
      const taken = takeBalanced(body, 0, "div");
      if (taken && taken.end === body.length) {
        body = taken.inner.trim();
      } else {
        break;
      }
    }
  }

  const out = [];
  let i = 0;

  const skipWhitespace = () => {
    while (i < body.length && /\s/.test(body[i])) i++;
  };

  while (i < body.length) {
    skipWhitespace();
    if (i >= body.length) break;

    // Block-level dispatch.
    const ch = body[i];
    if (ch !== "<") {
      // Plaintext run until the next `<` — treat as a paragraph.
      const nextLt = body.indexOf("<", i);
      const chunk = body.slice(i, nextLt === -1 ? body.length : nextLt);
      const md = inlineToMd(chunk);
      if (md) out.push(md);
      i = nextLt === -1 ? body.length : nextLt;
      continue;
    }

    // Heading <h1>-<h6>.
    const hMatch = body.slice(i).match(/^<h([1-6])\b[^>]*>/i);
    if (hMatch) {
      const level = Number(hMatch[1]);
      const taken = takeBalanced(body, i, `h${level}`);
      if (taken) {
        const md = inlineToMd(taken.inner);
        if (md) out.push("#".repeat(level) + " " + md);
        i = taken.end;
        continue;
      }
    }

    // Visit card: <div class="visit">…</div>. Promote the inner h3 to a
    // proper heading and inline the paragraphs/images.
    const visitMatch = body.slice(i).match(/^<div\b[^>]*class\s*=\s*"[^"]*\bvisit\b[^"]*"[^>]*>/i);
    if (visitMatch) {
      const taken = takeBalanced(body, i, "div");
      if (taken) {
        const inner = taken.inner.trim();
        const blockMd = convertVisitBlock(inner);
        if (blockMd) out.push(blockMd);
        i = taken.end;
        continue;
      }
    }

    // Any other <div …> — recurse on its inner content.
    if (/^<div\b/i.test(body.slice(i))) {
      const taken = takeBalanced(body, i, "div");
      if (taken) {
        const innerMd = htmlToMarkdown(taken.inner);
        if (innerMd.trim()) out.push(innerMd.trim());
        i = taken.end;
        continue;
      }
    }

    // Paragraph <p>…</p>.
    if (/^<p\b/i.test(body.slice(i))) {
      const taken = takeBalanced(body, i, "p");
      if (taken) {
        const md = inlineToMd(taken.inner);
        if (md) out.push(md);
        i = taken.end;
        continue;
      }
    }

    // List <ul>…</ul> or <ol>…</ol>.
    const listMatch = body.slice(i).match(/^<(ul|ol)\b[^>]*>/i);
    if (listMatch) {
      const tag = listMatch[1].toLowerCase();
      const taken = takeBalanced(body, i, tag);
      if (taken) {
        const items = [];
        const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
        let liMatch;
        let idx = 0;
        while ((liMatch = liRe.exec(taken.inner))) {
          idx++;
          const prefix = tag === "ol" ? `${idx}. ` : "- ";
          items.push(prefix + inlineToMd(liMatch[1]));
        }
        if (items.length) out.push(items.join("\n"));
        i = taken.end;
        continue;
      }
    }

    // Self-closing or void tags (img, hr, br at the block level).
    const voidMatch = body.slice(i).match(/^<(img|hr|br)\b[^>]*\/?>/i);
    if (voidMatch) {
      const md = inlineToMd(voidMatch[0]);
      if (md) out.push(md);
      i += voidMatch[0].length;
      continue;
    }

    // Unknown tag — strip the opener and continue. Better to drop
    // styling than fail loudly.
    const skipMatch = body.slice(i).match(/^<\/?[^>]+>/);
    if (skipMatch) {
      i += skipMatch[0].length;
      continue;
    }
    // Shouldn't reach — but advance to avoid an infinite loop.
    i++;
  }

  return out.join("\n\n").trim() + "\n";
}

// Visit block: <div class="visit"><h3>…</h3><p>…</p><img …></div>. The
// h3 carries the time range + place name + duration + companions. We
// keep it as an h3 so it stays scannable in the wiki page view, and
// preserve the inner paragraphs + images as-is.
function convertVisitBlock(inner) {
  // Reuse the main converter on the inner content — it already handles
  // h3, p, and img correctly.
  return htmlToMarkdown(inner).trim();
}

module.exports = { htmlToMarkdown, inlineToMd, decodeEntities };
