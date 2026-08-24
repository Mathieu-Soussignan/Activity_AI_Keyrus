<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { supabase } from "../lib/supabase";
import { useRouter } from "vue-router";

const router = useRouter();

const password = ref("");
const password2 = ref("");
const loading = ref(false);
const msg = ref<string>("");
const success = ref<string>("");
const hasValidSession = ref(false);
const checkingSession = ref(true);

let authSubscription: { unsubscribe: () => void } | null = null;

onMounted(async () => {
  // Check for error parameters in URL (hash or query)
  const hash = window.location.hash || "";
  const params = new URLSearchParams(window.location.search);
  
  if (hash.includes("error_description=") || params.get("error_description")) {
    const errorDesc = params.get("error_description") || new URLSearchParams(hash.replace(/^#/, "")).get("error_description");
    msg.value = decodeURIComponent(errorDesc || "Lien de récupération invalide ou expiré.");
    checkingSession.value = false;
    return;
  }

  // 1. Listen for auth state changes (crucial for PASSWORD_RECOVERY event)
  const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session) || (event === "INITIAL_SESSION" && session)) {
      hasValidSession.value = true;
      checkingSession.value = false;
      msg.value = "";
    }
  });
  authSubscription = authListener.subscription;

  // 2. Fallback check if session is already parsed
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      hasValidSession.value = true;
      checkingSession.value = false;
    } else {
      // Small grace period for hash fragment processing by supabase-js
      setTimeout(async () => {
        if (!hasValidSession.value) {
          const { data: retryData } = await supabase.auth.getSession();
          if (retryData?.session) {
            hasValidSession.value = true;
          } else {
            msg.value = "Aucune session de récupération active. Veuillez cliquer sur le lien reçu par email ou refaire une demande.";
          }
          checkingSession.value = false;
        }
      }, 600);
    }
  } catch (e: any) {
    msg.value = e?.message || "Erreur vérification session.";
    checkingSession.value = false;
  }
});

onUnmounted(() => {
  if (authSubscription) {
    authSubscription.unsubscribe();
  }
});

async function updatePassword() {
  msg.value = "";
  success.value = "";

  if (!password.value || password.value.length < 8) {
    msg.value = "Mot de passe trop court (min 8 caractères).";
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

    success.value = "✅ Mot de passe mis à jour avec succès. Redirection vers la page de connexion…";
    // Sign out recovery session cleanly so user logs in with new password
    await supabase.auth.signOut();
    setTimeout(() => router.push("/login"), 1200);
  } catch (e: any) {
    msg.value = e?.message || "Erreur lors de la mise à jour du mot de passe.";
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
        Définis un nouveau mot de passe pour ton compte.
      </p>

      <!-- Loading State -->
      <div v-if="checkingSession" class="mt-6 text-center py-6 text-sm text-zinc-400">
        Vérification du lien de récupération...
      </div>

      <!-- Invalid / Missing Session Notice -->
      <div v-else-if="!hasValidSession && !success" class="mt-5 space-y-4">
        <div class="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800 text-amber-300 text-xs">
          {{ msg || "Lien de récupération manquant ou expiré." }}
        </div>
        <p class="text-xs text-zinc-400">
          Pour des raisons de sécurité, la réinitialisation du mot de passe nécessite de cliquer sur le lien sécurisé reçu par email.
        </p>
        <button
          class="w-full rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium px-4 py-2.5 text-xs transition"
          @click="router.push('/login')"
        >
          Retour à la page de connexion
        </button>
      </div>

      <!-- Form (Active Session) -->
      <form v-else class="mt-5 space-y-3" @submit.prevent="updatePassword">
        <div>
          <label class="text-xs text-zinc-400">Nouveau mot de passe</label>
          <input
            v-model="password"
            type="password"
            class="w-full mt-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 outline-none text-zinc-100"
            placeholder="Min 8 caractères"
            autocomplete="new-password"
          />
        </div>

        <div>
          <label class="text-xs text-zinc-400">Confirmer le mot de passe</label>
          <input
            v-model="password2"
            type="password"
            class="w-full mt-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 outline-none text-zinc-100"
            placeholder="Confirmer le mot de passe"
            autocomplete="new-password"
          />
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-medium px-4 py-2 disabled:opacity-50 transition text-sm"
        >
          {{ loading ? "Enregistrement..." : "Mettre à jour le mot de passe" }}
        </button>

        <p v-if="msg" class="text-xs text-red-400 p-2 rounded-lg bg-red-950/30 border border-red-900">{{ msg }}</p>
        <p v-if="success" class="text-xs text-emerald-300 p-2 rounded-lg bg-emerald-950/30 border border-emerald-900">{{ success }}</p>

        <div class="pt-2 text-center">
          <button
            type="button"
            class="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-4"
            @click="router.push('/login')"
          >
            Annuler et retourner au login
          </button>
        </div>
      </form>

    </div>
  </div>
</template>