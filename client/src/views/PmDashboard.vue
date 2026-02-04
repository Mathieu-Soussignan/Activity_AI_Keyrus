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

// --------------------
// Date helpers
// --------------------
function pad2(n?: number) {
  return String(n ?? 0).padStart(2, "0");
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
function endOfWeekSunday(d: Date) {
  const start = startOfWeekMonday(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(0, 0, 0, 0);
  return end;
}
function isWeekend(d: Date) {
  const w = d.getDay();
  return w === 0 || w === 6;
}
function parseYmd(ymd: string): Date {
  const parts = ymd.split("-");

  const y = Number(parts[0] ?? 1970);
  const m = Number(parts[1] ?? 1);
  const d = Number(parts[2] ?? 1);

  return new Date(y, m - 1, d);
}
function clampDateRange(fromStr: string, toStr: string) {
  const f = parseYmd(fromStr);
  const t = parseYmd(toStr);
  if (f.getTime() > t.getTime()) return { from: toStr, to: fromStr };
  return { from: fromStr, to: toStr };
}

function businessDaysBetweenInclusive(fromStr: string, toStr: string) {
  const { from, to } = clampDateRange(fromStr, toStr);
  const f = parseYmd(from);
  const t = parseYmd(to);

  let count = 0;
  const cur = new Date(f);
  cur.setHours(0, 0, 0, 0);
  t.setHours(0, 0, 0, 0);

  while (cur.getTime() <= t.getTime()) {
    if (!isWeekend(cur)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// --------------------
// State
// --------------------
const loading = ref(false);
const msg = ref("");
const users = ref<UserStat[]>([]);
const me = ref<Me | null>(null);

// Filtres / UX
const search = ref("");
const sortBy = ref<"name" | "hours_desc" | "hours_asc" | "completion_desc" | "completion_asc">(
  "completion_desc"
);

// ---- Monthly summary (PM)
const summaryLoading = ref(false);
const summaryError = ref("");
const summaryStats = ref<any | null>(null);
const summaryText = ref<string | null>(null);

// Range
const from = ref(yyyyMmDd(startOfMonth(new Date())));
const to = ref(yyyyMmDd(endOfMonth(new Date())));

const expectedWorkingDays = computed(() => businessDaysBetweenInclusive(from.value, to.value));

const totalTeamHours = computed(() =>
  users.value.reduce((acc, u) => acc + (Number(u.totalHours) || 0), 0).toFixed(1)
);

const avgHoursPerDev = computed(() => {
  const n = users.value.length || 1;
  const total = users.value.reduce((acc, u) => acc + (Number(u.totalHours) || 0), 0);
  return (total / n).toFixed(1);
});

function completionRateFor(u: UserStat) {
  const denom = expectedWorkingDays.value || 1;
  const r = (Number(u.filledDays) || 0) / denom;
  return Math.max(0, Math.min(1, r));
}

const teamAvgCompletion = computed(() => {
  if (users.value.length === 0) return "0%";
  const sum = users.value.reduce((acc, u) => acc + completionRateFor(u), 0);
  return `${Math.round((sum / users.value.length) * 100)}%`;
});

const devsAtRisk = computed(() => {
  // "à risque" si < 80% de jours remplis sur la période
  return users.value.filter((u) => completionRateFor(u) < 0.8).length;
});

const devsPerfect = computed(() => {
  return users.value.filter((u) => completionRateFor(u) >= 0.999).length;
});

const rangeLabel = computed(() => `${from.value} → ${to.value}`);

const isFullMonthSelected = computed(() => {
  const f = parseYmd(from.value);
  const t = parseYmd(to.value);
  return (
    f.getDate() === 1 &&
    f.getFullYear() === t.getFullYear() &&
    f.getMonth() === t.getMonth() &&
    yyyyMmDd(endOfMonth(f)) === yyyyMmDd(t)
  );
});

// --------------------
// Auth / Load
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

async function loadCompletion() {
  msg.value = "";
  loading.value = true;
  try {
    const { from: f, to: t } = clampDateRange(from.value, to.value);

    // garde l’UI cohérente si l’utilisateur inverse les dates
    if (f !== from.value || t !== to.value) {
      from.value = f;
      to.value = t;
    }

    const { data } = await api.get("/api/pm/completion", {
      params: { from: from.value, to: to.value },
    });

    users.value = (data?.users ?? [])
      .filter((u: any) => (u?.role ?? "") === "dev")
      .map((u: any) => ({
        userId: u.userId,
        name: u.name,
        role: u.role,
        filledDays: Number(u.filledDays ?? 0),
        totalHours: Number(u.totalHours ?? 0),
      }));
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
    // basé sur le mois de "from"
    const d = parseYmd(from.value);
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
    summaryError.value =
      e?.response?.data?.error || e?.message || "Erreur génération résumé mensuel";
  } finally {
    summaryLoading.value = false;
  }
}

// --------------------
// Presets range
// --------------------
function setMonth(offset: number) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  from.value = yyyyMmDd(startOfMonth(d));
  to.value = yyyyMmDd(endOfMonth(d));
}

function setWeeksBack(n: number) {
  // du lundi (semaine courante - n) au dimanche (semaine courante - 1)
  const now = new Date();
  const startThisWeek = startOfWeekMonday(now);

  const start = new Date(startThisWeek);
  start.setDate(start.getDate() - 7 * n);

  const end = new Date(startThisWeek);
  end.setDate(end.getDate() - 1);

  from.value = yyyyMmDd(start);
  to.value = yyyyMmDd(end);
}

function setThisWeek() {
  const now = new Date();
  const start = startOfWeekMonday(now);
  const end = endOfWeekSunday(now);
  from.value = yyyyMmDd(start);
  to.value = yyyyMmDd(end);
}

// --------------------
// Export
// --------------------
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

// --------------------
// UI computed: filter/sort
// --------------------
const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = users.value.slice();

  if (q) {
    list = list.filter((u) => (u.name || "").toLowerCase().includes(q));
  }

  list.sort((a, b) => {
    if (sortBy.value === "name") return a.name.localeCompare(b.name);

    if (sortBy.value === "hours_desc") return (b.totalHours || 0) - (a.totalHours || 0);
    if (sortBy.value === "hours_asc") return (a.totalHours || 0) - (b.totalHours || 0);

    const ca = completionRateFor(a);
    const cb = completionRateFor(b);

    if (sortBy.value === "completion_desc") return cb - ca;
    if (sortBy.value === "completion_asc") return ca - cb;

    return 0;
  });

  return list;
});

function completionBadgeClass(rate: number) {
  // rate = 0..1
  if (rate >= 0.95) return "bg-emerald-500/15 text-emerald-200 border-emerald-700/40";
  if (rate >= 0.8) return "bg-amber-500/10 text-amber-200 border-amber-700/40";
  return "bg-red-500/10 text-red-200 border-red-700/40";
}

function completionLabel(rate: number) {
  return `${Math.round(rate * 100)}%`;
}

function missingDaysFor(u: UserStat) {
  return Math.max(0, expectedWorkingDays.value - (Number(u.filledDays) || 0));
}

// --------------------
// Clipboard helpers
// --------------------
const copyStatus = ref<string>("");
async function copySummaryToClipboard() {
  if (!summaryText.value) return;
  try {
    await navigator.clipboard.writeText(summaryText.value);
    copyStatus.value = "Copié ✅";
    setTimeout(() => (copyStatus.value = ""), 1200);
  } catch {
    copyStatus.value = "Copie impossible";
    setTimeout(() => (copyStatus.value = ""), 1200);
  }
}

// Auto clear résumé si on change de mois
watch(
  () => [from.value, to.value] as const,
  (next, prev) => {
    const [f] = next;
    const [pf] = (prev ?? next);

    const prevMonth = parseYmd(pf).getMonth();
    const prevYear = parseYmd(pf).getFullYear();
    const newMonth = parseYmd(f).getMonth();
    const newYear = parseYmd(f).getFullYear();

    if (prevMonth !== newMonth || prevYear !== newYear) {
      summaryStats.value = null;
      summaryText.value = null;
      summaryError.value = "";
    }
  }
);

// --------------------
// Mount
// --------------------
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
          <p class="text-zinc-400 text-sm">Suivi d’activité des devs · complétion · export</p>
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

      <!-- Range + KPIs -->
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

          <div class="ml-auto text-xs text-zinc-400">
            Période :
            <span class="font-mono text-zinc-200">{{ rangeLabel }}</span>
            · <span class="text-zinc-200 font-semibold">{{ expectedWorkingDays }}</span> jours ouvrés
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
            @click="setThisWeek(); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            Semaine courante
          </button>

          <button
            @click="setWeeksBack(1); loadCompletion()"
            class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
          >
            1 semaine (précédente)
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

          <div class="w-px bg-zinc-800 mx-1"></div>

          <button
            @click="exportMonth(0)"
            class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs"
          >
            Export mois courant
          </button>
          <button
            @click="exportMonth(-1)"
            class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs"
          >
            Export mois précédent
          </button>
          <button
            @click="exportRange()"
            class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs"
          >
            Export période
          </button>
        </div>

        <!-- KPI cards -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-sm">
          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-zinc-400 text-xs">Total équipe</div>
            <div class="font-semibold">{{ totalTeamHours }} h</div>
          </div>

          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-zinc-400 text-xs">Moyenne / dev</div>
            <div class="font-semibold">{{ avgHoursPerDev }} h</div>
          </div>

          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-zinc-400 text-xs">Complétion moyenne</div>
            <div class="font-semibold">{{ teamAvgCompletion }}</div>
          </div>

          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-zinc-400 text-xs">Devs à relancer (&lt; 80%)</div>
            <div class="font-semibold">
              {{ devsAtRisk }}
              <span class="text-zinc-500">/</span>
              {{ users.length }}
            </div>
          </div>
        </div>

        <p v-if="msg" class="mt-3 text-sm text-red-200">{{ msg }}</p>
      </div>

      <!-- Résumé mensuel -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 mb-4">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 class="text-lg font-semibold">Résumé mensuel</h2>
            <p class="text-xs text-zinc-400">
              Génère un résumé exploitable pour le reporting (basé sur le mois de la date “Du”).
            </p>
          </div>

          <div class="flex items-center gap-2">
            <button
              @click="loadMonthlySummary"
              :disabled="summaryLoading"
              class="rounded-lg bg-white text-zinc-950 px-4 py-2 text-sm font-medium disabled:opacity-50"
              :title="isFullMonthSelected ? 'Mois complet sélectionné' : 'Tu peux générer même si la période n’est pas un mois complet (mois de “Du”)'"
            >
              {{ summaryLoading ? "Génération..." : "Générer" }}
            </button>

            <button
              v-if="summaryText"
              @click="copySummaryToClipboard"
              class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm"
              title="Copier le résumé"
            >
              Copier
            </button>

            <span v-if="copyStatus" class="text-xs text-zinc-300">{{ copyStatus }}</span>
          </div>
        </div>

        <p v-if="summaryError" class="text-sm text-red-200 mb-2">
          {{ summaryError }}
        </p>

        <div v-if="summaryStats" class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-zinc-400 text-xs">Total équipe</div>
            <div class="font-semibold">
              {{ summaryStats?.totals?.days }} J · {{ summaryStats?.totals?.hours }} h
            </div>
          </div>

          <div
            v-for="(v, type) in summaryStats.byType"
            :key="type"
            class="rounded-xl bg-zinc-950 border border-zinc-800 p-3"
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

        <div v-if="!summaryText && !summaryLoading" class="text-sm text-zinc-500">
          Astuce : génère le résumé en fin de mois pour partager une synthèse propre (temps par type,
          risques, faits marquants).
        </div>
      </div>

      <!-- Table devs -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div class="flex items-center gap-2">
            <h2 class="font-semibold">Suivi devs</h2>
            <span class="text-xs text-zinc-500">
              ({{ filteredUsers.length }} / {{ users.length }})
            </span>
            <span class="text-xs text-zinc-500">· parfait : {{ devsPerfect }}</span>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="search"
              class="rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm"
              placeholder="Rechercher un dev…"
            />

            <select
              v-model="sortBy"
              class="rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm"
            >
              <option value="completion_desc">Tri : complétion ↓</option>
              <option value="completion_asc">Tri : complétion ↑</option>
              <option value="hours_desc">Tri : heures ↓</option>
              <option value="hours_asc">Tri : heures ↑</option>
              <option value="name">Tri : nom</option>
            </select>

            <button
              @click="exportRange()"
              class="rounded-xl bg-emerald-400 text-zinc-950 px-3 py-2 text-sm font-medium"
              title="Exporter toute l’équipe sur la période"
            >
              Export équipe
            </button>
          </div>
        </div>

        <div class="overflow-auto">
          <table class="w-full text-sm">
            <thead class="text-zinc-400">
              <tr>
                <th class="text-left py-2">Dev</th>
                <th class="text-right py-2">Jours remplis</th>
                <th class="text-right py-2">Manquants</th>
                <th class="text-right py-2">Complétion</th>
                <th class="text-right py-2">Heures</th>
                <th class="text-right py-2">Actions</th>
              </tr>
            </thead>

            <tbody>
              <tr
                v-for="u in filteredUsers"
                :key="u.userId"
                class="border-t border-zinc-800"
              >
                <td class="py-2">
                  <div class="font-medium">{{ u.name }}</div>
                  <div class="text-xs text-zinc-500 font-mono">{{ u.userId }}</div>
                </td>

                <td class="py-2 text-right">
                  {{ u.filledDays }}
                  <span class="text-zinc-500">/</span>
                  {{ expectedWorkingDays }}
                </td>

                <td class="py-2 text-right">
                  <span
                    class="px-2 py-0.5 rounded-full text-xs border"
                    :class="missingDaysFor(u) === 0 ? 'bg-emerald-500/10 text-emerald-200 border-emerald-700/30' : 'bg-red-500/10 text-red-200 border-red-700/30'"
                  >
                    {{ missingDaysFor(u) }}
                  </span>
                </td>

                <td class="py-2 text-right">
                  <span
                    class="px-2 py-0.5 rounded-full text-xs border"
                    :class="completionBadgeClass(completionRateFor(u))"
                  >
                    {{ completionLabel(completionRateFor(u)) }}
                  </span>
                </td>

                <td class="py-2 text-right font-semibold">
                  {{ u.totalHours.toFixed(1) }}
                </td>

                <td class="py-2 text-right whitespace-nowrap">
                  <button
                    @click="exportRange(u.userId)"
                    class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs"
                    title="Exporter l’activité de ce dev sur la période"
                  >
                    Export dev
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!loading && filteredUsers.length === 0" class="text-zinc-500 text-sm mt-3">
          Aucun dev ne correspond au filtre.
        </div>
      </div>
    </div>
  </div>
</template>