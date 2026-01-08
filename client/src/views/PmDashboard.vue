<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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

const loading = ref(false);
const msg = ref("");
const users = ref<UserStat[]>([]);
const me = ref<Me | null>(null);

const from = ref(yyyyMmDd(startOfMonth(new Date())));
const to = ref(yyyyMmDd(endOfMonth(new Date())));

const totalTeamHours = computed(() =>
  users.value.reduce((acc, u) => acc + (Number(u.totalHours) || 0), 0).toFixed(1)
);

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

    me.value = user; // 👈 IMPORTANT
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
    const { data } = await api.get("/api/pm/completion", {
      params: { from: from.value, to: to.value },
    });

    // On garde seulement les devs dans la liste (le CP n’a pas besoin de s’afficher)
    users.value = (data?.users ?? [])
      .filter((u: any) => (u?.role ?? "") === "dev")
      .map((u: any) => ({
        userId: u.userId,
        name: u.name,
        role: u.role,
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

function setMonth(offset: number) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  from.value = yyyyMmDd(startOfMonth(d));
  to.value = yyyyMmDd(endOfMonth(d));
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

      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 mb-4">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label class="text-xs text-zinc-400">Du</label>
            <input v-model="from" type="date" class="block rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2" />
          </div>

          <div>
            <label class="text-xs text-zinc-400">Au</label>
            <input v-model="to" type="date" class="block rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2" />
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
          <button @click="setMonth(0); loadCompletion()" class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs">
            Mois courant
          </button>
          <button @click="setMonth(-1); loadCompletion()" class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1 text-xs">
            Mois précédent
          </button>

          <button @click="exportMonth(0)" class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs">
            Export CP mois courant
          </button>
          <button @click="exportMonth(-1)" class="rounded-lg bg-emerald-400 text-zinc-950 px-3 py-1 text-xs">
            Export CP mois précédent
          </button>
        </div>

        <p v-if="msg" class="mt-3 text-sm text-red-200">{{ msg }}</p>
      </div>

      <div class="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4">
        <table class="w-full text-sm">
          <thead class="text-zinc-400">
            <tr>
              <th class="text-left py-2">Dev</th>
              <th class="text-right py-2">Jours remplis</th>
              <th class="text-right py-2">Heures</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.userId" class="border-t border-zinc-800">
              <td class="py-2">{{ u.name }}</td>
              <td class="py-2 text-right">{{ u.filledDays }}</td>
              <td class="py-2 text-right font-semibold">{{ u.totalHours.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="!loading && users.length === 0" class="text-zinc-500 text-sm mt-3">
          Aucun dev trouvé sur la période.
        </div>
      </div>
    </div>
  </div>
</template>