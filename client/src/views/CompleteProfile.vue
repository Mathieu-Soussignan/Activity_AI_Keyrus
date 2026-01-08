<script setup lang="ts">
import { ref } from "vue";
import { api } from "../lib/api";
import { useRouter } from "vue-router";
import { supabase } from "../lib/supabase";

const router = useRouter();

const full_name = ref("");
const roleWanted = ref<"dev" | "pm">("dev");
const loading = ref(false);
const msg = ref("");

async function submit() {
  msg.value = "";
  loading.value = true;
  try {
    // petit garde-fou si session expirée
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      await router.push("/login");
      return;
    }

    const resp = await api.post("/api/profile/complete", {
      full_name: full_name.value,
      roleWanted: roleWanted.value,
    });

    msg.value = `✅ Profil complété (${resp?.data?.role})`;
    await router.push("/activity");
  } catch (e: any) {
    msg.value = e?.response?.data?.error || e?.message || "Erreur";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
    <div class="w-full max-w-lg rounded-2xl bg-zinc-900/60 border border-zinc-800 p-6">
      <h1 class="text-xl font-semibold">Compléter ton profil</h1>
      <p class="text-zinc-400 text-sm mt-1">
        On a besoin de ton nom pour que les exports CP soient lisibles.
      </p>

      <div class="mt-5 space-y-3">
        <div>
          <label class="text-sm text-zinc-400">Nom / Prénom</label>
          <input
            v-model="full_name"
            class="w-full mt-2 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2"
            placeholder="Ex: Jhonatan Caldeira"
          />
        </div>

        <div>
          <label class="text-sm text-zinc-400">Rôle</label>
          <select
            v-model="roleWanted"
            class="w-full mt-2 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2"
          >
            <option value="dev">Dev</option>
            <option value="pm">CP (si autorisé)</option>
          </select>

          <p class="text-[12px] text-zinc-500 mt-2">
            Le rôle CP est accordé seulement aux emails listés côté backend.
          </p>
        </div>

        <button
          @click="submit"
          :disabled="loading || !full_name.trim()"
          class="mt-2 rounded-xl bg-emerald-400 text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
        >
          {{ loading ? "Enregistrement..." : "Valider" }}
        </button>

        <p v-if="msg" class="text-sm text-zinc-300 mt-3">{{ msg }}</p>
      </div>
    </div>
  </div>
</template>