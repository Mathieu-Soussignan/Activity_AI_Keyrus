<script setup lang="ts">
import { ref } from "vue";
import { supabase } from "../lib/supabase";
import { useRouter } from "vue-router";

type Mode = "login" | "signup";

const router = useRouter();

const mode = ref<Mode>("login");

const email = ref("");
const password = ref("");

const loading = ref(false);
const msg = ref<string>("");
const success = ref<string>("");

// Forgot password
const showForgot = ref(false);
const forgotEmail = ref("");
const forgotLoading = ref(false);
const forgotMsg = ref<string>("");
const forgotSuccess = ref<string>("");

// Important : URL publique du front (prod), ou localhost en dev.
// Supabase enverra le lien de reset vers cette URL + route /reset-password
const RESET_REDIRECT_TO = `${window.location.origin}/reset-password`;

function resetMessages() {
  msg.value = "";
  success.value = "";
}

async function submit() {
  resetMessages();
  loading.value = true;

  try {
    if (!email.value.trim() || !password.value.trim()) {
      msg.value = "Email et mot de passe requis.";
      return;
    }

    if (mode.value === "login") {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
      });
      if (error) throw error;

      await router.push("/activity");
      return;
    }

    // signup
    const { error } = await supabase.auth.signUp({
      email: email.value.trim(),
      password: password.value,
      // optionnel : si tu veux stocker des infos dans user_metadata
      options: { data: { invited_to_team: true } },
    });
    if (error) throw error;

    success.value =
      "✅ Inscription OK. Tu peux maintenant te connecter.";
  } catch (e: any) {
    msg.value = e?.message || "Erreur.";
  } finally {
    loading.value = false;
  }
}

async function sendResetEmail() {
  forgotMsg.value = "";
  forgotSuccess.value = "";
  forgotLoading.value = true;

  try {
    const target = (forgotEmail.value || email.value).trim();
    if (!target) {
      forgotMsg.value = "Renseigne ton email.";
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: RESET_REDIRECT_TO,
    });
    if (error) throw error;

    forgotSuccess.value =
      "✅ Email envoyé. Clique sur le lien reçu pour définir un nouveau mot de passe.";
  } catch (e: any) {
    forgotMsg.value = e?.message || "Erreur envoi email.";
  } finally {
    forgotLoading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
    <div class="w-full max-w-md rounded-2xl bg-zinc-900/60 border border-zinc-800 p-6">
      <h1 class="text-2xl font-semibold">Keyrus Suivi d’activité</h1>
      <p class="text-sm text-zinc-400 mt-1">Connexion / Inscription équipe</p>

      <!-- Tabs -->
      <div class="mt-5 grid grid-cols-2 gap-2 rounded-xl bg-zinc-950 border border-zinc-800 p-1">
        <button
          class="py-2 rounded-lg text-sm"
          :class="mode === 'login' ? 'bg-zinc-800/70' : 'text-zinc-400 hover:text-zinc-200'"
          @click="
            mode = 'login';
            resetMessages();
          "
        >
          Connexion
        </button>
        <button
          class="py-2 rounded-lg text-sm"
          :class="mode === 'signup' ? 'bg-zinc-800/70' : 'text-zinc-400 hover:text-zinc-200'"
          @click="
            mode = 'signup';
            resetMessages();
          "
        >
          Inscription
        </button>
      </div>

      <!-- Form -->
      <form class="mt-5 space-y-3" @submit.prevent="submit">
        <div>
          <label class="text-xs text-zinc-400">Email</label>
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            class="w-full mt-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 outline-none"
            placeholder="prenom.nom@domaine.com"
          />
        </div>

        <div>
          <label class="text-xs text-zinc-400">Mot de passe</label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="w-full mt-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-2 outline-none"
            placeholder="••••••••"
          />
          <div class="mt-2 flex justify-between items-center">
            <button
              type="button"
              class="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-4"
              @click="
                showForgot = !showForgot;
                forgotEmail = '';
                forgotMsg = '';
                forgotSuccess = '';
              "
            >
              Mot de passe oublié ?
            </button>

            <div class="text-xs text-zinc-500">
              {{ mode === "signup" ? "Créer un compte" : "Se connecter" }}
            </div>
          </div>
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full rounded-xl bg-white text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
        >
          {{ loading ? "..." : mode === "signup" ? "S'inscrire" : "Se connecter" }}
        </button>

        <p v-if="msg" class="text-sm text-red-300">{{ msg }}</p>
        <p v-if="success" class="text-sm text-emerald-300">{{ success }}</p>
      </form>

      <!-- Forgot password panel -->
      <div v-if="showForgot" class="mt-5 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
        <div class="text-sm font-medium">Réinitialiser le mot de passe</div>
        <p class="text-xs text-zinc-400 mt-1">
          On t’envoie un lien pour choisir un nouveau mot de passe.
        </p>

        <div class="mt-3">
          <label class="text-xs text-zinc-400">Email</label>
          <input
            v-model="forgotEmail"
            type="email"
            class="w-full mt-1 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2 outline-none"
            :placeholder="email ? email : 'prenom.nom@domaine.com'"
          />
        </div>

        <button
          @click="sendResetEmail"
          :disabled="forgotLoading"
          class="mt-3 w-full rounded-xl bg-zinc-100 text-zinc-950 font-medium px-4 py-2 disabled:opacity-50"
        >
          {{ forgotLoading ? "Envoi..." : "Envoyer le lien" }}
        </button>

        <p v-if="forgotMsg" class="text-sm text-red-300 mt-2">{{ forgotMsg }}</p>
        <p v-if="forgotSuccess" class="text-sm text-emerald-300 mt-2">{{ forgotSuccess }}</p>
      </div>

      <div class="mt-5 text-xs text-zinc-500">
        Astuce : si l’inscription demande une validation email, l’accès ne sera effectif qu’après clic sur le mail.
      </div>
    </div>
  </div>
</template>