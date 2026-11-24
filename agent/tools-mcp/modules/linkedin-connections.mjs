// tools-mcp/modules/linkedin-connections.mjs — the owner's LinkedIn connections
// (local DB from a LinkedIn data export; bin/linkedin-connections). Answers
// "not imported yet" until `linkedin-connections import <folder>` has run.
export const after = "contact_list";

export function tools({ BIN, run }) {
  return [
    {
      name: "linkedin_connection_find",
      description: "Look up people in the owner's LinkedIn connections (local, instant; ~all of their 1st-degree network). Search by name (partial, accent-insensitive), and/or filter by company. Each hit has their company and title as of the last export, the date they connected, the profile URL, email if shared, and a 'tie' (strong / some / weak / connection only) from LinkedIn messages, recommendations and endorsements. Use it for 'do I know someone at X?', 'who is Dana Cohen?', intros. A connection alone does not mean the owner knows them: say what the tie is. Roles may be stale; for today's role use live LinkedIn lookup.",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name or words to match (name, company, title, email). Optional when company is given." },
          company: { type: "string", description: "Only people whose company contains this (optional)" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
      run: (a) => run("node", [`${BIN}/linkedin-connections`, a.query ? "find" : "company",
        ...(a.query ? [a.query] : [a.company || ""]),
        ...(a.query && a.company ? ["--company", a.company] : []),
        ...(a.limit ? ["--limit", String(a.limit)] : []),
      ]),
    },
  ];
}
