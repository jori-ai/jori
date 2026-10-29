#!/usr/bin/env node
// notes-html.js — Convert between Apple Notes HTML and Markdown
// Handles tables, formatting, links, lists, checklists
//
// Usage:
//   node notes-html.js html2md           < input.html  > output.md
//   node notes-html.js md2html           < input.md    > output.html
//   node notes-html.js html2md --inline  "html string"
//   node notes-html.js md2html --inline  "markdown string"

"use strict";

// ── HTML → Markdown ─────────────────────────────────────────────────────────

function htmlToMarkdown(html) {
  let s = html;

  // Normalize: collapse whitespace around tags but preserve <br> as newlines
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove <head>, <style>, <meta> etc.
  s = s.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<meta[^>]*\/?>/gi, "");

  // --- Tables (must be done before general tag stripping) ---
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableInner) => {
    return convertTable(tableInner);
  });

  // --- Headings ---
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `# ${stripTags(c).trim()}\n`);
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `## ${stripTags(c).trim()}\n`);
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `### ${stripTags(c).trim()}\n`);

  // --- Links ---
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = stripTags(text).trim();
    if (t === href || t === "") return href;
    return `[${t}](${href})`;
  });

  // --- Bold / Italic (avoid crossing block-level boundaries) ---
  s = s.replace(/<(b|strong)[^>]*>([^<]*(?:<(?!\/?\1|div|\/div|br|p|\/p|h[1-3]|table|tr|td)[^>]*>[^<]*)*)<\/\1>/gi,
    (_, __, c) => `**${stripTags(c).trim()}**`);
  s = s.replace(/<(i|em)[^>]*>([^<]*(?:<(?!\/?\1|div|\/div|br|p|\/p|h[1-3]|table|tr|td)[^>]*>[^<]*)*)<\/\1>/gi,
    (_, __, c) => `*${stripTags(c).trim()}*`);
  s = s.replace(/<u[^>]*>([\s\S]*?)<\/u>/gi, (_, c) => stripTags(c));

  // --- Checklists (Apple Notes uses tt:state on li) ---
  s = s.replace(/<li[^>]*tt:state="checked"[^>]*>([\s\S]*?)<\/li>/gi,
    (_, c) => `- [x] ${stripTags(c).trim()}\n`);
  s = s.replace(/<li[^>]*tt:state="unchecked"[^>]*>([\s\S]*?)<\/li>/gi,
    (_, c) => `- [ ] ${stripTags(c).trim()}\n`);

  // --- Regular lists ---
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c).trim()}\n`);
  s = s.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // --- Block elements → newlines ---
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<div[^>]*>/gi, "");
  s = s.replace(/<p[^>]*>/gi, "");

  // --- Strip remaining tags ---
  s = stripTags(s);

  // --- Decode entities ---
  s = decodeEntities(s);

  // --- Collapse blank lines (max 2) ---
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim() + "\n";
}

function convertTable(tableHtml) {
  // Extract rows
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripTags(cellMatch[1]).trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return "";

  // Normalize column count
  const maxCols = Math.max(...rows.map(r => r.length));
  rows.forEach(r => { while (r.length < maxCols) r.push(""); });

  // Calculate column widths
  const widths = [];
  for (let c = 0; c < maxCols; c++) {
    widths[c] = Math.max(3, ...rows.map(r => r[c].length));
  }

  // Format as markdown table
  const lines = [];
  // First row = header
  lines.push("| " + rows[0].map((cell, i) => cell.padEnd(widths[i])).join(" | ") + " |");
  // Separator
  lines.push("| " + widths.map(w => "-".repeat(w)).join(" | ") + " |");
  // Data rows
  for (let r = 1; r < rows.length; r++) {
    lines.push("| " + rows[r].map((cell, i) => cell.padEnd(widths[i])).join(" | ") + " |");
  }

  return "\n" + lines.join("\n") + "\n";
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

// ── Markdown → HTML ─────────────────────────────────────────────────────────

function markdownToHtml(md) {
  const lines = md.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    // --- Table detection: line starting with | ---
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && /^\|[\s\-|]+\|$/.test(lines[i + 1].trim())) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(convertMdTable(tableLines));
      continue;
    }

    // Also detect tables without explicit separator (just rows of |...|)
    if (lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        result.push(convertMdTable(tableLines));
        continue;
      }
      // Wasn't really a table, process normally
      for (const l of tableLines) {
        result.push(convertMdLine(l));
      }
      continue;
    }

    result.push(convertMdLine(lines[i]));
    i++;
  }

  return result.join("");
}

function convertMdTable(lines) {
  // Filter out separator rows (|---|---|)
  const dataLines = lines.filter(l => !/^\|[\s\-:|]+\|$/.test(l.trim()));

  const rows = dataLines.map(line => {
    // Split by | but ignore first and last empty entries
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    return cells;
  });

  if (rows.length === 0) return "";

  let html = '<table style="width:100%">\n';

  // First row as header
  html += "<tr>\n";
  for (const cell of rows[0]) {
    html += `<td style="font-weight:bold">${inlineMarkdown(escapeHtml(cell))}</td>\n`;
  }
  html += "</tr>\n";

  // Remaining rows
  for (let r = 1; r < rows.length; r++) {
    html += "<tr>\n";
    for (const cell of rows[r]) {
      html += `<td>${inlineMarkdown(escapeHtml(cell))}</td>\n`;
    }
    html += "</tr>\n";
  }

  html += "</table>\n";
  return html;
}

function convertMdLine(line) {
  const trimmed = line.trim();

  // Empty line → <br>
  if (trimmed === "") return "<br>\n";

  // Headings
  if (trimmed.startsWith("### ")) return `<h3>${inlineMarkdown(escapeHtml(trimmed.slice(4)))}</h3>\n`;
  if (trimmed.startsWith("## "))  return `<h2>${inlineMarkdown(escapeHtml(trimmed.slice(3)))}</h2>\n`;
  if (trimmed.startsWith("# "))   return `<h1>${inlineMarkdown(escapeHtml(trimmed.slice(2)))}</h1>\n`;

  // Checklists
  if (/^- \[x\] /i.test(trimmed)) {
    return `<li tt:state="checked">${inlineMarkdown(escapeHtml(trimmed.slice(6)))}</li>\n`;
  }
  if (/^- \[ \] /.test(trimmed)) {
    return `<li tt:state="unchecked">${inlineMarkdown(escapeHtml(trimmed.slice(6)))}</li>\n`;
  }

  // List items
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    return `<li>${inlineMarkdown(escapeHtml(trimmed.slice(2)))}</li>\n`;
  }

  // Regular paragraph
  return `<div>${inlineMarkdown(escapeHtml(trimmed))}</div>\n`;
}

function inlineMarkdown(s) {
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic
  s = s.replace(/\*(.+?)\*/g, "<i>$1</i>");
  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bare URLs
  s = s.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
  return s;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, flag, inline] = process.argv;

  if (!cmd || cmd === "--help") {
    process.stderr.write("Usage: notes-html.js <html2md|md2html> [--inline \"string\"]\n");
    process.exit(1);
  }

  const convert = cmd === "html2md" ? htmlToMarkdown : markdownToHtml;

  if (flag === "--inline" && inline != null) {
    process.stdout.write(convert(inline));
  } else {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      process.stdout.write(convert(input));
    });
  }
}

module.exports = { htmlToMarkdown, markdownToHtml };
