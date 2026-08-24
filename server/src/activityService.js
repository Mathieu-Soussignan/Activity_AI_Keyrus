// server/src/activityService.js
import { ALLOWED_DAY_CHARGES, HOURS_PER_DAY, hoursToExcelDays, excelDaysToHours, validateDayCharge } from "./graphService.js";
import { MockActivityRepository } from "./repositories/activityRepository.js";

export const ALLOWED_PROJECTS = [
  "AX",
  "Technique",
  "CRM",
  "eComm",
  "ORO",
  "Okaveo",
  "SIRH",
  "IRMA",
  "LMS",
  "IMPU",
  "Mail relève",
  "Absent",
  "Autre",
];

export const ALLOWED_TYPES = [
  "Projet - Evo",
  "TMA - Correctif",
  "Incident Applicatif",
  "Support",
  "Réunion",
  "Congés",
  "Alternance",
  "Autre",
];

/**
 * Detailed duration analysis for UI helper
 */
export function analyzeDuration(hours) {
  const h = Math.max(0, Number(hours || 0));
  const rawDays = Math.round((h / HOURS_PER_DAY) * 1000) / 1000;
  const closestDay = hoursToExcelDays(h);
  const isExact = ALLOWED_DAY_CHARGES.some((v) => Math.abs(v - rawDays) < 1e-4);

  let helperMessage = null;
  if (!isExact && h > 0) {
    // Find two bounding allowed charges
    const lower = [...ALLOWED_DAY_CHARGES].reverse().find((v) => v <= rawDays) || ALLOWED_DAY_CHARGES[0];
    const upper = ALLOWED_DAY_CHARGES.find((v) => v >= rawDays) || ALLOWED_DAY_CHARGES[ALLOWED_DAY_CHARGES.length - 1];
    helperMessage = `Cette durée (${h}h) correspond à ${rawDays} jour. Choisissez la charge Excel autorisée la plus proche (${lower}j ou ${upper}j) ou ajustez la durée.`;
  }

  return {
    hours: h,
    rawDays,
    closestDay,
    isExact,
    helperMessage,
    allowedValues: ALLOWED_DAY_CHARGES,
  };
}

/**
 * Intelligent Local Regex Parser for offline simulation / Mistral fallback
 */
export function parseNaturalTextLocal(text, defaultDay = new Date().toISOString().slice(0, 10)) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }

  // Check for multi-line or multi-sentence tasks
  const segments = trimmed
    .split(/(?:\r?\n|;|\s+-\s+|,(?=\s*(?:\d+(?:[.,h]|\s*h|\s*heures?)|sur\b|ticket\b|r[ée]union\b|point\b|daily\b))|\bet\b(?=\s*(?:\d+(?:[.,h]|\s*h|\s*heures?)|sur\b|ticket\b|r[ée]union\b|point\b|daily\b))|\band\b)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);

  const activities = [];

  for (const segment of segments) {
    // 1. Extract Ticket ID (e.g. "ticket 594", "#594", "sur le 594")
    const ticketMatch = segment.match(/(?:ticket|sur le|#)\s*(\d{2,6})/i) || segment.match(/\b(\d{3,5})\b/);
    const ticket = ticketMatch ? ticketMatch[1] : "";

    // 2. Extract Flux Name (e.g. "FNA035", "Flux FNA035", "FNA 035")
    const fluxMatch = segment.match(/\b([A-Z]{2,4}\s*\d{2,4}[A-Z]?)\b/i);
    const flux = fluxMatch ? fluxMatch[1].replace(/\s+/g, "").toUpperCase() : "";

    // 3. Extract Hours (e.g. "5h", "1h30", "1h45", "2.5h", "3 heures", "toute la journée")
    let hours = 0;
    if (/toute\s+la\s+journ[ée]e|journ[ée]e\s+compl[èe]te/i.test(segment)) {
      hours = 7;
    } else {
      const hoursMatch = segment.match(/(\d+(?:[.,]\d+)?)\s*(?:h(?:eures?)?|hours?)/i);
      const minMatch = segment.match(/(\d+)\s*h\s*(\d+)/i);

      if (minMatch) {
        hours = Number(minMatch[1]) + Number(minMatch[2]) / 60;
      } else if (hoursMatch) {
        hours = Number(hoursMatch[1].replace(",", "."));
      } else {
        const justHours = segment.match(/\b(\d+(?:[.,]\d+)?)\s*h\b/i);
        if (justHours) hours = Number(justHours[1].replace(",", "."));
      }
    }

    // 4. Extract Project
    let project = "AX";
    for (const p of ALLOWED_PROJECTS) {
      if (p !== "Autre" && new RegExp(`\\b${p}\\b`, "i").test(segment)) {
        project = p;
        break;
      }
    }

    // 5. Extract Activity Type
    let type = "Projet - Evo";
    if (/r[ée]union|meeting|daily|point|cadrage/i.test(segment)) {
      type = "Réunion";
      if (project === "AX") project = "Technique";
    } else if (/bug|ano|anomalie|incident/i.test(segment)) {
      type = "TMA - Correctif";
    } else if (/support|assistance|debug/i.test(segment)) {
      type = "Support";
    } else if (/cong[ée]|vacances|cp/i.test(segment)) {
      type = "Congés";
      hours = 0;
    } else if (/formation|alternance|cours/i.test(segment)) {
      type = "Alternance";
    }

    // 6. Clean Subject
    let subject = segment
      .replace(/(?:j'ai|aujourd'hui|travaill[ée]|pass[ée])\s*/i, "")
      .replace(/(\d+(?:[.,]\d+)?)\s*h(?:eures?)?/gi, "")
      .replace(/ticket\s*\d+/gi, "")
      .trim();

    if (subject.length < 5) {
      subject = `Activité sur ${flux || (ticket ? `Ticket ${ticket}` : project)}`;
    }
    subject = subject.charAt(0).toUpperCase() + subject.slice(1);

    activities.push({
      date: defaultDay,
      ticket,
      flux,
      subject,
      project,
      type,
      hours: Math.round(hours * 100) / 100,
      days: hoursToExcelDays(hours),
      durationAnalysis: analyzeDuration(hours),
    });
  }

  // If no hours were specified at all, default to 7h split
  if (activities.length === 1 && activities[0].hours === 0) {
    activities[0].hours = 7;
    activities[0].days = 1.0;
    activities[0].durationAnalysis = analyzeDuration(7);
  } else if (activities.length > 1) {
    const totalH = activities.reduce((acc, a) => acc + a.hours, 0);
    if (totalH === 0) {
      const split = Math.round((7 / activities.length) * 100) / 100;
      activities.forEach((a) => {
        a.hours = split;
        a.days = hoursToExcelDays(split);
        a.durationAnalysis = analyzeDuration(split);
      });
    }
  }

  return activities;
}

/**
 * Activity Service handling business logic and AI orchestration
 */
export class ActivityService {
  constructor(supabaseAdmin, mistralClient = null) {
    this.supabaseAdmin = supabaseAdmin;
    this.mistral = mistralClient;
    this.mockRepository = new MockActivityRepository(supabaseAdmin);
    this.activeRepository = this.mockRepository; // Default: Mock
  }

  /**
   * Parse natural text using Mistral or local fallback
   */
  async parseNaturalActivity({ text, day = new Date().toISOString().slice(0, 10), knownProjects = ALLOWED_PROJECTS }) {
    if (!text || !text.trim()) {
      return { success: true, activities: [], totalHours: 0, totalDays: 0 };
    }

    let parsedRows = [];

    // Try Mistral if client is configured
    if (this.mistral && process.env.MISTRAL_API_KEY) {
      try {
        const systemPrompt = `
Tu es l'assistant IA d'Activity AI pour les développeurs de l'équipe Keyrus.
Ton rôle est d'analyser la description naturelle de la journée du développeur et d'en extraire les activités structurées.

Format de sortie STRICT: Tu renvoies UNIQUEMENT un objet JSON valide (aucun texte en dehors) :
{
  "activities": [
    {
      "date": "YYYY-MM-DD",
      "ticket": "594",
      "flux": "FNA035",
      "subject": "Analyse, correction du mapping et tests REC",
      "project": "AX",
      "type": "Projet - Evo",
      "hours": 5.0
    }
  ]
}

Règles Métier Keyrus :
1. Si l'utilisateur mentionne plusieurs tâches ou plusieurs tickets, crée une entrée par tâche.
2. ticket: extrait le numéro de ticket (ex: 594, 612). Si absent, chaîne vide "".
3. flux: extrait le nom de flux si présent (ex: FNA035). Si absent, chaîne vide "".
4. subject: résumé clair et concis de la tâche effectuée.
5. project: choisis dans cette liste: ${JSON.stringify(knownProjects)}. Par défaut "AX".
6. type: choisis parmi: ${JSON.stringify(ALLOWED_TYPES)}. Par défaut "Projet - Evo".
7. hours: durée en heures décimales (ex: 5h = 5.0, 1h30 = 1.5, 1h45 = 1.75, 45min = 0.75).
8. Si l'utilisateur dit "toute la journée", mets 7.0 heures.
`;

        const response = await this.mistral.chat.complete({
          model: process.env.MISTRAL_MODEL || "mistral-small-latest",
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Date: ${day}\nTexte: ${text}\nExtrais le JSON.` },
          ],
        });

        const content = response?.choices?.[0]?.message?.content;
        let outText = typeof content === "string" ? content : (Array.isArray(content) ? content.map(c => c.text).join("") : "");
        const jsonMatch = outText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const rawParsed = JSON.parse(jsonMatch[0]);
          parsedRows = rawParsed.activities || rawParsed.rows || [];
        }
      } catch (aiErr) {
        console.warn("Mistral parsing failed, using intelligent local fallback:", aiErr.message);
        parsedRows = [];
      }
    }

    // Fallback if Mistral is unavailable or returned empty
    if (!parsedRows || parsedRows.length === 0) {
      parsedRows = parseNaturalTextLocal(text, day);
    }

    // Enrich and validate activities with duration analysis & Excel day steps
    const enrichedActivities = parsedRows.map((act) => {
      const h = Number(act.hours || act.temps_passe_h || 0);
      const days = hoursToExcelDays(h);
      return {
        date: act.date || day,
        ticket: String(act.ticket || act.id_ticket || "").trim(),
        flux: String(act.flux || act.nom_flux || act.impute || "").trim(),
        subject: String(act.subject || act.sujet || "").trim(),
        project: act.project || act.projet || "AX",
        type: act.type || "Projet - Evo",
        hours: h,
        days,
        durationAnalysis: analyzeDuration(h),
      };
    });

    const totalHours = enrichedActivities.reduce((acc, a) => acc + a.hours, 0);
    const totalDays = Math.round((totalHours / HOURS_PER_DAY) * 1000) / 1000;
    const isOverDay = totalHours > HOURS_PER_DAY;

    return {
      success: true,
      day,
      activities: enrichedActivities,
      totalHours: Math.round(totalHours * 100) / 100,
      totalDays,
      isOverDay,
      warningMessage: isOverDay
        ? `Attention : Le total de la journée (${totalHours}h) dépasse la durée de référence journalière (7h = 1j).`
        : null,
      allowedProjects: ALLOWED_PROJECTS,
      allowedTypes: ALLOWED_TYPES,
      allowedDayCharges: ALLOWED_DAY_CHARGES,
    };
  }

  async getActivities(userId, filters) {
    return this.activeRepository.getActivities(userId, filters);
  }

  async saveActivities(userId, day, activities) {
    return this.activeRepository.saveActivities(userId, day, activities);
  }

  async deleteActivity(userId, activityId) {
    return this.activeRepository.deleteActivity(userId, activityId);
  }

  async getPersonalSummary(userId, referenceDate) {
    return this.activeRepository.getPersonalSummary(userId, referenceDate);
  }
}
