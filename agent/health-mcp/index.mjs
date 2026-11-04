#!/usr/bin/env node
// health-mcp — exposes Apple Health data (synced from the Jori iOS client
// into Supabase tables `health_samples` / `health_workouts` /
// `health_aggregates` / `health_clinical_records`) as MCP tools.
//
// Read-only. All queries run against Supabase REST / RPC using the service-role
// key from .env. See the companion app's HealthKitManager.swift for the
// set of hk_type identifiers, canonical units, and clinical record types.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnv } = require("../../lib/load-env.js");
const { instance, supabaseUrl } = require("../../lib/instance.cjs");
const { labAliases, suggest } = require("../../lib/health-lab-aliases.cjs");

loadEnv();

// This installation's Supabase project (instance.json supabase_project);
// SUPABASE_URL wins, as elsewhere. Without one the tools answer with an error
// instead of failing to start: no project configured = health is off.
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();

function key() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
}

async function sbFetch(pathAndQuery, { method = "GET", body } = {}) {
  if (!SUPABASE_URL) throw new Error("no Supabase project configured (instance.json supabase_project) — health data is not set up");
  const k = key();
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  const res = await fetch(SUPABASE_URL + pathAndQuery, {
    method,
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

function ok(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const TOOLS = [
  {
    name: "health_schema",
    description:
      "List all Apple Health sample types currently present in Supabase, with row counts, date range, and units. Use this FIRST to discover what data is available before querying — the client may not have synced every hk_type the app supports. Also returns the workouts summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "health_latest",
    description:
      "Return the most recent N samples for a given hk_type (e.g. 'HKQuantityTypeIdentifierHeartRate'). Useful for 'what's my latest resting HR?' style questions.",
    inputSchema: {
      type: "object",
      properties: {
        hk_type: { type: "string", description: "Full HealthKit identifier, e.g. HKQuantityTypeIdentifierStepCount" },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 200 },
      },
      required: ["hk_type"],
      additionalProperties: false,
    },
  },
  {
    name: "health_query",
    description:
      "Query samples with a date range and optional bucketing/aggregation. bucket='raw' returns up to 5000 raw samples; 'hour' or 'day' returns aggregated series. agg applies to bucketed modes: avg|sum|min|max|count.",
    inputSchema: {
      type: "object",
      properties: {
        hk_type: { type: "string" },
        from: { type: "string", description: "ISO timestamp (inclusive)" },
        to: { type: "string", description: "ISO timestamp (exclusive)" },
        bucket: { type: "string", enum: ["raw", "hour", "day"], default: "day" },
        agg: { type: "string", enum: ["avg", "sum", "min", "max", "count"], default: "avg" },
      },
      required: ["hk_type", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "health_workouts",
    description:
      "List workouts within a date range. Returns activity_type, duration, energy, distance, source.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "integer", default: 100, minimum: 1, maximum: 1000 },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "health_clinical_schema",
    description:
      "Summary of Apple Health Records (clinical FHIR resources pulled from connected providers like MyChart/Epic): per (hk_clinical_type, fhir_resource_type) counts + date range. Call this first to see what clinical data is actually present before drilling in.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "health_clinical_latest",
    description:
      "Most recent N clinical records, optionally filtered by hk_clinical_type (e.g. 'HKClinicalTypeIdentifierLabResultRecord') and/or fhir_resource_type (e.g. 'Observation'). Returns summary fields — call health_clinical_get with the hk_uuid to read the full FHIR JSON.",
    inputSchema: {
      type: "object",
      properties: {
        hk_clinical_type: {
          type: "string",
          description:
            "e.g. HKClinicalTypeIdentifierLabResultRecord, HKClinicalTypeIdentifierMedicationRecord",
        },
        fhir_resource_type: {
          type: "string",
          description: "FHIR resourceType, e.g. Observation, MedicationRequest, Condition",
        },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "health_clinical_get",
    description:
      "Return the full FHIR JSON for one clinical record, keyed by hk_uuid. Use health_clinical_latest to find the hk_uuid first. The payload is the raw FHIR resource as emitted by the provider — shape depends on fhir_resource_type (Observation has .code/.valueQuantity, MedicationRequest has .medicationCodeableConcept, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        hk_uuid: { type: "string", description: "health_clinical_records.hk_uuid (uuid)" },
      },
      required: ["hk_uuid"],
      additionalProperties: false,
    },
  },
  {
    name: "health_clinical_named",
    description:
      "Lookup clinical lab values by natural-language name ('LDL', 'A1C', 'cholesterol', 'hemoglobin', 'creatinine', etc.) instead of raw LOINC codes. Returns recent Observation records whose fhir_json.code.coding matches one of the mapped codes, with value + unit + effectiveDateTime extracted. Source of the alias map: agent/health-mcp/loinc-aliases.json plus any lab-specific codes in the local health config. Use this for 'what were my LDL results?' / 'show A1C trend' queries — no need to reason about FHIR shape. Falls back with suggested aliases if the name isn't mapped.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Natural-language lab name, e.g. 'LDL', 'A1C', 'cholesterol'." },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 100 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

const mcp = new Server(
  { name: "health", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      `Apple Health data synced from the user's iPhone into Supabase. Read-only. Call health_schema first to see which hk_type identifiers actually have data — the client syncs incrementally via HKAnchoredObjectQuery, so not every catalog type will be populated. Timestamps are UTC; the user's home time zone is ${instance().tz}. Findings are pattern recognition, never a diagnosis: point the user to their doctor for anything clinical.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "health_schema") {
      const [types, wk] = await Promise.all([
        sbFetch("/rest/v1/rpc/health_types_summary", { method: "POST", body: {} }),
        sbFetch(
          "/rest/v1/health_workouts?select=activity_type,start_date,duration_s,total_energy_kcal,total_distance_m&order=start_date.desc&limit=5",
        ),
      ]);
      const wkCountRes = await fetch(SUPABASE_URL + "/rest/v1/health_workouts?select=hk_uuid", {
        method: "HEAD",
        headers: { apikey: key(), Authorization: `Bearer ${key()}`, Prefer: "count=exact" },
      });
      const wkCount = Number((wkCountRes.headers.get("content-range") || "/0").split("/")[1]) || 0;
      return ok({
        tables: {
          health_samples: {
            columns: "hk_uuid, device_id, hk_type, start_date, end_date, value, unit, source_name, source_bundle_id, metadata, inserted_at",
            types_present: types,
          },
          health_workouts: {
            columns: "hk_uuid, device_id, activity_type, start_date, end_date, duration_s, total_energy_kcal, total_distance_m, source_name, source_bundle_id, metadata, inserted_at",
            total_count: wkCount,
            recent: wk,
          },
        },
      });
    }

    if (name === "health_latest") {
      const { hk_type, limit = 10 } = args;
      const rows = await sbFetch(
        `/rest/v1/health_samples?hk_type=eq.${encodeURIComponent(hk_type)}&select=start_date,end_date,value,unit,source_name&order=start_date.desc&limit=${Number(limit)}`,
      );
      return ok(rows);
    }

    if (name === "health_query") {
      const { hk_type, from, to, bucket = "day", agg = "avg" } = args;
      const rows = await sbFetch("/rest/v1/rpc/health_bucketed", {
        method: "POST",
        body: { p_type: hk_type, p_from: from, p_to: to, p_bucket: bucket, p_agg: agg },
      });
      return ok(rows);
    }

    if (name === "health_workouts") {
      const { from, to, limit = 100 } = args;
      const rows = await sbFetch(
        `/rest/v1/health_workouts?start_date=gte.${encodeURIComponent(from)}&start_date=lt.${encodeURIComponent(to)}&select=activity_type,start_date,end_date,duration_s,total_energy_kcal,total_distance_m,source_name&order=start_date.desc&limit=${Number(limit)}`,
      );
      return ok(rows);
    }

    if (name === "health_clinical_schema") {
      const rows = await sbFetch("/rest/v1/rpc/health_clinical_summary", {
        method: "POST",
        body: {},
      });
      return ok({
        table: "health_clinical_records",
        columns:
          "hk_uuid, device_id, hk_clinical_type, fhir_resource_type, fhir_id, fhir_version, display_name, received_date, source_name, source_bundle_id, fhir_json, inserted_at",
        by_type: rows,
      });
    }

    if (name === "health_clinical_latest") {
      const { hk_clinical_type, fhir_resource_type, limit = 20 } = args;
      const clauses = [];
      if (hk_clinical_type) clauses.push(`hk_clinical_type=eq.${encodeURIComponent(hk_clinical_type)}`);
      if (fhir_resource_type) clauses.push(`fhir_resource_type=eq.${encodeURIComponent(fhir_resource_type)}`);
      clauses.push(
        "select=hk_uuid,hk_clinical_type,fhir_resource_type,fhir_id,display_name,received_date,source_name",
      );
      clauses.push("order=received_date.desc.nullslast");
      clauses.push(`limit=${Number(limit)}`);
      const rows = await sbFetch(`/rest/v1/health_clinical_records?${clauses.join("&")}`);
      return ok(rows);
    }

    if (name === "health_clinical_get") {
      const { hk_uuid } = args;
      const rows = await sbFetch(
        `/rest/v1/health_clinical_records?hk_uuid=eq.${encodeURIComponent(hk_uuid)}&select=*&limit=1`,
      );
      if (!rows || rows.length === 0) return err(`No record with hk_uuid=${hk_uuid}`);
      return ok(rows[0]);
    }

    if (name === "health_clinical_named") {
      const { name: queryName, limit = 10 } = args;
      const key = String(queryName || "").trim().toLowerCase();
      if (!key) return err("name is required");

      let aliases;
      try {
        aliases = labAliases();
      } catch (e) {
        return err(`Could not read the lab alias map: ${e.message}`);
      }

      const codes = aliases[key];
      if (!codes) {
        return ok({
          name: queryName,
          matched: false,
          reason: `No alias for '${queryName}' in the lab alias map`,
          suggestions: suggest(aliases, key),
        });
      }

      // Supabase JSONB "contains" filter: fhir_json->code->coding @> [{"system":..,"code":..}]
      // PostgREST syntax: fhir_json=cs.{"code":{"coding":[{...}]}}
      // We run one query per code variant and merge — simpler than constructing one
      // OR-ed cs filter across arrays of arrays.
      const seen = new Map();
      for (const c of codes) {
        const containsDoc = JSON.stringify({
          code: { coding: [{ system: c.system, code: c.code }] },
        });
        const qs = new URLSearchParams({
          fhir_resource_type: "eq.Observation",
          fhir_json: `cs.${containsDoc}`,
          select: "hk_uuid,display_name,received_date,source_name,fhir_json",
          order: "received_date.desc.nullslast",
          limit: String(Number(limit)),
        });
        let rows;
        try {
          rows = await sbFetch(`/rest/v1/health_clinical_records?${qs.toString()}`);
        } catch (e) {
          // Skip variants that PostgREST rejects (e.g. encoding edge cases) rather
          // than failing the whole query.
          continue;
        }
        for (const r of rows || []) {
          if (seen.has(r.hk_uuid)) continue;
          const fj = r.fhir_json || {};
          const q = fj.valueQuantity || {};
          seen.set(r.hk_uuid, {
            hk_uuid: r.hk_uuid,
            display_name: r.display_name || q._display || null,
            received_date: r.received_date,
            source_name: r.source_name,
            value: q.value ?? null,
            unit: q.unit ?? null,
            reference_range: fj.referenceRange || null,
            effective: fj.effectiveDateTime || fj.effectivePeriod || null,
            matched_via: { system: c.system, code: c.code },
          });
        }
      }

      const results = [...seen.values()]
        .sort((a, b) => String(b.received_date || "").localeCompare(String(a.received_date || "")))
        .slice(0, Number(limit));

      return ok({
        name: queryName,
        matched: true,
        alias_key: key,
        codes_tried: codes,
        count: results.length,
        results,
      });
    }

    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(e.message);
  }
});

await mcp.connect(new StdioServerTransport());
