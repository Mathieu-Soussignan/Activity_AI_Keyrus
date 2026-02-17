<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { supabase } from "../lib/supabase";
import { api } from "../lib/api";

const router = useRouter();

type UserStat = {
  userId: string;
  name: string;
  role: string;
  filledDays: number;
  totalHours: number;
};

type Me = {
  id: string;
  email: string;
  role: string;
  full_name?: string | null;
};

// Lignes d'activité (détail par dev)
type ActivityLine = {
  id: string;
  day: string; // YYYY-MM-DD
  id_ticket: string;
  sujet: string;
  projet: string;
  temps_passe_j: number; // en jours (affichage)
  temps_passe_h: number; // en heures (source backend)
  type: string;
  impute: string; // Code VSA
};

// --------------------
// Dates helpers
// --------------------
function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function yyyyMmDd(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

// lundi (semaine locale)
function startOfWeekMonday(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0 dim .. 6 sam
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

// parse YYYY-MM-DD (sécurisé)
function parseYmd(ymd: string): Date {
  const [y, m, d] = String(ymd || "").split("-").map((x) => Number(x));
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
}

// --------------------
// State
// --------------------
const loading = ref(false);
const msg = ref("");
const users = ref<UserStat[]>([]);
const me = ref<Me | null>(null);

/** URL de base de l'ADO pour les tickets */
const ADO_BASE = "https://scp-tma-flux.visualstudio.com";
const ADO_PROJECT = "Gestion des tickets";

/**
 * Retourne l'URL ADO.
 * Accepte: "12345", "INC12345", "US 12345", etc.
 */
function adoWorkItemUrl(idTicket: string) {
  const raw = String(idTicket ?? "").trim();
  if (!raw) return null;

  const m = raw.match(/(\d+)/); // prend le premier bloc numérique
  if (!m) return null;

  const id = m[1];
  return `${ADO_BASE}/${encodeURIComponent(ADO_PROJECT)}/_workitems/edit/${id}/`;
}

// ---- Monthly summary (PM)
const summaryLoading = ref(false);
const summaryError = ref("");
const summaryStats = ref<any | null>(null);
const summaryText = ref<string | null>(null);

const from = ref(yyyyMmDd(startOfMonth(new Date())));
const to = ref(yyyyMmDd(endOfMonth(new Date())));

const totalTeamHours = computed(() =>
  users.value.reduce((acc, u) => acc + (Number(u.totalHours) || 0), 0).toFixed(1)
);

// --------------------
// Conversion heures -> jours (PM)
// --------------------
const HOURS_PER_DAY = 7;
const DAY_STEP = 0.25;

function clampToDayStep(x: number) {
  const n = Number(x ?? 0);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 10); // 10J max arbitraire PM
  return Math.round(clamped / DAY_STEP) * DAY_STEP;
}
function hToJ(h: number) {
  return clampToDayStep(Number(h || 0) / HOURS_PER_DAY);
}

// --------------------
// Détail par dev
// --------------------
const selectedUserId = ref<string>("");
const activitiesLoading = ref(false);
const activitiesError = ref("");
const activities = ref<ActivityLine[]>([]);
const savingVsa = ref(false);
const vsaMsg = ref("");

// --------------------
// Auth / guard PM
// --------------------
async function ensurePm() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) {
    await router.push("/login");
    return false;
  }

  try {
    const resp = await api.get("/api/me");
    const user = resp.data;

    if (user?.role !== "pm") {
      await router.push("/activity");
      return false;
    }

    me.value = user;
    return true;
  } catch {
    await router.push("/activity");
    return false;
  }
}

// --------------------
// Data loads
// --------------------
async function loadCompletion() {
  msg.value = "";
  loading.value = true;
  try {
    const { data } = await api.get("/api/pm/completion", {
      params: { from: from.value, to: to.value },
    });

    users.value = (data?.users ?? [])
      .filter((u: any) => (u?.role ?? "") === "dev")
      .map((u: any) => ({
        userId: String(u.userId),
        name: String(u.name ?? ""),
        role: String(u.role ?? ""),
        filledDays: Number(u.filledDays ?? 0),
        totalHours: Number(u.totalHours ?? 0),
      }))
      .sort((a: UserStat, b: UserStat) => a.name.localeCompare(b.name));
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur chargement dashboard CP";
  } finally {
    loading.value = false;
  }
}

async function loadMonthlySummary() {
  summaryError.value = "";
  summaryStats.value = null;
  summaryText.value = null;
  summaryLoading.value = true;

  try {
    const d = parseYmd(from.value);
    if (!Number.isFinite(d.getTime())) throw new Error("Date 'from' invalide");

    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const statsResp = await api.get("/api/pm/summary", {
      params: { year, month },
    });
    summaryStats.value = statsResp.data;

    const aiResp = await api.post("/api/pm/summary/ai", {
      stats: statsResp.data,
    });
    summaryText.value = aiResp.data?.summary ?? null;
  } catch (e: any) {
    summaryError.value = e?.response?.data?.error || e?.message || "Erreur génération résumé mensuel";
  } finally {
    summaryLoading.value = false;
  }
}

function setMonth(offset: number) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  from.value = yyyyMmDd(startOfMonth(d));
  to.value = yyyyMmDd(endOfMonth(d));
}

// n semaines = du lundi (semaine courante - n) au dimanche (semaine courante - 1)
function setWeeksBack(n: number) {
  const now = new Date();
  const startThisWeek = startOfWeekMonday(now);

  const start = new Date(startThisWeek);
  start.setDate(start.getDate() - 7 * n);

  const end = new Date(startThisWeek);
  end.setDate(end.getDate() - 1);

  from.value = yyyyMmDd(start);
  to.value = yyyyMmDd(end);
}

// ---- Exports (CSV existants)
async function exportRange(userId?: string) {
  msg.value = "";
  try {
    const resp = await api.get("/api/pm/export-range", {
      params: { from: from.value, to: to.value, ...(userId ? { userId } : {}) },
      responseType: "blob",
    });

    const blob = new Blob([resp.data], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `activities_CP_${from.value}_to_${to.value}${userId ? `_user_${userId}` : ""}.csv`;
    a.click();

    window.URL.revokeObjectURL(url);
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur export période";
  }
}

async function exportMonth(offset: number) {
  msg.value = "";
  try {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const resp = await api.get("/api/pm/export", {
      params: { year, month },
      responseType: "blob",
    });

    const blob = new Blob([resp.data], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `activities_CP_${year}-${pad2(month)}.csv`;
    a.click();

    window.URL.revokeObjectURL(url);
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur export CP";
  }
}

// ---- Exports XLSX (préparé côté front : endpoints à ajouter côté back)
async function exportRangeXlsx(userId?: string) {
  msg.value = "";
  try {
    const resp = await api.get("/api/pm/export-range-xlsx", {
      params: { from: from.value, to: to.value, ...(userId ? { userId } : {}) },
      responseType: "blob",
    });

    const blob = new Blob([resp.data], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `activities_CP_${from.value}_to_${to.value}${userId ? `_user_${userId}` : ""}.xlsx`;
    a.click();

    window.URL.revokeObjectURL(url);
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur export période Excel";
  }
}

async function exportMonthXlsx(offset: number) {
  msg.value = "";
  try {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const resp = await api.get("/api/pm/export-xlsx", {
      params: { year, month },
      responseType: "blob",
    });

    const blob = new Blob([resp.data], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `activities_CP_${year}-${pad2(month)}.xlsx`;
    a.click();

    window.URL.revokeObjectURL(url);
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur export CP Excel";
  }
}

// ---- charger les lignes d'un dev sur from/to
async function loadUserActivities() {
  activitiesError.value = "";
  vsaMsg.value = "";
  activities.value = [];

  if (!selectedUserId.value) return;

  activitiesLoading.value = true;
  try {
    const { data } = await api.get("/api/pm/activities", {
      params: { from: from.value, to: to.value, userId: selectedUserId.value },
    });

    const rows = (data?.rows ?? data?.activities ?? data ?? []) as any[];
    activities.value = rows.map((r: any) => {
      const h = Number(r.temps_passe_h ?? 0);
      return {
        id: String(r.id),
        day: String(r.day ?? ""),
        id_ticket: String(r.id_ticket ?? ""),
        sujet: String(r.sujet ?? ""),
        projet: String(r.projet ?? ""),
        temps_passe_h: h,
        temps_passe_j: hToJ(h),
        type: String(r.type ?? ""),
        impute: String(r.impute ?? ""),
      };
    });
  } catch (e: any) {
    activitiesError.value = e?.response?.data?.error || e?.message || "Erreur chargement activités";
  } finally {
    activitiesLoading.value = false;
  }
}

// --------------------
// Watchers (éviter spam + reset résumé sur changement de mois)
// --------------------
let reloadTimer: number | null = null;

function scheduleReloadActivities() {
  if (!selectedUserId.value) return;
  if (reloadTimer) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    loadUserActivities();
  }, 250);
}

// recharge auto quand on change de dev
watch(selectedUserId, async () => {
  await loadUserActivities();
});

// recharge auto si la période change (si un dev est sélectionné)
watch([from, to], () => {
  scheduleReloadActivities();
});

// Auto clear résumé si on change de mois
watch(
  () => [from.value, to.value] as const,
  (next, prev) => {
    const [f] = next;
    const [pf] = prev ?? next;

    const prevDate = parseYmd(pf);
    const newDate = parseYmd(f);
    if (!Number.isFinite(prevDate.getTime()) || !Number.isFinite(newDate.getTime())) return;

    if (
      prevDate.getMonth() !== newDate.getMonth() ||
      prevDate.getFullYear() !== newDate.getFullYear()
    ) {
      summaryStats.value = null;
      summaryText.value = null;
      summaryError.value = "";
    }
  }
);

// ---- save VSA (batch)
async function saveVsaForSelectedDev() {
  vsaMsg.value = "";
  activitiesError.value = "";
  if (!selectedUserId.value) return;
  if (savingVsa.value) return;

  savingVsa.value = true;
  try {
    // ⚠️ endpoint à créer côté backend: update VSA sur une liste de lignes
    // payload minimal: [{ id, impute }]
    const payload = activities.value.map((a) => ({
      id: a.id,
      impute: a.impute ?? "",
    }));

    const { data } = await api.post("/api/pm/activities/update-vsa", {
      userId: selectedUserId.value,
      from: from.value,
      to: to.value,
      rows: payload,
    });

    vsaMsg.value = `Code VSA sauvegardé (${data?.updated ?? payload.length} lignes)`;
    await loadUserActivities();
  } catch (e: any) {
    activitiesError.value = e?.response?.data?.error || e?.message || "Erreur sauvegarde Code VSA";
  } finally {
    savingVsa.value = false;
  }
}

onMounted(async () => {
  const ok = await ensurePm();
  if (!ok) return;
  await loadCompletion();
});
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100">
    <div class="max-w-6xl mx-auto p-6">
      <header class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold">Dashboard CP</h1>
          <p class="text-zinc-400 text-sm">Suivi d’activité des devs + export</p>
        </div>

        <div class="flex items-center gap-4">
          <div class="text-right text-sm">
            <div class="font-medium">
              {{ me?.full_name || me?.email }}
            </div>
            <div class="text-zinc-400 text-xs">Chef de projet</div>
          </div>

          <button
            @click="router.push('/activity')"
            class="rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm"
          >
            Retour feuille dev
          </button>
        </div>
      </header>

      <!-- Filtres période + exports -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 mb-4">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label class="text-xs text-zinc-400">Du</label>
            <input
              v-model="from"
              type="date"
              class="block rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2"
            />
          </div>

          <div>
            <label class="text-xs text-zinc-400">Au</label>
            <input
              v-model="to"
              type="date"
              class="block rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2"
            />
          </div>

          <button
            @click="loadCompletion"
            :disabled="loading"
            class="rounded-xl bg-white text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
          >
            {{ loading ? "Chargement..." : "Actualiser" }}
          </button>

          <div class="ml-auto text-sm text-zinc-300">
            Total équipe : <span class="font-semibold">{{ totalTeamHours }}h</span>
          </div>
        </div>

        <div class="flex flex-wrap gap-2 mt-3">
          <button
            @click="setMonth(0); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            Mois courant
          </button>
          <button
            @click="setMonth(-1); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            Mois précédent
          </button>

          <button
            @click="exportMonth(0)"
            class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs"
          >
            Export CP mois courant
          </button>
          <button
            @click="exportMonth(-1)"
            class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs"
          >
            Export CP mois précédent
          </button>

          <button
            @click="exportRange()"
            class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs"
          >
            Export CP période
          </button>

          <button
            @click="setWeeksBack(1); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            1 semaine
          </button>
          <button
            @click="setWeeksBack(2); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            2 semaines
          </button>
          <button
            @click="setWeeksBack(3); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            3 semaines
          </button>
          <button
            @click="setWeeksBack(4); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            4 semaines
          </button>
        </div>

        <p v-if="msg" class="mt-3 text-sm text-red-200">{{ msg }}</p>
      </div>

      <!-- sélection dev + lignes + Code VSA -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 mb-4 min-w-0">
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-[260px]">
            <label class="text-xs text-zinc-400">Dev</label>
            <select
              v-model="selectedUserId"
              class="block w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2"
            >
              <option value="">— Sélectionner un dev —</option>
              <option v-for="u in users" :key="u.userId" :value="u.userId">
                {{ u.name }}
              </option>
            </select>
          </div>

          <button
            @click="loadUserActivities"
            :disabled="activitiesLoading || !selectedUserId"
            class="rounded-xl bg-white text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
          >
            {{ activitiesLoading ? "Chargement..." : "Charger les lignes" }}
          </button>

          <button
            @click="exportRange(selectedUserId)"
            :disabled="!selectedUserId"
            class="rounded-xl bg-emerald-400 text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
          >
            Export dev (période)
          </button>

          <button
            @click="saveVsaForSelectedDev"
            :disabled="savingVsa || !selectedUserId || activities.length === 0"
            class="rounded-xl bg-white text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
            title="Sauvegarde uniquement la colonne Code VSA"
          >
            {{ savingVsa ? "Sauvegarde..." : "💾 Sauver Code VSA" }}
          </button>

          <div v-if="vsaMsg" class="text-sm text-emerald-200">
            {{ vsaMsg }}
          </div>
        </div>

        <p v-if="activitiesError" class="mt-3 text-sm text-red-200">{{ activitiesError }}</p>

        <div class="mt-4 overflow-x-auto overflow-y-hidden">
          <table class="w-full text-sm table-fixed">
            <thead class="text-zinc-400">
              <tr>
                <th class="w-28 text-left py-2 pr-2 whitespace-nowrap">Date</th>
                <th class="w-32 text-left py-2 pr-2 whitespace-nowrap">ID Ticket</th>
                <th class="w-[20rem] text-left py-2 pr-2 whitespace-nowrap">Sujet</th>
                <th class="w-48 text-left py-2 pr-2 whitespace-nowrap">Projet</th>
                <th class="w-32 text-left py-2 pr-2 whitespace-nowrap">Charge réelle (J)</th>
                <th class="w-44 text-left py-2 pr-2 whitespace-nowrap">Type</th>
                <th class="w-44 text-left py-2 pr-2 whitespace-nowrap">Code VSA</th>
              </tr>
            </thead>

            <tbody>
              <tr v-if="!activitiesLoading && activities.length === 0">
                <td colspan="7" class="py-3 text-zinc-500">
                  Aucune ligne sur la période (ou aucun dev sélectionné).
                </td>
              </tr>

              <tr v-for="a in activities" :key="a.id" class="border-t border-zinc-800">
                <!-- Date -->
                <td class="py-2 pr-2 whitespace-nowrap">
                  <span class="text-[11px] font-mono text-zinc-400">{{ a.day }}</span>
                </td>

                <!-- ID Ticket (lien ADO) -->
                <td class="py-2 pr-2 whitespace-nowrap overflow-hidden text-ellipsis">
                  <template v-if="adoWorkItemUrl(a.id_ticket)">
                    <a
                      :href="adoWorkItemUrl(a.id_ticket)!"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="underline text-emerald-300 hover:text-emerald-200 font-mono"
                      :title="a.id_ticket"
                    >
                      {{ a.id_ticket }}
                    </a>
                  </template>
                  <template v-else>
                    <span class="font-mono text-zinc-300">{{ a.id_ticket || "—" }}</span>
                  </template>
                </td>

                <!-- Sujet -->
                <td class="py-2 pr-2">
                  <input
                    :value="a.sujet"
                    class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1 text-zinc-300"
                    disabled
                  />
                </td>

                <!-- Projet -->
                <td class="py-2 pr-2">
                  <input
                    :value="a.projet"
                    class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1 text-zinc-300"
                    disabled
                  />
                </td>

                <!-- Charge réelle (J) -->
                <td class="py-2 pr-2">
                  <input
                    :value="String(a.temps_passe_j).replace('.', ',') + ' J'"
                    class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1 text-zinc-300"
                    disabled
                  />
                </td>

                <!-- Type -->
                <td class="py-2 pr-2">
                  <input
                    :value="a.type"
                    class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1 text-zinc-300"
                    disabled
                  />
                </td>

                <!-- Code VSA (seul champ éditable côté PM) -->
                <td class="py-2 pr-2">
                  <input
                    v-model="a.impute"
                    class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1"
                    placeholder="Code VSA"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-3 text-zinc-500 text-xs">
          Seule la colonne “Code VSA” est modifiable côté CP ; le reste est en lecture seule pour éviter de casser la saisie dev.
        </div>
      </div>

      <!-- Résumé mensuel CP -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 mb-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Résumé mensuel</h2>

          <button
            @click="loadMonthlySummary"
            :disabled="summaryLoading"
            class="rounded-lg bg-white text-zinc-950 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {{ summaryLoading ? "Génération..." : "Générer le résumé" }}
          </button>
        </div>

        <p class="text-xs text-zinc-400 mb-3">
          Résumé basé uniquement sur les données saisies pour le mois sélectionné.
        </p>

        <p v-if="summaryError" class="text-sm text-red-200 mb-2">
          {{ summaryError }}
        </p>

        <div v-if="summaryStats" class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
          <div class="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-zinc-400 text-xs">Total équipe</div>
            <div class="font-semibold">
              {{ summaryStats.totals.days }} J · {{ summaryStats.totals.hours }} h
            </div>
          </div>

          <div
            v-for="(v, type) in summaryStats.byType"
            :key="type"
            class="rounded-lg bg-zinc-950 border border-zinc-800 p-3"
          >
            <div class="text-zinc-400 text-xs">{{ type }}</div>
            <div class="font-semibold">
              {{ v.days.toFixed(2) }} J ({{ v.percent }}%)
            </div>
          </div>
        </div>

        <div
          v-if="summaryText"
          class="rounded-xl bg-zinc-950 border border-zinc-800 p-4 whitespace-pre-line text-sm"
        >
          {{ summaryText }}
        </div>
      </div>

      <!-- Tableau synthèse devs -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 min-w-0">
        <div class="overflow-x-auto overflow-y-hidden">
          <table class="w-full text-sm">
            <thead class="text-zinc-400">
              <tr>
                <th class="text-left py-2 whitespace-nowrap">Dev</th>
                <th class="text-right py-2 whitespace-nowrap">Jours remplis</th>
                <th class="text-right py-2 whitespace-nowrap">Heures</th>
                <th class="text-right py-2 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.userId" class="border-t border-zinc-800">
                <td class="py-2">{{ u.name }}</td>
                <td class="py-2 text-right">{{ u.filledDays }}</td>
                <td class="py-2 text-right font-semibold">{{ u.totalHours.toFixed(1) }}</td>
                <td class="py-2 text-right">
                  <button
                    @click="exportRange(u.userId)"
                    class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
                  >
                    Export dev
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!loading && users.length === 0" class="text-zinc-500 text-sm mt-3">
          Aucun dev trouvé sur la période.
        </div>
      </div>
    </div>
  </div>
</template>