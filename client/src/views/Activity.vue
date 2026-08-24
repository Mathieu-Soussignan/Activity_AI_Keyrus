<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { supabase } from "../lib/supabase";
import { api } from "../lib/api";
import { ensureMe, clearMeCache, type Me } from "../lib/me";

const router = useRouter();

// Reference constants matching Excel schema
const ALLOWED_PROJECTS = [
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
] as const;

const ALLOWED_TYPES = [
  "Projet - Evo",
  "TMA - Correctif",
  "Incident Applicatif",
  "Support",
  "Réunion",
  "Congés",
  "Alternance",
  "Autre",
] as const;

const ALLOWED_DAY_CHARGES = [0.125, 0.25, 0.5, 0.75, 0.875, 1.0];
const HOURS_PER_DAY = 7;

type ActivityItem = {
  id: string;
  date?: string;
  day?: string;
  ticket: string;
  flux: string;
  subject: string;
  project: string;
  type: string;
  hours: number;
  days: number;
  helperMessage?: string | null;
  devOpsUrl?: string | null;
  syncStatus?: string;
  syncLabel?: string;
};

// State
const me = ref<Me | null>(null);
const currentTab = ref<"saisie" | "historique" | "dashboard">("saisie");
const inputMode = ref<"ai" | "manual">("ai");

// Saisie state
const selectedDay = ref<string>(new Date().toISOString().slice(0, 10));
const naturalText = ref<string>("");
const isAnalyzing = ref<boolean>(false);
const isSaving = ref<boolean>(false);
const saveSuccess = ref<string>("");
const saveError = ref<string>("");
const aiWarning = ref<string>("");

// Human-in-the-loop review items
const proposedActivities = ref<ActivityItem[]>([]);
const hasAnalyzed = ref<boolean>(false);

// Summary & History state
const summary = ref<any>(null);
const historyActivities = ref<ActivityItem[]>([]);
const historyLoading = ref<boolean>(false);
const historyFilterDay = ref<string>("");

function uid() {
  return crypto.randomUUID();
}

function hoursToDays(hours: number): number {
  const h = Math.max(0, Number(hours || 0));
  const raw = h / HOURS_PER_DAY;
  if (raw <= 0) return 0;
  let closest: number = ALLOWED_DAY_CHARGES[0]!;
  let minDiff = Math.abs(raw - closest);
  for (const step of ALLOWED_DAY_CHARGES) {
    const diff = Math.abs(raw - step);
    if (diff < minDiff) {
      minDiff = diff;
      closest = step;
    }
  }
  return closest;
}

function checkDurationHelper(hours: number): string | null {
  const h = Math.max(0, Number(hours || 0));
  const rawDays = Math.round((h / HOURS_PER_DAY) * 1000) / 1000;
  const isExact = ALLOWED_DAY_CHARGES.some((v) => Math.abs(v - rawDays) < 1e-4);
  if (!isExact && h > 0) {
    return `Cette durée (${h}h) correspond à ${rawDays} jour. Choisissez la charge Excel la plus proche ou ajustez la durée.`;
  }
  return null;
}

// Computeds
const meLabel = computed(() => me.value?.full_name?.trim() || me.value?.email || "Développeur");
const meRoleLabel = computed(() => (me.value?.role === "pm" ? "Chef de Projet (CP)" : "Développeur"));

const totalDayHours = computed(() => {
  return Math.round(proposedActivities.value.reduce((acc, a) => acc + (Number(a.hours) || 0), 0) * 100) / 100;
});

const totalDayDays = computed(() => {
  return Math.round((totalDayHours.value / HOURS_PER_DAY) * 1000) / 1000;
});

const isOverDailyTarget = computed(() => totalDayHours.value > HOURS_PER_DAY);

// Example prompt helpers
function applyPromptExample(exampleText: string) {
  naturalText.value = exampleText;
}

// 1. Natural Language Parse via Mistral / Backend
async function analyzeActivity() {
  if (!naturalText.value.trim()) return;

  saveSuccess.value = "";
  saveError.value = "";
  aiWarning.value = "";
  isAnalyzing.value = true;

  try {
    const { data } = await api.post("/api/v2/ai/parse-natural", {
      text: naturalText.value,
      day: selectedDay.value,
    });

    if (data?.success && Array.isArray(data.activities)) {
      proposedActivities.value = data.activities.map((a: any) => ({
        id: uid(),
        date: a.date || selectedDay.value,
        ticket: a.ticket || "",
        flux: a.flux || "",
        subject: a.subject || "",
        project: a.project || "AX",
        type: a.type || "Projet - Evo",
        hours: Number(a.hours || 0),
        days: Number(a.days || hoursToDays(Number(a.hours || 0))),
        helperMessage: checkDurationHelper(Number(a.hours || 0)),
        devOpsUrl: a.ticket ? `https://scp-tma-flux.visualstudio.com/Gestion%20des%20tickets/_workitems/edit/${a.ticket}` : null,
      }));

      hasAnalyzed.value = true;
      if (data.warningMessage) {
        aiWarning.value = data.warningMessage;
      }
    }
  } catch (e: any) {
    saveError.value = e?.response?.data?.error || e.message || "Erreur lors de l'analyse.";
  } finally {
    isAnalyzing.value = false;
  }
}

// Update hours on a card
function updateActivityHours(item: ActivityItem, val: number) {
  item.hours = Math.max(0, Number(val || 0));
  item.days = hoursToDays(item.hours);
  item.helperMessage = checkDurationHelper(item.hours);
}

// Update days on a card
function updateActivityDays(item: ActivityItem, val: number) {
  item.days = Number(val || 0);
  item.hours = Math.round(item.days * HOURS_PER_DAY * 100) / 100;
  item.helperMessage = null;
}

// Add empty activity
function addActivity() {
  proposedActivities.value.push({
    id: uid(),
    date: selectedDay.value,
    ticket: "",
    flux: "",
    subject: "Nouvelle activité",
    project: "AX",
    type: "Projet - Evo",
    hours: 1.75,
    days: 0.25,
    helperMessage: null,
  });
  hasAnalyzed.value = true;
}

// Duplicate activity
function duplicateActivity(index: number) {
  const source = proposedActivities.value[index];
  if (!source) return;
  proposedActivities.value.splice(index + 1, 0, {
    ...source,
    id: uid(),
  });
}

// Remove activity
function removeActivity(index: number) {
  proposedActivities.value.splice(index, 1);
  if (proposedActivities.value.length === 0) {
    hasAnalyzed.value = false;
  }
}

// Reset form
function resetSaisie() {
  naturalText.value = "";
  proposedActivities.value = [];
  hasAnalyzed.value = false;
  saveSuccess.value = "";
  saveError.value = "";
  aiWarning.value = "";
}

// 2. Save Activities (Human-in-the-loop confirmation)
async function saveActivities() {
  if (proposedActivities.value.length === 0) return;

  isSaving.value = true;
  saveSuccess.value = "";
  saveError.value = "";

  try {
    const { data } = await api.post("/api/v2/activities", {
      day: selectedDay.value,
      activities: proposedActivities.value,
    });

    if (data?.success) {
      saveSuccess.value = `✅ Journée du ${selectedDay.value} validée et enregistrée ! (Simulation SharePoint : Tableau6245781824)`;
      await loadSummary();
      await loadHistory();
    }
  } catch (e: any) {
    saveError.value = e?.response?.data?.error || e.message || "Erreur lors de l'enregistrement.";
  } finally {
    isSaving.value = false;
  }
}

// Load personal summary
async function loadSummary() {
  try {
    const { data } = await api.get("/api/v2/activities/summary", {
      params: { date: selectedDay.value },
    });
    if (data?.summary) {
      summary.value = data.summary;
    }
  } catch (e) {
    console.warn("Erreur chargement résumé personnel:", e);
  }
}

// Load activities history
async function loadHistory() {
  historyLoading.value = true;
  try {
    const { data } = await api.get("/api/v2/activities", {
      params: {
        day: historyFilterDay.value ? historyFilterDay.value : undefined,
      },
    });
    if (data?.activities) {
      historyActivities.value = data.activities;
    }
  } catch (e) {
    console.warn("Erreur chargement historique:", e);
  } finally {
    historyLoading.value = false;
  }
}

// Delete activity from history
async function deleteHistoryItem(id: string) {
  if (!confirm("Voulez-vous supprimer cette ligne d'activité ?")) return;
  try {
    await api.delete(`/api/v2/activities/${id}`);
    await loadHistory();
    await loadSummary();
  } catch (e: any) {
    alert(e?.message || "Erreur suppression");
  }
}

// Logout
async function handleLogout() {
  await supabase.auth.signOut();
  clearMeCache();
  router.push("/login");
}

onMounted(async () => {
  const profile = await ensureMe();
  if (!profile) {
    router.push("/login");
    return;
  }
  me.value = profile;
  await loadSummary();
  await loadHistory();
});
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 pb-16">
    
    <!-- Top Header & Navigation -->
    <header class="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur sticky top-0 z-20 px-6 py-3.5">
      <div class="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap">
        
        <!-- Brand & Title -->
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
            A
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="text-base font-bold text-white tracking-tight">Activity AI</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase">
                ● Simulation locale (SharePoint Mock)
              </span>
            </div>
            <p class="text-xs text-zinc-400">Saisie & Synchronisation d’activité Keyrus</p>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <nav class="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800 text-xs font-medium">
          <button
            @click="currentTab = 'saisie'"
            class="px-3 py-1.5 rounded-lg transition"
            :class="currentTab === 'saisie' ? 'bg-zinc-800 text-white font-semibold shadow' : 'text-zinc-400 hover:text-zinc-200'"
          >
            ✍️ Saisir mon activité
          </button>
          <button
            @click="currentTab = 'historique'; loadHistory()"
            class="px-3 py-1.5 rounded-lg transition"
            :class="currentTab === 'historique' ? 'bg-zinc-800 text-white font-semibold shadow' : 'text-zinc-400 hover:text-zinc-200'"
          >
            📋 Mes activités
          </button>
          <button
            @click="currentTab = 'dashboard'; loadSummary()"
            class="px-3 py-1.5 rounded-lg transition"
            :class="currentTab === 'dashboard' ? 'bg-zinc-800 text-white font-semibold shadow' : 'text-zinc-400 hover:text-zinc-200'"
          >
            📊 Mon bilan
          </button>
        </nav>

        <!-- User profile & Lab link -->
        <div class="flex items-center gap-3">
          <!-- Laboratory link (Tech Diagnostic POC) -->
          <router-link
            to="/sharepoint-poc"
            class="px-2.5 py-1 rounded-lg text-xs font-medium bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition flex items-center gap-1.5"
            title="Outil de test et diagnostic technique Microsoft Graph / SharePoint"
          >
            <span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
            <span>Lab Diagnostic POC</span>
          </router-link>

          <!-- User Pill -->
          <div class="text-xs text-right hidden sm:block">
            <div class="font-semibold text-zinc-200">{{ meLabel }}</div>
            <div class="text-[11px] text-zinc-500">{{ meRoleLabel }}</div>
          </div>

          <button
            @click="handleLogout"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
          >
            Sortir
          </button>
        </div>

      </div>
    </header>

    <!-- Main Container -->
    <main class="max-w-6xl mx-auto px-6 pt-6 space-y-6">

      <!-- Mini-Dashboard Summary Cards -->
      <section class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
        
        <!-- Aujourd'hui -->
        <div class="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 relative overflow-hidden">
          <div class="flex items-center justify-between text-zinc-400 mb-1">
            <span>Aujourd'hui</span>
            <span class="font-mono text-zinc-500">{{ summary?.referenceDate || selectedDay }}</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="text-2xl font-bold text-white">{{ summary?.today?.hours || 0 }} h</span>
            <span class="text-zinc-400 text-xs">/ 7 h</span>
            <span class="ml-auto font-medium text-emerald-400">({{ summary?.today?.days || 0 }} j)</span>
          </div>
          <div class="w-full bg-zinc-800 h-1.5 rounded-full mt-3 overflow-hidden">
            <div
              class="h-full bg-blue-500 rounded-full transition-all"
              :style="{ width: `${Math.min(100, ((summary?.today?.hours || 0) / 7) * 100)}%` }"
            ></div>
          </div>
        </div>

        <!-- Cette Semaine -->
        <div class="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 relative overflow-hidden">
          <div class="flex items-center justify-between text-zinc-400 mb-1">
            <span>Cette semaine</span>
            <span class="font-mono text-zinc-500">Objectif 35 h</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="text-2xl font-bold text-white">{{ summary?.week?.hours || 0 }} h</span>
            <span class="text-zinc-400 text-xs">/ 35 h</span>
            <span class="ml-auto font-medium text-emerald-400">({{ summary?.week?.days || 0 }} j)</span>
          </div>
          <div class="w-full bg-zinc-800 h-1.5 rounded-full mt-3 overflow-hidden">
            <div
              class="h-full bg-indigo-500 rounded-full transition-all"
              :style="{ width: `${Math.min(100, ((summary?.week?.hours || 0) / 35) * 100)}%` }"
            ></div>
          </div>
        </div>

        <!-- Ce Mois -->
        <div class="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 relative overflow-hidden">
          <div class="flex items-center justify-between text-zinc-400 mb-1">
            <span>Ce mois-ci</span>
            <span class="font-mono text-zinc-500">Cumul</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="text-2xl font-bold text-white">{{ summary?.month?.hours || 0 }} h</span>
            <span class="ml-auto font-medium text-emerald-400">({{ summary?.month?.days || 0 }} j)</span>
          </div>
          <div class="w-full bg-zinc-800 h-1.5 rounded-full mt-3 overflow-hidden">
            <div class="h-full bg-emerald-500 rounded-full w-full"></div>
          </div>
        </div>

      </section>

      <!-- TAB 1: SAISIE D'ACTIVITÉ -->
      <section v-if="currentTab === 'saisie'" class="space-y-6">

        <!-- Banner messages -->
        <div v-if="saveSuccess" class="p-4 rounded-2xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs flex items-center justify-between">
          <span>{{ saveSuccess }}</span>
          <button @click="saveSuccess = ''" class="text-emerald-400 hover:text-emerald-200">✕</button>
        </div>

        <div v-if="saveError" class="p-4 rounded-2xl bg-red-950/40 border border-red-800 text-red-300 text-xs flex items-center justify-between">
          <span>{{ saveError }}</span>
          <button @click="saveError = ''" class="text-red-400 hover:text-red-200">✕</button>
        </div>

        <!-- Main Prompt Card -->
        <div class="rounded-2xl bg-zinc-900/70 border border-zinc-800 p-6 space-y-5 shadow-xl">
          
          <div class="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 class="text-lg font-bold text-white">Bonjour {{ meLabel }} 👋</h2>
              <p class="text-xs text-zinc-400 mt-0.5">Qu'as-tu fait aujourd'hui ?</p>
            </div>

            <!-- Date Selector & Mode Toggle -->
            <div class="flex items-center gap-3">
              <div class="flex items-center gap-1 bg-zinc-950 px-3 py-1.5 rounded-xl border border-zinc-800 text-xs">
                <span class="text-zinc-500">Date :</span>
                <input
                  v-model="selectedDay"
                  type="date"
                  class="bg-transparent text-zinc-200 font-medium outline-none cursor-pointer"
                />
              </div>

              <div class="flex items-center bg-zinc-950 p-0.5 rounded-xl border border-zinc-800 text-xs">
                <button
                  @click="inputMode = 'ai'"
                  class="px-2.5 py-1 rounded-lg transition"
                  :class="inputMode === 'ai' ? 'bg-blue-600 text-white font-semibold' : 'text-zinc-400'"
                >
                  ✨ Assistant IA
                </button>
                <button
                  @click="inputMode = 'manual'; if (proposedActivities.length === 0) addActivity()"
                  class="px-2.5 py-1 rounded-lg transition"
                  :class="inputMode === 'manual' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400'"
                >
                  ✍️ Saisie Manuelle
                </button>
              </div>
            </div>
          </div>

          <!-- Mode 1: Saisie Naturelle Assistée par IA -->
          <div v-if="inputMode === 'ai'" class="space-y-3">
            <div class="relative">
              <textarea
                v-model="naturalText"
                rows="4"
                class="w-full rounded-2xl bg-zinc-950 border border-zinc-800 p-4 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition resize-none"
                placeholder="Exemple : Aujourd'hui j'ai travaillé 5h sur le ticket 594. J'ai analysé le problème, corrigé le mapping de FNA035 et fait les tests en REC..."
              ></textarea>
            </div>

            <!-- Example chips -->
            <div class="flex items-center gap-2 flex-wrap text-[11px] text-zinc-400">
              <span class="text-zinc-500">Exemples rapides :</span>
              <button
                @click="applyPromptExample('Aujourd\'hui j\'ai travaillé 5h sur le ticket 594. J\'ai analysé le problème, corrigé le mapping de FNA035 et fait les tests en REC.')"
                class="px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
              >
                Ticket 594 (5h) + FNA035
              </button>
              <button
                @click="applyPromptExample('2h sur le ticket 594 pour corriger FNA035, 3h sur le ticket 612 projet CRM et 1h30 en réunion daily')"
                class="px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
              >
                Multi-tâches (2h + 3h + 1h30)
              </button>
              <button
                @click="applyPromptExample('Journée complète de 7h sur la TMA correctif plateforme AX')"
                class="px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
              >
                Journée complète (7h)
              </button>
            </div>

            <!-- Action button -->
            <div class="flex items-center justify-end gap-3 pt-2">
              <button
                v-if="naturalText"
                @click="resetSaisie"
                class="px-3 py-2 rounded-xl text-xs text-zinc-400 hover:text-zinc-200"
              >
                Effacer
              </button>
              <button
                @click="analyzeActivity"
                :disabled="isAnalyzing || !naturalText.trim()"
                class="px-5 py-2.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition shadow-lg shadow-blue-600/20 flex items-center gap-2"
              >
                <span v-if="isAnalyzing">Traitement par Mistral IA...</span>
                <span v-else>✨ Analyser mon activité</span>
              </button>
            </div>
          </div>

        </div>

        <!-- Section Human-in-the-loop : Revue & Validation des Activités -->
        <div v-if="hasAnalyzed || inputMode === 'manual'" class="space-y-4">
          
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <h3 class="text-sm font-bold text-white">Analyse & Revue de ton activité (Validation humaine)</h3>
            </div>
            <button
              @click="addActivity"
              class="px-3 py-1 rounded-lg text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200"
            >
              + Ajouter une tâche
            </button>
          </div>

          <!-- Non-blocking Warning if > 7h -->
          <div v-if="isOverDailyTarget || aiWarning" class="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800 text-amber-300 text-xs">
            {{ aiWarning || `⚠️ Total journalier (${totalDayHours}h = ${totalDayDays}j) supérieur à la journée de référence (7h = 1j). Vous pouvez valider ou ajuster les durées.` }}
          </div>

          <!-- Cards for each proposed activity -->
          <div class="space-y-3">
            <div
              v-for="(item, idx) in proposedActivities"
              :key="item.id"
              class="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 text-xs space-y-3 transition hover:border-zinc-700"
            >
              <div class="flex items-center justify-between pb-2 border-b border-zinc-800/80">
                <span class="font-bold text-zinc-300">Tâche #{{ idx + 1 }}</span>
                <div class="flex items-center gap-2">
                  <button
                    @click="duplicateActivity(idx)"
                    class="text-zinc-500 hover:text-zinc-300 text-xs"
                    title="Dupliquer la ligne"
                  >
                    ⎘ Dupliquer
                  </button>
                  <button
                    @click="removeActivity(idx)"
                    class="text-red-400 hover:text-red-300 text-xs"
                    title="Supprimer la tâche"
                  >
                    ✕ Supprimer
                  </button>
                </div>
              </div>

              <!-- Grid Fields -->
              <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                
                <!-- Ticket ID -->
                <div>
                  <label class="text-zinc-400 block mb-1">ID Ticket</label>
                  <div class="relative">
                    <input
                      v-model="item.ticket"
                      type="text"
                      class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 font-mono outline-none"
                      placeholder="594"
                    />
                    <a
                      v-if="item.ticket"
                      :href="`https://scp-tma-flux.visualstudio.com/Gestion%20des%20tickets/_workitems/edit/${item.ticket}`"
                      target="_blank"
                      class="absolute right-2.5 top-2 text-blue-400 hover:text-blue-300"
                      title="Ouvrir dans Azure DevOps"
                    >
                      ↪
                    </a>
                  </div>
                </div>

                <!-- Nom Flux -->
                <div>
                  <label class="text-zinc-400 block mb-1">Nom Flux</label>
                  <input
                    v-model="item.flux"
                    type="text"
                    class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-amber-300 font-mono outline-none"
                    placeholder="FNA035"
                  />
                </div>

                <!-- Projet -->
                <div>
                  <label class="text-zinc-400 block mb-1">Projet</label>
                  <select
                    v-model="item.project"
                    class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none"
                  >
                    <option v-for="p in ALLOWED_PROJECTS" :key="p" :value="p">{{ p }}</option>
                  </select>
                </div>

                <!-- Type -->
                <div>
                  <label class="text-zinc-400 block mb-1">Type d'activité</label>
                  <select
                    v-model="item.type"
                    class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none"
                  >
                    <option v-for="t in ALLOWED_TYPES" :key="t" :value="t">{{ t }}</option>
                  </select>
                </div>

                <!-- Sujet (Large) -->
                <div class="sm:col-span-2 md:col-span-2">
                  <label class="text-zinc-400 block mb-1">Sujet / Description</label>
                  <input
                    v-model="item.subject"
                    type="text"
                    class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none"
                    placeholder="Description de la tâche..."
                  />
                </div>

                <!-- Durée en Heures -->
                <div>
                  <label class="text-zinc-400 block mb-1">Durée (heures)</label>
                  <input
                    :value="item.hours"
                    @input="updateActivityHours(item, Number(($event.target as HTMLInputElement).value))"
                    type="number"
                    step="0.25"
                    min="0"
                    max="24"
                    class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 font-mono outline-none"
                  />
                </div>

                <!-- Charge Excel (Jours) -->
                <div>
                  <label class="text-zinc-400 block mb-1">Charge Excel (jours)</label>
                  <select
                    :value="item.days"
                    @change="updateActivityDays(item, Number(($event.target as HTMLSelectElement).value))"
                    class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-emerald-400 font-semibold outline-none"
                  >
                    <option v-for="ch in ALLOWED_DAY_CHARGES" :key="ch" :value="ch">
                      {{ ch }} j ({{ Math.round(ch * 7 * 100) / 100 }}h)
                    </option>
                  </select>
                </div>

              </div>

              <!-- Duration helper alert if intermediate duration -->
              <div v-if="item.helperMessage" class="text-[11px] text-amber-400 p-2 rounded-lg bg-amber-950/30 border border-amber-900/60">
                💡 {{ item.helperMessage }}
              </div>
            </div>
          </div>

          <!-- Daily Total Bar & Final Validation -->
          <div class="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800 flex items-center justify-between flex-wrap gap-4">
            <div>
              <div class="text-xs text-zinc-400">Total de la journée :</div>
              <div class="text-base font-bold text-white flex items-center gap-2">
                <span>{{ totalDayHours }} h / 7 h</span>
                <span class="text-xs font-semibold text-emerald-400">({{ totalDayDays }} jour)</span>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <button
                @click="resetSaisie"
                class="px-4 py-2 rounded-xl text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
              >
                Annuler
              </button>
              <button
                @click="saveActivities"
                :disabled="isSaving || proposedActivities.length === 0"
                class="px-6 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 transition shadow-lg shadow-emerald-600/20 flex items-center gap-2"
              >
                <span v-if="isSaving">Enregistrement & Simulation SharePoint...</span>
                <span v-else>✓ Valider & Enregistrer</span>
              </button>
            </div>
          </div>

        </div>

      </section>

      <!-- TAB 2: HISTORIQUE / MES ACTIVITÉS -->
      <section v-if="currentTab === 'historique'" class="space-y-4">
        
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 class="text-base font-bold text-white">Mes activités récentes</h2>
            <p class="text-xs text-zinc-400">Historique des saisies et état de synchronisation.</p>
          </div>

          <div class="flex items-center gap-2 text-xs">
            <input
              v-model="historyFilterDay"
              @change="loadHistory"
              type="date"
              class="bg-zinc-950 border border-zinc-800 px-3 py-1.5 rounded-xl text-zinc-200 outline-none cursor-pointer"
            />
            <button
              v-if="historyFilterDay"
              @click="historyFilterDay = ''; loadHistory()"
              class="px-2.5 py-1.5 rounded-xl bg-zinc-800 text-zinc-300"
            >
              Tous
            </button>
          </div>
        </div>

        <div v-if="historyLoading" class="text-center py-10 text-xs text-zinc-500">
          Chargement des activités...
        </div>

        <div v-else-if="historyActivities.length === 0" class="text-center py-12 rounded-2xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-400">
          Aucune activité enregistrée pour cette période.
        </div>

        <div v-else class="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-xl">
          <table class="w-full text-xs text-left">
            <thead class="text-zinc-400 bg-zinc-900/80 border-b border-zinc-800 sticky top-0">
              <tr>
                <th class="p-3">Date</th>
                <th class="p-3">Ticket</th>
                <th class="p-3">Flux</th>
                <th class="p-3">Sujet</th>
                <th class="p-3">Projet</th>
                <th class="p-3">Durée</th>
                <th class="p-3">Type</th>
                <th class="p-3">Statut Sync</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-800/60">
              <tr v-for="act in historyActivities" :key="act.id" class="hover:bg-zinc-900/40">
                <td class="p-3 font-mono text-zinc-300">{{ act.day }}</td>
                <td class="p-3 font-mono">
                  <a
                    v-if="act.ticket"
                    :href="act.devOpsUrl || '#'"
                    target="_blank"
                    class="text-blue-400 hover:underline"
                  >
                    {{ act.ticket }} ↪
                  </a>
                  <span v-else class="text-zinc-600">-</span>
                </td>
                <td class="p-3 font-mono text-amber-400">{{ act.flux || '-' }}</td>
                <td class="p-3 text-zinc-200 max-w-xs truncate">{{ act.subject }}</td>
                <td class="p-3 text-zinc-400">{{ act.project }}</td>
                <td class="p-3 font-semibold text-emerald-400">
                  {{ act.hours }}h <span class="text-zinc-500 font-normal">({{ act.days }}j)</span>
                </td>
                <td class="p-3 text-zinc-400">{{ act.type }}</td>
                <td class="p-3">
                  <span class="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-950/60 text-emerald-300 border border-emerald-800">
                    {{ act.syncLabel || '✓ Enregistrée' }}
                  </span>
                </td>
                <td class="p-3 text-right">
                  <button
                    @click="deleteHistoryItem(act.id)"
                    class="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-800"
                  >
                    Suppr
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

      </section>

      <!-- TAB 3: DASHBOARD / BILAN PERSONNEL -->
      <section v-if="currentTab === 'dashboard'" class="space-y-6">
        
        <div>
          <h2 class="text-base font-bold text-white">Mon Bilan d'activité</h2>
          <p class="text-xs text-zinc-400">Synthèse de temps et suivi des objectifs journaliers & hebdomadaires.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          <div class="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4 text-xs">
            <h3 class="font-bold text-white">Répartition de la semaine</h3>
            <div class="space-y-2">
              <div class="flex justify-between text-zinc-400">
                <span>Temps cumulé cette semaine :</span>
                <span class="font-bold text-white">{{ summary?.week?.hours || 0 }} h ({{ summary?.week?.days || 0 }} j)</span>
              </div>
              <div class="flex justify-between text-zinc-400">
                <span>Objectif hebdomadaire :</span>
                <span class="font-mono text-zinc-300">35.0 h (5 jours)</span>
              </div>
              <div class="flex justify-between text-zinc-400">
                <span>Progression :</span>
                <span class="font-bold text-indigo-400">
                  {{ Math.round(((summary?.week?.hours || 0) / 35) * 100) }}%
                </span>
              </div>
            </div>
          </div>

          <div class="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4 text-xs">
            <h3 class="font-bold text-white">Règles Métier & Échelons Excel</h3>
            <div class="space-y-1.5 text-zinc-300">
              <div>• Base contractuelle : <strong>1 jour = 7 heures</strong></div>
              <div>• Échelons autorisés : <strong>0.125, 0.25, 0.5, 0.75, 0.875, 1.0 j</strong></div>
              <div>• Mode actif : <span class="text-amber-400 font-bold">Mock / Simulation locale</span></div>
              <div>• Onglet Excel cible : <strong>Mathieu</strong> (Tableau6245781824)</div>
            </div>
          </div>

        </div>

      </section>

    </main>

  </div>
</template>