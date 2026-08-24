// server/test-v2-activity-service.js
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { ActivityService, parseNaturalTextLocal, analyzeDuration, ALLOWED_PROJECTS, ALLOWED_TYPES } from "./src/activityService.js";
import { ALLOWED_DAY_CHARGES } from "./src/graphService.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runV2ActivityServiceTests() {
  console.log("================================================================================");
  console.log("🧪 SUITE DE TESTS AUTOMATISÉS — V2 ACTIVITY SERVICE & MOCK REPOSITORY");
  console.log("================================================================================\n");

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, testName, details = "") {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      if (details) console.error(`     ↳ Détails: ${details}`);
    }
  }

  // TEST 1: Duration analysis & UI Helper
  console.log("--- 1. Analyse détaillée des durées & aide au choix ---");
  const exactCheck = analyzeDuration(3.5);
  assert(exactCheck.isExact === true, "3.5h est reconnu comme charge exacte (0.5j)");
  assert(exactCheck.closestDay === 0.5, "Charge Excel la plus proche = 0.5j");
  assert(exactCheck.helperMessage === null, "Pas de message d'alerte pour une charge exacte");

  const nonExactCheck = analyzeDuration(5.5);
  assert(nonExactCheck.isExact === false, "5.5h est reconnu comme charge intermédiaire");
  assert(Boolean(nonExactCheck.helperMessage), "Message d'aide utilisateur généré");
  assert(nonExactCheck.helperMessage.includes("0.75j ou 0.875j") || nonExactCheck.helperMessage.includes("0.786"), "Suggestion des échelons 0.75j ou 0.875j");

  // TEST 2: Natural Language Local Parsing (Single task)
  console.log("\n--- 2. Parsing du langage naturel (Tâche unique) ---");
  const sample1 = "Aujourd'hui j'ai travaillé 5h sur le ticket 594. J'ai analysé le problème, corrigé le mapping de FNA035 et fait les tests en REC.";
  const parsed1 = parseNaturalTextLocal(sample1, "2026-08-24");
  assert(parsed1.length === 1, "1 activité extraite");
  assert(parsed1[0].ticket === "594", `ID Ticket extrait: ${parsed1[0].ticket} (attendu: 594)`);
  assert(parsed1[0].flux === "FNA035", `Nom Flux extrait: ${parsed1[0].flux} (attendu: FNA035)`);
  assert(parsed1[0].hours === 5, `Heures extraites: ${parsed1[0].hours} (attendu: 5)`);
  assert(parsed1[0].days === 0.75, `Charge Excel correspondante: ${parsed1[0].days}j (attendu: 0.75j)`);

  // TEST 3: Multi-task Parsing
  console.log("\n--- 3. Parsing du langage naturel (Multi-tâches dans la journée) ---");
  const sample2 = "2h sur le 594 pour corriger FNA035, 3h sur le 612 projet CRM et 1h30 en réunion daily";
  const parsed2 = parseNaturalTextLocal(sample2, "2026-08-24");
  assert(parsed2.length === 3, `3 activités distinctes extraites (${parsed2.length} trouvées)`);
  assert(parsed2[0].ticket === "594" && parsed2[0].hours === 2, "Tâche 1: Ticket 594 (2h)");
  assert(parsed2[1].ticket === "612" && parsed2[1].hours === 3, "Tâche 2: Ticket 612 (3h)");
  assert(parsed2[2].type === "Réunion" && parsed2[2].hours === 1.5, "Tâche 3: Réunion (1.5h)");

  // TEST 4: Service Natural Parsing Orchestration
  console.log("\n--- 4. Service d'orchestration ActivityService ---");
  const service = new ActivityService(supabaseAdmin, null); // with local fallback
  const serviceRes = await service.parseNaturalActivity({
    text: sample1,
    day: "2026-08-24",
  });
  assert(serviceRes.success === true, "Appel parseNaturalActivity réussi");
  assert(serviceRes.activities.length === 1, "Activité retournée avec structure enrichie");
  assert(serviceRes.totalHours === 5, "Total journalier calculé (5h)");
  assert(serviceRes.totalDays === 0.714, "Total journalier en jours calculé (0.714j)");

  // TEST 5: Mock Activity Repository Save & Retrieve
  console.log("\n--- 5. Mock Activity Repository : Sauvegarde et Récupération ---");
  const testUserId = "8dab2cd7-8b0e-477a-8e9a-f4d2bb6d882a"; // Mathieu Soussignan
  const testDay = "2026-08-24";

  const saveRes = await service.saveActivities(testUserId, testDay, [
    {
      ticket: "594",
      flux: "FNA035",
      subject: "Test V2 Mock Repository - Analyse et mapping",
      project: "AX",
      type: "Projet - Evo",
      hours: 5.25,
      days: 0.75,
    },
    {
      ticket: "612",
      flux: "CRM012",
      subject: "Test V2 Mock Repository - Réunion et sync",
      project: "CRM",
      type: "Réunion",
      hours: 1.75,
      days: 0.25,
    },
  ]);

  assert(saveRes.success === true, "Enregistrement via MockActivityRepository réussi");
  assert(saveRes.count === 2, "2 lignes d'activités enregistrées");
  assert(saveRes.syncStatus.targetTable === "Tableau6245781824", "Métadonnées de simulation SharePoint présentes (Tableau6245781824)");

  // Retrieve activities
  const userActivities = await service.getActivities(testUserId, { day: testDay });
  assert(userActivities.length === 2, "2 activités retrouvées pour la journée");
  assert(userActivities[0].syncLabel.includes("Simulation SharePoint"), "Label de synchronisation SharePoint simulé");
  assert(Boolean(userActivities[0].devOpsUrl), "Lien DevOps généré pour le ticket");

  // TEST 6: Personal Summary Calculation
  console.log("\n--- 6. Calcul du Mini-Dashboard Personnel ---");
  const summary = await service.getPersonalSummary(testUserId, new Date("2026-08-24T12:00:00Z"));
  assert(summary.today.hours === 7.0, `Total aujourd'hui = ${summary.today.hours}h (attendu: 7.0h)`);
  assert(summary.today.days === 1.0, `Total aujourd'hui en jours = ${summary.today.days}j (attendu: 1.0j)`);
  assert(summary.week.hours >= 7.0, `Total semaine calculé (${summary.week.hours}h)`);
  assert(summary.recentActivities.length >= 2, "Activités récentes listées");

  // Summary
  console.log("\n================================================================================");
  console.log(`📊 RÉSULTAT SUITE V2 SERVICE : ${passedTests}/${totalTests} TESTS VALIDÉS (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log("================================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runV2ActivityServiceTests().catch(err => {
  console.error("FATAL ERROR in V2 Activity Service tests:", err);
  process.exit(1);
});
