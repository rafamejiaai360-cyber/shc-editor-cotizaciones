/**
 * Cloudflare Worker — Proxy para Notion API
 * SHC Ingeniería Hidráulica — Editor de Cotizaciones
 *
 * Configura la variable de entorno NOTION_TOKEN en Cloudflare.
 * Database ID: 51ab7f207aab47faadd7772e89665bc6
 */

const DATABASE_ID = "51ab7f207aab47faadd7772e89665bc6";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Divide texto largo en chunks de 2000 chars (límite de Notion por bloque)
function toRichText(text) {
  if (!text) return [{ type: "text", text: { content: "" } }];
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

// Reconstruye el texto desde el array de rich_text de Notion
function fromRichText(richText) {
  if (!Array.isArray(richText)) return "";
  return richText.map((b) => b.plain_text || "").join("");
}

function buildProperties(body) {
  const p = {
    "Nombre Cotización": {
      title: [{ text: { content: (body.nombre || "Sin nombre").slice(0, 2000) } }],
    },
    "Cliente":       { rich_text: toRichText(body.cliente || "") },
    "No. COT":       { rich_text: toRichText(body.noCOT || "") },
    "Estado":        { select: { name: body.estado || "Borrador" } },
    "Secciones":     { number: body.secciones || 0 },
    "Datos JSON":    { rich_text: toRichText(body.datosJSON || "") },
  };
  if (body.tipo)         p["Tipo"]            = { select: { name: body.tipo } };
  if (body.totalGTQ != null) p["Total GTQ"]  = { number: body.totalGTQ };
  if (body.totalUSD != null) p["Total USD"]  = { number: body.totalUSD };
  if (body.notas)        p["Notas"]           = { rich_text: toRichText(body.notas) };
  if (body.fecha)        p["Fecha Cotización"] = { date: { start: body.fecha } };
  return p;
}

function mapPage(page, includeFull = true) {
  const p = page.properties;
  return {
    id:       page.id,
    nombre:   fromRichText(p["Nombre Cotización"]?.title),
    cliente:  fromRichText(p["Cliente"]?.rich_text),
    noCOT:    fromRichText(p["No. COT"]?.rich_text),
    tipo:     p["Tipo"]?.select?.name || "",
    estado:   p["Estado"]?.select?.name || "Borrador",
    totalGTQ: p["Total GTQ"]?.number ?? null,
    totalUSD: p["Total USD"]?.number ?? null,
    secciones: p["Secciones"]?.number || 0,
    notas:    fromRichText(p["Notas"]?.rich_text),
    fecha:    p["Fecha Cotización"]?.date?.start || "",
    creado:   page.created_time,
    url:      page.url,
    ...(includeFull
      ? { datosJSON: fromRichText(p["Datos JSON"]?.rich_text) }
      : {}),
  };
}

export default {
  async fetch(request, env) {
    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    const notionFetch = (endpoint, options = {}) =>
      fetch(`https://api.notion.com/v1${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

    try {
      // ── GET /sesiones ─────────────────────────────────────
      if (request.method === "GET" && path === "/sesiones") {
        const resp = await notionFetch(`/databases/${DATABASE_ID}/query`, {
          method: "POST",
          body: JSON.stringify({
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 100,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) return json(data, resp.status);
        return json({ sessions: (data.results || []).map((p) => mapPage(p, false)) });
      }

      // ── GET /sesiones/:id ─────────────────────────────────
      if (request.method === "GET" && path.startsWith("/sesiones/")) {
        const pageId = path.slice("/sesiones/".length);
        const resp   = await notionFetch(`/pages/${pageId}`);
        const data   = await resp.json();
        if (!resp.ok) return json(data, resp.status);
        return json(mapPage(data, true));
      }

      // ── POST /sesiones ────────────────────────────────────
      if (request.method === "POST" && path === "/sesiones") {
        const body = await request.json();
        const resp = await notionFetch("/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { database_id: DATABASE_ID },
            properties: buildProperties(body),
          }),
        });
        const data = await resp.json();
        if (!resp.ok) return json(data, resp.status);
        return json({ id: data.id, url: data.url }, 201);
      }

      // ── PATCH /sesiones/:id ───────────────────────────────
      if (request.method === "PATCH" && path.startsWith("/sesiones/")) {
        const pageId = path.slice("/sesiones/".length);
        const body   = await request.json();
        const resp   = await notionFetch(`/pages/${pageId}`, {
          method: "PATCH",
          body: JSON.stringify({ properties: buildProperties(body) }),
        });
        const data = await resp.json();
        if (!resp.ok) return json(data, resp.status);
        return json({ id: data.id });
      }

      // ── DELETE /sesiones/:id ──────────────────────────────
      if (request.method === "DELETE" && path.startsWith("/sesiones/")) {
        const pageId = path.slice("/sesiones/".length);
        const resp   = await notionFetch(`/pages/${pageId}`, {
          method: "PATCH",
          body: JSON.stringify({ archived: true }),
        });
        const data = await resp.json();
        if (!resp.ok) return json(data, resp.status);
        return json({ archived: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
