// server/src/graphService.js
import { ConfidentialClientApplication, PublicClientApplication } from "@azure/msal-node";
import ExcelJS from "exceljs";
import fs from "fs";

// Configuration
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || "";
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || "common";
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || "";
const AZURE_REDIRECT_URI = process.env.AZURE_REDIRECT_URI || "http://localhost:8787/api/poc/ms/callback";

// Minimal scopes: User.Read (profile), Files.ReadWrite (delegated file access), offline_access (refresh)
const DEFAULT_SCOPES = ["User.Read", "Files.ReadWrite", "offline_access"];

// Local test file path
const LOCAL_TEST_FILE = "C:\\Users\\Mathieu.Soussignan\\Downloads\\2026-08 - Plan d'activité équipe - TEST.xlsx";
const LOCAL_OFFICIAL_FILE = "C:\\Users\\Mathieu.Soussignan\\Downloads\\2026-08 - Plan d'activité équipe.xlsx";

/**
 * In-memory token & session store for the POC
 */
let currentSession = {
  account: null,
  accessToken: null,
  idToken: null,
  tokenExpiresOn: null,
  scopes: [],
};

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
 * Generate Microsoft OAuth Login URL
 */
export async function getAuthUrl() {
  const msalClient = getMsalClient();
  if (!msalClient) {
    return {
      configured: false,
      message: "AZURE_CLIENT_ID n'est pas encore configuré dans server/.env.",
      authUrl: null,
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
      authUrl,
      state,
      scopes: DEFAULT_SCOPES,
    };
  } catch (error) {
    return {
      configured: true,
      error: error.message || "Erreur lors de la génération de l'URL Microsoft OAuth",
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
  };

  return currentSession;
}

/**
 * Get current Microsoft session status
 */
export function getStatus() {
  const isConfigured = Boolean(AZURE_CLIENT_ID);
  const isAuthenticated = Boolean(currentSession.accessToken && currentSession.tokenExpiresOn && new Date() < new Date(currentSession.tokenExpiresOn));

  return {
    configured: isConfigured,
    authenticated: isAuthenticated,
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
  };
  return { ok: true };
}

/**
 * Generic Graph API fetch helper
 */
async function callGraph(endpoint, options = {}) {
  if (!currentSession.accessToken) {
    throw new Error("Utilisateur Microsoft non authentifié (aucun token Graph actif)");
  }

  const url = endpoint.startsWith("https://") ? endpoint : `https://graph.microsoft.com/v1.0${endpoint}`;
  const headers = {
    Authorization: `Bearer ${currentSession.accessToken}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

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
  try {
    const res = await callGraph(`/sites?search=${encodeURIComponent(siteSearch)}`);
    const sites = res.value || [];
    const matched = sites.find(s => s.name?.toLowerCase().includes("keyfr-projets") || s.displayName?.toLowerCase().includes("keyfr-projets")) || sites[0] || null;

    return {
      success: true,
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
      error: error.message,
      code: error.code,
      status: error.status,
      graphError: error.graphError,
    };
  }
}

/**
 * 2. Discover Drives & Find Activity File in Site
 */
export async function discoverFiles(siteId, fileNameQuery = "Plan d'activité") {
  try {
    // List drives
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

    return {
      success: true,
      drivesCount: drives.length,
      files: fileResults,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      status: error.status,
      graphError: error.graphError,
    };
  }
}

/**
 * 3. List Worksheets of an Excel workbook via Graph
 */
export async function listWorksheets(driveId, itemId) {
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
      count: sheets.length,
      worksheets: sheets,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      status: error.status,
      graphError: error.graphError,
    };
  }
}

/**
 * 4. Read Worksheet data & Tables (Worksheet 'Mathieu')
 */
export async function readMathieuWorksheet(driveId, itemId) {
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
    for (let i = 3; i < Math.min(values.length, 40); i++) {
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
          charge: rowVals[6] || 0,
          type: rowVals[7] || "",
          repartition_vsa: rowVals[8] || "",
        });
      }
    }

    return {
      success: true,
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
      error: error.message,
      code: error.code,
      status: error.status,
      graphError: error.graphError,
    };
  }
}

/**
 * 5. Controlled Write Test to a TEST file
 * STRICT SAFETY CHECK: File name MUST contain 'TEST' or 'test'.
 */
export async function writeTestRowGraph({ driveId, itemId, fileName, tableName, rowData }) {
  // SAFETY CHECK
  const safeName = String(fileName || "").toLowerCase();
  if (!safeName.includes("test")) {
    throw new Error("SÉCURITÉ: L'écriture est STRICTEMENT INTERDITE sur le fichier officiel. Le nom du fichier doit contenir 'TEST'.");
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
      Number(rowData.charge || 0.25),
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
      message: "Ligne de test ajoutée avec succès dans le fichier de TEST SharePoint !",
      addedRow: addRes,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      status: error.status,
      graphError: error.graphError,
    };
  }
}

/**
 * =========================================================================
 * LOCAL WORKBOOK SIMULATION & VALIDATION (Offline / Sandbox Mode)
 * Allows immediate testing of the exact workbook structure against
 * '2026-08 - Plan d'activité équipe - TEST.xlsx'.
 * =========================================================================
 */
export async function inspectLocalTestWorkbook() {
  if (!fs.existsSync(LOCAL_TEST_FILE)) {
    throw new Error(`Fichier test local non trouvé : ${LOCAL_TEST_FILE}`);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(LOCAL_TEST_FILE);

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
    filePath: LOCAL_TEST_FILE,
    isTestCopy: true,
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
  const charge = Number(rowData.charge || 0.25);
  const type = rowData.type || "Projet - Evo";
  const repartitionVsa = rowData.repartition_vsa || "AX";

  // Set cells
  row.getCell(1).value = dateStr;
  row.getCell(2).value = idTicket;
  // Cell 3 is hyperlink formula
  row.getCell(3).value = {
    formula: `IF(Tableau6245781824[[#This Row],[ID Ticket]]<>""; HYPERLINK("https://scp-tma-flux.visualstudio.com/Gestion%20des%20tickets/_workitems/edit/"&Tableau6245781824[[#This Row],[ID Ticket]]; "↪"); "")`
  };
  row.getCell(4).value = nomFlux;
  row.getCell(5).value = sujet;
  row.getCell(6).value = projet;
  row.getCell(7).value = charge;
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
      charge,
      type,
      repartition_vsa: repartitionVsa,
    },
  };
}
