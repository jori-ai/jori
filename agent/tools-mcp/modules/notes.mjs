// tools-mcp/modules/notes.mjs — Apple Notes (bin/notes, macOS: AppleScript).
// Optional tools served by agent/tools-mcp/index.mjs (loadExtTools):
// `after` keeps them at their place in the served tool list.
export const after = "flight_status";

export function tools({ BIN, run }) {
  return [
    // ── Notes ──
    {
      name: "notes_list",
      description: "List Apple Notes, optionally in a specific folder",
      schema: { type: "object", properties: { folder: { type: "string" } } },
      run: (a) => run(`${BIN}/notes`, ["list", ...(a.folder ? [a.folder] : [])]),
    },
    {
      name: "notes_read",
      description: "Read an Apple Note by title. Returns structured markdown with tables preserved. Use format='html' for raw HTML or format='plain' for stripped plaintext.",
      schema: { type: "object", properties: { title: { type: "string" }, format: { type: "string", enum: ["markdown", "html", "plain"], description: "Output format (default: markdown)" } }, required: ["title"] },
      run: (a) => {
        const fmt = a.format === "html" ? "--html" : a.format === "plain" ? "--plain" : "";
        return run(`${BIN}/notes`, ["read", a.title, ...(fmt ? [fmt] : [])]);
      },
    },
    {
      name: "notes_search",
      description: "Search Apple Notes by keyword",
      schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: (a) => run(`${BIN}/notes`, ["search", a.query]),
    },
    {
      name: "notes_create",
      description: "Create a new Apple Note. Body supports markdown with tables (| col1 | col2 |), **bold**, *italic*, links, headings (#), and lists (-). Use html=true to pass raw HTML instead.",
      schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string", description: "Markdown body (tables, bold, links supported)" }, folder: { type: "string" }, html: { type: "boolean", description: "If true, body is raw HTML" } }, required: ["title", "body"] },
      run: (a) => run(`${BIN}/notes`, ["create", a.title, a.body, ...(a.folder ? ["--folder", a.folder] : []), ...(a.html ? ["--html"] : [])]),
    },
    {
      name: "notes_append",
      description: "Append text to an existing Apple Note",
      schema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] },
      run: (a) => run(`${BIN}/notes`, ["append", a.title, a.text]),
    },
    {
      name: "notes_edit",
      description: "Replace the entire body of an Apple Note. Body supports markdown with tables (| col1 | col2 |), **bold**, *italic*, links, headings, and lists. Use html=true to pass raw HTML.",
      schema: { type: "object", properties: { title: { type: "string", description: "Existing note title" }, body: { type: "string", description: "New markdown body (tables, bold, links supported)" }, html: { type: "boolean", description: "If true, body is raw HTML" } }, required: ["title", "body"] },
      run: (a) => run(`${BIN}/notes`, ["edit", a.title, a.body, ...(a.html ? ["--html"] : [])]),
    },
  ];
}
