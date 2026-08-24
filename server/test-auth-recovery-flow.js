// server/test-auth-recovery-flow.js
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runRecoveryFlowTest() {
  console.log("================================================================================");
  console.log("🧪 TEST AUTOMATISÉ END-TO-END — FLOW COMPLET DE RÉCUPÉRATION DU MOT DE PASSE");
  console.log("================================================================================\n");

  const testEmail = "mathieu.soussignan@keyrus.com";
  const initialPassword = "Scp2026!";
  const tempRecoveryPassword = "NewPassword2026!Test";

  let passedSteps = 0;
  const totalSteps = 8;

  function assert(condition, stepName, details = "") {
    if (condition) {
      console.log(`  ✅ [PASS] ${stepName}`);
      passedSteps++;
    } else {
      console.error(`  ❌ [FAIL] ${stepName}`);
      if (details) console.error(`     ↳ Détails: ${details}`);
    }
  }

  // ÉTAPE 1: Demande de réinitialisation (Génération du lien sécurisé)
  console.log("--- Étape 1 : Génération du lien de récupération GoTrue ---");
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: testEmail,
    options: {
      redirectTo: "http://localhost:5173/reset-password",
    },
  });
  assert(!linkErr && Boolean(linkData?.properties?.action_link), "Lien d'action généré avec succès par Supabase GoTrue");
  const actionLink = linkData.properties.action_link;

  // ÉTAPE 2: Validation du lien par GoTrue (Vérification du token)
  console.log("\n--- Étape 2 : Simulation du clic utilisateur sur le lien reçu ---");
  const verifyRes = await fetch(actionLink, { redirect: "manual" });
  assert(verifyRes.status === 303 || verifyRes.status === 302, `Redirection GoTrue HTTP ${verifyRes.status} (303 attendu)`);
  
  const location = verifyRes.headers.get("location") || "";
  assert(location.includes("reset-password#access_token="), "Redirection vers /reset-password avec hash access_token");
  
  // Extraire les tokens du hash
  const hashPart = location.split("#")[1] || "";
  const hashParams = new URLSearchParams(hashPart);
  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");
  const type = hashParams.get("type");

  assert(Boolean(accessToken) && type === "recovery", "Access Token et type 'recovery' extraits du hash fragment");

  // ÉTAPE 3: Initialisation de la session de récupération côté client (PASSWORD_RECOVERY)
  console.log("\n--- Étape 3 : Établissement de la session PASSWORD_RECOVERY ---");
  const clientSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: sessionData, error: sessionErr } = await clientSupabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  assert(!sessionErr && Boolean(sessionData?.session), "Session de récupération active établie côté client");

  // ÉTAPE 4: Mise à jour du mot de passe (updateUser)
  console.log("\n--- Étape 4 : Définition du nouveau mot de passe (updateUser) ---");
  const { data: updateData, error: updateErr } = await clientSupabase.auth.updateUser({
    password: tempRecoveryPassword,
  });

  assert(!updateErr && Boolean(updateData?.user), "Mot de passe mis à jour avec succès via updateUser({ password })");

  // ÉTAPE 5: Reconnexion avec le NOUVEAU mot de passe
  console.log("\n--- Étape 5 : Reconnexion avec le nouveau mot de passe ---");
  const loginClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: newLoginData, error: newLoginErr } = await loginClient.auth.signInWithPassword({
    email: testEmail,
    password: tempRecoveryPassword,
  });

  assert(!newLoginErr && Boolean(newLoginData?.session), "Connexion réussie avec le nouveau mot de passe !");

  // ÉTAPE 6: Restauration du mot de passe initial
  console.log("\n--- Étape 6 : Nettoyage et restauration du mot de passe de test initial ---");
  const { error: restoreErr } = await loginClient.auth.updateUser({
    password: initialPassword,
  });

  assert(!restoreErr, "Mot de passe initial restauré avec succès");

  // BILAN
  console.log("\n================================================================================");
  console.log(`📊 RÉSULTAT DU FLOW DE RÉCUPÉRATION : ${passedSteps}/${totalSteps} ÉTAPES VALIDÉES (100%)`);
  console.log("================================================================================");

  if (passedSteps !== totalSteps) {
    process.exit(1);
  }
}

runRecoveryFlowTest().catch(err => {
  console.error("FATAL ERROR in Recovery flow test:", err);
  process.exit(1);
});
