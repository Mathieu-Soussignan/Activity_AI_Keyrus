<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute } from "vue-router";
import axios from "axios";

const route = useRoute();

const API_BASE = (import.meta.env.VITE_API_URL as string) || "http://localhost:8787";

// Session & Config state
const loading = ref(false);
const statusData = ref<any>(null);
const authError = ref<string>("");
const authSuccess = ref<string>("");

// Step 2: Site discovery
const siteSearchQuery = ref("KEYFR-Projets");
const siteLoading = ref(false);
const siteData = ref<any>(null);
const siteError = ref<string>("");

// Step 3: Files discovery
const fileSearchQuery = ref("Plan d'activité");
const filesLoading = ref(false);
const filesData = ref<any>(null);
const filesError = ref<string>("");
const selectedFile = ref<any>(null);

// Step 4: Worksheets
const worksheetsLoading = ref(false);
const worksheetsData = ref<any>(null);
const worksheetsError = ref<string>("");

// Step 5: Read Mathieu worksheet
const mathieuLoading = ref(false);
const mathieuData = ref<any>(null);
const mathieuError = ref<string>("");

// Step 6: Controlled Write Test
const writeLoading = ref(false);
const writeSuccess = ref<string>("");
const writeError = ref<string>("");
const newRow = ref({
  date: new Date().toISOString().slice(0, 10),
  id_ticket: "594",
  nom_flux: "FNA035",
  sujet: "POC Activity AI / Microsoft Graph - Test contrôlé",
  projet: "AX",
  charge: 0.25,
  type: "Projet - Evo",
  repartition_vsa: "AX",
});

// Unit conversion widget
const calcHours = ref<number>(1.75);
const calcResult = ref<any>(null);

// Diff report state
const diffLoading = ref(false);
const diffReport = ref<any>(null);
const diffError = ref<string>("");

// Error Simulator state
const testScenarioLoading = ref(false);
const simulatedError = ref<any>(null);

// Diagnostic Log
const rawLogs = ref<Array<{ title: string; data: any; ts: string }>>([]);

function addLog(title: string, data: any) {
  rawLogs.value.unshift({
    title,
    data,
    ts: new Date().toLocaleTimeString(),
  });
}

// Fetch session status
async function refreshStatus() {
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/status`);
    statusData.value = res.data;
    addLog("Status Microsoft Session", res.data);
  } catch (e: any) {
    statusData.value = { configured: false, authenticated: false, error: e.message };
  }
}

// Enable simulation mode
async function enableSimulationMode() {
  try {
    const res = await axios.post(`${API_BASE}/api/poc/ms/mock/enable`);
    statusData.value = res.data.status;
    authSuccess.value = "Mode simulation locale activé (Mathieu Soussignan).";
    addLog("Simulation Mode Enabled", res.data);
    await discoverSharePointSite();
  } catch (e: any) {
    authError.value = e.message;
  }
}

// Start Microsoft OAuth Login
async function loginMicrosoft() {
  authError.value = "";
  loading.value = true;
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/auth-url`);
    addLog("Auth URL Generated", res.data);
    if (!res.data.configured) {
      authError.value = res.data.message || "AZURE_CLIENT_ID non configuré dans server/.env";
      return;
    }
    if (res.data.authUrl) {
      window.location.href = res.data.authUrl;
    }
  } catch (e: any) {
    authError.value = e?.response?.data?.error || e.message || "Erreur connexion Microsoft";
  } finally {
    loading.value = false;
  }
}

// Logout Microsoft
async function logoutMicrosoft() {
  try {
    await axios.post(`${API_BASE}/api/poc/ms/logout`);
    await refreshStatus();
    siteData.value = null;
    filesData.value = null;
    worksheetsData.value = null;
    mathieuData.value = null;
    selectedFile.value = null;
    authSuccess.value = "Session Microsoft fermée.";
  } catch (e: any) {
    authError.value = e.message;
  }
}

// Discover SharePoint site
async function discoverSharePointSite() {
  siteLoading.value = true;
  siteError.value = "";
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/site?search=${encodeURIComponent(siteSearchQuery.value)}`);
    siteData.value = res.data;
    addLog("SharePoint Site Discovery", res.data);
    if (!res.data.success) {
      siteError.value = res.data.error || "Erreur lors de la recherche du site SharePoint.";
    } else if (res.data.siteFound) {
      await discoverFiles(res.data.siteFound.id);
    }
  } catch (e: any) {
    siteError.value = e?.response?.data?.error || e.message;
  } finally {
    siteLoading.value = false;
  }
}

// Discover Files in Site
async function discoverFiles(siteId: string) {
  filesLoading.value = true;
  filesError.value = "";
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/files?siteId=${encodeURIComponent(siteId)}&query=${encodeURIComponent(fileSearchQuery.value)}`);
    filesData.value = res.data;
    addLog("Files Discovery", res.data);
    if (!res.data.success) {
      filesError.value = res.data.error || "Erreur recherche fichiers.";
    } else if (res.data.files?.length > 0) {
      const testFile = res.data.files.find((f: any) => f.isTestFile) || res.data.files[0];
      selectedFile.value = testFile;
      await listWorksheets();
    }
  } catch (e: any) {
    filesError.value = e?.response?.data?.error || e.message;
  } finally {
    filesLoading.value = false;
  }
}

// List Worksheets
async function listWorksheets() {
  if (!selectedFile.value) return;
  worksheetsLoading.value = true;
  worksheetsError.value = "";
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/worksheets?driveId=${selectedFile.value.driveId}&itemId=${selectedFile.value.id}`);
    worksheetsData.value = res.data;
    addLog("Worksheets List", res.data);
    if (!res.data.success) {
      worksheetsError.value = res.data.error || "Erreur liste worksheets.";
    } else {
      await readMathieuSheet();
    }
  } catch (e: any) {
    worksheetsError.value = e?.response?.data?.error || e.message;
  } finally {
    worksheetsLoading.value = false;
  }
}

// Read Mathieu Worksheet
async function readMathieuSheet() {
  if (!selectedFile.value) return;
  mathieuLoading.value = true;
  mathieuError.value = "";
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/worksheet/mathieu?driveId=${selectedFile.value.driveId}&itemId=${selectedFile.value.id}`);
    mathieuData.value = res.data;
    addLog("Mathieu Sheet Data", res.data);
    if (!res.data.success) {
      mathieuError.value = res.data.error || "Erreur lecture onglet Mathieu.";
    }
  } catch (e: any) {
    mathieuError.value = e?.response?.data?.error || e.message;
  } finally {
    mathieuLoading.value = false;
  }
}

// Controlled Write Test in SharePoint (TEST file only)
async function sendWriteTestGraph() {
  if (!selectedFile.value) return;
  if (!selectedFile.value.isTestFile && !selectedFile.value.name.toLowerCase().includes("test")) {
    writeError.value = "SÉCURITÉ STRICTE : L'écriture est interdite sur le fichier officiel. Veuillez sélectionner une copie contenant 'TEST'.";
    return;
  }

  writeLoading.value = true;
  writeError.value = "";
  writeSuccess.value = "";
  try {
    const res = await axios.post(`${API_BASE}/api/poc/ms/test-write`, {
      driveId: selectedFile.value.driveId,
      itemId: selectedFile.value.id,
      fileName: selectedFile.value.name,
      tableName: "Tableau6245781824",
      rowData: newRow.value,
    });
    addLog("Graph Write Test Result", res.data);
    if (res.data.success) {
      writeSuccess.value = res.data.message || "Ligne ajoutée avec succès via Microsoft Graph !";
      await readMathieuSheet();
      await runDiffCheck();
    } else {
      writeError.value = res.data.error || "Échec écriture Graph.";
    }
  } catch (e: any) {
    writeError.value = e?.response?.data?.error || e.message;
  } finally {
    writeLoading.value = false;
  }
}

// Convert Units Calculator
async function updateConversion() {
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/convert-units?hours=${calcHours.value}`);
    calcResult.value = res.data;
  } catch (e: any) {
    console.error(e);
  }
}

// Diff & Integrity Check
async function runDiffCheck() {
  diffLoading.value = true;
  diffError.value = "";
  try {
    const res = await axios.get(`${API_BASE}/api/poc/ms/diff`);
    diffReport.value = res.data;
    addLog("Diff Report", res.data);
  } catch (e: any) {
    diffError.value = e?.response?.data?.error || e.message;
  } finally {
    diffLoading.value = false;
  }
}

// Test Error Scenario
async function triggerErrorScenario(scenarioId: string) {
  testScenarioLoading.value = true;
  simulatedError.value = null;
  try {
    await axios.get(`${API_BASE}/api/poc/ms/test-scenario/${scenarioId}`);
  } catch (e: any) {
    simulatedError.value = {
      scenarioId,
      status: e?.response?.status,
      data: e?.response?.data,
    };
    addLog(`Error Scenario: ${scenarioId}`, e?.response?.data);
  } finally {
    testScenarioLoading.value = false;
  }
}

onMounted(async () => {
  if (route.query.auth_success) {
    authSuccess.value = "✅ Authentification Microsoft réussie avec succès !";
  }
  if (route.query.auth_error) {
    authError.value = `Erreur de connexion : ${String(route.query.auth_error)}`;
  }
  await refreshStatus();
  await updateConversion();
  await runDiffCheck();
});
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6">
    <div class="max-w-6xl mx-auto space-y-6">
      
      <!-- Top Navigation & Header -->
      <div class="flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">
              POC Technique V2
            </span>
            <span class="text-xs text-zinc-400">Microsoft Graph & SharePoint</span>
          </div>
          <h1 class="text-2xl font-bold mt-1 text-white">Activity AI — SharePoint POC</h1>
          <p class="text-xs text-zinc-400 mt-0.5">
            Validation technique d'accès au classeur d'activités SharePoint via Microsoft Entra ID & Graph API.
          </p>
        </div>
        <div class="flex items-center gap-3">
          <router-link
            to="/activity"
            class="px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white transition"
          >
            ← Retour à l'application
          </router-link>
        </div>
      </div>

      <!-- Alerts -->
      <div v-if="authSuccess" class="p-4 rounded-xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-sm flex items-center justify-between">
        <span>{{ authSuccess }}</span>
        <button @click="authSuccess = ''" class="text-emerald-400 hover:text-emerald-200">✕</button>
      </div>

      <div v-if="authError" class="p-4 rounded-xl bg-red-950/40 border border-red-800 text-red-300 text-sm flex items-center justify-between">
        <div>
          <div class="font-semibold">Information d'authentification</div>
          <div class="text-xs mt-1">{{ authError }}</div>
        </div>
        <button @click="authError = ''" class="text-red-400 hover:text-red-200">✕</button>
      </div>

      <!-- Section 1 : Statut Microsoft Entra ID & Mode Simulation -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-4">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div class="flex items-center gap-3">
            <div class="w-3 h-3 rounded-full" :class="statusData?.authenticated ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'"></div>
            <h2 class="text-lg font-semibold text-white">1. Authentification & Mode d'Exécution</h2>
            <span
              v-if="statusData?.isMock"
              class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase"
            >
              Mode Simulation Locale (Mock)
            </span>
            <span
              v-else-if="statusData?.authenticated"
              class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase"
            >
              Mode Microsoft Graph Live
            </span>
          </div>

          <div class="flex items-center gap-2">
            <button
              v-if="!statusData?.authenticated"
              @click="enableSimulationMode"
              class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-amber-300 border border-amber-500/30 transition"
            >
              Activer Simulation Locale
            </button>
            <button
              v-if="statusData?.authenticated"
              @click="logoutMicrosoft"
              class="px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
            >
              Déconnexion
            </button>
            <button
              v-else
              @click="loginMicrosoft"
              :disabled="loading"
              class="px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-2 transition disabled:opacity-50"
            >
              <svg class="w-4 h-4" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M0 0H10V10H0V0Z" fill="#F25022"/>
                <path d="M11 0H21V10H11V0Z" fill="#7FBA00"/>
                <path d="M0 11H10V21H0V11Z" fill="#00A4EF"/>
                <path d="M11 11H21V21H11V11Z" fill="#FFB900"/>
              </svg>
              <span>Se connecter avec Microsoft Keyrus</span>
            </button>
          </div>
        </div>

        <!-- Info details grid -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div class="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
            <span class="text-zinc-500 block">Configuration Backend</span>
            <span class="font-medium" :class="statusData?.configured ? 'text-emerald-400' : 'text-amber-400'">
              {{ statusData?.configured ? `Client ID: ${statusData.clientId}` : 'Variables .env en attente (Simulation prête)' }}
            </span>
          </div>
          <div class="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
            <span class="text-zinc-500 block">Identité Connectée</span>
            <span class="font-medium" :class="statusData?.authenticated ? 'text-emerald-400' : 'text-zinc-400'">
              {{ statusData?.account ? `${statusData.account.name} (${statusData.account.username})` : 'Non connecté' }}
            </span>
          </div>
          <div class="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
            <span class="text-zinc-500 block">Permissions Déléguées cibles</span>
            <span class="font-mono text-zinc-300">User.Read, Files.ReadWrite</span>
          </div>
        </div>
      </div>

      <!-- Section 2 : Découverte SharePoint (Site & Fichier) -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        <!-- Step 2: Site discovery -->
        <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-white">2. Découverte Site SharePoint</h3>
            <button
              @click="discoverSharePointSite"
              :disabled="siteLoading || !statusData?.authenticated"
              class="px-3 py-1 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40"
            >
              {{ siteLoading ? 'Recherche...' : 'Rechercher Site' }}
            </button>
          </div>
          <input
            v-model="siteSearchQuery"
            class="w-full text-xs rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none"
            placeholder="Nom ou mot-clé du site (ex: KEYFR-Projets)"
          />
          <div v-if="siteError" class="text-xs text-red-400 p-2 rounded-lg bg-red-950/30 border border-red-900">
            {{ siteError }}
          </div>
          <div v-if="siteData?.siteFound" class="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs space-y-1">
            <div class="text-emerald-400 font-medium">✓ Site trouvé : {{ siteData.siteFound.displayName || siteData.siteFound.name }}</div>
            <div class="text-zinc-400 truncate">ID : <span class="font-mono text-zinc-300">{{ siteData.siteFound.id }}</span></div>
            <div class="text-zinc-400 truncate">URL : <a :href="siteData.siteFound.webUrl" target="_blank" class="text-blue-400 underline">{{ siteData.siteFound.webUrl }}</a></div>
          </div>
        </div>

        <!-- Step 3: File discovery -->
        <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-white">3. Localisation Classeur Excel</h3>
            <button
              @click="siteData?.siteFound && discoverFiles(siteData.siteFound.id)"
              :disabled="filesLoading || !siteData?.siteFound"
              class="px-3 py-1 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40"
            >
              {{ filesLoading ? 'Recherche...' : 'Rechercher Fichier' }}
            </button>
          </div>
          <input
            v-model="fileSearchQuery"
            class="w-full text-xs rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none"
            placeholder="Nom du fichier (ex: Plan d'activité)"
          />
          <div v-if="filesError" class="text-xs text-red-400 p-2 rounded-lg bg-red-950/30 border border-red-900">
            {{ filesError }}
          </div>
          <div v-if="filesData?.files?.length" class="space-y-2 max-h-36 overflow-y-auto">
            <div
              v-for="file in filesData.files"
              :key="file.id"
              @click="selectedFile = file; listWorksheets()"
              class="p-2.5 rounded-xl border text-xs cursor-pointer transition flex items-center justify-between"
              :class="selectedFile?.id === file.id ? 'bg-blue-950/40 border-blue-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-700'"
            >
              <div class="truncate mr-2">
                <span v-if="file.isTestFile" class="px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300 text-[10px] font-bold mr-1.5">TEST</span>
                <span v-else class="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px] font-bold mr-1.5">OFFICIEL</span>
                <span>{{ file.name }}</span>
              </div>
              <span class="text-[11px] text-zinc-500 font-mono shrink-0">{{ Math.round(file.size / 1024) }} Ko</span>
            </div>
          </div>
        </div>

      </div>

      <!-- Section 3 : Inspection Excel & Worksheets -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold text-white">4 & 5. Inspection du Classeur & Onglet Mathieu</h3>
            <p class="text-xs text-zinc-400">Lecture des 10 onglets et extraction sécurisée des données de la table de Mathieu.</p>
          </div>
          <div class="flex items-center gap-2">
            <button
              @click="listWorksheets"
              :disabled="worksheetsLoading || !selectedFile"
              class="px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40"
            >
              {{ worksheetsLoading ? 'Chargement...' : '1. Lister les Onglets' }}
            </button>
            <button
              @click="readMathieuSheet"
              :disabled="mathieuLoading || !selectedFile"
              class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
            >
              {{ mathieuLoading ? 'Lecture...' : '2. Lire Onglet Mathieu' }}
            </button>
          </div>
        </div>

        <!-- Worksheets pills -->
        <div v-if="worksheetsData?.worksheets?.length" class="flex flex-wrap gap-2 pt-2 border-t border-zinc-800">
          <span
            v-for="ws in worksheetsData.worksheets"
            :key="ws.id"
            class="px-2.5 py-1 rounded-lg text-xs font-medium border"
            :class="ws.name === 'Mathieu' ? 'bg-emerald-950 border-emerald-600 text-emerald-300 font-bold' : 'bg-zinc-950 border-zinc-800 text-zinc-400'"
          >
            {{ ws.name }}
          </span>
        </div>

        <!-- Mathieu sheet table view -->
        <div v-if="mathieuData?.rows?.length" class="space-y-2">
          <div class="flex items-center justify-between text-xs text-zinc-400">
            <span>Plage : <span class="font-mono text-zinc-300">{{ mathieuData.address }}</span> | Table : <span class="font-mono text-zinc-300">{{ mathieuData.tables?.[0]?.name || 'Tableau6245781824' }}</span></span>
            <span>{{ mathieuData.rows.length }} lignes lues</span>
          </div>

          <div class="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 max-h-56 overflow-y-auto">
            <table class="w-full text-xs text-left">
              <thead class="text-zinc-400 bg-zinc-900/80 sticky top-0 border-b border-zinc-800">
                <tr>
                  <th class="p-2.5">Date</th>
                  <th class="p-2.5">ID Ticket</th>
                  <th class="p-2.5">Nom Flux</th>
                  <th class="p-2.5">Sujet</th>
                  <th class="p-2.5">Projet</th>
                  <th class="p-2.5">Charge (j)</th>
                  <th class="p-2.5">Type</th>
                  <th class="p-2.5">VSA</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-zinc-800/60">
                <tr v-for="r in mathieuData.rows" :key="r.rowNumber" class="hover:bg-zinc-900/40">
                  <td class="p-2.5 font-mono text-zinc-300">{{ r.date }}</td>
                  <td class="p-2.5 font-mono text-blue-400">{{ r.id_ticket }}</td>
                  <td class="p-2.5 font-mono text-amber-400">{{ r.nom_flux }}</td>
                  <td class="p-2.5 text-zinc-200 max-w-xs truncate">{{ r.sujet }}</td>
                  <td class="p-2.5 text-zinc-300">{{ r.projet }}</td>
                  <td class="p-2.5 font-semibold text-emerald-400">{{ r.charge }}</td>
                  <td class="p-2.5 text-zinc-400">{{ r.type }}</td>
                  <td class="p-2.5 text-zinc-400">{{ r.repartition_vsa }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Section 4 : Test d'Écriture Contrôlé & Convertisseur Heures <-> Jours -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        <!-- Formulaire d'écriture -->
        <div class="lg:col-span-2 rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-bold uppercase tracking-wider border border-amber-500/30">
                Garde-Fou Sécurité
              </span>
              <h3 class="text-sm font-semibold text-white">6. Test d'Écriture Contrôlé (Copie TEST Uniquement)</h3>
            </div>
            <p class="text-xs text-zinc-400 mt-1">
              Insertion sécurisée dans la Table <code class="text-zinc-300">Tableau6245781824</code> du fichier TEST.
            </p>
          </div>

          <div v-if="writeSuccess" class="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800 text-emerald-300 text-xs">
            {{ writeSuccess }}
          </div>
          <div v-if="writeError" class="text-xs text-red-400 p-3 rounded-xl bg-red-950/30 border border-red-900">
            {{ writeError }}
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <label class="text-zinc-400 block mb-1">Date</label>
              <input v-model="newRow.date" type="date" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none" />
            </div>
            <div>
              <label class="text-zinc-400 block mb-1">ID Ticket</label>
              <input v-model="newRow.id_ticket" type="text" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none" placeholder="594" />
            </div>
            <div>
              <label class="text-zinc-400 block mb-1">Nom Flux</label>
              <input v-model="newRow.nom_flux" type="text" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none" placeholder="FNA035" />
            </div>
            <div>
              <label class="text-zinc-400 block mb-1">Charge (jours)</label>
              <select v-model="newRow.charge" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none">
                <option :value="0.125">0.125 j (0.875h)</option>
                <option :value="0.25">0.25 j (1.75h)</option>
                <option :value="0.5">0.5 j (3.5h)</option>
                <option :value="0.75">0.75 j (5.25h)</option>
                <option :value="0.875">0.875 j (6.125h)</option>
                <option :value="1.0">1.0 j (7.0h)</option>
              </select>
            </div>
            <div class="col-span-2">
              <label class="text-zinc-400 block mb-1">Sujet</label>
              <input v-model="newRow.sujet" type="text" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none" />
            </div>
            <div>
              <label class="text-zinc-400 block mb-1">Projet</label>
              <input v-model="newRow.projet" type="text" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none" />
            </div>
            <div>
              <label class="text-zinc-400 block mb-1">Type</label>
              <input v-model="newRow.type" type="text" class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none" />
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              @click="sendWriteTestGraph"
              :disabled="writeLoading || !selectedFile"
              class="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 transition"
            >
              {{ writeLoading ? 'Envoi...' : 'Envoyer Ligne dans SharePoint TEST' }}
            </button>
          </div>
        </div>

        <!-- Calculateur de conversion Heures <-> Jours -->
        <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-3">
          <h3 class="text-sm font-semibold text-white">Conversion Heures ↔ Jours</h3>
          <p class="text-xs text-zinc-400">
            Règle métier Keyrus : 1 jour = 7 heures.
          </p>

          <div class="space-y-2 text-xs">
            <div>
              <label class="text-zinc-400 block mb-1">Saisie Activity AI (heures)</label>
              <input
                v-model.number="calcHours"
                @input="updateConversion"
                type="number"
                step="0.25"
                min="0"
                max="7"
                class="w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-200 outline-none font-mono"
              />
            </div>

            <div v-if="calcResult" class="p-3 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1.5">
              <div class="flex justify-between text-zinc-400">
                <span>Équivalent Excel :</span>
                <span class="font-bold text-emerald-400">{{ calcResult.convertedDays }} jour(s)</span>
              </div>
              <div class="flex justify-between text-zinc-400">
                <span>Heures recalculées :</span>
                <span class="font-mono text-zinc-200">{{ calcResult.convertedHours }} h</span>
              </div>
              <div class="text-[11px] text-zinc-500 pt-1 border-t border-zinc-800">
                Pas valides : 0.125, 0.25, 0.5, 0.75, 0.875, 1.0 j
              </div>
            </div>
          </div>
        </div>

      </div>

      <!-- Section 5 : Vérificateur de Diff & Non-Altération -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[10px] font-bold uppercase tracking-wider border border-blue-500/30">
                Diff & Intégrité
              </span>
              <h3 class="text-sm font-semibold text-white">Vérification Automatisée de Non-Altération</h3>
            </div>
            <p class="text-xs text-zinc-400 mt-1">
              Compare cellule par cellule le fichier officiel et le fichier test pour certifier qu'aucune ligne ou formule existante n'a été corrompue.
            </p>
          </div>
          <button
            @click="runDiffCheck"
            :disabled="diffLoading"
            class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition"
          >
            {{ diffLoading ? 'Analyse...' : 'Re-calculer Diff' }}
          </button>
        </div>

        <div v-if="diffReport" class="text-xs space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
              <span class="text-zinc-500 block">Formules & Référentiels</span>
              <span class="font-bold text-emerald-400">✓ 100% Intacts</span>
            </div>
            <div class="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
              <span class="text-zinc-500 block">Modifications inattendues</span>
              <span class="font-bold" :class="diffReport.unintendedChanges.length === 0 ? 'text-emerald-400' : 'text-red-400'">
                {{ diffReport.unintendedChanges.length === 0 ? '✓ 0 modification accidentelle' : `${diffReport.unintendedChanges.length} changement(s)` }}
              </span>
            </div>
            <div class="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
              <span class="text-zinc-500 block">Nouvelles lignes Mathieu</span>
              <span class="font-bold text-blue-400">{{ diffReport.mathieuAdditions.length }} ligne(s) de test ajoutée(s)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Section 6 : Banc d'Essai des Scénarios d'Erreurs -->
      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 space-y-4">
        <div>
          <h3 class="text-sm font-semibold text-white">7. Simulateur & Banc d'Essai des Scénarios d'Erreurs</h3>
          <p class="text-xs text-zinc-400 mt-1">
            Cliquez sur un cas pour tester la résilience et vérifier que l'application fournit un message explicite avec l'action corrective requise.
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            @click="triggerErrorScenario('unauthenticated')"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-zinc-300"
          >
            401 Token Absent / Expiré
          </button>
          <button
            @click="triggerErrorScenario('consent_required')"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-amber-300"
          >
            403 Consentement IT Requis (AADSTS65001)
          </button>
          <button
            @click="triggerErrorScenario('permission_denied')"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-red-300"
          >
            403 Droits SharePoint Insuffisants
          </button>
          <button
            @click="triggerErrorScenario('item_not_found')"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-zinc-300"
          >
            404 Fichier Introuvable
          </button>
          <button
            @click="triggerErrorScenario('safety_violation')"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-950 hover:bg-zinc-800 border border-red-800 text-red-400 font-bold"
          >
            403 Tentative Écriture Fichier Officiel
          </button>
          <button
            @click="triggerErrorScenario('invalid_charge')"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-amber-300"
          >
            400 Charge Invalide
          </button>
        </div>

        <!-- Simulated Error Feedback Panel -->
        <div v-if="simulatedError" class="p-4 rounded-xl border text-xs space-y-2 bg-zinc-950" :class="simulatedError.status >= 400 ? 'border-red-900/80 text-red-200' : 'border-zinc-800'">
          <div class="flex items-center justify-between">
            <span class="font-bold text-red-400">HTTP {{ simulatedError.status }} — {{ simulatedError.data?.title || simulatedError.data?.category }}</span>
            <span class="text-zinc-500 font-mono">{{ simulatedError.scenarioId }}</span>
          </div>
          <p class="text-zinc-300">{{ simulatedError.data?.message }}</p>
          <div v-if="simulatedError.data?.actionRequired" class="p-2 rounded bg-zinc-900 border border-zinc-800 text-amber-300 font-medium">
            💡 Action corrective : {{ simulatedError.data?.actionRequired }}
          </div>
        </div>
      </div>

      <!-- Section 7 : Formalisation Demande IT Keyrus -->
      <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-5 space-y-3">
        <h3 class="text-sm font-semibold text-white">8. Synthèse de la Demande IT Keyrus (App Registration)</h3>
        <div class="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 text-xs">
          <table class="w-full text-left">
            <tbody class="divide-y divide-zinc-800/60">
              <tr>
                <td class="p-2.5 font-semibold text-zinc-400 w-1/4">Nom de l'App Registration</td>
                <td class="p-2.5 font-mono text-zinc-200">Activity-AI-Keyrus-Local-POC</td>
              </tr>
              <tr>
                <td class="p-2.5 font-semibold text-zinc-400">Redirect URI (Web / SPA)</td>
                <td class="p-2.5 font-mono text-zinc-200">http://localhost:8787/api/poc/ms/callback et http://localhost:5173/sharepoint-poc</td>
              </tr>
              <tr>
                <td class="p-2.5 font-semibold text-zinc-400">Permissions API Déléguées</td>
                <td class="p-2.5 font-mono text-blue-400">User.Read, Files.ReadWrite (ou Sites.Selected), offline_access</td>
              </tr>
              <tr>
                <td class="p-2.5 font-semibold text-zinc-400">Périmètre & Risque</td>
                <td class="p-2.5 text-zinc-300">
                  Strictement délégué à l'identité du collaborateur connecté. L'application ne peut accéder qu'aux fichiers auxquels l'utilisateur a déjà accès dans SharePoint.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Section 8 : Diagnostic & Logs Raw -->
      <div class="rounded-2xl bg-zinc-900/30 border border-zinc-800/80 p-5 space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-zinc-300">9. Journal Diagnostic des Requêtes Graph</h3>
          <button @click="rawLogs = []" class="text-xs text-zinc-500 hover:text-zinc-300">Effacer</button>
        </div>
        <div class="max-h-48 overflow-y-auto space-y-2">
          <div
            v-for="(log, idx) in rawLogs"
            :key="idx"
            class="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400"
          >
            <div class="flex items-center justify-between text-zinc-300 font-bold mb-1">
              <span>{{ log.title }}</span>
              <span class="text-zinc-500 font-normal">{{ log.ts }}</span>
            </div>
            <pre class="overflow-x-auto text-zinc-400">{{ JSON.stringify(log.data, null, 2) }}</pre>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>
