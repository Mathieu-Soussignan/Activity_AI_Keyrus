// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
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
  "Week-end",
  "Autre",
  "Evol",
  "Ano",
  "Incident Applicatif",
  "Ticket Non défini",
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
  "ticket non defini": "Ticket Non défini",
  "non defini": "Ticket Non défini",
  ticket: "Ticket Non défini",

  // ----- Congés
  conge: "Congés",
  conges: "Congés",
  cp: "Congés",
  vacances: "Congés",

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
      "Week-end",
      "Autre",
      "Evol",
      "Ano",
      "Incident Applicatif",
      "Ticket Non défini"
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
- Projet: choisis au plus proche dans cette liste si pertinent: ${JSON.stringify(knownProjects)}
- Si manque temps total -> mets 7h par défaut réparties (ex: 3.5 + 3.5) si plusieurs lignes, sinon 7h sur une ligne.
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

    return res.json({ rows: validated });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/activities/upsertDay
 * Replaces the whole day (delete then insert)
 * Auth required
 */
app.post("/api/activities/upsertDay", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const schema = z.object({
      day: z.string().min(10),
      rows: z.array(RowInputSchema),
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
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Autre",
      impute: r.impute ?? "",
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
 * (Useful if you ever want "add" semantics; typically Save should remain upsert.)
 */
app.post("/api/activities/appendDay", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const schema = z.object({
      day: z.string().min(10),
      rows: z.array(RowInputSchema),
    });
    const body = schema.parse(req.body);

    const payload = body.rows.map((r) => ({
      user_id: user.id,
      day: body.day,
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Autre",
      impute: r.impute ?? "",
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
  rows: z.array(RowInputSchema),
});

app.post("/api/pm/activities/upsertDayForUser", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const body = UpsertForUserSchema.parse(req.body);
    const supabaseUser = supabaseForJwt(jwt);

    // delete existing for that user/day
    const { error: dErr } = await supabaseUser
      .from("activities")
      .delete()
      .eq("user_id", body.userId)
      .eq("day", body.day);

    if (dErr) throw new Error(dErr.message);

    const payload = body.rows.map((r) => ({
      user_id: body.userId,
      day: body.day,
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Autre",
      impute: r.impute ?? "",
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
      .select("day, sujet, projet, temps_passe_h, type, impute")
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

    const q = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .parse(req.query);

    const { startStr, endStr } = startEndOfMonth(q.year, q.month);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", user.id)
      .gte("day", startStr)
      .lte("day", endStr)
      .order("day", { ascending: true });

    if (error) throw new Error(error.message);

    const header = "day;sujet;projet;temps_passe_h;type;impute";
    function sanitizeCsvCell(v) {
      let s = String(v ?? "")
        .replaceAll(";", ",")
        .replaceAll("\n", " ")
        .replaceAll("\r", " ");

      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return s;
    }
    const lines = (data ?? []).map((r) =>
      [r.day, r.sujet, r.projet, r.temps_passe_h, r.type, r.impute]
        .map((v) =>
          String(v ?? "")
            .replaceAll(";", ",")
            .replaceAll("\n", " ")
            .replaceAll("\r", " ")
        )
        .join(";")
    );

    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_${q.year}-${String(q.month).padStart(
        2,
        "0"
      )}.csv"`
    );
    const csvWithBom = "\uFEFF" + csv;
    return res.send(csvWithBom);
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
      .select("id, user_id, day, sujet, projet, temps_passe_h, type, impute")
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
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const q = z.object({
      from: z.string().min(10),
      to: z.string().min(10),
      userId: z.string().optional(), // optionnel
    }).parse(req.query);

    const supabaseUser = supabaseForJwt(jwt);

    const { data: profiles, error: pErr } = await supabaseUser
      .from("profiles")
      .select("id, full_name, role");
    if (pErr) throw new Error(pErr.message);

    const nameById = new Map((profiles ?? []).map(p => [p.id, (p.full_name ?? "").trim() || p.id]));

    let query = supabaseUser
      .from("activities")
      .select("user_id, day, sujet, projet, temps_passe_h, type, impute")
      .gte("day", q.from)
      .lte("day", q.to)
      .order("user_id", { ascending: true })
      .order("day", { ascending: true });

    if (q.userId) query = query.eq("user_id", q.userId);

    const { data: acts, error: aErr } = await query;
    if (aErr) throw new Error(aErr.message);

    const header = "full_name;user_id;day;sujet;projet;temps_passe_h;type;impute";
    const lines = (acts ?? []).map(r => [
      nameById.get(r.user_id) ?? r.user_id,
      r.user_id,
      r.day,
      r.sujet,
      r.projet,
      r.temps_passe_h,
      r.type,
      r.impute,
    ].map(sanitizeCsvCell).join(";"));

    const csv = [header, ...lines].join("\n");
    const csvWithBom = "\uFEFF" + csv;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="activities_CP_${q.from}_to_${q.to}${q.userId ? "_"+q.userId : ""}.csv"`
    );
    return res.send(csvWithBom);
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
      .select("user_id, day, sujet, projet, temps_passe_h, type, impute")
      .gte("day", startStr)
      .lte("day", endStr)
      .order("user_id", { ascending: true })
      .order("day", { ascending: true });

    if (aErr) throw new Error(aErr.message);

    // 3) CSV
    const header = "full_name;user_id;day;sujet;projet;temps_passe_h;type;impute";
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

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`✅ server on http://localhost:${port}`));