// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { Mistral } from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";

const app = express();
const allowedOrigins = [
  "http://localhost:5173",
  "https://activity-ai-keyrus.vercel.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // autoriser Postman / SSR / server-to-server
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

// ---------- Clients ----------
const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY ?? "",
});

// Admin: ONLY for auth.getUser(jwt) + admin-only tables (if any)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

// User-scoped client (RLS compatible): anon/publishable key + Bearer jwt
function supabaseForJwt(jwt) {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_ANON_KEY ?? "",
    {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}

// ---------- Helpers ----------
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
  // NOTE: if profiles is RLS protected, this must be readable for self.
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("role, full_name")
    .eq("id", userId)
    .single();

  if (error) throw new Error(error.message || "Role lookup failed");
  return data; // { role, full_name }
}

function mistralContentToText(content) {
  // SDK can return string or array of blocks
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
      .join("");
  }
  return "";
}

// ---------- Schemas ----------

// Types attendus côté Keyrus
const ActivityType = [
  "Evol",
  "Ano",
  "Incident Applicatif",
  "Projet",
  "Ticket Non défini",
  "Congés",
  "Week-end",
];

// Normalisation robuste (accents, tirets, variantes)
function normalizeType(v) {
  const s0 = String(v ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width
    .trim()
    .normalize("NFC");

  // helpers : on “simplifie” pour matcher large
  const simplified = s0
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const map = {
    // Evol
    evol: "Evol",
    evolution: "Evol",
    evo: "Evol",

    // Ano
    ano: "Ano",
    anomalie: "Ano",
    anomalies: "Ano",

    // Incident Applicatif
    incident: "Incident Applicatif",
    "incident applicatif": "Incident Applicatif",
    "incident application": "Incident Applicatif",
    "incident appli": "Incident Applicatif",
    "incident applic": "Incident Applicatif",

    // Projet
    projet: "Projet",
    projets: "Projet",
    project: "Projet",

    // Ticket Non défini
    "ticket non defini": "Ticket Non défini",
    "non defini": "Ticket Non défini",
    "non défini": "Ticket Non défini",
    "non-defini": "Ticket Non défini",
    ticket: "Ticket Non défini",

    // Congés
    conge: "Congés",
    conges: "Congés",
    "congés": "Congés",
    cp: "Congés",
    vacances: "Congés",

    // Week-end
    weekend: "Week-end",
    "week end": "Week-end",
    "week-end": "Week-end",
    we: "Week-end",
  };

  // Match direct sur original s0 si déjà clean
  if (ActivityType.includes(s0)) return s0;

  // Match sur la version simplifiée
  return map[simplified] ?? s0;
}

const RowSchema = z.object({
  day: z.string().min(10), // YYYY-MM-DD
  sujet: z.string().default(""),
  projet: z.string().default(""),
  temps_passe_h: z.coerce.number().min(0).max(24).default(0),
  type: z.preprocess(
    (v) => normalizeType(v),
    z
      .enum([
        "Evol",
        "Ano",
        "Incident Applicatif",
        "Projet",
        "Ticket Non défini",
        "Congés",
        "Week-end",
      ])
      .default("Ticket Non défini")
  ),
  impute: z.string().default(""),
});

const AiParseSchema = z.object({
  text: z.string().min(1),
  day: z.string().min(10),
  knownProjects: z.array(z.string()).optional(),
});

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/me
 * Auth required
 * Returns basic user info + role/full_name from profiles
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
 * Auth required (Bearer user JWT)
 * Returns rows (for that day) ready to insert into activities
 */
app.post("/api/ai/parse", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

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
- Si type non clair -> "Ticket Non défini".
- Projet: choisis au plus proche dans cette liste si pertinent: ${JSON.stringify(knownProjects)}
- Si manque temps total -> mets 7h par défaut réparties (ex: 3.5 + 3.5) si plusieurs lignes, sinon 7h sur une ligne.
- La réponse DOIT commencer par { et finir par }.
`;

    const response = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
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
    const validated = rows.map((r) => RowSchema.parse({ ...r, day: body.day }));
    res.json({ rows: validated });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/activities/upsertDay
 * Dev: Upsert rows for current user for that day (replace existing)
 * IMPORTANT: uses user-scoped supabase client so RLS passes.
 */
app.post("/api/activities/upsertDay", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const supabaseUser = supabaseForJwt(jwt);

    const schema = z.object({
      day: z.string().min(10),
      rows: z.array(RowSchema),
    });
    const body = schema.parse(req.body);

    // Delete existing activities for that day (as user)
    const { error: dErr } = await supabaseUser
      .from("activities")
      .delete()
      .eq("user_id", user.id)
      .eq("day", body.day);

    if (dErr) throw new Error(dErr.message);

    // Insert new
    const payload = body.rows.map((r) => ({
      user_id: user.id,
      day: body.day,
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Ticket Non défini",
      impute: r.impute ?? "",
    }));

    const { data, error } = await supabaseUser.from("activities").insert(payload).select();
    if (error) throw new Error(error.message);

    res.json({ ok: true, inserted: data?.length ?? 0 });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * POST /api/pm/activities/upsertDayForUser
 * PM only: upsert rows for a given userId & day
 */
const UpsertForUserSchema = z.object({
  userId: z.string().min(10),
  day: z.string().min(10),
  rows: z.array(RowSchema),
});

app.post("/api/pm/activities/upsertDayForUser", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;

    // 1) Vérifie que c'est bien un pm (via profiles OU jwt role si tu l'as mis)
    const prof = await getRole(user.id); // retourne role, full_name
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const body = UpsertForUserSchema.parse(req.body);

    // 2) User-scoped client pour RLS (jwt du PM)
    const supabaseUser = supabaseForJwt(jwt);

    // 3) Delete existing day rows for that dev
    const { error: dErr } = await supabaseUser
      .from("activities")
      .delete()
      .eq("user_id", body.userId)
      .eq("day", body.day);

    if (dErr) throw new Error(dErr.message);

    // 4) Insert new rows for that dev
    const payload = body.rows.map((r) => ({
      user_id: body.userId,
      day: body.day,
      sujet: r.sujet ?? "",
      projet: r.projet ?? "",
      temps_passe_h: r.temps_passe_h ?? 0,
      type: r.type ?? "Ticket Non défini",
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
 * Uses user auth; reads projects list.
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
    res.json({ projects: (data ?? []).map((x) => x.name) });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Bad request" });
  }
});

/**
 * GET /api/activities/day?day=YYYY-MM-DD
 * Returns rows for that day for the authenticated user.
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

/**
 * GET /api/pm/activities/dayForUser?userId=...&day=YYYY-MM-DD
 * PM only: returns rows for a given user/day
 */
app.get("/api/pm/activities/dayForUser", async (req, res) => {
  try {
    const auth = await getUserFromBearer(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { user, jwt } = auth;
    const prof = await getRole(user.id);
    if (prof.role !== "pm") return res.status(403).json({ error: "Forbidden" });

    const supabaseUser = supabaseForJwt(jwt);

    const q = z
      .object({
        userId: z.string().min(1),
        day: z.string().min(10),
      })
      .parse(req.query);

    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", q.userId)
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
  const end = new Date(Date.UTC(year, month1to12, 0)); // last day of month
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  return { startStr, endStr };
}

/**
 * GET /api/activities/month?year=YYYY&month=M
 * Returns aggregated days for the authenticated user.
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

    // Fetch minimal fields for aggregation
    const { data, error } = await supabaseUser
      .from("activities")
      .select("day, temps_passe_h")
      .eq("user_id", user.id)
      .gte("day", startStr)
      .lte("day", endStr);

    if (error) throw new Error(error.message);

    // Aggregate by day
    const map = new Map(); // day -> { totalHours, linesCount }
    for (const a of data ?? []) {
      const k = a.day;
      const prev = map.get(k) ?? { totalHours: 0, linesCount: 0 };
      prev.totalHours += Number(a.temps_passe_h || 0);
      prev.linesCount += 1;
      map.set(k, prev);
    }

    const days = Array.from(map.entries())
      .map(([day, v]) => ({
        day,
        totalHours: Math.round(v.totalHours * 10) / 10,
        linesCount: v.linesCount,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return res.json({ year: q.year, month: q.month, days });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

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
      .select("day, sujet, projet, temps_passe_h, type, impute")
      .eq("user_id", user.id)
      .gte("day", startStr)
      .lte("day", endStr)
      .order("day", { ascending: true });

    if (error) throw new Error(error.message);

    const header = "day;sujet;projet;temps_passe_h;type;impute";
    const lines = (data ?? []).map(r =>
      [r.day, r.sujet, r.projet, r.temps_passe_h, r.type, r.impute]
        .map(v => String(v ?? "").replaceAll(";", ","))
        .join(";")
    );

    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="activities_${q.year}-${String(q.month).padStart(2,"0")}.csv"`);
    return res.send(csv);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

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

    // 1) Interdire hors keyrus.com
    if (!isKeyrusEmail(user.email)) {
      return res.status(403).json({ error: "Email non autorisé (keyrus.com requis)." });
    }

    // 2) Rôle final sécurisé
    let finalRole = "dev";
    if (body.roleWanted === "pm") {
      if (!isAllowedPm(user.email)) {
        return res.status(403).json({ error: "Tu n'es pas autorisé à être CP (pm)." });
      }
      finalRole = "pm";
    }

    // 3) Upsert profile (service role OK)
    const { error: upsertErr } = await supabaseAdmin
      .from("profiles")
      .upsert(
        { id: user.id, full_name: body.full_name, role: finalRole },
        { onConflict: "id" }
      );

    if (upsertErr) throw new Error(upsertErr.message);

    // 4) Injecter le rôle dans le JWT (app_metadata)
    const { error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      app_metadata: { role: finalRole },
    });

    // rollback simple si meta échoue (évite incohérences)
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

    const q = z
      .object({
        from: z.string().min(10),
        to: z.string().min(10),
      })
      .parse(req.query);

    // For PM view, you likely want a SECURITY DEFINER RPC in production.
    // For now, assuming your RLS allows PM to read profiles/activities.
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

    res.json({ from: q.from, to: q.to, users: result });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Bad request" });
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`✅ server on http://localhost:${port}`));