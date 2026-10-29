// tools-mcp/modules/contact-lookup.mjs — Apollo.io lookups + the local contacts DB (bin/contact-lookup).
// Optional tools served by agent/tools-mcp/index.mjs (loadExtTools):
// `after` keeps them at their place in the served tool list.
export const after = "office_read_sheet";

export function tools({ BIN, run }) {
  return [
    // ── Contacts (Apollo + local DB) ──
    {
      name: "contact_search",
      description: "Search Apollo.io for a person by name, company, or domain. Returns enriched contact info.",
      schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person's name" },
          company: { type: "string", description: "Company name (optional)" },
          domain: { type: "string", description: "Company domain e.g. acme.com (optional)" },
          title: { type: "string", description: "Job title filter (optional)" },
        },
        required: ["name"],
      },
      run: (a) => run("node", [`${BIN}/contact-lookup`, "search",
        "--name", a.name,
        ...(a.company ? ["--company", a.company] : []),
        ...(a.domain ? ["--domain", a.domain] : []),
        ...(a.title ? ["--title", a.title] : []),
      ]),
    },
    {
      name: "contact_enrich",
      description: "Enrich a person's contact details via Apollo.io people match. Requires name + domain.",
      schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person's full name" },
          domain: { type: "string", description: "Company domain e.g. acme.com" },
          email: { type: "string", description: "Known email address (optional)" },
        },
        required: ["name", "domain"],
      },
      run: (a) => run("node", [`${BIN}/contact-lookup`, "enrich",
        "--name", a.name,
        "--domain", a.domain,
        ...(a.email ? ["--email", a.email] : []),
      ]),
    },
    {
      name: "contact_save",
      description: "Save or update a contact in the local contacts database. Upserts by name+company or apollo_id.",
      schema: {
        type: "object",
        properties: {
          data: { type: "string", description: "JSON string with contact fields: name, email, phone, company, title, linkedin_url, apollo_id, notes, tags, metadata" },
        },
        required: ["data"],
      },
      run: (a) => run("node", [`${BIN}/contact-lookup`, "save", "--data", a.data]),
    },
    {
      name: "contact_find",
      description: "Search the local contacts database by name, company, email, or any text. Full-text search.",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search query" },
        },
        required: ["query"],
      },
      run: (a) => run("node", [`${BIN}/contact-lookup`, "find", a.query]),
    },
    {
      name: "contact_get",
      description: "Get a specific contact's full details by name or ID.",
      schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Contact name (partial match)" },
          id: { type: "number", description: "Contact ID" },
        },
      },
      run: (a) => run("node", [`${BIN}/contact-lookup`, "get",
        ...(a.id ? ["--id", String(a.id)] : []),
        ...(a.name ? ["--name", a.name] : []),
      ]),
    },
    {
      name: "contact_list",
      description: "List all saved contacts in the local database",
      schema: { type: "object", properties: {} },
      run: () => run("node", [`${BIN}/contact-lookup`, "list"]),
    },
  ];
}
