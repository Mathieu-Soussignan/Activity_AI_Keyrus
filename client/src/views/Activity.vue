<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { supabase } from "../lib/supabase";
import { ensureMe, clearMeCache, type Me } from "../lib/me";
import { api } from "../lib/api";
import { useRouter } from "vue-router";

const router = useRouter();

type ActivityType =
  | "Evol"
  | "Ano"
  | "Incident Applicatif"
  | "Projet"
  | "Non défini"
  | "Congés"
  | "Alternance"
  | "Week-end";

const PROJECT_GROUPS = [
  { label: "Plateformes", items: ["Technique", "CRM", "AX", "eComm", "ORO", "Okaveo", "SIRH"] },
  { label: "Projets / Domaines", items: ["Mail relève", "IRMA", "LMS", "IMPU"] },
  { label: "Absences", items: ["Absent"] },
] as const;

type Row = {
  id: string;
  day: string;

  id_ticket: string;
  sujet: string;
  projet: string;

  temps_passe_h: number;
  temps_passe_j: number;

  type: ActivityType;
  impute: string; // Code VSA
};

type MonthDayStatus = "weekend" | "filled" | "empty";
type MonthDayItem = {
  day: string; // YYYY-MM-DD
  dayNumber: number;
  weekdayLabel: string;
  isWeekend: boolean;
  status: MonthDayStatus;
  totalHours: number; // ✅ on garde en heures dans le panel mois (comme avant)
  linesCount: number;
};

function uid() {
  return crypto.randomUUID();
}

const day = ref<string>(new Date().toISOString().slice(0, 10));
const text = ref<string>("");
const projects = ref<string[]>([]);
const rows = ref<Row[]>([]);
const loadingAi = ref<boolean>(false);
const saving = ref<boolean>(false);
const msg = ref<string>("");
const logoutLoading = ref<boolean>(false);
const me = ref<Me | null>(null);

const meLabel = computed(() => {
  if (!me.value) return "";
  return (me.value.full_name?.trim() || me.value.email || "").trim();
});

const meRoleLabel = computed(() => {
  const r = me.value?.role;
  if (r === "pm") return "CP";
  if (r === "dev") return "Dev";
  return "";
});

// ---- Month panel state
const monthDays = ref<MonthDayItem[]>([]);
const loadingMonth = ref(false);
const monthError = ref<string>("");

// Anti-perte
const lastSavedSnapshot = ref<string>("");

// ---- Day change controller
const changingDay = ref(false);
let lastDayBeforeInput = day.value;

function onDayInputFocus() {
  lastDayBeforeInput = day.value;
}

async function onDayInputChange(e: Event) {
  const wanted = (e.target as HTMLInputElement)?.value;
  if (!wanted || wanted === lastDayBeforeInput) return;

  day.value = lastDayBeforeInput;
  await changeDay(wanted);
}

async function changeDay(targetDay: string, opts?: { force?: boolean }) {
  if (!targetDay || targetDay === day.value) return;
  if (changingDay.value) return;

  if (!opts?.force && isDirty.value) {
    const ok = window.confirm(
      "Tu as des modifications non sauvegardées. Changer de jour va les perdre.\n\nOK = changer quand même\nAnnuler = rester ici"
    );
    if (!ok) return;
  }

  changingDay.value = true;
  try {
    day.value = targetDay;
    await loadDayFromApi(targetDay);
    await loadMonth();
  } finally {
    changingDay.value = false;
  }
}

// --------------------
// Temps en jours (UI)
// --------------------
const DAY_STEP = 0.25;
const MAX_DAYS_PER_ROW = 1;
const HOURS_PER_DAY = 7;

// Options 0 -> 1J par pas de 0.25
const DAY_OPTIONS = computed(() => {
  const out: number[] = [];
  for (let v = 0; v <= MAX_DAYS_PER_ROW + 1e-9; v += DAY_STEP) {
    out.push(Math.round(v / DAY_STEP) * DAY_STEP);
  }
  return out;
});

function clampToDayStep(x: number) {
  const n = Number(x ?? 0);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), MAX_DAYS_PER_ROW);
  return Math.round(clamped / DAY_STEP) * DAY_STEP;
}

// clamp heures au quart d’heure (utile si l’API renvoie 1.333 etc)
const HOUR_STEP = 0.25;
const MAX_HOURS_PER_ROW = 24;
function clampToHourStep(x: number) {
  const n = Number(x ?? 0);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), MAX_HOURS_PER_ROW);
  return Math.round(clamped / HOUR_STEP) * HOUR_STEP;
}

function hToJ(h: number) {
  return clampToDayStep(clampToHourStep(Number(h || 0)) / HOURS_PER_DAY);
}

function jToH(j: number) {
  const h = Number(j || 0) * HOURS_PER_DAY;
  return clampToHourStep(h);
}

const totalDays = computed(() =>
  rows.value.reduce((acc, r) => acc + (Number(r.temps_passe_j) || 0), 0)
);

const totalHours = computed(() =>
  Math.round(totalDays.value * HOURS_PER_DAY * 10) / 10
);

const monthTitle = computed(() => {
  const d = new Date(day.value);
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
});

const filledDaysCount = computed(() =>
  monthDays.value.filter((d) => d.status === "filled").length
);

const missingDaysCount = computed(() =>
  monthDays.value.filter((d) => d.status === "empty").length
);

const monthTotalHours = computed(() =>
  monthDays.value
    .reduce((acc, d) => acc + (Number(d.totalHours) || 0), 0)
    .toFixed(1)
);

function snapshotCurrent() {
  return JSON.stringify({
    day: day.value,
    text: text.value,
    rows: rows.value.map(({ id, ...rest }) => rest),
  });
}

const isDirty = computed(() => snapshotCurrent() !== lastSavedSnapshot.value);

// ---- Helpers dates
function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function toYYYYMMDD(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function getDaysInMonth(year: number, month1to12: number) {
  return new Date(year, month1to12, 0).getDate();
}
const WEEKDAYS_FR = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"] as const;

function weekdayLabelFR(date: Date): string {
  return WEEKDAYS_FR[date.getDay()] ?? "??";
}
function isWeekendDate(date: Date) {
  const w = date.getDay();
  return w === 0 || w === 6;
}
function isCurrentMonthSelected() {
  const selected = new Date(day.value);
  const now = new Date();
  return (
    selected.getFullYear() === now.getFullYear() &&
    selected.getMonth() === now.getMonth()
  );
}

// --------------------
// Rows helpers
// --------------------
function newEmptyRow(): Row {
  return {
    id: uid(),
    day: day.value,
    id_ticket: "",
    sujet: "",
    projet: "",
    temps_passe_h: 0,
    temps_passe_j: 0,
    type: "Non défini",
    impute: "",
  };
}

function addRow() {
  msg.value = "";
  rows.value.push(newEmptyRow());
}

function duplicateRow(index: number) {
  msg.value = "";
  const r = rows.value[index];
  if (!r) return;

  rows.value.splice(index + 1, 0, {
    ...r,
    id: uid(),
    day: day.value,
  });
}

function removeRow(index: number) {
  msg.value = "";
  rows.value.splice(index, 1);
}

function clearAll() {
  text.value = "";
  msg.value = "";
  loadingAi.value = false;
}

async function ensureAuthedOrRedirect() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) {
    await router.push("/login");
  }
}

async function loadProjects() {
  msg.value = "";
  try {
    const { data } = await api.get("/api/projects");
    projects.value = (data?.projects ?? []) as string[];
  } catch (e: any) {
    msg.value =
      e?.response?.data?.error || e?.message || "Erreur chargement projects";
  }
}

// ---- API parsing helpers
function coerceRows(payload: any): any[] {
  if (payload?.rows && Array.isArray(payload.rows)) return payload.rows;
  if (payload?.activities && Array.isArray(payload.activities))
    return payload.activities;
  if (Array.isArray(payload)) return payload;
  return [];
}

function buildMonthDaysFromActivities(year: number, month: number, activities: any[]) {
  const daysCount = getDaysInMonth(year, month);

  const byDay = new Map<string, any[]>();
  for (const a of activities) {
    if (!a?.day) continue;
    if (!byDay.has(a.day)) byDay.set(a.day, []);
    byDay.get(a.day)!.push(a);
  }

  const result: MonthDayItem[] = [];
  for (let dayNumber = 1; dayNumber <= daysCount; dayNumber++) {
    const d = new Date(year, month - 1, dayNumber);
    const yyyyMMdd = toYYYYMMDD(d);
    const weekend = isWeekendDate(d);

    const dayActs = byDay.get(yyyyMMdd) ?? [];
    const total = dayActs.reduce((acc, r) => acc + (Number(r.temps_passe_h) || 0), 0);

    let status: MonthDayStatus = "empty";
    if (weekend) status = "weekend";
    else if (dayActs.length > 0) status = "filled";

    result.push({
      day: yyyyMMdd,
      dayNumber,
      weekdayLabel: weekdayLabelFR(d),
      isWeekend: weekend,
      status,
      totalHours: Number(total.toFixed(1)),
      linesCount: dayActs.length,
    });
  }

  return result;
}

function buildMonthDaysFromAggregatedDays(year: number, month: number, payload: any) {
  const daysCount = getDaysInMonth(year, month);
  const map = new Map<string, { totalHours?: number; linesCount?: number }>();

  if (Array.isArray(payload?.days)) {
    for (const d of payload.days) {
      if (d?.day) map.set(d.day, { totalHours: d.totalHours, linesCount: d.linesCount });
    }
  }

  const result: MonthDayItem[] = [];
  for (let dayNumber = 1; dayNumber <= daysCount; dayNumber++) {
    const d = new Date(year, month - 1, dayNumber);
    const yyyyMMdd = toYYYYMMDD(d);
    const weekend = isWeekendDate(d);
    const agg = map.get(yyyyMMdd);

    const total = Number(agg?.totalHours ?? 0);
    const count = Number(agg?.linesCount ?? 0);

    let status: MonthDayStatus = "empty";
    if (weekend) status = "weekend";
    else if (count > 0) status = "filled";

    result.push({
      day: yyyyMMdd,
      dayNumber,
      weekdayLabel: weekdayLabelFR(d),
      isWeekend: weekend,
      status,
      totalHours: Number(total.toFixed(1)),
      linesCount: count,
    });
  }

  return result;
}

async function loadMonth() {
  loadingMonth.value = true;
  monthError.value = "";
  try {
    const d = new Date(day.value);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const { data } = await api.get("/api/activities/month", { params: { year, month } });

    if (data?.days) {
      monthDays.value = buildMonthDaysFromAggregatedDays(year, month, data);
      return;
    }

    const activities = coerceRows(data?.activities ?? data);
    monthDays.value = buildMonthDaysFromActivities(year, month, activities);
  } catch (e: any) {
    monthError.value = e?.response?.data?.error || e?.message || "Erreur chargement mois";
  } finally {
    loadingMonth.value = false;
  }
}

async function loadDayFromApi(targetDay: string) {
  msg.value = "";
  try {
    const { data } = await api.get("/api/activities/day", { params: { day: targetDay } });

    rows.value = coerceRows(data).map((r: any) => {
      const id_ticket = r.id_ticket ?? "";
      const h = clampToHourStep(Number(r.temps_passe_h ?? 0));
      const j = clampToDayStep(
        Number.isFinite(Number(r.temps_passe_j)) ? Number(r.temps_passe_j) : hToJ(h)
      );

      return {
        id: uid(),
        day: targetDay,
        id_ticket,
        sujet: r.sujet ?? "",
        projet: r.projet ?? "",
        temps_passe_h: h,
        temps_passe_j: j,
        type: (r.type ?? "Non défini") as ActivityType,
        impute: r.impute ?? "",
      };
    });

    text.value = "";
    lastSavedSnapshot.value = snapshotCurrent();
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur chargement jour";
  }
}

function rowFingerprint(r: Pick<Row, "sujet" | "projet" | "temps_passe_j" | "type">) {
  return [
    (r.sujet ?? "").trim().toLowerCase(),
    (r.projet ?? "").trim().toLowerCase(),
    String(clampToDayStep(Number(r.temps_passe_j ?? 0))),
    r.type,
  ].join("|");
}

async function parseAi() {
  msg.value = "";
  loadingAi.value = true;
  try {
    const existing = rows.value.map((r) => ({ ...r }));

    const { data } = await api.post("/api/ai/parse", {
      day: day.value,
      text: text.value,
      knownProjects: projects.value,
    });

    const generatedRaw = (data?.rows ?? []) as any[];

    const generated: Row[] = generatedRaw.map((r) => {
      const id_ticket = r.id_ticket ?? "";
      const h = clampToHourStep(Number(r.temps_passe_h ?? 0));
      const j = clampToDayStep(
        Number.isFinite(Number(r.temps_passe_j)) ? Number(r.temps_passe_j) : hToJ(h)
      );

      return {
        id: uid(),
        day: day.value,
        id_ticket,
        sujet: r.sujet ?? "",
        projet: r.projet ?? "",
        temps_passe_h: h,
        temps_passe_j: j,
        type: (r.type ?? "Non défini") as ActivityType,
        impute: r.impute ?? "",
      };
    });

    const seen = new Set(existing.map((r) => rowFingerprint(r)));
    const toAdd = generated.filter((r) => {
      const fp = rowFingerprint(r);
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });

    rows.value = [...existing, ...toAdd];

    if (toAdd.length === 0) {
      msg.value = "ℹ️ L’IA n’a rien ajouté (doublons).";
    }
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur IA";
  } finally {
    loadingAi.value = false;
  }
}

async function saveDay() {
  msg.value = "";
  saving.value = true;
  try {
    const { data } = await api.post("/api/activities/upsertDay", {
      day: day.value,
      rows: rows.value.map(({ id, ...rest }) => {
        const j = clampToDayStep(Number(rest.temps_passe_j ?? 0));
        const h = jToH(j);

        return {
          ...rest,
          temps_passe_j: j,      // UI
          temps_passe_h: h,      // DB (autorité)
        };
      }),
    });

    msg.value = `✅ Sauvegardé (${data?.inserted ?? 0} lignes)`;
    lastSavedSnapshot.value = snapshotCurrent();
    await loadMonth();
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur sauvegarde";
  } finally {
    saving.value = false;
  }
}

async function selectDayFromMonthPanel(targetDay: string) {
  await changeDay(targetDay);
}

async function logout() {
  if (logoutLoading.value) return;
  logoutLoading.value = true;
  try {
    await supabase.auth.signOut();
    clearMeCache();
    await router.push("/login");
  } finally {
    logoutLoading.value = false;
  }
}

const canExport = computed(() => true);
const exportHint = computed(() => {
  if (!isCurrentMonthSelected()) return "";
  return "⚠️ Mois en cours : l’export est possible même si tout n’est pas rempli.";
});

async function exportExcel() {
  msg.value = "";
  try {
    const d = new Date(day.value);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const resp = await api.get("/api/activities/export", {
      params: { year, month },
      responseType: "blob",
    });

    const blob = new Blob([resp.data], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `activities_${year}-${String(month).padStart(2, "0")}.csv`;
    a.click();

    window.URL.revokeObjectURL(url);
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur export";
  }
}

onMounted(async () => {
  await ensureAuthedOrRedirect();

  try {
    me.value = await ensureMe();
  } catch {
    me.value = null;
  }

  await loadProjects();
  await loadMonth();
  await loadDayFromApi(day.value);
});
</script>


<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100">
    <div class="max-w-6xl mx-auto p-6">
      <!-- Header -->
      <header class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold">Feuille d’activité</h1>
          <p class="text-zinc-400 text-sm">Une phrase → lignes prêtes → sauvegarde</p>
        </div>

        <div class="flex items-center gap-4">
          <!-- 👤 Utilisateur connecté -->
          <div v-if="me" class="text-right leading-tight">
            <div class="text-sm font-semibold">
              {{ meLabel }}
            </div>
            <div class="text-xs text-zinc-400">
              {{ meRoleLabel }}
            </div>
          </div>

          <!-- ⚠️ Modifs non sauvegardées -->
          <div
            v-if="isDirty"
            class="text-xs text-amber-300/90 border border-amber-700/40 px-2 py-1 rounded-lg"
          >
            Modifs non sauvegardées
          </div>

          <!-- Dashboard CP (PM only) -->
          <button
            v-if="me?.role === 'pm'"
            @click="router.push('/pm')"
            class="rounded-xl bg-emerald-400 text-zinc-950 px-3 py-2 text-sm font-medium"
          >
            Dashboard CP
          </button>

          <!-- 🚪 Logout -->
          <button
            @click="logout"
            :disabled="logoutLoading"
            class="text-zinc-300 hover:text-white text-sm disabled:opacity-50"
          >
            {{ logoutLoading ? "Déconnexion..." : "Déconnexion" }}
          </button>
        </div>
      </header>

      <!-- Layout -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <!-- Mois en cours -->
        <aside class="lg:col-span-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h2 class="font-semibold capitalize">{{ monthTitle }}</h2>
              <p class="text-zinc-400 text-xs">
                ✔ {{ filledDaysCount }} / ❌ {{ missingDaysCount }} — Total {{ monthTotalHours }}h
              </p>
            </div>

            <div class="flex flex-col items-end gap-1">
              <button
                @click="exportExcel"
                :disabled="!canExport"
                class="rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm disabled:opacity-50"
                title="Exporter le mois affiché"
              >
                Export Excel
              </button>
              <div v-if="exportHint" class="text-[11px] text-amber-300/80">
                {{ exportHint }}
              </div>
            </div>
          </div>

          <p v-if="monthError" class="mt-3 text-sm text-red-300">
            {{ monthError }}
          </p>

          <div class="mt-4">
            <div v-if="loadingMonth" class="text-sm text-zinc-400">Chargement du mois…</div>

            <ul v-else class="space-y-2 max-h-[65vh] overflow-auto pr-1">
              <li
                v-for="d in monthDays"
                :key="d.day"
                @click="selectDayFromMonthPanel(d.day)"
                class="flex items-center justify-between gap-3 p-2 rounded-xl border border-zinc-800 hover:bg-zinc-800/40 cursor-pointer"
                :class="day === d.day ? 'bg-zinc-800/60 border-zinc-700' : ''"
              >
                <div class="flex items-center gap-3">
                  <div class="w-12 text-center">
                    <div class="text-xs text-zinc-400">{{ d.weekdayLabel }}</div>
                    <div class="text-base font-semibold">{{ d.dayNumber }}</div>
                  </div>

                  <div class="text-sm">
                    <div class="flex items-center gap-2">
                      <span
                        class="px-2 py-0.5 rounded-full text-xs border"
                        :class="{
                          'bg-zinc-700/40 text-zinc-200 border-zinc-700': d.status === 'weekend',
                          'bg-emerald-500/15 text-emerald-200 border-emerald-700/40': d.status === 'filled',
                          'bg-red-500/10 text-red-200 border-red-700/40': d.status === 'empty',
                        }"
                      >
                        <template v-if="d.status === 'weekend'">Week-end</template>
                        <template v-else-if="d.status === 'filled'">✔ Rempli</template>
                        <template v-else>❌ Vide</template>
                      </span>

                      <span class="text-xs text-zinc-400">{{ d.linesCount }} ligne(s)</span>
                    </div>
                  </div>
                </div>

                <div class="text-right">
                  <div class="text-sm font-semibold">{{ d.totalHours }}h</div>
                  <div class="text-[11px] text-zinc-500 font-mono">{{ d.day }}</div>
                </div>
              </li>
            </ul>
          </div>
        </aside>

        <!-- Colonne principale -->
        <section class="lg:col-span-8 min-w-0">
          <div class="grid gap-4">
            <!-- Input -->
            <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4">
              <div class="flex flex-wrap gap-3 items-center mb-3">
                <label class="text-sm text-zinc-400">Jour</label>
                <input
                  v-model="day"
                  type="date"
                  @focus="onDayInputFocus"
                  @change="onDayInputChange"
                  class="rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2"
                />
              </div>

              <label class="text-sm text-zinc-400">Décris ta journée</label>
              <textarea
                v-model="text"
                class="w-full mt-2 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 min-h-[110px] outline-none"
                placeholder="Ex: Matin incident applicatif. Aprem evol AMP lot2. Total 1J."
              />

              <div class="flex gap-3 mt-3">
                <button
                  @click="parseAi"
                  :disabled="loadingAi || !text.trim()"
                  class="rounded-xl bg-white text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
                >
                  {{ loadingAi ? "Analyse..." : "✨ Générer" }}
                </button>

                <button
                  type="button"
                  class="btn-secondary"
                  :disabled="!text && !msg"
                  @click="clearAll"
                >
                  Effacer et repartir de zéro
                </button>

                <button
                  @click="saveDay"
                  :disabled="saving || rows.length === 0"
                  class="rounded-xl bg-emerald-400 text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
                >
                  {{ saving ? "Sauvegarde..." : "💾 Sauver" }}
                </button>
              </div>

              <p v-if="msg" class="mt-3 text-sm text-zinc-300">{{ msg }}</p>
            </div>

            <!-- Preview -->
            <div v-if="rows.length" class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 min-w-0">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <h2 class="font-semibold">Prévisualisation</h2>

                  <button
                    @click="addRow"
                    class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs hover:bg-zinc-900"
                  >
                    ➕ Ajouter une ligne
                  </button>
                </div>

                <div class="text-zinc-400 text-sm">
                  Total : {{ totalDays.toFixed(2) }}J ({{ totalHours.toFixed(2) }}h)
                </div>
              </div>

              <div class="overflow-x-auto overflow-y-hidden">
                <table class="w-full text-sm table-fixed">
                  <thead class="text-zinc-400">
                    <tr>
                      <th class="w-28 text-left py-2 pr-2 whitespace-nowrap">Date</th>
                      <th class="w-32 text-left py-2 pr-2 whitespace-nowrap">ID Ticket</th>
                      <th class="w-[20rem] text-left py-2 pr-2 whitespace-nowrap">Sujet</th>
                      <th class="w-48 text-left py-2 pr-2 whitespace-nowrap">Projet</th>
                      <th class="w-40 text-left py-2 pr-2 whitespace-nowrap">Charge réelle (J)</th>
                      <th class="w-44 text-left py-2 pr-2 whitespace-nowrap">Type</th>
                      <th class="w-44 text-left py-2 pr-2 whitespace-nowrap">Code VSA</th>
                      <th class="w-28 text-right py-2 whitespace-nowrap">Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    <tr v-for="(r, i) in rows" :key="r.id" class="border-t border-zinc-800">
                      <!-- Date -->
                      <td class="py-2 pr-2 whitespace-nowrap">
                        <span class="text-[11px] font-mono text-zinc-400">{{ r.day }}</span>
                      </td>

                      <!-- ID Ticket -->
                      <td class="py-2 pr-2">
                        <input
                          v-model="r.id_ticket"
                          class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1"
                          placeholder="ex: INC12345"
                        />
                      </td>

                      <!-- Sujet -->
                      <td class="py-2 pr-2">
                        <input
                          v-model="r.sujet"
                          class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1"
                          placeholder="Ex: Incident API, Evol AMP lot2..."
                        />
                      </td>

                      <!-- Projet (optgroups) -->
                      <td class="py-2 pr-2">
                        <select
                          v-model="r.projet"
                          class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1"
                        >
                          <option value="">(Non défini)</option>

                          <optgroup v-for="g in PROJECT_GROUPS" :key="g.label" :label="g.label">
                            <option v-for="p in g.items" :key="g.label + '-' + p" :value="p">
                              {{ p }}
                            </option>
                          </optgroup>
                        </select>
                      </td>

                      <!-- Temps -->
                      <td class="py-2 pr-2">
                        <select
                          v-model.number="r.temps_passe_j"
                          class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1"
                        >
                          <option v-for="t in DAY_OPTIONS" :key="t" :value="t">
                            {{ String(t).replace(".", ",") }} J
                          </option>
                        </select>
                      </td>

                      <!-- Type -->
                      <td class="py-2 pr-2">
                        <select
                          v-model="r.type"
                          class="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1"
                        >
                          <optgroup label="Tickets">
                            <option value="Evol">Evol</option>
                            <option value="Ano">Ano</option>
                            <option value="Incident Applicatif">Incident Applicatif</option>
                            <option value="Projet">Projet</option>
                            <option value="Non défini">Non défini</option>
                          </optgroup>

                          <optgroup label="Absences">
                            <option value="Congés">Congés</option>
                            <option value="Week-end">Week-end</option>
                          </optgroup>
                        </select>
                      </td>

                      <!-- Code VSA (verrouillé) -->
                      <td class="py-2 pr-2">
                        <input
                          :value="r.impute"
                          disabled
                          class="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-2 py-1 text-zinc-400 cursor-not-allowed"
                          title="Ne pas modifier (Code VSA)"
                        />
                      </td>

                      <!-- Actions -->
                      <td class="py-2 text-right whitespace-nowrap">
                        <button
                          @click="duplicateRow(i)"
                          class="text-xs px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 hover:bg-zinc-900 mr-2"
                          title="Dupliquer"
                        >
                          📄
                        </button>

                        <button
                          @click="removeRow(i)"
                          class="text-xs px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 hover:bg-zinc-900"
                          title="Supprimer"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="mt-3 text-zinc-500 text-xs">
                Astuce : mets “Non défini” uniquement si tu n’as vraiment pas l’info — sinon ça dégrade le reporting.
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>