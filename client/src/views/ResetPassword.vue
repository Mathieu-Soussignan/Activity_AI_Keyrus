<script setup lang="ts">
import { ref, onMounted } from "vue";
import { supabase } from "../lib/supabase";
import { useRouter } from "vue-router";

const router = useRouter();

const password = ref("");
const password2 = ref("");
const loading = ref(false);
const msg = ref<string>("");
const success = ref<string>("");

onMounted(async () => {
  // IMPORTANT :
  // Supabase “récupère” la session via le lien email (hash/params) automatiquement côté supabase-js.
  // Ici on vérifie juste qu’on a bien une session active.
  const { data } = await supabase.auth.getSession();
  if (!data?.session) {
    msg.value = "Lien invalide ou expiré. Recommence 'mot de passe oublié'.";
  }
});

async function updatePassword() {
  msg.value = "";
  success.value = "";

  if (!password.value || password.value.length < 8) {
    msg.value = "Mot de passe trop court (min 8).";
    return;
  }
  if (password.value !== password2.value) {
    msg.value = "Les mots de passe ne correspondent pas.";
    return;
  }

  loading.value = true;
  try {
    const { error } = await supabase.auth.updateUser({ password: password.value });
    if (error) throw error;

    success.value = "✅ Mot de passe mis à jour. Redirection…";
    setTimeout(() => router.push("/login"), 800);
  } catch (e: any) {
    msg.value = e?.message || "Erreur.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
    <div class="w-full max-w-md rounded-2xl bg-zinc-900/60 border border-zinc-800 p-6">
      <h1 class="text-2xl font-semibold">Nouveau mot de passe</h1>
      <p class="text-sm text-zinc-400 mt-1">
        Choisis un nouveau mot de passe pour ton compte.
      </p>

      <form class="mt-5 space-y-3" @submit.prevent="updatePassword">
        <div>
          <label class="text-xs text-zinc-400">Nouveau mot de passe</label>
          <input
            v-model="password"
            type="password"
            class="w-full mt-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 outline-none"
            placeholder="Min 8 caractères"
          />
        </div>

        <div>
          <label class="text-xs text-zinc-400">Confirmer</label>
          <input
            v-model="password2"
            type="password"
            class="w-full mt-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 outline-none"
          />
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full rounded-xl bg-white text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
        >
          {{ loading ? "..." : "Mettre à jour" }}
        </button>

        <p v-if="msg" class="text-sm text-red-300">{{ msg }}</p>
        <p v-if="success" class="text-sm text-emerald-300">{{ success }}</p>
      </form>

      <button
        class="mt-4 text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-4"
        @click="router.push('/login')"
      >
        Retour au login
      </button>
    </div>
  </div>
</template>