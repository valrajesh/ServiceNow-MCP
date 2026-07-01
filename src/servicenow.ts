import type { Tool, Parameter, ParamLocation } from "./types.js";
import https from "https";
import { URL } from "url";

export interface SNCredentials {
  instanceUrl: string; // e.g. https://dev00000.service-now.com
  username: string;
  password: string;
}

// For dev/test ServiceNow instances with self-signed certs, disable cert validation
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Helper to make HTTPS requests with self-signed cert support
async function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    options.agent = httpsAgent;
    https
      .request(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 500, text: data }));
      })
      .on("error", reject)
      .end(body);
  });
}

function authHeader(creds: SNCredentials): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
}

const PATH_PLACEHOLDER = /\{([^}]+)\}/g;

function defaultLocation(method: Tool["method"]): ParamLocation {
  return method === "POST" || method === "PATCH" ? "body" : "query";
}

function resolveLocation(p: Parameter, method: Tool["method"], pathNames: Set<string>): ParamLocation {
  if (p.in) return p.in;
  if (pathNames.has(p.name)) return "path";
  return defaultLocation(method);
}

function tableNameFromEndpoint(endpoint: string): string | null {
  const match = endpoint.match(/^\/api\/now\/table\/([^/?]+)/);
  return match ? match[1] : null;
}

async function resolveSysIdFromNumber(
  tool: Tool,
  args: Record<string, unknown>,
  creds: SNCredentials
): Promise<string | null> {
  const number = args["number"] ?? args["incident_number"];
  if (!number || typeof number !== "string") return null;

  const tableName = tableNameFromEndpoint(tool.endpoint);
  if (!tableName) return null;

  const baseUrl = creds.instanceUrl.replace(/\/$/, "");
  const url =
    `${baseUrl}/api/now/table/${tableName}` +
    `?sysparm_query=number=${encodeURIComponent(number)}` +
    `&sysparm_fields=sys_id&sysparm_limit=1`;

  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    Accept: "application/json",
  };

  const urlObj = new URL(url);
  const res = await httpsRequest(
    urlObj.href,
    {
      method: "GET",
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers,
    },
    undefined
  );

  if (res.status >= 400) return null;

  try {
    const payload = JSON.parse(res.text) as {
      result?: Array<{ sys_id?: string }>;
    };
    const sysId = payload.result?.[0]?.sys_id;
    return sysId ?? null;
  } catch {
    return null;
  }
}

async function resolveIncidentSysIdByNumber(
  incidentNumber: string,
  creds: SNCredentials
): Promise<string | null> {
  const baseUrl = creds.instanceUrl.replace(/\/$/, "");
  const url =
    `${baseUrl}/api/now/table/incident` +
    `?sysparm_query=number=${encodeURIComponent(incidentNumber)}` +
    `&sysparm_fields=sys_id&sysparm_limit=1`;

  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    Accept: "application/json",
  };

  const urlObj = new URL(url);
  const res = await httpsRequest(
    urlObj.href,
    {
      method: "GET",
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers,
    },
    undefined
  );

  if (res.status >= 400) return null;

  try {
    const payload = JSON.parse(res.text) as {
      result?: Array<{ sys_id?: string }>;
    };
    return payload.result?.[0]?.sys_id ?? null;
  } catch {
    return null;
  }
}

// Maps tool parameters to a ServiceNow REST call.
// - `{name}` placeholders in endpoint → substituted from path params
// - body params → JSON body (flat object)
// - query params → URL query string (Table API params mapped to sysparm_*)
export async function callTool(
  tool: Tool,
  args: Record<string, unknown>,
  creds: SNCredentials
): Promise<unknown> {
  const baseUrl = creds.instanceUrl.replace(/\/$/, "");

  const pathNames = new Set<string>();
  for (const match of tool.endpoint.matchAll(PATH_PLACEHOLDER)) {
    pathNames.add(match[1]!);
  }

  // Catch tool-definition mistakes early: param marked as path but endpoint has no slot for it.
  for (const p of tool.parameters) {
    if (p.in === "path" && !pathNames.has(p.name)) {
      throw new Error(
        `Tool "${tool.name}": parameter "${p.name}" is marked as a path parameter, ` +
        `but the endpoint "${tool.endpoint}" has no {${p.name}} placeholder. ` +
        `Add {${p.name}} to the endpoint URL.`
      );
    }
  }

  const buckets = { body: {} as Record<string, unknown>, query: {} as Record<string, unknown>, path: {} as Record<string, unknown> };

  for (const p of tool.parameters) {
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    const loc = resolveLocation(p, tool.method, pathNames);
    buckets[loc][p.name] = value;
  }

  // Pass through any args that weren't declared but match a path placeholder.
  for (const name of pathNames) {
    if (buckets.path[name] === undefined && args[name] !== undefined) {
      buckets.path[name] = args[name];
    }
  }

  // Convenience fallback for update tools: allow callers to pass `number`
  // and resolve `{sys_id}` automatically for ServiceNow table records.
  if (
    pathNames.has("sys_id") &&
    (buckets.path["sys_id"] === undefined || buckets.path["sys_id"] === null || buckets.path["sys_id"] === "")
  ) {
    const resolvedSysId = await resolveSysIdFromNumber(tool, args, creds);
    if (resolvedSysId) {
      buckets.path["sys_id"] = resolvedSysId;
    }
  }

  // Convenience for incident task creation: accept `incident_number`
  // and resolve the incident reference field automatically.
  if (
    tool.method === "POST" &&
    tool.endpoint === "/api/now/table/incident_task" &&
    buckets.body["incident"] === undefined
  ) {
    const incidentNumber = args["incident_number"];
    if (typeof incidentNumber === "string" && incidentNumber.trim()) {
      const incidentSysId = await resolveIncidentSysIdByNumber(incidentNumber, creds);
      if (!incidentSysId) {
        throw new Error(`Incident not found for number: ${incidentNumber}`);
      }
      buckets.body["incident"] = incidentSysId;
      delete buckets.body["incident_number"];
      delete buckets.query["incident_number"];
      delete buckets.path["incident_number"];
    }
  }

  // Substitute path placeholders.
  let path = tool.endpoint.replace(PATH_PLACEHOLDER, (_, name: string) => {
    const v = buckets.path[name];
    if (v === undefined || v === null || v === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(v));
  });

  // Query string.
  const qs = buildQueryString(tool, buckets.query);
  if (qs) path += (path.includes("?") ? "&" : "?") + qs;

  const url = baseUrl + path;

  const headers: Record<string, string> = {
    Authorization: authHeader(creds),
    Accept: "application/json",
  };

  let body: string | undefined;
  if (Object.keys(buckets.body).length > 0) {
    body = JSON.stringify(buckets.body);
    headers["Content-Type"] = "application/json";
  }

  const urlObj = new URL(url);
  const res = await httpsRequest(urlObj.href, {
    method: tool.method,
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    headers,
  }, body);

  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = res.text;
  }

  if (res.status >= 400) {
    throw new Error(
      `ServiceNow returned ${res.status}: ${typeof data === "object" ? JSON.stringify(data) : res.text}`
    );
  }

  return data;
}

function buildQueryString(tool: Tool, args: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    if (tool.apiType === "table") {
      const snKey = TABLE_PARAM_MAP[key] ?? key;
      params.set(snKey, String(value));
    } else {
      params.set(key, String(value));
    }
  }

  return params.toString();
}

// Lets tool authors use clean names like "query", "fields", "limit"
// which the model understands, while sending the correct sysparm_ names.
const TABLE_PARAM_MAP: Record<string, string> = {
  query: "sysparm_query",
  fields: "sysparm_fields",
  limit: "sysparm_limit",
  offset: "sysparm_offset",
  order_by: "sysparm_orderby",
  display_value: "sysparm_display_value",
  exclude_ref_link: "sysparm_exclude_reference_link",
  view: "sysparm_view",
};

// Quick connectivity test — fetches a single row from sys_user
export async function testConnection(creds: SNCredentials): Promise<{ ok: boolean; error?: string }> {
  try {
    const urlStr = `${creds.instanceUrl.replace(/\/$/, "")}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`;
    const urlObj = new URL(urlStr);
    const headers = { Authorization: authHeader(creds), Accept: "application/json" };
    const res = await Promise.race([
      httpsRequest(urlObj.href, { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers }, ""),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
    return res.status < 400 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
