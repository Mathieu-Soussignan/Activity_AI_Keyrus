// server/diagnose-auth.js
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function diagnose() {
  console.log("================================================================================");
  console.log("🔍 DIAGNOSTIC COMPLET SUPABASE AUTH — FLOW RÉCUPÉRATION MOT DE PASSE");
  console.log("================================================================================\n");

  console.log(`1. Supabase Project URL: ${SUPABASE_URL}`);
  
  // 1. Check user accounts in Supabase Auth
  console.log("\n--- 2. Inspection des utilisateurs dans Supabase Auth ---");
  const { data: usersData, error: usersErr } = await supabaseAdmin.auth.admin.listUsers();
  
  if (usersErr) {
    console.error("Erreur listUsers:", usersErr);
  } else {
    console.log(`Total utilisateurs trouvés: ${usersData.users.length}`);
    for (const u of usersData.users) {
      console.log(`\nUser ID: ${u.id}`);
      console.log(`  Email: ${u.email}`);
      console.log(`  Email Confirmed At: ${u.email_confirmed_at}`);
      console.log(`  Last Sign In At: ${u.last_sign_in_at}`);
      console.log(`  Recovery Sent At: ${u.recovery_sent_at}`);
      console.log(`  Invited At: ${u.invited_at}`);
      console.log(`  App Metadata:`, JSON.stringify(u.app_metadata));
      console.log(`  User Metadata:`, JSON.stringify(u.user_metadata));
    }
  }

  // 2. Test generating a recovery link via Admin API
  console.log("\n--- 3. Test de génération d'un lien de récupération (Admin API) ---");
  const testEmail = "mathieu.soussignan@keyrus.com";
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: testEmail,
    options: {
      redirectTo: "http://localhost:5173/reset-password",
    },
  });

  if (linkErr) {
    console.error("❌ Erreur generateLink:", linkErr);
  } else {
    console.log("✅ Lien de récupération généré avec succès par l'Admin API !");
    console.log("  Action Link (URL):", linkData?.properties?.action_link);
    console.log("  Hashed Token:", linkData?.properties?.hashed_token);
    console.log("  Redirect To:", linkData?.properties?.redirect_to);
  }

  // 3. Test client-level resetPasswordForEmail directly to see what GoTrue / Auth returns
  console.log("\n--- 4. Test de resetPasswordForEmail (simulation client) ---");
  const supabaseAnon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const resetRes = await supabaseAnon.auth.resetPasswordForEmail(testEmail, {
    redirectTo: "http://localhost:5173/reset-password",
  });
  console.log("Résultat resetPasswordForEmail:", JSON.stringify(resetRes, null, 2));

  // 4. Check user profile in public.profiles table
  console.log("\n--- 5. Inspection de la table public.profiles ---");
  const { data: profiles, error: profErr } = await supabaseAdmin.from("profiles").select("*");
  if (profErr) {
    console.error("Erreur profiles:", profErr);
  } else {
    console.log("Profiles trouvés:", profiles?.length);
    profiles?.forEach(p => console.log(`  ${p.id}: ${p.full_name} (${p.role})`));
  }
}

diagnose().catch(err => {
  console.error("Fatal diagnostic error:", err);
});
