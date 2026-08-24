// server/src/repositories/activityRepository.js
import { HOURS_PER_DAY } from "../graphService.js";

function mapToDbType(rawType) {
  const t = String(rawType || "").toLowerCase();
  if (t.includes("evo") || t.includes("projet - evo")) return "Evol";
  if (t.includes("ano") || t.includes("correctif") || t.includes("support")) return "Ano";
  if (t.includes("incident")) return "Incident Applicatif";
  if (t.includes("projet") || t.includes("réunion") || t.includes("reunion")) return "Projet";
  if (t.includes("congé") || t.includes("conge")) return "Congés";
  if (t.includes("alternance") || t.includes("formation")) return "Alternance";
  if (t.includes("week")) return "Week-end";
  return "Non défini";
}

function mapToExcelType(dbType, subject = "") {
  if (dbType === "Evol") return "Projet - Evo";
  if (dbType === "Ano") return "TMA - Correctif";
  if (dbType === "Projet") {
    if (/r[ée]union|meeting|daily|point/i.test(subject)) return "Réunion";
    return "Projet - Evo";
  }
  return dbType || "Projet - Evo";
}

/**
 * Base Abstract Activity Repository
 */
export class ActivityRepository {
  async getActivities(userId, filters = {}) {
    throw new Error("getActivities must be implemented by subclass");
  }

  async saveActivities(userId, day, activities) {
    throw new Error("saveActivities must be implemented by subclass");
  }

  async deleteActivity(userId, activityId) {
    throw new Error("deleteActivity must be implemented by subclass");
  }

  async getPersonalSummary(userId, referenceDate = new Date()) {
    throw new Error("getPersonalSummary must be implemented by subclass");
  }
}

/**
 * Mock Activity Repository (Simulation Mode)
 * Uses Supabase (or in-memory store) while annotating records with SharePoint Mock metadata
 * (e.g. status: "synced_mock", targetTable: "Tableau6245781824", targetSheet: "Mathieu")
 */
export class MockActivityRepository extends ActivityRepository {
  constructor(supabaseAdmin) {
    super();
    this.supabaseAdmin = supabaseAdmin;
    this.inMemoryActivities = new Map(); // Fallback if Supabase is offline
  }

  async getActivities(userId, filters = {}) {
    const { day, startDate, endDate } = filters;

    try {
      let query = this.supabaseAdmin
        .from("activities")
        .select("*")
        .eq("user_id", userId)
        .order("day", { ascending: false })
        .order("created_at", { ascending: false });

      if (day) {
        query = query.eq("day", day);
      }
      if (startDate) {
        query = query.gte("day", startDate);
      }
      if (endDate) {
        query = query.lte("day", endDate);
      }

      const { data, error } = await query;
      if (error) throw error;

      return (data || []).map((row) => this._formatActivityOutput(row));
    } catch (err) {
      console.warn("MockActivityRepository: retrieving from in-memory store:", err.message);
      let list = this.inMemoryActivities.get(userId) || [];
      if (day) list = list.filter((a) => a.day === day);
      if (startDate) list = list.filter((a) => a.day >= startDate);
      if (endDate) list = list.filter((a) => a.day <= endDate);
      return list;
    }
  }

  async saveActivities(userId, day, activities) {
    if (!day || !Array.isArray(activities)) {
      throw new Error("Paramètres invalides pour saveActivities");
    }

    const rowsToInsert = activities.map((act) => {
      const hours = Number(act.hours || act.temps_passe_h || 0);

      return {
        user_id: userId,
        day,
        id_ticket: String(act.ticket || act.id_ticket || "").trim(),
        sujet: String(act.subject || act.sujet || "").trim(),
        projet: String(act.project || act.projet || "AX").trim(),
        temps_passe_h: hours,
        type: mapToDbType(act.type),
        impute: String(act.flux || act.nom_flux || act.impute || "").trim(),
      };
    });

    try {
      // 1. Delete previous activities for this day
      const { error: delErr } = await this.supabaseAdmin
        .from("activities")
        .delete()
        .eq("user_id", userId)
        .eq("day", day);

      if (delErr) throw delErr;

      // 2. Insert new activities if any
      let inserted = [];
      if (rowsToInsert.length > 0) {
        const { data, error: insErr } = await this.supabaseAdmin
          .from("activities")
          .insert(rowsToInsert)
          .select();

        if (insErr) throw insErr;
        inserted = data || [];
      }

      return {
        success: true,
        isMock: true,
        day,
        count: inserted.length,
        activities: inserted.map((row) => this._formatActivityOutput(row)),
        syncStatus: {
          synced: true,
          mode: "SIMULATION_SHAREPOINT",
          targetSheet: "Mathieu",
          targetTable: "Tableau6245781824",
          timestamp: new Date().toISOString(),
        },
      };
    } catch (err) {
      console.warn("MockActivityRepository: saving to in-memory store:", err.message);
      const userList = (this.inMemoryActivities.get(userId) || []).filter((a) => a.day !== day);
      const formatted = rowsToInsert.map((r, i) => this._formatActivityOutput({
        id: `mock-${Date.now()}-${i}`,
        ...r,
        created_at: new Date().toISOString(),
      }));
      this.inMemoryActivities.set(userId, [...formatted, ...userList]);

      return {
        success: true,
        isMock: true,
        day,
        count: formatted.length,
        activities: formatted,
        syncStatus: {
          synced: true,
          mode: "SIMULATION_SHAREPOINT_IN_MEMORY",
          targetSheet: "Mathieu",
          targetTable: "Tableau6245781824",
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  async deleteActivity(userId, activityId) {
    try {
      const { error } = await this.supabaseAdmin
        .from("activities")
        .delete()
        .eq("user_id", userId)
        .eq("id", activityId);

      if (error) throw error;
      return { success: true, deletedId: activityId };
    } catch (err) {
      const list = this.inMemoryActivities.get(userId) || [];
      this.inMemoryActivities.set(
        userId,
        list.filter((a) => a.id !== activityId)
      );
      return { success: true, deletedId: activityId };
    }
  }

  async getPersonalSummary(userId, referenceDate = new Date()) {
    const d = new Date(referenceDate);
    const dayStr = d.toISOString().slice(0, 10);

    // Calculate start of week (Monday)
    const dayOfWeek = d.getDay(); // 0 is Sunday, 1 is Monday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    const startOfWeekStr = monday.toISOString().slice(0, 10);

    // Calculate start of month
    const startOfMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

    const allMonthActivities = await this.getActivities(userId, {
      startDate: startOfMonthStr,
      endDate: dayStr,
    });

    let todayHours = 0;
    let weekHours = 0;
    let monthHours = 0;

    for (const act of allMonthActivities) {
      const h = Number(act.hours || 0);
      monthHours += h;
      if (act.day >= startOfWeekStr) {
        weekHours += h;
      }
      if (act.day === dayStr) {
        todayHours += h;
      }
    }

    return {
      referenceDate: dayStr,
      today: {
        hours: Math.round(todayHours * 100) / 100,
        days: Math.round((todayHours / HOURS_PER_DAY) * 1000) / 1000,
        targetHours: HOURS_PER_DAY,
      },
      week: {
        hours: Math.round(weekHours * 100) / 100,
        days: Math.round((weekHours / HOURS_PER_DAY) * 1000) / 1000,
        targetHours: HOURS_PER_DAY * 5, // 35h
      },
      month: {
        hours: Math.round(monthHours * 100) / 100,
        days: Math.round((monthHours / HOURS_PER_DAY) * 1000) / 1000,
      },
      recentActivities: allMonthActivities.slice(0, 10),
    };
  }

  _formatActivityOutput(row) {
    const hours = Number(row.temps_passe_h || 0);
    const days = Math.round((hours / HOURS_PER_DAY) * 1000) / 1000;

    return {
      id: row.id,
      day: row.day,
      ticket: row.id_ticket || "",
      flux: row.impute || "",
      subject: row.sujet || "",
      project: row.projet || "AX",
      type: mapToExcelType(row.type, row.sujet),
      rawType: row.type,
      hours,
      days,
      syncStatus: "synced_mock",
      syncLabel: "✓ Enregistrée (Simulation SharePoint)",
      devOpsUrl: row.id_ticket
        ? `https://scp-tma-flux.visualstudio.com/Gestion%20des%20tickets/_workitems/edit/${row.id_ticket}`
        : null,
      createdAt: row.created_at,
    };
  }
}

/**
 * SharePoint / Microsoft Graph Activity Repository (Production Target)
 */
export class SharePointActivityRepository extends ActivityRepository {
  constructor(graphClient, driveId, itemId) {
    super();
    this.graphClient = graphClient;
    this.driveId = driveId;
    this.itemId = itemId;
  }

  async getActivities(userId, filters = {}) {
    throw new Error("SharePointActivityRepository.getActivities: App Registration Entra ID requise");
  }

  async saveActivities(userId, day, activities) {
    throw new Error("SharePointActivityRepository.saveActivities: App Registration Entra ID requise");
  }

  async deleteActivity(userId, activityId) {
    throw new Error("SharePointActivityRepository.deleteActivity: App Registration Entra ID requise");
  }

  async getPersonalSummary(userId, referenceDate = new Date()) {
    throw new Error("SharePointActivityRepository.getPersonalSummary: App Registration Entra ID requise");
  }
}
