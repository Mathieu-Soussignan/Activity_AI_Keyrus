// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import ExcelJS from "exceljs";
import { Mistral } from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";

const app = express();

/**
 * ---------------------------
 * CORS
 * ---------------------------
 */
const allowedOrigins = [
  "http://localhost:5173",
  "https://activity-ai-keyrus.vercel.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // autoriser Postman / SSR / server-to-server
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

/**
 * ---------------------------
 * ENV sanity checks
 * ---------------------------
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.warn(`⚠️ Missing env var: ${name}`);
  }
  return v ?? "";
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY"); // IMPORTANT: needed for user-scoped client
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

/**
 * ---------------------------
 * Clients
 * ---------------------------
 */
const mistral = new Mistral({
  apiKey: MISTRAL_API_KEY,
});

// Admin: ONLY for auth.getUser(jwt) + admin-only operations
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// User-scoped client (RLS compatible): anon key + Bearer jwt
function supabaseForJwt(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * ---------------------------
 * Helpers
 * ---------------------------
 */
async function getUserFromBearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;

  const jwt = m[1];
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) return null;

  return { user: data.user, jwt };
}

async function getRole(userId) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("role, full_name")
    .eq("id", userId)
    .single();

  if (error) throw new Error(error.message || "Role lookup failed");
  return data; // { role, full_name }
}

function mistralContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
      .join("");
  }
  return "";
}

const ADO_BASE_URL = process.env.ADO_BASE_URL || "https://scp-tma-flux.visualstudio.com";
const ADO_PROJECT_NAME = process.env.ADO_PROJECT_NAME || "Gestion des tickets";

function adoWorkItemUrl(idTicket) {
  const id = String(idTicket ?? "").trim();
  if (!/^\d+$/.test(id)) return ""; // si vide ou non-numérique
  return `${ADO_BASE_URL}/${encodeURIComponent(ADO_PROJECT_NAME)}/_workitems/edit/${id}/`;
}

/**
 * ---------------------------
 * Hours per day (max)
 * ---------------------------
 */
const HOURS_PER_DAY = 7;

/**
 * ---------------------------
 * Activity types (ALIGN with Supabase enum)
 * Supabase enum currently: Travail, Réunion, Support, Congés, Week-end, Autre
 * ---------------------------
 */
const ActivityType = [
  "Travail",
  "Réunion",
  "Support",
  "Projet",
  "Congés",
  "Alternance",
  "Week-end",
  "Autre",
  "Evol",
  "Ano",
  "Incident Applicatif",
  "Non défini",
];

// Normalisation robuste (accents, tirets, variantes)
function normalizeType(v) {
  const s0 = String(v ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width
    .trim()
    .normalize("NFC");

  const simplified = s0
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const map = {
    // ----- Travail
    travail: "Travail",
    dev: "Travail",
    developpement: "Travail",
    developper: "Travail",
    "dev sur": "Travail",

    // ----- Réunion
    reunion: "Réunion",
    meeting: "Réunion",
    daily: "Réunion",
    point: "Réunion",
    sync: "Réunion",

    // ----- Support (hors incident applicatif)
    support: "Support",
    assistance: "Support",
    debug: "Support",
    bug: "Support",
    correction: "Support",

    // ----- Incident Applicatif
    incident: "Incident Applicatif",
    "incident applicatif": "Incident Applicatif",
    "incident appli": "Incident Applicatif",
    "incident application": "Incident Applicatif",

    // ----- Projet
    projet: "Projet",
    project: "Projet",

    // ----- Evol (legacy)
    evol: "Evol",
    evolution: "Evol",
    "evolution technique": "Evol",
    "feature": "Evol",

    // ----- Ano (legacy)
    ano: "Ano",
    anomalie: "Ano",
    anomalies: "Ano",

    // ----- Ticket Non défini (legacy)
    "ticket non defini": "Non défini",
    "non defini": "Non défini",
    ticket: "Non défini",

    // ----- Congés
    conge: "Congés",
    conges: "Congés",
    cp: "Congés",
    vacances: "Congés",

    // ----- Alternance
    alternance: "Alternance",
    ecole: "Alternance",
    cfa: "Alternance",
    cours: "Alternance",
    formation: "Alternance",    // si le LLM dit “formation”
    "formation ia": "Alternance",

    // ----- Week-end
    weekend: "Week-end",
    "week end": "Week-end",
    "week-end": "Week-end",
    we: "Week-end",

    // ----- Autre
    autre: "Autre",
    divers: "Autre",
  };

  if (ActivityType.includes(s0)) return s0;
  return map[simplified] ?? "Autre";
}

/**
 * ---------------------------
 * Schemas
 * ---------------------------
 */

// Row input coming from client (without day)
const RowInputSchema = z.object({
  id_ticket: z.string().default(""),
  sujet: z.string().default(""),
  projet: z.string().default(""),
  temps_passe_h: z.coerce.number().min(0).max(24).default(0),
  type: z.preprocess(
    (v) => normalizeType(v),
    z.enum([
      "Travail",
      "Réunion",
      "Support",
      "Projet",
      "Congés",
      "Alternance",
      "Week-end",
      "Autre",
      "Evol",
      "Ano",
      "Incident Applicatif",
      "Non défini"
    ])
  ),
  impute: z.string().default(""),
});

// Row stored/returned with day included
const RowWithDaySchema = RowInputSchema.extend({
  day: z.string().min(10), // YYYY-MM-DD
});

const AiParseSchema = z.object({
  text: z.string().min(1),
  day: z.string().min(10),
  knownProjects: z.array(z.string()).optional(),
});

/**
 * ---------------------------
 * Routes
 * ---------------------------
 */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/keepalive", async (req, res) => {
  try {
    // micro requête DB (RLS safe via service role)
    const { error } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .limit(1);

    if (error) throw new Error(error.message);
    return res.json({ ok: true, ts: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "keepalive failed" });
  }
});

/**
 * GET /api/me
 */
app.get("/api/me", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user } = auth;
    const prof = await getRole(user.id);

    return res.json({
      id: user.id,
      email: user.email,
      role: prof.role,
      full_name: prof.full_name,
    });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/ai/parse
 * Auth required
 * Returns rows for that day (no DB write here)
 */

// util interne pour s'assurer que la somme des temps <= 7h
function capRowsToOneDay(rows, maxHours = HOURS_PER_DAY) {
  // nettoie et force les nombres positifs
  const cleaned = rows.map((r) => ({
    ...r,
    temps_passe_h: Math.max(0, Number(r.temps_passe_h || 0)),
  }));

  const total = cleaned.reduce((acc, r) => acc + r.temps_passe_h, 0);

  if (total <= maxHours || total === 0) return cleaned;

  const factor = maxHours / total;

  let scaled = cleaned.map((r) => ({
    ...r,
    temps_passe_h: Math.round(r.temps_passe_h * factor * 100) / 100, // 2 décimales
  }));

  // correction de l'arrondi pour coller exactement à maxHours
  const total2 = scaled.reduce((acc, r) => acc + r.temps_passe_h, 0);
  let delta = Math.round((maxHours - total2) * 100) / 100;

  if (delta !== 0 && scaled.length > 0) {
    // on ajuste la plus grosse ligne
    let idx = 0;
    for (let i = 1; i < scaled.length; i++) {
      if (scaled[i].temps_passe_h > scaled[idx].temps_passe_h) idx = i;
    }
    scaled[idx].temps_passe_h = Math.max(
      0,
      Math.round((scaled[idx].temps_passe_h + delta) * 100) / 100
    );
  }

  // sécurité finale : ne jamais dépasser maxHours
  const finalTotal = scaled.reduce((acc, r) => acc + r.temps_passe_h, 0);
  if (finalTotal > maxHours && scaled.length > 0) {
    const over = Math.round((finalTotal - maxHours) * 100) / 100;
    let idx = 0;
    for (let i = 1; i < scaled.length; i++) {
      if (scaled[i].temps_passe_h > scaled[idx].temps_passe_h) idx = i;
    }
    scaled[idx].temps_passe_h = Math.max(
      0,
      Math.round((scaled[idx].temps_passe_h - over) * 100) / 100
    );
  }

  return scaled;
}

app.post("/api/ai/parse", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    // If Mistral isn't configured, fail clearly (not 401/400 confusing errors)
    if (!MISTRAL_API_KEY || !String(MISTRAL_API_KEY).trim()) {
      return res.status(500).json({
        error: "MISTRAL_NOT_CONFIGURED",
        message: "MISTRAL_API_KEY is missing on the backend.",
      });
    }

    const body = AiParseSchema.parse(req.body);
    const knownProjects = body.knownProjects ?? [];

    const system = `
Tu aides un développeur Keyrus à remplir sa feuille d'activité journalière.

Tu renvoies UNIQUEMENT un JSON valide (aucun texte hors JSON), format EXACT:
{
  "rows": [
    { "day":"YYYY-MM-DD", "sujet":"", "projet":"", "temps_passe_h": number, "type":"${ActivityType.join(
      "|"
    )}", "impute":"" }
  ]
}

Règles:
- Chaque tâche différente = une ligne différente (tu peux en mettre plusieurs).
- Si "matin/aprem" -> tu peux faire 2+ rows (même day).
- Types autorisés STRICTS: ${JSON.stringify(ActivityType)}
- Si week-end ou congés -> type "Week-end" ou "Congés", temps_passe_h = 0 et sujet "Week-end"/"Congés".
- Si type non clair -> "Autre".
- Projet: choisis au plus proche dans cette liste si pertinent: ${JSON.stringify(
      knownProjects
    )}
- La SOMME de tous les "temps_passe_h" pour la journée DOIT être <= 7 (heures).
- Si manque temps total -> répartis AU MAXIMUM 7h (par ex: 3.5 + 3.5) si plusieurs lignes, sinon 7h sur une ligne.
- La réponse DOIT commencer par { et finir par }.
`;

    const response = await mistral.chat.complete({
      model: MISTRAL_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Jour: ${body.day}\nTexte: ${body.text}\nRenvoie le JSON demandé.`,
        },
      ],
    });

    const content = response?.choices?.[0]?.message?.content;
    const outText = mistralContentToText(content);

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      const m = outText.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Réponse IA non-JSON.");
      parsed = JSON.parse(m[0]);
    }

    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];

    // Validate + normalize + force correct day
    const validated = rows.map((r) =>
      RowWithDaySchema.parse({
        ...r,
        day: body.day,
      })
    );

    // Cap dur à 7h max pour la journée
    const capped = capRowsToOneDay(validated, HOURS_PER_DAY);

    return res.json({ rows: capped });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

app.post("/api/activities/upsertDay", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const schema = z
      .object({
        day: z.string().min(10),
        rows: z.array(RowInputSchema),
      })
      .superRefine((val, ctx) => {
        const total = (val.rows ?? []).reduce(
          (acc, r) => acc + Number(r?.temps_passe_h ?? 0),
          0
        );

        if (total > HOURS_PER_DAY + 1e-9) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Total journée > ${HOURS_PER_DAY}h interdit (reçu: ${Math.round(total * 100) / 100}h).`,
            path: ["rows"],
          });
        }
      });

    const body = schema.parse(req.body);

    // Delete existing activities for that day (as user)
    const { error: dErr } = await supabaseUser
      .from("activities")
      .delete()
      .eq("user_id", user.id)
      .eq("day", body.day);

    if (dErr) throw new Error(dErr.message);

    const payload = body.rows.map((r) => ({
      user_id: user.id,
      day: body.day,
      id_ticket: r.id_ticket ?? "",
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Autre",
      // impute volontairement absent (PM only)
    }));

    const { data, error } = await supabaseUser
      .from("activities")
      .insert(payload)
      .select();

    if (error) throw new Error(error.message);

    return res.json({ ok: true, inserted: data?.length ?? 0 });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/activities/appendDay
 * Adds rows for a day WITHOUT deleting existing ones.
 * Auth required
 */
app.post("/api/activities/appendDay", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    // 1) parse input + check sum(rows) <= 7 (au moins)
    const schema = z
      .object({
        day: z.string().min(10),
        rows: z.array(RowInputSchema).min(1),
      })
      .superRefine((val, ctx) => {
        const added = (val.rows ?? []).reduce(
          (acc, r) => acc + Number(r?.temps_passe_h ?? 0),
          0
        );

        if (added > HOURS_PER_DAY + 1e-9) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Ajout > ${HOURS_PER_DAY}h interdit (reçu: ${Math.round(added * 100) / 100}h).`,
            path: ["rows"],
          });
        }
      });

    const body = schema.parse(req.body);

    // 2) calcule le total déjà existant sur ce jour (DB)
    const { data: existing, error: exErr } = await supabaseUser
      .from("activities")
      .select("temps_passe_h")
      .eq("user_id", user.id)
      .eq("day", body.day);

    if (exErr) throw new Error(exErr.message);

    const existingTotal = (existing ?? []).reduce(
      (acc, r) => acc + Number(r?.temps_passe_h ?? 0),
      0
    );

    // 3) calcule le total ajouté
    const addedTotal = body.rows.reduce(
      (acc, r) => acc + Number(r?.temps_passe_h ?? 0),
      0
    );

    const finalTotal = existingTotal + addedTotal;

    if (finalTotal > HOURS_PER_DAY + 1e-9) {
      return res.status(400).json({
        error: `Total journée > ${HOURS_PER_DAY}h interdit (existant: ${Math.round(existingTotal * 100) / 100}h, ajout: ${Math.round(addedTotal * 100) / 100}h).`,
      });
    }

    // 4) insert (impute absent : PM-only)
    const payload = body.rows.map((r) => ({
      user_id: user.id,
      day: body.day,
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Autre",
    }));

    const { data, error } = await supabaseUser
      .from("activities")
      .insert(payload)
      .select();

    if (error) throw new Error(error.message);

    return res.json({ ok: true, inserted: data?.length ?? 0 });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * PM only: upsert for another user/day
 */
const UpsertForUserSchema = z.object({
  userId: z.string().min(1),
  day: z.string().min(10),
  rows: z.array(RowInputSchema).min(1),
});

const UpsertForUserSchemaWithLimit = UpsertForUserSchema.superRefine((val, ctx) => {
  const total = (val.rows ?? []).reduce(
    (acc, r) => acc + Number(r?.temps_passe_h ?? 0),
    0
  );
  if (total > HOURS_PER_DAY + 1e-9) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Total journée > ${HOURS_PER_DAY}h interdit (reçu: ${Math.round(total * 100) / 100}h).`,
      path: ["rows"],
    });
  }
});

app.post("/api/pm/activities/upsertDayForUser", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const body = UpsertForUserSchemaWithLimit.parse(req.body);
    const supabaseUser = supabaseForJwt(jwt);

    const { error: dErr } = await supabaseUser
      .from("activities")
      .delete()
      .eq("user_id", body.userId)
      .eq("day", body.day);
    if (dErr) throw new Error(dErr.message);

    const payload = body.rows.map((r) => ({
      user_id: body.userId,
      day: body.day,
      id_ticket: r.id_ticket ?? "",
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Autre",
      impute: r.impute ?? "",
    }));

    const { data, error } = await supabaseUser.from("activities").insert(payload).select();
    if (error) throw new Error(error.message);

    return res.json({ ok: true, inserted: data?.length ?? 0 });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/pm/activities/update-vsa
 * PM only: met à jour uniquement "impute" (Code VSA) sur une liste de lignes
 */
const UpdateVsaSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string().min(1),      // uuid (string côté JS)
      impute: z.string().default(""),
    })
  ).min(1),
});

app.post("/api/pm/activities/update-vsa", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const body = UpdateVsaSchema.parse(req.body);

    const supabaseUser = supabaseForJwt(jwt);

    // updates "one by one" (simple, lisible, OK si volume raisonnable)
    // si tu veux optimiser ensuite, on passera par RPC SQL + jsonb_to_recordset.
    let updated = 0;

    for (const r of body.rows) {
      const { error } = await supabaseUser
        .from("activities")
        .update({ impute: r.impute ?? "" })
        .eq("id", r.id);

      if (error) throw new Error(error.message);
      updated += 1;
    }

    return res.json({ ok: true, updated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * GET /api/projects
 */
app.get("/api/projects", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const supabaseUser = supabaseForJwt(auth.jwt);

    const { data, error } = await supabaseUser
      .from("projects")
      .select("name")
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) throw new Error(error.message);
    return res.json({ projects: (data ?? []).map((x) => x.name) });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * GET /api/activities/day?day=YYYY-MM-DD
 */
app.get("/api/activities/day", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const q = z.object({ day: z.string().min(10) }).parse(req.query);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", user.id)
      .eq("day", q.day)
      .order("id", { ascending: true });

    if (error) throw new Error(error.message);

    return res.json({ rows: data ?? [] });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

function startEndOfMonth(year, month1to12) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1));
  const end = new Date(Date.UTC(year, month1to12, 0));
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  return { startStr, endStr };
}

function computeMonthlySummaryStats({
  activities,
  profiles,
  year,
  month,
}) {
  // ---- Totaux
  let totalHours = 0;

  const byType = {};
  const byProject = {};
  const byUser = {};

  for (const p of profiles) {
    byUser[p.id] = {
      userId: p.id,
      name: p.full_name || p.id,
      totalHours: 0,
      days: new Set(),
    };
  }

  for (const a of activities) {
    const h = Number(a.temps_passe_h || 0);
    totalHours += h;

    // by type
    byType[a.type] ??= { hours: 0 };
    byType[a.type].hours += h;

    // by project
    if (a.projet) {
      byProject[a.projet] ??= { hours: 0 };
      byProject[a.projet].hours += h;
    }

    // by user
    const u = byUser[a.user_id];
    if (u) {
      u.totalHours += h;
      u.days.add(a.day);
    }
  }

  const totalDays = Math.round((totalHours / HOURS_PER_DAY) * 100) / 100;

  // enrich byType
  for (const t of Object.keys(byType)) {
    byType[t].days = byType[t].hours / HOURS_PER_DAY;
    byType[t].percent =
      totalHours > 0
        ? Math.round((byType[t].hours / totalHours) * 100)
        : 0;
  }

  const topProjects = Object.entries(byProject)
    .map(([project, v]) => ({
      project,
      hours: v.hours,
      days: v.hours / HOURS_PER_DAY,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 5);

  const usersWithMissingDays = Object.values(byUser).filter(
    (u) => u.days.size < 20 // volontairement simple, ajustable
  );

  return {
    period: { year, month },
    totals: {
      hours: Math.round(totalHours * 10) / 10,
      days: totalDays,
    },
    byType,
    topProjects,
    alerts: {
      usersWithMissingDays: usersWithMissingDays.length,
    },
  };
}

/**
 * GET /api/activities/month?year=YYYY&month=M
 */
app.get("/api/activities/month", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const q = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, temps_passe_h")
      .eq("user_id", user.id)
      .gte("day", startStr)
      .lte("day", endStr);

    if (error) throw new Error(error.message);

    const map = new Map();
    for (const a of data ?? []) {
      const k = a.day;
      const prev = map.get(k) ?? { totalHours: 0, linesCount: 0 };
      prev.totalHours += Number(a.temps_passe_h || 0);
      prev.linesCount += 1;
      map.set(k, prev);
    }

    const daysInMonth = new Date(q.year, q.month, 0).getDate();
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(Date.UTC(q.year, q.month - 1, d));
      const yyyyMMdd = date.toISOString().slice(0, 10);

      const agg = map.get(yyyyMMdd) ?? { totalHours: 0, linesCount: 0 };
      days.push({
        day: yyyyMMdd,
        totalHours: Math.round(agg.totalHours * 10) / 10,
        linesCount: agg.linesCount,
      });
    }

    return res.json({ year: q.year, month: q.month, days });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * GET /api/activities/export?year=YYYY&month=M
 * CSV export
 */
app.get("/api/activities/export", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const q = z.object({
      year: z.coerce.number().int().min(2000).max(2100),
      month: z.coerce.number().int().min(1).max(12),
    }).parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", user.id)
      .gte("day", startStr)
      .lte("day", endStr)
      .order("day", { ascending: true });

    if (error) throw new Error(error.message);

    function sanitizeCsvCell(v) {
      let s = String(v ?? "")
        .replaceAll(";", ",")
        .replaceAll("\n", " ")
        .replaceAll("\r", " ");

      // protège Excel injection
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return s;
    }
    const header = "day;id_ticket;ticket_url;sujet;projet;temps_passe_h;type;impute";

    const lines = (data ?? []).map((r) => {
      const url = adoWorkItemUrl(r.id_ticket); // attention: doit gérer "" / null
      return [
        r.day,
        r.id_ticket,
        url,
        r.sujet,
        r.projet,
        r.temps_passe_h,
        r.type,
        r.impute,
      ].map(sanitizeCsvCell).join(";");
    });

    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_${q.year}-${String(q.month).padStart(2, "0")}.csv"`
    );
    return res.send("\uFEFF" + csv);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

app.get("/api/activities/export-xlsx", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const q = z.object({
      year: z.coerce.number().int().min(2000).max(2100),
      month: z.coerce.number().int().min(1).max(12),
    }).parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", user.id)
      .gte("day", startStr)
      .lte("day", endStr)
      .order("day", { ascending: true })
      .order("id", { ascending: true });

    if (error) throw new Error(error.message);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Activity AI";
    wb.created = new Date();

    const ws = wb.addWorksheet(`activities_${q.year}-${String(q.month).padStart(2, "0")}`);

    // Colonnes Excel
    ws.columns = [
      { header: "Date", key: "day", width: 12 },
      { header: "ID Ticket", key: "id_ticket", width: 18 },
      { header: "Sujet", key: "sujet", width: 50 },
      { header: "Projet", key: "projet", width: 18 },
      { header: "Charge réelle (h)", key: "temps_passe_h", width: 16 },
      { header: "Type", key: "type", width: 20 },
      { header: "Code VSA", key: "impute", width: 18 },
    ];

    // Header style + filter
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: ws.columns.length },
    };

    // Format colonnes
    ws.getColumn("temps_passe_h").numFmt = "0.00";

    // Data rows + Hyperlink sur ID Ticket
    for (const r of data ?? []) {
      const row = ws.addRow({
        day: r.day,
        id_ticket: String(r.id_ticket ?? "").trim(),
        sujet: r.sujet ?? "",
        projet: r.projet ?? "",
        temps_passe_h: Number(r.temps_passe_h ?? 0),
        type: r.type ?? "",
        impute: r.impute ?? "",
      });

      const idTicket = String(r.id_ticket ?? "").trim();
      if (idTicket) {
        const url = adoWorkItemUrl(idTicket);
        if (url) {
          const cell = row.getCell("id_ticket"); // key-based
          cell.value = { text: idTicket, hyperlink: url };
          cell.font = { color: { argb: "FF2563EB" }, underline: true };
        }
      }
    }

    // Response
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_${q.year}-${String(q.month).padStart(2, "0")}.xlsx"`
    );

    const buffer = await wb.xlsx.writeBuffer();
    return res.send(Buffer.from(buffer));
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * Profile completion
 */
const CompleteProfileSchema = z.object({
  full_name: z.string().min(1),
  roleWanted: z.enum(["dev", "pm"]).default("dev"),
});

function isKeyrusEmail(email) {
  return typeof email === "string" && email.toLowerCase().endsWith("@keyrus.com");
}

function isAllowedPm(email) {
  const allowed = String(process.env.PM_ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return allowed.includes(String(email || "").toLowerCase());
}

app.post("/api/profile/complete", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user } = auth;
    const body = CompleteProfileSchema.parse(req.body);

    if (!isKeyrusEmail(user.email)) {
      return res.status(403).json({ error: "Email non autorisé (keyrus.com requis)." });
    }

    let finalRole = "dev";
    if (body.roleWanted === "pm") {
      if (!isAllowedPm(user.email)) {
        return res.status(403).json({ error: "Tu n'es pas autorisé à être CP (pm)." });
      }
      finalRole = "pm";
    }

    const { error: upsertErr } = await supabaseAdmin
      .from("profiles")
      .upsert({ id: user.id, full_name: body.full_name, role: finalRole }, { onConflict: "id" });

    if (upsertErr) throw new Error(upsertErr.message);

    const { error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      app_metadata: { role: finalRole },
    });

    if (metaErr) {
      await supabaseAdmin.from("profiles").update({ role: "dev" }).eq("id", user.id);
      throw new Error(metaErr.message);
    }

    return res.json({ ok: true, role: finalRole });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * GET /api/pm/summary?year=YYYY&month=MM
 * PM only – calculs purs
 */
app.get("/api/pm/summary", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z
      .object({
        year: z.coerce.number().int(),
        month: z.coerce.number().int().min(1).max(12),
      })
      .parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);
    const supabaseUser = supabaseForJwt(jwt);

    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name");
    if (pErr) throw new Error(pErr.message);

    const { data: activities, error: aErr } = await supabaseUser
      .from("activities")
      .select("user_id, day, temps_passe_h, type, projet")
      .gte("day", startStr)
      .lte("day", endStr);
    if (aErr) throw new Error(aErr.message);

    const stats = computeMonthlySummaryStats({
      profiles,
      activities,
      year: q.year,
      month: q.month,
    });

    return res.json(stats);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/pm/summary/ai
 * Reformulation uniquement
 */
app.post("/api/pm/summary/ai", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const body = z.object({
      stats: z.any(),
    }).parse(req.body);

    const system = `
Tu es un assistant de rédaction professionnelle.
Tu ne fais AUCUN calcul.
Tu reformules uniquement les données fournies.

Structure STRICTE :
1. Introduction (1 phrase)
2. Trois faits marquants
3. Deux points de vigilance
4. Conclusion (1 phrase)

Aucune supposition. Aucune interprétation humaine.
`;

    const response = await mistral.chat.complete({
      model: MISTRAL_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify(body.stats),
        },
      ],
    });

    const content = mistralContentToText(
      response?.choices?.[0]?.message?.content
    );

    return res.json({ summary: content });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * PM Dashboard: GET /api/pm/completion?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
app.get("/api/pm/completion", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const { role } = await getRole(user.id);
    if (role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z.object({ from: z.string().min(10), to: z.string().min(10) }).parse(req.query);
    const supabaseUser = supabaseForJwt(jwt);

    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name, role");
    if (pErr) throw new Error(pErr.message);

    const { data: acts, error: aErr } = await supabaseUser
      .from("activities")
      .select("user_id, day, temps_passe_h, type")
      .gte("day", q.from)
      .lte("day", q.to);
    if (aErr) throw new Error(aErr.message);

    const map = new Map();
    for (const prof of profiles ?? []) {
      map.set(prof.id, {
        days: new Set(),
        hours: 0,
        name: prof.full_name || prof.id,
        role: prof.role,
      });
    }

    for (const a of acts ?? []) {
      const st = map.get(a.user_id);
      if (!st) continue;
      st.days.add(a.day);
      st.hours += Number(a.temps_passe_h || 0);
    }

    const result = Array.from(map.entries()).map(([userId, st]) => ({
      userId,
      name: st.name,
      role: st.role,
      filledDays: st.days.size,
      totalHours: Math.round(st.hours * 10) / 10,
    }));

    return res.json({ from: q.from, to: q.to, users: result });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/*
 * PM Dashboard: GET /api/pm/activities?userId=UUID&from=YYYY-MM-DD&to=YYYY-MM-DD
 * PM only: récupère les activités d'un user entre deux dates
 */
app.get("/api/pm/activities", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z.object({
      userId: z.string().min(1),
      from: z.string().min(10),
      to: z.string().min(10),
    }).parse(req.query);

    const supabaseUser = supabaseForJwt(jwt);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("id, user_id, day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", q.userId)
      .gte("day", q.from)
      .lte("day", q.to)
      .order("day", { ascending: true })
      .order("id", { ascending: true });

    if (error) throw new Error(error.message);
    return res.json({ userId: q.userId, from: q.from, to: q.to, rows: data ?? [] });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * PM Dashboard: GET /api/pm/export-range?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=UUID
 * PM only: export CSV global (tous les users) avec full_name
 */
app.get("/api/pm/export-range", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;

    // check role via admin (source of truth)
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      userId: z.string().optional(),
    }).parse(req.query);

    const supabaseUser = supabaseForJwt(jwt);

    // profiles map
    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name, role");
    if (pErr) throw new Error(pErr.message);

    const nameById = new Map(
      (profiles ?? []).map((p) => [p.id, (p.full_name ?? "").trim() || p.id])
    );

    // activities range
    let actsQ = supabaseUser
      .from("activities")
      .select("user_id, day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .gte("day", q.from)
      .lte("day", q.to)
      .order("user_id", { ascending: true })
      .order("day", { ascending: true });

    if (q.userId) actsQ = actsQ.eq("user_id", q.userId);

    const { data: acts, error: aErr } = await actsQ;
    if (aErr) throw new Error(aErr.message);

    // CSV safe cells
    function sanitizeCsvCell(v) {
      let s = String(v ?? "")
        .replaceAll(";", ",")
        .replaceAll("\n", " ")
        .replaceAll("\r", " ");

      // protège Excel injection
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return s;
    }

    const header = "full_name;user_id;day;id_ticket;ticket_url;sujet;projet;temps_passe_h;type;impute";
    const lines = (acts ?? []).map((r) => {
      const fullName = nameById.get(r.user_id) ?? r.user_id;
      return [
        fullName,
        r.user_id,
        r.day,
        r.id_ticket,
        adoWorkItemUrl(r.id_ticket),
        r.sujet,
        r.projet,
        r.temps_passe_h,
        r.type,
        r.impute,
      ].map(sanitizeCsvCell).join(";");
    });

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_CP_${q.from}_to_${q.to}${q.userId ? `_user_${q.userId}` : ""}.csv"`
    );

    return res.send("\uFEFF" + csv);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * GET /api/pm/export?year=YYYY&month=M
 * PM only: export CSV global (tous les users) avec full_name
 */
app.get("/api/pm/export", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;

    // Vérif rôle PM
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);

    // On utilise un client user-scoped (jwt du PM) pour respecter RLS
    // (à condition que tes policies autorisent le PM à lire profiles + activities)
    const supabaseUser = supabaseForJwt(jwt);

    // 1) Profiles: id -> full_name (+ role si tu veux)
    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name, role");
    if (pErr) throw new Error(pErr.message);

    const nameById = new Map(
      (profiles ?? []).map((p) => [p.id, (p.full_name ?? "").trim() || p.id])
    );

    // 2) Activities du mois (tous users)
    const { data: acts, error: aErr } = await supabaseUser
      .from("activities")
      .select("user_id, day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .gte("day", startStr)
      .lte("day", endStr)
      .order("user_id", { ascending: true })
      .order("day", { ascending: true });

    if (aErr) throw new Error(aErr.message);

    // 3) CSV
    const header = "full_name;user_id;day;id_ticket;ticket_url;sujet;projet;temps_passe_h;type;impute";
    function sanitizeCsvCell(v) {
      let s = String(v ?? "")
        .replaceAll(";", ",")
        .replaceAll("\n", " ")
        .replaceAll("\r", " ");

      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return s;
    }
    const lines = (acts ?? []).map((r) => {
      const fullName = nameById.get(r.user_id) ?? r.user_id;

      return [
        fullName,
        r.user_id,
        r.day,
        r.id_ticket,
        adoWorkItemUrl(r.id_ticket),
        r.sujet,
        r.projet,
        r.temps_passe_h,
        r.type,
        r.impute,
      ]
        .map((v) =>
          String(v ?? "")
            .replaceAll(";", ",")
            .replaceAll("\n", " ")
            .replaceAll("\r", " ")
        )
        .join(";");
    });

    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_CP_${q.year}-${String(q.month).padStart(2, "0")}.csv"`
    );

    const csvWithBom = "\uFEFF" + csv;
    return res.send(csvWithBom);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

app.get("/api/pm/export-range-xlsx", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      userId: z.string().optional(),
    }).parse(req.query);

    const supabaseUser = supabaseForJwt(jwt);

    // profiles map
    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name, role");
    if (pErr) throw new Error(pErr.message);

    const nameById = new Map(
      (profiles ?? []).map((p) => [p.id, (p.full_name ?? "").trim() || p.id])
    );

    // activities range
    let actsQ = supabaseUser
      .from("activities")
      .select("user_id, day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .gte("day", q.from)
      .lte("day", q.to)
      .order("user_id", { ascending: true })
      .order("day", { ascending: true });

    if (q.userId) actsQ = actsQ.eq("user_id", q.userId);

    const { data: acts, error: aErr } = await actsQ;
    if (aErr) throw new Error(aErr.message);

    // --- Excel
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Activities");

    ws.columns = [
      { header: "Nom", key: "full_name", width: 22 },
      { header: "User ID", key: "user_id", width: 36 },
      { header: "Date", key: "day", width: 12 },
      { header: "ID Ticket", key: "id_ticket", width: 14 },
      { header: "Sujet", key: "sujet", width: 40 },
      { header: "Projet", key: "projet", width: 18 },
      { header: "Temps (h)", key: "temps_passe_h", width: 10 },
      { header: "Type", key: "type", width: 18 },
      { header: "Code VSA", key: "impute", width: 16 },
    ];

    ws.getRow(1).font = { bold: true };
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: ws.columns.length },
    };

    for (const r of acts ?? []) {
      const fullName = nameById.get(r.user_id) ?? r.user_id;
      const row = ws.addRow({
        full_name: fullName,
        user_id: r.user_id,
        day: r.day,
        id_ticket: r.id_ticket ?? "",
        sujet: r.sujet ?? "",
        projet: r.projet ?? "",
        temps_passe_h: Number(r.temps_passe_h ?? 0),
        type: r.type ?? "",
        impute: r.impute ?? "",
      });

      // Hyperlink sur ID Ticket si numérique
      const url = adoWorkItemUrl(r.id_ticket);
      if (url) {
        const cell = row.getCell("id_ticket");
        cell.value = { text: String(r.id_ticket), hyperlink: url };
        cell.font = { color: { argb: "FF10B981" }, underline: true };
      }
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_CP_${q.from}_to_${q.to}${q.userId ? `_user_${q.userId}` : ""}.xlsx"`
    );

    await wb.xlsx.write(res);
    return res.end();
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

app.get("/api/pm/export-xlsx", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z.object({
      year: z.coerce.number().int().min(2000).max(2100),
      month: z.coerce.number().int().min(1).max(12),
    }).parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);
    const supabaseUser = supabaseForJwt(jwt);

    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name, role");
    if (pErr) throw new Error(pErr.message);

    const nameById = new Map(
      (profiles ?? []).map((p) => [p.id, (p.full_name ?? "").trim() || p.id])
    );

    const { data: acts, error: aErr } = await supabaseUser
      .from("activities")
      .select("user_id, day, id_ticket, sujet, projet, temps_passe_h, type, impute")
      .gte("day", startStr)
      .lte("day", endStr)
      .order("user_id", { ascending: true })
      .order("day", { ascending: true });

    if (aErr) throw new Error(aErr.message);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Activities");

    ws.columns = [
      { header: "Nom", key: "full_name", width: 22 },
      { header: "User ID", key: "user_id", width: 36 },
      { header: "Date", key: "day", width: 12 },
      { header: "ID Ticket", key: "id_ticket", width: 14 },
      { header: "Sujet", key: "sujet", width: 40 },
      { header: "Projet", key: "projet", width: 18 },
      { header: "Temps (h)", key: "temps_passe_h", width: 10 },
      { header: "Type", key: "type", width: 18 },
      { header: "Code VSA", key: "impute", width: 16 },
    ];

    ws.getRow(1).font = { bold: true };
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: ws.columns.length },
    };

    for (const r of acts ?? []) {
      const fullName = nameById.get(r.user_id) ?? r.user_id;
      const row = ws.addRow({
        full_name: fullName,
        user_id: r.user_id,
        day: r.day,
        id_ticket: r.id_ticket ?? "",
        sujet: r.sujet ?? "",
        projet: r.projet ?? "",
        temps_passe_h: Number(r.temps_passe_h ?? 0),
        type: r.type ?? "",
        impute: r.impute ?? "",
      });

      const url = adoWorkItemUrl(r.id_ticket);
      if (url) {
        const cell = row.getCell("id_ticket");
        cell.value = { text: String(r.id_ticket), hyperlink: url };
        cell.font = { color: { argb: "FF10B981" }, underline: true };
      }
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_CP_${q.year}-${String(q.month).padStart(2, "0")}.xlsx"`
    );

    await wb.xlsx.write(res);
    return res.end();
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`✅ server on http://localhost:${port}`));