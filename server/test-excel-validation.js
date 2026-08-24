// server/test-excel-validation.js
import fs from "fs";
import {
  LOCAL_OFFICIAL_FILE,
  LOCAL_TEST_FILE,
  ALLOWED_DAY_CHARGES,
  HOURS_PER_DAY,
  hoursToExcelDays,
  excelDaysToHours,
  validateDayCharge,
  inspectLocalTestWorkbook,
  writeLocalTestRow,
  compareWorkbooks,
} from "./src/graphService.js";

async function runExcelValidationSuite() {
  console.log("================================================================================");
  console.log("🧪 SUITE DE TESTS AUTOMATISÉS — VALIDATION EXCEL & SYNCHRONISATION ACTIVITÉS");
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

  // TEST 1: Unit Conversion Activity AI (Hours) <-> Excel (Days)
  console.log("--- 1. Test des conversions d'unités (Heures ↔ Jours) ---");
  assert(hoursToExcelDays(7) === 1.0, "Conversion 7h -> 1.0j");
  assert(hoursToExcelDays(5.25) === 0.75, "Conversion 5.25h -> 0.75j");
  assert(hoursToExcelDays(3.5) === 0.5, "Conversion 3.5h -> 0.5j");
  assert(hoursToExcelDays(1.75) === 0.25, "Conversion 1.75h -> 0.25j");
  assert(hoursToExcelDays(0.875) === 0.125, "Conversion 0.875h -> 0.125j");
  assert(hoursToExcelDays(1.8) === 0.25, "Arrondi au pas le plus proche (1.8h -> 0.25j)");
  assert(excelDaysToHours(0.5) === 3.5, "Conversion inverse 0.5j -> 3.5h");
  assert(excelDaysToHours(1.0) === 7.0, "Conversion inverse 1.0j -> 7.0h");

  // TEST 2: Validation of Allowed Charge Values
  console.log("\n--- 2. Test des valeurs de charge autorisées ---");
  assert(validateDayCharge(0.25).valid === true, "0.25j est une charge valide");
  assert(validateDayCharge(0.875).valid === true, "0.875j est une charge valide");
  assert(validateDayCharge(0.33).valid === false, "0.33j est rejeté (non conforme au référentiel)");
  assert(validateDayCharge(2.0).valid === false, "2.0j est rejeté (> 1j)");

  // Prepare clean test file
  fs.copyFileSync(LOCAL_OFFICIAL_FILE, LOCAL_TEST_FILE);
  const officialStatBefore = fs.statSync(LOCAL_OFFICIAL_FILE);

  // TEST 3: Inspection of Table Tableau6245781824 and Columns
  console.log("\n--- 3. Inspection de la structure et des colonnes de l'onglet Mathieu ---");
  const inspectBefore = await inspectLocalTestWorkbook(LOCAL_TEST_FILE);
  assert(inspectBefore.worksheets.length === 10, "10 worksheets détectées");
  
  const mathieuWsInfo = inspectBefore.worksheets.find(w => w.name === "Mathieu");
  assert(Boolean(mathieuWsInfo), "Worksheet 'Mathieu' trouvée");
  assert(mathieuWsInfo.tables.some(t => t.name === "Tableau6245781824"), "Table Excel 'Tableau6245781824' identifiée");

  const expectedColumns = ["Date", "ID Ticket", "Lien", "Nom Flux", "Sujet", "Projet", "Charge réelle", "Type", "Répartition VSA"];
  const mathieuTableCols = mathieuWsInfo.tables.find(t => t.name === "Tableau6245781824")?.columns || [];
  assert(mathieuTableCols.length >= 2, `Colonnes de la table identifiées (${mathieuTableCols.join(", ")})`);

  const initialRowsCount = inspectBefore.mathieuRows.length;
  console.log(`  ℹ️ Nombre initial de lignes d'activités dans Mathieu: ${initialRowsCount}`);

  // TEST 4: Controlled Write Test
  console.log("\n--- 4. Exécution de l'écriture contrôlée sur le fichier TEST ---");
  const testPayload = {
    date: "2026-08-24",
    id_ticket: "594",
    nom_flux: "FNA035",
    sujet: "POC Activity AI / Microsoft Graph - Test validation automatisée",
    projet: "AX",
    charge: 0.25,
    type: "Projet - Evo",
    repartition_vsa: "AX",
  };

  const writeResult = await writeLocalTestRow(testPayload);
  assert(writeResult.success === true, "Écriture réussie dans le fichier de test");
  assert(writeResult.insertedRowNumber > 90, `Ligne insérée à la position ${writeResult.insertedRowNumber}`);

  // TEST 5: Verify new row contents & formulas
  console.log("\n--- 5. Vérification de la ligne ajoutée et de ses formules ---");
  const inspectAfter = await inspectLocalTestWorkbook(LOCAL_TEST_FILE);
  assert(inspectAfter.mathieuRows.length === initialRowsCount + 1, "Le nombre de lignes a augmenté exactement de 1");

  const lastRow = inspectAfter.mathieuRows[inspectAfter.mathieuRows.length - 1];
  assert(lastRow.date === "2026-08-24", "Date conforme (2026-08-24)");
  assert(lastRow.id_ticket === 594, "ID Ticket conforme (594)");
  assert(lastRow.nom_flux === "FNA035", "Nom Flux conforme (FNA035)");
  assert(lastRow.sujet === "POC Activity AI / Microsoft Graph - Test validation automatisée", "Sujet conforme");
  assert(lastRow.projet === "AX", "Projet conforme (AX)");
  assert(lastRow.charge === 0.25, "Charge conforme (0.25j)");
  assert(lastRow.type === "Projet - Evo", "Type conforme (Projet - Evo)");

  // TEST 6: Full Diff Verification (Zero Unintended Modifications)
  console.log("\n--- 6. Comparaison Diff complète avant / après ---");
  const diffReport = await compareWorkbooks(LOCAL_OFFICIAL_FILE, LOCAL_TEST_FILE);
  assert(diffReport.sheetCountMatch === true, "Nombre d'onglets inchangé (10 = 10)");
  assert(diffReport.sheetNamesMatch === true, "Ordre et noms des onglets préservés");
  assert(diffReport.unintendedChanges.length === 0, "Aucune altération accidentelle détectée sur les autres onglets/lignes");
  assert(diffReport.mathieuAdditions.length === 1, "Exactement 1 ligne ajoutée dans l'onglet Mathieu");

  // TEST 7: Verify Official File Untouched
  console.log("\n--- 7. Vérification de l'intégrité absolue du fichier officiel ---");
  const officialStatAfter = fs.statSync(LOCAL_OFFICIAL_FILE);
  assert(officialStatBefore.mtimeMs === officialStatAfter.mtimeMs, "Fichier officiel: date de modification INTACTE");
  assert(officialStatBefore.size === officialStatAfter.size, "Fichier officiel: taille INTACTE (328 560 octets)");

  // Summary
  console.log("\n================================================================================");
  console.log(`📊 RÉSULTAT SUITE EXCEL : ${passedTests}/${totalTests} TESTS VALIDÉS (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log("================================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runExcelValidationSuite().catch(err => {
  console.error("FATAL ERROR in Excel validation suite:", err);
  process.exit(1);
});
