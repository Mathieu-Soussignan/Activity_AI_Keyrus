// server/test-error-scenarios.js
import { formatGraphError, writeTestRowGraph, validateDayCharge } from "./src/graphService.js";

async function runErrorScenariosSuite() {
  console.log("================================================================================");
  console.log("🧪 SUITE DE TESTS AUTOMATISÉS — SCÉNARIOS D'ERREURS & RÉSILIENCE");
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

  // SCENARIO 1: Unauthenticated request
  console.log("--- 1. Utilisateur non authentifié / Token manquant ---");
  const errUnauth = formatGraphError({
    code: "InvalidAuthenticationToken",
    message: "Access token is empty.",
    status: 401,
  });
  assert(errUnauth.status === 401, "Code HTTP 401 retourné");
  assert(errUnauth.category === "TOKEN_EXPIRED", "Catégorie TOKEN_EXPIRED identifiée");
  assert(Boolean(errUnauth.actionRequired), "Action corrective fournie à l'utilisateur");

  // SCENARIO 2: Consent Required (Admin Consent / AADSTS65001)
  console.log("\n--- 2. Consentement administrateur requis (AADSTS65001) ---");
  const errConsent = formatGraphError({
    code: "AADSTS65001",
    message: "AADSTS65001: The user or administrator has not consented to use the application with ID '123'.",
    status: 403,
  });
  assert(errConsent.status === 403, "Code HTTP 403 retourné");
  assert(errConsent.category === "CONSENT_REQUIRED", "Catégorie CONSENT_REQUIRED identifiée");
  assert(errConsent.title.includes("Consentement administrateur"), "Titre explicite en français");

  // SCENARIO 3: App not found in Tenant (AADSTS700016)
  console.log("\n--- 3. Application introuvable dans le tenant (AADSTS700016) ---");
  const errAppNotFound = formatGraphError({
    code: "AADSTS700016",
    message: "AADSTS700016: Application with identifier '123' was not found in directory 'keyrus.com'.",
    status: 404,
  });
  assert(errAppNotFound.status === 404, "Code HTTP 404 retourné");
  assert(errAppNotFound.category === "APP_NOT_FOUND", "Catégorie APP_NOT_FOUND identifiée");

  // SCENARIO 4: MFA Required (AADSTS50076)
  console.log("\n--- 4. MFA requise par politique Keyrus (AADSTS50076) ---");
  const errMfa = formatGraphError({
    code: "AADSTS50076",
    message: "AADSTS50076: Due to a configuration change made by your administrator, you must use MFA.",
    status: 401,
  });
  assert(errMfa.status === 401, "Code HTTP 401 retourné");
  assert(errMfa.category === "MFA_REQUIRED", "Catégorie MFA_REQUIRED identifiée");

  // SCENARIO 5: Permission Denied (Authorization_RequestDenied)
  console.log("\n--- 5. Permission refusée / Droits SharePoint insuffisants ---");
  const errDenied = formatGraphError({
    code: "Authorization_RequestDenied",
    message: "Insufficient privileges to complete the operation.",
    status: 403,
  });
  assert(errDenied.status === 403, "Code HTTP 403 retourné");
  assert(errDenied.category === "PERMISSION_DENIED", "Catégorie PERMISSION_DENIED identifiée");

  // SCENARIO 6: Item Not Found (SharePoint site or file missing)
  console.log("\n--- 6. Fichier ou site SharePoint introuvable (404) ---");
  const errItemNotFound = formatGraphError({
    code: "ItemNotFound",
    message: "The resource could not be found.",
    status: 404,
  });
  assert(errItemNotFound.status === 404, "Code HTTP 404 retourné");
  assert(errItemNotFound.category === "ITEM_NOT_FOUND", "Catégorie ITEM_NOT_FOUND identifiée");

  // SCENARIO 7: Worksheet or Table not found
  console.log("\n--- 7. Onglet ou Table introuvable dans Excel ---");
  const errWsNotFound = formatGraphError({
    code: "ResourceNotFound",
    message: "Worksheet does not exist.",
    status: 404,
  });
  assert(errWsNotFound.status === 404, "Code HTTP 404 retourné");
  assert(errWsNotFound.category === "WORKSHEET_OR_TABLE_NOT_FOUND", "Catégorie WORKSHEET_OR_TABLE_NOT_FOUND identifiée");

  // SCENARIO 8: Safety Guard: Attempt to write to Official File
  console.log("\n--- 8. Garde-fou sécurité : tentative d'écriture sur fichier officiel ---");
  let safetyBlocked = false;
  let safetyError = null;
  try {
    await writeTestRowGraph({
      driveId: "d1",
      itemId: "item1",
      fileName: "2026-08 - Plan d'activité équipe.xlsx", // OFFICIAL FILE (no TEST)
      tableName: "Tableau6245781824",
      rowData: { charge: 0.25 },
    });
  } catch (e) {
    safetyBlocked = true;
    safetyError = e;
  }
  assert(safetyBlocked === true, "Tentative d'écriture sur fichier officiel INTERCEPTÉE");
  assert(safetyError?.code === "SafetyGuardViolation", "Code d'erreur SafetyGuardViolation levé");
  assert(safetyError?.status === 403, "Code HTTP 403 levé");

  // SCENARIO 9: Invalid Charge Value
  console.log("\n--- 9. Valeur de charge non autorisée ---");
  let invalidChargeBlocked = false;
  let invalidChargeError = null;
  try {
    await writeTestRowGraph({
      driveId: "d1",
      itemId: "item1",
      fileName: "2026-08 - Plan d'activité équipe - TEST.xlsx",
      tableName: "Tableau6245781824",
      rowData: { charge: 0.33 }, // 0.33 is not allowed
    });
  } catch (e) {
    invalidChargeBlocked = true;
    invalidChargeError = e;
  }
  assert(invalidChargeBlocked === true, "Charge 0.33j rejetée");
  assert(invalidChargeError?.code === "InvalidChargeValue", "Code d'erreur InvalidChargeValue levé");
  assert(invalidChargeError?.status === 400, "Code HTTP 400 levé");

  // Summary
  console.log("\n================================================================================");
  console.log(`📊 RÉSULTAT SCÉNARIOS D'ERREURS : ${passedTests}/${totalTests} TESTS VALIDÉS (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log("================================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runErrorScenariosSuite().catch(err => {
  console.error("FATAL ERROR in Error scenarios suite:", err);
  process.exit(1);
});
