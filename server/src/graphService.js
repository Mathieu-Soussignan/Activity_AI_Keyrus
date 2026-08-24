// server/src/graphService.js
import { ConfidentialClientApplication, PublicClientApplication } from "@azure/msal-node";
import ExcelJS from "exceljs";
import fs from "fs";

// Configuration
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || "";
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || "common";
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || "";
const AZURE_REDIRECT_URI = process.env.AZURE_REDIRECT_URI || "http://localhost:8787/api/poc/ms/callback";

// Minimal delegated scopes: User.Read (profile), Files.ReadWrite (delegated file access), offline_access (refresh)
const DEFAULT_SCOPES = ["User.Read", "Files.ReadWrite", "offline_access"];

// Local file paths
export const LOCAL_TEST_FILE = "C:\\Users\\Mathieu.Soussignan\\Downloads\\2026-08 - Plan d'activité équipe - TEST.xlsx";
export const LOCAL_OFFICIAL_FILE = "C:\\Users\\Mathieu.Soussignan\\Downloads\\2026-08 - Plan d'activité équipe.xlsx";

// Allowed charge values in days (referential from Params sheet)
export const ALLOWED_DAY_CHARGES = [0.125, 0.25, 0.5, 0.75, 0.875, 1.0];
export const HOURS_PER_DAY = 7;

/**
 * Convert Activity AI hours to Excel days (with nearest step alignment)
 */
export function hoursToExcelDays(hours) {
  const h = Math.max(0, Number(hours || 0));
  const rawDays = h / HOURS_PER_DAY;
  
  if (rawDays <= 0) return 0;
  
  // Find closest allowed charge
  let closest = ALLOWED_DAY_CHARGES[0];
  let minDiff = Math.abs(rawDays - closest);
  for (const step of ALLOWED_DAY_CHARGES) {
    const diff = Math.abs(rawDays - step);
    if (diff < minDiff) {
      minDiff = diff;
      closest = step;
    }
  }
  return closest;
}

/**
 * Convert Excel days to Activity AI hours
 */
export function excelDaysToHours(days) {
  return Math.round(Number(days || 0) * HOURS_PER_DAY * 100) / 100;
}

/**
 * Validate that a charge value is allowed
 */
export function validateDayCharge(charge) {
  const num = Number(charge);
  const isAllowed = ALLOWED_DAY_CHARGES.some(allowed => Math.abs(allowed - num) < 1e-4);
  return {
    valid: isAllowed,
    value: num,
    allowedValues: ALLOWED_DAY_CHARGES,
  };
}

/**
 * In-memory token & session store for the POC
 */
let currentSession = {
  account: null,
  accessToken: null,
  idToken: null,
  tokenExpiresOn: null,
  scopes: [],
  isMock: false,
};

/**
 * Format and translate Microsoft Entra ID / Graph errors into clear explanations
 */
export function formatGraphError(err) {
  const message = String(err?.message || err || "");
  const code = err?.code || err?.graphError?.code || "";
  const status = err?.status || 500;

  // AADSTS Errors (Entra ID Authentication & Consent)
  if (message.includes("AADSTS65001") || code === "AADSTS65001") {
    return {
      status: 403,
      category: "CONSENT_REQUIRED",
      title: "Consentement administrateur requis",
      message: "L'application nécessite le consentement d'un administrateur du tenant Keyrus pour les permissions demandées.",
      actionRequired: "Demander à l'administrateur Microsoft 365 Keyrus de valider le consentement pour l'App Registration.",
      rawError: message,
    };
  }

  if (message.includes("AADSTS700016") || code === "AADSTS700016") {
    return {
      status: 404,
      category: "APP_NOT_FOUND",
      title: "Application non trouvée dans l'annuaire Keyrus",
      message: "Le AZURE_CLIENT_ID configuré n'existe pas dans le tenant Microsoft Entra ID spécifié.",
      actionRequired: "Vérifier le AZURE_CLIENT_ID et le AZURE_TENANT_ID dans server/.env.",
      rawError: message,
    };
  }

  if (message.includes("AADSTS50076") || message.includes("AADSTS50079")) {
    return {
      status: 401,
      category: "MFA_REQUIRED",
      title: "Authentification multifacteur (MFA) requise",
      message: "Une stratégie d'accès conditionnel Keyrus exige une authentification forte (MFA).",
      actionRequired: "Se reconnecter et valider la notification Microsoft Authenticator.",
      rawError: message,
    };
  }

  // Graph API Errors
  if (code === "Authorization_RequestDenied" || status === 403) {
    return {
      status: 403,
      category: "PERMISSION_DENIED",
      title: "Accès refusé par Microsoft Graph",
      message: "Le token utilisateur ne dispose pas des droits suffisants pour accéder à cette ressource SharePoint.",
      actionRequired: "Vérifier que la permission déléguée 'Files.ReadWrite' (ou 'Sites.Selected' avec droit write) est accordée.",
      rawError: message,
    };
  }

  if (code === "InvalidAuthenticationToken" || status === 401) {
    return {
      status: 401,
      category: "TOKEN_EXPIRED",
      title: "Session Microsoft expirée ou token invalide",
      message: "Le jeton d'accès Graph a expiré ou a été révoqué.",
      actionRequired: "Cliquer sur 'Se connecter avec Microsoft' pour renouveler la session.",
      rawError: message,
    };
  }

  if (code === "ResourceNotFound" || message.includes("ResourceNotFound") || message.toLowerCase().includes("worksheet") || message.toLowerCase().includes("table")) {
    return {
      status: 404,
      category: "WORKSHEET_OR_TABLE_NOT_FOUND",
      title: "Onglet ou Table Excel introuvable",
      message: "L'onglet 'Mathieu' ou la table 'Tableau6245781824' n'existe pas dans le classeur.",
      actionRequired: "Vérifier la structure du classeur Excel.",
      rawError: message,
    };
  }

  if (code === "ItemNotFound" || status === 404) {
    return {
      status: 404,
      category: "ITEM_NOT_FOUND",
      title: "Ressource introuvable sur SharePoint",
      message: "Le site, la bibliothèque ou le fichier demandé est introuvable sur SharePoint.",
      actionRequired: "Vérifier le nom du site ('KEYFR-Projets') ou le nom du classeur.",
      rawError: message,
    };
  }

  // Generic fallback
  return {
    status,
    category: "GRAPH_ERROR",
    title: "Erreur Microsoft Graph",
    message: err?.graphError?.message || message || "Erreur de communication avec Microsoft Graph.",
    actionRequired: "Consulter le journal diagnostic pour analyser la réponse API brute.",
    rawError: message,
    graphError: err?.graphError || null,
  };
}

/**
 * Build MSAL Client Application instance
 */
function getMsalClient() {
  if (!AZURE_CLIENT_ID) {
    return null;
  }

  const authority = `https://login.microsoftonline.com/${AZURE_TENANT_ID}`;

  if (AZURE_CLIENT_SECRET) {
    return new ConfidentialClientApplication({
      auth: {
        clientId: AZURE_CLIENT_ID,
        authority,
        clientSecret: AZURE_CLIENT_SECRET,
      },
    });
  }

  return new PublicClientApplication({
    auth: {
      clientId: AZURE_CLIENT_ID,
      authority,
    },
  });
}

/**
 * Generate Microsoft OAuth Login URL (or simulation URL)
 */
export async function getAuthUrl() {
  const msalClient = getMsalClient();
  
  // If no client ID configured, provide simulation auth
  if (!msalClient) {
    return {
      configured: false,
      simulationAvailable: true,
      message: "AZURE_CLIENT_ID n'est pas encore configuré dans server/.env. Vous pouvez utiliser la simulation locale ou renseigner vos identifiants Entra ID.",
      authUrl: null,
      scopes: DEFAULT_SCOPES,
    };
  }

  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  try {
    const authUrl = await msalClient.getAuthCodeUrl({
      scopes: DEFAULT_SCOPES,
      redirectUri: AZURE_REDIRECT_URI,
      state,
    });

    return {
      configured: true,
      simulationAvailable: true,
      authUrl,
      state,
      scopes: DEFAULT_SCOPES,
    };
  } catch (error) {
    return {
      configured: true,
      simulationAvailable: true,
      error: formatGraphError(error),
    };
  }
}

/**
 * Handle OAuth Callback & acquire tokens
 */
export async function handleCallback(code) {
  const msalClient = getMsalClient();
  if (!msalClient) {
    throw new Error("MSAL client non initialisé (AZURE_CLIENT_ID manquant)");
  }

  try {
    const tokenResponse = await msalClient.acquireTokenByCode({
      code,
      scopes: DEFAULT_SCOPES,
      redirectUri: AZURE_REDIRECT_URI,
    });

    currentSession = {
      account: tokenResponse.account,
      accessToken: tokenResponse.accessToken,
      idToken: tokenResponse.idToken,
      tokenExpiresOn: tokenResponse.expiresOn,
      scopes: tokenResponse.scopes,
      isMock: false,
    };

    return currentSession;
  } catch (error) {
    throw formatGraphError(error);
  }
}

/**
 * Enable Mock / Simulation session
 */
export function enableMockSession() {
  currentSession = {
    account: {
      username: "mathieu.soussignan@keyrus.com",
      name: "Mathieu Soussignan (Simulation Locale)",
      tenantId: "keyrus-tenant-simulation",
    },
    accessToken: "mock_jwt_token_for_local_poc_simulation",
    idToken: "mock_id_token",
    tokenExpiresOn: new Date(Date.now() + 3600 * 1000).toISOString(),
    scopes: DEFAULT_SCOPES,
    isMock: true,
  };
  return getStatus();
}

/**
 * Get current Microsoft session status
 */
export function getStatus() {
  const isConfigured = Boolean(AZURE_CLIENT_ID);
  const isAuthenticated = Boolean(
    currentSession.accessToken &&
    (currentSession.isMock || (currentSession.tokenExpiresOn && new Date() < new Date(currentSession.tokenExpiresOn)))
  );

  return {
    configured: isConfigured,
    authenticated: isAuthenticated,
    isMock: currentSession.isMock,
    tenantId: AZURE_TENANT_ID,
    clientId: AZURE_CLIENT_ID ? `${AZURE_CLIENT_ID.slice(0, 6)}...${AZURE_CLIENT_ID.slice(-4)}` : null,
    redirectUri: AZURE_REDIRECT_URI,
    account: currentSession.account ? {
      username: currentSession.account.username,
      name: currentSession.account.name,
      tenantId: currentSession.account.tenantId,
    } : null,
    scopes: currentSession.scopes,
    tokenExpiresOn: currentSession.tokenExpiresOn,
  };
}

/**
 * Logout Microsoft session
 */
export function logout() {
  currentSession = {
    account: null,
    accessToken: null,
    idToken: null,
    tokenExpiresOn: null,
    scopes: [],
    isMock: false,
  };
  return { ok: true };
}

/**
 * Generic Graph API fetch helper
 */
async function callGraph(endpoint, options = {}) {
  if (!currentSession.accessToken) {
    const err = new Error("Utilisateur Microsoft non authentifié (aucun token Graph actif)");
    err.status = 401;
    err.code = "InvalidAuthenticationToken";
    throw err;
  }

  const url = endpoint.startsWith("https://") ? endpoint : `https://graph.microsoft.com/v1.0${endpoint}`;
  const headers = {
    Authorization: `Bearer ${currentSession.accessToken}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (netErr) {
    const err = new Error(`Échec de connexion réseau vers Microsoft Graph : ${netErr.message}`);
    err.status = 504;
    err.code = "NetworkError";
    throw err;
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { rawText: text };
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || `Graph API error HTTP ${response.status}`);
    err.status = response.status;
    err.graphError = data?.error;
    err.code = data?.error?.code;
    throw err;
  }

  return data;
}

/**
 * 1. Discover SharePoint site 'KEYFR-Projets'
 */
export async function discoverSite(siteSearch = "KEYFR-Projets") {
  // If mock mode active
  if (currentSession.isMock) {
    return {
      success: true,
      isMock: true,
      siteFound: {
        id: "keyrus.sharepoint.com,d8f1e2a3-4b5c-6d7e-8f9a-0b1c2d3e4f5a,9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4",
        name: "KEYFR-Projets",
        displayName: "KEYFR-Projets (Espace Projets Keyrus)",
        webUrl: "https://keyrus.sharepoint.com/sites/KEYFR-Projets",
      },
      allResults: [
        {
          id: "keyrus.sharepoint.com,d8f1e2a3-4b5c-6d7e-8f9a-0b1c2d3e4f5a,9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4",
          name: "KEYFR-Projets",
          displayName: "KEYFR-Projets",
          webUrl: "https://keyrus.sharepoint.com/sites/KEYFR-Projets",
        }
      ],
    };
  }

  try {
    const res = await callGraph(`/sites?search=${encodeURIComponent(siteSearch)}`);
    const sites = res.value || [];
    const matched = sites.find(s => s.name?.toLowerCase().includes("keyfr-projets") || s.displayName?.toLowerCase().includes("keyfr-projets")) || sites[0] || null;

    if (!matched && sites.length === 0) {
      return {
        success: false,
        error: `Aucun site SharePoint trouvé correspondant à '${siteSearch}'.`,
        category: "ITEM_NOT_FOUND",
      };
    }

    return {
      success: true,
      isMock: false,
      siteFound: matched,
      allResults: sites.map(s => ({
        id: s.id,
        name: s.name,
        displayName: s.displayName,
        webUrl: s.webUrl,
      })),
    };
  } catch (error) {
    return {
      success: false,
      ...formatGraphError(error),
    };
  }
}

/**
 * 2. Discover Drives & Find Activity File in Site
 */
export async function discoverFiles(siteId, fileNameQuery = "Plan d'activité") {
  // If mock mode active
  if (currentSession.isMock) {
    const officialExists = fs.existsSync(LOCAL_OFFICIAL_FILE);
    const testExists = fs.existsSync(LOCAL_TEST_FILE);
    const files = [];

    if (officialExists) {
      const stat = fs.statSync(LOCAL_OFFICIAL_FILE);
      files.push({
        driveId: "mock-drive-documents-partages",
        driveName: "Documents partagés",
        id: "mock-item-official-plan-activite",
        name: "2026-08 - Plan d'activité équipe.xlsx",
        size: stat.size,
        lastModifiedDateTime: stat.mtime.toISOString(),
        webUrl: "https://keyrus.sharepoint.com/sites/KEYFR-Projets/Documents/2026-08%20-%20Plan%20d'activit%C3%A9%20%C3%A9quipe.xlsx",
        isTestFile: false,
      });
    }

    if (testExists) {
      const stat = fs.statSync(LOCAL_TEST_FILE);
      files.push({
        driveId: "mock-drive-documents-partages",
        driveName: "Documents partagés",
        id: "mock-item-test-plan-activite",
        name: "2026-08 - Plan d'activité équipe - TEST.xlsx",
        size: stat.size,
        lastModifiedDateTime: stat.mtime.toISOString(),
        webUrl: "https://keyrus.sharepoint.com/sites/KEYFR-Projets/Documents/2026-08%20-%20Plan%20d'activit%C3%A9%20%C3%A9quipe%20-%20TEST.xlsx",
        isTestFile: true,
      });
    }

    return {
      success: true,
      isMock: true,
      drivesCount: 1,
      files,
    };
  }

  try {
    const drivesRes = await callGraph(`/sites/${siteId}/drives`);
    const drives = drivesRes.value || [];

    const fileResults = [];

    for (const drive of drives) {
      try {
        const searchRes = await callGraph(`/drives/${drive.id}/root/search(q='${encodeURIComponent(fileNameQuery)}')`);
        const items = searchRes.value || [];
        for (const item of items) {
          if (item.file) {
            fileResults.push({
              driveId: drive.id,
              driveName: drive.name,
              id: item.id,
              name: item.name,
              size: item.size,
              lastModifiedDateTime: item.lastModifiedDateTime,
              webUrl: item.webUrl,
              isTestFile: item.name.toLowerCase().includes("test"),
            });
          }
        }
      } catch (searchErr) {
        console.warn(`Search failed on drive ${drive.id}:`, searchErr.message);
      }
    }

    if (fileResults.length === 0) {
      return {
        success: false,
        error: `Aucun fichier correspondant à '${fileNameQuery}' trouvé dans les bibliothèques du site.`,
        category: "ITEM_NOT_FOUND",
      };
    }

    return {
      success: true,
      isMock: false,
      drivesCount: drives.length,
      files: fileResults,
    };
  } catch (error) {
    return {
      success: false,
      ...formatGraphError(error),
    };
  }
}

/**
 * 3. List Worksheets of an Excel workbook via Graph
 */
export async function listWorksheets(driveId, itemId) {
  // If mock mode active
  if (currentSession.isMock) {
    const localInspect = await inspectLocalTestWorkbook();
    return {
      success: true,
      isMock: true,
      count: localInspect.worksheets.length,
      worksheets: localInspect.worksheets.map((ws, i) => ({
        id: `{00000000-0000-0000-0000-00000000000${i+1}}`,
        name: ws.name,
        position: i,
        visibility: "Visible",
      })),
    };
  }

  try {
    const res = await callGraph(`/drives/${driveId}/items/${itemId}/workbook/worksheets`);
    const sheets = (res.value || []).map(ws => ({
      id: ws.id,
      name: ws.name,
      position: ws.position,
      visibility: ws.visibility,
    }));

    return {
      success: true,
      isMock: false,
      count: sheets.length,
      worksheets: sheets,
    };
  } catch (error) {
    return {
      success: false,
      ...formatGraphError(error),
    };
  }
}

/**
 * 4. Read Worksheet data & Tables (Worksheet 'Mathieu')
 */
export async function readMathieuWorksheet(driveId, itemId) {
  // If mock mode active
  if (currentSession.isMock) {
    const localInspect = await inspectLocalTestWorkbook();
    return {
      success: true,
      isMock: true,
      address: "Mathieu!A1:I91",
      rowCount: localInspect.mathieuRows.length + 3,
      columnCount: 9,
      tables: [{ id: "1", name: "Tableau6245781824", showHeaders: true }],
      headerRow: ["Date", "ID Ticket", "Lien", "Nom Flux", "Sujet", "Projet", "Charge réelle", "Type", "Répartition VSA"],
      rows: localInspect.mathieuRows,
    };
  }

  try {
    // 1. Get Tables in Mathieu sheet
    const tablesRes = await callGraph(`/drives/${driveId}/items/${itemId}/workbook/worksheets('Mathieu')/tables`);
    const tables = tablesRes.value || [];

    // 2. Get Used Range in Mathieu sheet
    const rangeRes = await callGraph(`/drives/${driveId}/items/${itemId}/workbook/worksheets('Mathieu')/usedRange`);

    // Parse header and sample rows
    const values = rangeRes.values || [];

    // Header is on row 3 (0-indexed: index 2)
    const headerRow = values.length > 2 ? values[2] : [];

    const rows = [];
    for (let i = 3; i < values.length; i++) {
      const rowVals = values[i];
      if (rowVals && rowVals.some(v => v !== null && v !== "")) {
        rows.push({
          rowNumber: i + 1,
          date: rowVals[0] || "",
          id_ticket: rowVals[1] || "",
          lien: rowVals[2] || "",
          nom_flux: rowVals[3] || "",
          sujet: rowVals[4] || "",
          projet: rowVals[5] || "",
          charge: Number(rowVals[6] || 0),
          type: rowVals[7] || "",
          repartition_vsa: rowVals[8] || "",
        });
      }
    }

    return {
      success: true,
      isMock: false,
      address: rangeRes.address,
      rowCount: rangeRes.rowCount,
      columnCount: rangeRes.columnCount,
      tables: tables.map(t => ({ id: t.id, name: t.name, showHeaders: t.showHeaders })),
      headerRow,
      rows,
    };
  } catch (error) {
    return {
      success: false,
      ...formatGraphError(error),
    };
  }
}

/**
 * 5. Controlled Write Test to a TEST file
 * STRICT SAFETY CHECK: File name MUST contain 'TEST' or 'test'.
 */
export async function writeTestRowGraph({ driveId, itemId, fileName, tableName, rowData }) {
  // SAFETY CHECK: Rejection if official file
  const safeName = String(fileName || "").toLowerCase();
  if (!safeName.includes("test")) {
    const err = new Error("SÉCURITÉ STRICTE : L'écriture est INTERDITE sur le fichier officiel. Le nom du fichier doit contenir 'TEST'.");
    err.status = 403;
    err.code = "SafetyGuardViolation";
    throw err;
  }

  // Validate charge value
  const chargeVal = Number(rowData.charge || 0.25);
  const chargeValidation = validateDayCharge(chargeVal);
  if (!chargeValidation.valid) {
    const err = new Error(`Valeur de charge '${chargeVal}' invalide. Valeurs autorisées : ${ALLOWED_DAY_CHARGES.join(", ")} jours.`);
    err.status = 400;
    err.code = "InvalidChargeValue";
    throw err;
  }

  // If mock mode active: execute write on local test copy
  if (currentSession.isMock) {
    const localResult = await writeLocalTestRow({
      date: rowData.date,
      id_ticket: rowData.id_ticket,
      nom_flux: rowData.nom_flux,
      sujet: rowData.sujet,
      projet: rowData.projet,
      charge: chargeVal,
      type: rowData.type,
      repartition_vsa: rowData.repartition_vsa,
    });

    return {
      success: true,
      isMock: true,
      message: "Ligne de test insérée avec succès dans le fichier de TEST (Simulation locale) !",
      insertedRowNumber: localResult.insertedRowNumber,
      rowData: localResult.rowData,
    };
  }

  // Format row for Tableau6245781824:
  // Columns: [Date, ID Ticket, Lien, Nom Flux, Sujet, Projet, Charge réelle, Type, Répartition VSA]
  const payloadValues = [
    [
      rowData.date || new Date().toISOString().slice(0, 10),
      rowData.id_ticket || "",
      "", // Lien formula is automatically filled by Excel table
      rowData.nom_flux || "",
      rowData.sujet || "POC Activity AI / Microsoft Graph - Test écriture",
      rowData.projet || "AX",
      chargeVal,
      rowData.type || "Projet - Evo",
      rowData.repartition_vsa || "AX",
    ]
  ];

  try {
    const targetTable = tableName || "Tableau6245781824";
    const addRes = await callGraph(
      `/drives/${driveId}/items/${itemId}/workbook/worksheets('Mathieu')/tables('${targetTable}')/rows/add`,
      {
        method: "POST",
        body: JSON.stringify({ values: payloadValues }),
      }
    );

    return {
      success: true,
      isMock: false,
      message: "Ligne de test ajoutée avec succès dans le fichier de TEST SharePoint via Microsoft Graph !",
      addedRow: addRes,
    };
  } catch (error) {
    return {
      success: false,
      ...formatGraphError(error),
    };
  }
}

/**
 * =========================================================================
 * LOCAL WORKBOOK SIMULATION & VALIDATION (Offline / Sandbox Mode)
 * =========================================================================
 */
export async function inspectLocalTestWorkbook(filePath = LOCAL_TEST_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fichier test local non trouvé : ${filePath}`);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const worksheets = wb.worksheets.map(ws => ({
    id: ws.id,
    name: ws.name,
    rowCount: ws.rowCount,
    columnCount: ws.columnCount,
    tables: (ws.getTables ? ws.getTables() : []).map(t => ({
      name: t.name,
      columns: t.table?.columns?.map(c => c.name) || [],
    })),
  }));

  // Inspect Mathieu worksheet
  const wsMathieu = wb.getWorksheet("Mathieu");
  const mathieuRows = [];
  if (wsMathieu) {
    for (let r = 4; r <= wsMathieu.rowCount; r++) {
      const row = wsMathieu.getRow(r);
      const hasVal = [1, 2, 4, 5, 6, 7, 8, 9].some(col => row.getCell(col).value);
      if (hasVal) {
        let idVal = row.getCell(2).value;
        if (idVal && typeof idVal === "object" && idVal.result !== undefined) {
          idVal = idVal.result;
        }

        let chargeVal = row.getCell(7).value;
        if (chargeVal && typeof chargeVal === "object" && chargeVal.result !== undefined) {
          chargeVal = chargeVal.result;
        }

        mathieuRows.push({
          rowNumber: r,
          date: row.getCell(1).value ? String(row.getCell(1).value).slice(0, 10) : "",
          id_ticket: idVal ?? "",
          nom_flux: row.getCell(4).value ?? "",
          sujet: row.getCell(5).value ?? "",
          projet: row.getCell(6).value ?? "",
          charge: Number(chargeVal || 0),
          type: row.getCell(8).value ?? "",
          repartition_vsa: row.getCell(9).value ?? "",
        });
      }
    }
  }

  return {
    filePath,
    isTestCopy: filePath.toLowerCase().includes("test"),
    worksheets,
    mathieuRows,
  };
}

/**
 * Local Controlled Write Test on '2026-08 - Plan d'activité équipe - TEST.xlsx'
 */
export async function writeLocalTestRow(rowData) {
  if (!fs.existsSync(LOCAL_TEST_FILE)) {
    throw new Error(`Fichier test local non trouvé : ${LOCAL_TEST_FILE}`);
  }

  // Validate charge
  const chargeVal = Number(rowData.charge || 0.25);
  const chargeValidation = validateDayCharge(chargeVal);
  if (!chargeValidation.valid) {
    throw new Error(`Charge '${chargeVal}' invalide. Valeurs autorisées : ${ALLOWED_DAY_CHARGES.join(", ")} jours.`);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(LOCAL_TEST_FILE);

  const wsMathieu = wb.getWorksheet("Mathieu");
  if (!wsMathieu) {
    throw new Error("Onglet 'Mathieu' non trouvé dans le classeur de test");
  }

  // Find next row in the table
  const newRowNumber = wsMathieu.rowCount + 1;
  const row = wsMathieu.getRow(newRowNumber);

  const dateStr = rowData.date || new Date().toISOString().slice(0, 10);
  const idTicket = rowData.id_ticket ? Number(rowData.id_ticket) || rowData.id_ticket : "";
  const nomFlux = rowData.nom_flux || "";
  const sujet = rowData.sujet || "POC Activity AI / Microsoft Graph - Test local";
  const projet = rowData.projet || "AX";
  const type = rowData.type || "Projet - Evo";
  const repartitionVsa = rowData.repartition_vsa || "AX";

  // Set cells
  row.getCell(1).value = dateStr;
  row.getCell(2).value = idTicket;
  row.getCell(3).value = {
    formula: `IF(Tableau6245781824[[#This Row],[ID Ticket]]<>""; HYPERLINK("https://scp-tma-flux.visualstudio.com/Gestion%20des%20tickets/_workitems/edit/"&Tableau6245781824[[#This Row],[ID Ticket]]; "↪"); "")`
  };
  row.getCell(4).value = nomFlux;
  row.getCell(5).value = sujet;
  row.getCell(6).value = projet;
  row.getCell(7).value = chargeVal;
  row.getCell(8).value = type;
  row.getCell(9).value = repartitionVsa;

  row.commit();

  // Sanitize Excel CF rules without formulae if any (ExcelJS compatibility fix)
  for (const ws of wb.worksheets) {
    if (ws.conditionalFormattings) {
      ws.conditionalFormattings = ws.conditionalFormattings.filter(cf => {
        if (cf.rules) {
          cf.rules = cf.rules.filter(r => {
            if (r.type === 'expression' && (!r.formulae || r.formulae.length === 0 || !r.formulae[0])) {
              return false;
            }
            return true;
          });
          return cf.rules.length > 0;
        }
        return true;
      });
    }
  }

  await wb.xlsx.writeFile(LOCAL_TEST_FILE);

  return {
    success: true,
    fileModified: LOCAL_TEST_FILE,
    insertedRowNumber: newRowNumber,
    rowData: {
      date: dateStr,
      id_ticket: idTicket,
      nom_flux: nomFlux,
      sujet,
      projet,
      charge: chargeVal,
      type,
      repartition_vsa: repartitionVsa,
    },
  };
}

/**
 * =========================================================================
 * COMPREHENSIVE WORKBOOK DIFF & INTEGRITY VERIFICATION
 * =========================================================================
 */
export async function compareWorkbooks(officialPath = LOCAL_OFFICIAL_FILE, testPath = LOCAL_TEST_FILE) {
  if (!fs.existsSync(officialPath)) throw new Error(`Fichier officiel non trouvé : ${officialPath}`);
  if (!fs.existsSync(testPath)) throw new Error(`Fichier test non trouvé : ${testPath}`);

  const wbOfficial = new ExcelJS.Workbook();
  await wbOfficial.xlsx.readFile(officialPath);

  const wbTest = new ExcelJS.Workbook();
  await wbTest.xlsx.readFile(testPath);

  const diffReport = {
    officialFile: officialPath,
    testFile: testPath,
    sheetsComparison: [],
    unintendedChanges: [],
    mathieuAdditions: [],
    formulasIntact: true,
    tablesIntact: true,
  };

  // 1. Check sheet names and count
  const officialSheets = wbOfficial.worksheets.map(w => w.name);
  const testSheets = wbTest.worksheets.map(w => w.name);

  diffReport.sheetCountMatch = officialSheets.length === testSheets.length;
  diffReport.sheetNamesMatch = officialSheets.every((name, i) => testSheets[i] === name);

  // 2. Check each sheet
  for (const sheetName of officialSheets) {
    const wsOff = wbOfficial.getWorksheet(sheetName);
    const wsTest = wbTest.getWorksheet(sheetName);

    const sheetDiff = {
      name: sheetName,
      officialRows: wsOff.rowCount,
      testRows: wsTest.rowCount,
      changedCells: 0,
    };

    // For all sheets EXCEPT 'Mathieu', rows should be identical
    if (sheetName !== "Mathieu") {
      const maxRows = Math.max(wsOff.rowCount, wsTest.rowCount);
      for (let r = 1; r <= maxRows; r++) {
        const rowOff = wsOff.getRow(r);
        const rowTest = wsTest.getRow(r);
        for (let c = 1; c <= Math.max(rowOff.cellCount, rowTest.cellCount); c++) {
          const valOff = rowOff.getCell(c).value;
          const valTest = rowTest.getCell(c).value;
          const strOff = typeof valOff === 'object' ? JSON.stringify(valOff) : String(valOff ?? '');
          const strTest = typeof valTest === 'object' ? JSON.stringify(valTest) : String(valTest ?? '');
          if (strOff !== strTest) {
            sheetDiff.changedCells++;
            diffReport.unintendedChanges.push({
              sheet: sheetName,
              cell: `${rowOff.getCell(c).address}`,
              official: strOff,
              test: strTest,
            });
          }
        }
      }
    } else {
      // On Mathieu sheet, verify existing rows 1 to wsOff.rowCount are identical
      for (let r = 1; r <= wsOff.rowCount; r++) {
        const rowOff = wsOff.getRow(r);
        const rowTest = wsTest.getRow(r);
        for (let c = 1; c <= 9; c++) {
          const valOff = rowOff.getCell(c).value;
          const valTest = rowTest.getCell(c).value;
          const strOff = typeof valOff === 'object' ? JSON.stringify(valOff) : String(valOff ?? '');
          const strTest = typeof valTest === 'object' ? JSON.stringify(valTest) : String(valTest ?? '');
          if (strOff !== strTest) {
            diffReport.unintendedChanges.push({
              sheet: "Mathieu (Existing Rows)",
              cell: `${rowOff.getCell(c).address}`,
              official: strOff,
              test: strTest,
            });
          }
        }
      }

      // Check newly added rows beyond official rowCount
      if (wsTest.rowCount > wsOff.rowCount) {
        for (let r = wsOff.rowCount + 1; r <= wsTest.rowCount; r++) {
          const rowTest = wsTest.getRow(r);
          diffReport.mathieuAdditions.push({
            rowNumber: r,
            date: rowTest.getCell(1).value,
            id_ticket: rowTest.getCell(2).value,
            sujet: rowTest.getCell(5).value,
            charge: rowTest.getCell(7).value,
          });
        }
      }
    }

    diffReport.sheetsComparison.push(sheetDiff);
  }

  diffReport.formulasIntact = diffReport.unintendedChanges.length === 0;
  return diffReport;
}
