/**
 * MavisExpense — Google Apps Script Backend  v3.0
 *
 * POST actions (body JSON):
 *   action=log_visit       — Create / update a visit row in Visits_Log
 *   action=upload_receipt  — Save Base64 image to Drive, write URL to expense row
 *   action=archive_log     — Set Archive = "Yes" on an expense row (rowIndex in params)
 *   (default)              — Sync expense metadata logs (NO image in this call)
 *
 * GET actions (query params):
 *   action=get_all_logs        — Return all Expenses_Logs rows
 *   action=get_visits          — Return all Visits_Log rows
 *   action=get_locations       — Return all Locations_DB rows
 *   action=increment_autofill  — Increment autofill counter on a row
 *   action=mark_synced         — Set Sync_Status = "Synced" on a row
 *
 * Utility (run manually from Apps Script editor):
 *   setupSpreadsheet()         — Initialise / repair all sheets
 */

const SECRET_PROPERTY_NAME = 'SHARED_SECRET_KEY';
const MILEAGE_RATE = 0.67; // £/mile — update as needed

// ============================================================
//  SHEET COLUMN MAPS  (1-indexed)
// ============================================================
const COL_EXPENSE = {
  ID: 1, TIMESTAMP: 2, DATE: 3, CATEGORY: 4, AMOUNT: 5,
  VENDOR: 6, ADDRESS: 7, NOTES: 8, DISTANCE: 9,
  SYNC_STATUS: 10, AUTOFILL_COUNT: 11, ARCHIVE: 12,
  RECEIPT_URL: 13, VISIT_ID: 14
};

const COL_VISIT = {
  ID: 1, DATE: 2, DESTINATION: 3, DISTANCE_MILES: 4,
  MILEAGE_RATE: 5, MILEAGE_VALUE: 6, NOTES: 7, STATUS: 8
};

const COL_LOCATION = {
  NAME: 1, LATITUDE: 2, LONGITUDE: 3, RADIUS: 4,
  DEFAULT_CATEGORY: 5, DISTANCE_FROM_HOME: 6
};

// ============================================================
//  AUTH HELPER
// ============================================================
function _checkAuth(token) {
  const secureToken = getSharedSecretKey();
  return !secureToken || token === secureToken;
}

// ============================================================
//  DRIVE FOLDER HELPER
// ============================================================
function _getReceiptFolder() {
  try {
    const folders = DriveApp.getFoldersByName('MavisExpense_Receipts');
    while (folders.hasNext()) {
      const folder = folders.next();
      if (!folder.isTrashed()) {
        return folder;
      }
    }
    return DriveApp.createFolder('MavisExpense_Receipts');
  } catch (err) {
    console.error('[Drive] Cannot access receipt folder:', err);
    return null;
  }
}

// ============================================================
//  doPost  —  ALL WRITE OPERATIONS
// ============================================================
function doPost(e) {
  try {
    const params = e.parameter || {};

    // Parse JSON body
    let payload = {};
    try {
      if (e.postData && e.postData.contents) {
        payload = JSON.parse(e.postData.contents);
      }
    } catch (parseErr) {
      console.warn('doPost: non-JSON body', parseErr);
    }

    const action = payload.action || params.action;
    const token  = payload.token  || params.token;
    if (!_checkAuth(token)) {
      return jsonResponse({ success: false, message: 'Unauthorized. Invalid Token.' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── UPDATE STATUS ONLY (Sync_Status / Archive) ──────────────────────────
    if (action === 'update_status') {
      const sheet     = ss.getSheetByName('Expenses_Logs');
      const expenseId = payload.expense_id || params.expense_id;
      if (!sheet || !expenseId) {
        return jsonResponse({ success: false, message: 'expense_id required for update_status.' });
      }

      const data = sheet.getDataRange().getValues();
      let targetRow = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === String(expenseId)) { targetRow = i + 1; break; }
      }

      if (targetRow < 0) {
        return jsonResponse({ success: false, message: `Expense ${expenseId} not found in sheet.` });
      }

      const statusVal = payload.sync_status !== undefined ? payload.sync_status : params.sync_status;
      if (statusVal) {
        sheet.getRange(targetRow, COL_EXPENSE.SYNC_STATUS).setValue(statusVal);
      }
      
      const archiveVal = payload.archive !== undefined ? payload.archive : params.archive;
      if (archiveVal !== undefined) {
        sheet.getRange(targetRow, COL_EXPENSE.ARCHIVE).setValue(archiveVal === 'Yes' ? 'Yes' : 'No');
      }

      SpreadsheetApp.flush();
      return jsonResponse({ success: true, message: `Expense ${expenseId} status updated.` });
    }

    // ── ARCHIVE LOG ROW ──────────────────────────────────────
    if (action === 'archive_log') {
      const sheet    = ss.getSheetByName('Expenses_Logs');
      const rowIndex = parseInt(payload.rowIndex || params.rowIndex);
      if (sheet && rowIndex > 1 && rowIndex <= sheet.getLastRow()) {
        sheet.getRange(rowIndex, COL_EXPENSE.ARCHIVE).setValue('Yes');
        SpreadsheetApp.flush();
        return jsonResponse({ success: true, message: `Row ${rowIndex} archived.` });
      }
      return jsonResponse({ success: false, message: 'Invalid row index for archiving.' });
    }

    // ── LOG / UPDATE VISIT ───────────────────────────────────
    if (action === 'log_visit') {
      const sheet = ss.getSheetByName('Visits_Log');
      if (!sheet) {
        setupSpreadsheet();
        return jsonResponse({ success: false, message: 'Visits_Log sheet was missing — setup triggered, please retry.' });
      }

      const visitId      = payload.visit_id;
      if (!visitId) return jsonResponse({ success: false, message: 'visit_id is required.' });

      const distMiles    = parseFloat(payload.distance_miles) || 0;
      const mileageValue = (distMiles * MILEAGE_RATE).toFixed(2);
      const status       = payload.status || 'Open';
      const data = sheet.getDataRange().getValues();
      let existingRow = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === String(visitId)) { existingRow = i + 1; break; }
      }

      if (existingRow > 0) {
        // Update status (and mileage if provided)
        sheet.getRange(existingRow, COL_VISIT.STATUS).setValue(status);
        if (payload.distance_miles !== undefined && distMiles > 0) {
          sheet.getRange(existingRow, COL_VISIT.DISTANCE_MILES).setValue(distMiles);
          sheet.getRange(existingRow, COL_VISIT.MILEAGE_VALUE).setValue(parseFloat(mileageValue));
        }
      } else {
        // Create new visit row
        sheet.appendRow([
          visitId,
          payload.date        || new Date().toLocaleDateString('en-GB'),
          payload.destination || '',
          distMiles,
          MILEAGE_RATE,
          parseFloat(mileageValue),
          payload.notes       || '',
          status
        ]);
      }

      SpreadsheetApp.flush();
      return jsonResponse({ success: true, visit_id: visitId, mileage_value: mileageValue });
    }

    // ── SAVE / UPDATE A SINGLE LOCATION ──────────────────────
    if (action === 'save_location') {
      const sheet = ss.getSheetByName('Locations_DB');
      if (!sheet) {
        setupSpreadsheet();
        return jsonResponse({ success: false, message: 'Locations_DB sheet was missing — setup triggered.' });
      }

      const loc = payload.location;
      if (!loc || !loc.name) {
        return jsonResponse({ success: false, message: 'location object with name is required.' });
      }

      const data = sheet.getDataRange().getValues();
      let targetRow = -1;
      const targetName = (payload.oldName || loc.name || '').trim().toLowerCase();

      for (let i = 1; i < data.length; i++) {
        const rowName = String(data[i][COL_LOCATION.NAME - 1]).trim().toLowerCase();
        if (rowName === targetName) {
          targetRow = i + 1;
          break;
        }
      }

      const newRowValues = [
        loc.name.trim(),
        parseFloat(loc.lat) || 0,
        parseFloat(loc.lng) || 0,
        parseInt(loc.radius) || 100,
        loc.category || loc.default_category || 'Other',
        parseFloat(loc.distance_from_home) || 0
      ];

      if (targetRow > 0) {
        // Update existing row
        sheet.getRange(targetRow, 1, 1, 6).setValues([newRowValues]);
        SpreadsheetApp.flush();
        return jsonResponse({ success: true, message: `Updated location ${loc.name} at row ${targetRow}.` });
      } else {
        // Append new row
        sheet.appendRow(newRowValues);
        SpreadsheetApp.flush();
        return jsonResponse({ success: true, message: `Added new location ${loc.name}.` });
      }
    }

    // ── DELETE A SINGLE LOCATION ─────────────────────────────
    if (action === 'delete_location') {
      const sheet = ss.getSheetByName('Locations_DB');
      if (!sheet) {
        return jsonResponse({ success: false, message: 'Locations_DB sheet not found.' });
      }

      const name = (payload.name || '').trim().toLowerCase();
      if (!name) {
        return jsonResponse({ success: false, message: 'location name is required.' });
      }

      const data = sheet.getDataRange().getValues();
      let targetRow = -1;
      for (let i = 1; i < data.length; i++) {
        const rowName = String(data[i][COL_LOCATION.NAME - 1]).trim().toLowerCase();
        if (rowName === name) {
          targetRow = i + 1;
          break;
        }
      }

      if (targetRow > 0) {
        sheet.deleteRow(targetRow);
        SpreadsheetApp.flush();
        return jsonResponse({ success: true, message: `Deleted location ${payload.name} from row ${targetRow}.` });
      }
      return jsonResponse({ success: false, message: `Location ${payload.name} not found in sheet.` });
    }

// ── PRE-PROCESS RECEIPT (AI FIRST APPROACH) ────────────────────────
    if (action === 'process_receipt') {
      console.log('[process_receipt] Started pre-processing.');
      const image_base64 = payload.image_base64;
      
      if (!image_base64) {
        return jsonResponse({ success: false, message: 'image_base64 is required.' });
      }

      // 1. Save image to Drive to get the URL immediately
      const receiptFolder = _getReceiptFolder();
      let receiptUrl = '';
      try {
        const b64 = image_base64.includes(',') ? image_base64.split(',')[1] : image_base64;
        const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', `Receipt_${Utilities.getUuid()}.jpg`);
        const file = receiptFolder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        receiptUrl = file.getUrl();
      } catch (imgErr) {
        console.error('[Drive] Failed to save pre-receipt:', imgErr);
        // We continue even if drive save fails, AI might still work
      }

      // 2. Run Groq AI
      console.log('[process_receipt] Calling Groq API...');
      const aiData = _analyzeReceiptWithGroq(image_base64);
      
      // Attempt GPS EXIF extraction without modifying how Groq AI functions
      const exifGps = _extractGpsFromExif(image_base64);
      if (exifGps && aiData) {
        if (!aiData.gps_lat) aiData.gps_lat = exifGps.gps_lat;
        if (!aiData.gps_lng) aiData.gps_lng = exifGps.gps_lng;
      }
      
      // 3. Optional Location Match
      let suggestedVisitId = '';
      if (aiData && (aiData.gps_lat || aiData.date)) {
        suggestedVisitId = _matchVisitByLocation(ss, aiData.gps_lat, aiData.gps_lng, aiData.date);
      }

      return jsonResponse({
        success: true,
        receipt_url: receiptUrl,
        ai_data: aiData || null,
        suggested_visit_id: suggestedVisitId || ''
      });
    }


    // ── UPLOAD RECEIPT IMAGE + AI ANALYSIS (Step 2 of two-step upload) ────
    if (action === 'upload_receipt') {
      console.log('[upload_receipt] Started processing.');
      const expenseId    = payload.expense_id;
      const image_base64 = payload.image_base64;
      if (!expenseId || !image_base64) {
        console.warn('[upload_receipt] Error: Missing expense_id or image_base64.');
        return jsonResponse({ success: false, message: 'expense_id and image_base64 are required.' });
      }

      // ── 1. Save image to Google Drive ──────────────────────
      console.log('[upload_receipt] Resolving receipt folder.');
      const receiptFolder = _getReceiptFolder();
      if (!receiptFolder) {
        console.error('[upload_receipt] Error: Drive folder not accessible.');
        return jsonResponse({ success: false, message: 'Drive folder not accessible. Check permissions.' });
      }
      console.log('[upload_receipt] Folder resolved (ID: ' + receiptFolder.getId() + ').');

      let receiptUrl = '';
      try {
        const b64  = image_base64.includes(',') ? image_base64.split(',')[1] : image_base64;
        console.log('[upload_receipt] Decoding Base64 image (length: ' + b64.length + ' chars).');
        const blob = Utilities.newBlob(
          Utilities.base64Decode(b64),
          'image/jpeg',
          `Receipt_${expenseId}.jpg`
        );
        console.log('[upload_receipt] Blob created. Creating file in Drive.');
        const file = receiptFolder.createFile(blob);
        try {
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        } catch (eShare) {
          console.warn('[Drive] Sharing restricted (saved privately):', eShare.message);
        }
        receiptUrl = file.getUrl();
        console.log('[upload_receipt] File saved. URL = ' + receiptUrl);
      } catch (imgErr) {
        console.error('[Drive] Failed to save receipt image:', imgErr);
        return jsonResponse({ success: false, message: 'Image decode/save failed: ' + imgErr.toString() });
      }

      // ── 2. AI Analysis via Groq ──────────────────────────
      console.log('[upload_receipt] Calling Groq API via native OCR pipeline...');
      const aiData = _analyzeReceiptWithGroq(image_base64);
      console.log('[upload_receipt] Groq extraction result: ' + JSON.stringify(aiData));

      // Attempt GPS EXIF extraction without modifying how Groq AI functions
      const exifGps = _extractGpsFromExif(image_base64);
      if (exifGps && aiData) {
        if (!aiData.gps_lat) aiData.gps_lat = exifGps.gps_lat;
        if (!aiData.gps_lng) aiData.gps_lng = exifGps.gps_lng;
      }

      // ── 3. Location/Date-based visit matching ──────────────
      let suggestedVisitId = '';
      if (aiData && (aiData.gps_lat || aiData.date)) {
        console.log('[upload_receipt] Attempting visit match: lat=' + aiData.gps_lat + ' date=' + aiData.date);
        suggestedVisitId = _matchVisitByLocation(ss, aiData.gps_lat, aiData.gps_lng, aiData.date);
        console.log('[upload_receipt] Suggested visit: ' + (suggestedVisitId || 'none'));
      }

      // ── 4. Write Receipt_URL (and AI fields) to sheet ─────
      const expSheet = ss.getSheetByName('Expenses_Logs');
      if (!expSheet) {
        return jsonResponse({ success: false, message: 'Expenses_Logs sheet not found.' });
      }
      const data = expSheet.getDataRange().getValues();
      let targetRow = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === String(expenseId)) { targetRow = i + 1; break; }
      }
      console.log('[upload_receipt] targetRow resolved: ' + targetRow);
      if (targetRow > 0) {
        expSheet.getRange(targetRow, COL_EXPENSE.RECEIPT_URL).setValue(receiptUrl);
        // Back-fill AI-extracted fields if the row still has blanks
        if (aiData) {
          const row = data[targetRow - 1];
          if (!row[COL_EXPENSE.AMOUNT - 1]    && aiData.amount)      expSheet.getRange(targetRow, COL_EXPENSE.AMOUNT).setValue(aiData.amount);
          if (!row[COL_EXPENSE.VENDOR - 1]    && aiData.vendor)      expSheet.getRange(targetRow, COL_EXPENSE.VENDOR).setValue(aiData.vendor);
          if (!row[COL_EXPENSE.NOTES - 1]     && aiData.description) expSheet.getRange(targetRow, COL_EXPENSE.NOTES).setValue(aiData.description);
          if (!row[COL_EXPENSE.CATEGORY - 1]  && aiData.category)    expSheet.getRange(targetRow, COL_EXPENSE.CATEGORY).setValue(aiData.category);
          if (suggestedVisitId && !row[COL_EXPENSE.VISIT_ID - 1])    expSheet.getRange(targetRow, COL_EXPENSE.VISIT_ID).setValue(suggestedVisitId);
        }
        SpreadsheetApp.flush();
        console.log('[upload_receipt] Sheet updated and flushed.');
      } else {
        console.warn('[upload_receipt] Row not found for Expense ID: ' + expenseId);
      }

      return jsonResponse({
        success: true,
        receipt_url: receiptUrl,
        expense_id: expenseId,
        ai_data: aiData || null,
        suggested_visit_id: suggestedVisitId || ''
      });
    }

    // ── SYNC EXPENSE METADATA (default — NO image) ───────────
    const logs = payload.logs;
    if (!logs || !Array.isArray(logs)) {
      return jsonResponse({ success: false, message: 'No logs array provided and no recognised action.' });
    }

    let expenseSheet = ss.getSheetByName('Expenses_Logs');
    if (!expenseSheet) {
      setupSpreadsheet();
      expenseSheet = ss.getSheetByName('Expenses_Logs');
    }

    let itemsLogged = 0;

    logs.forEach(log => {
      const resolvedAddress = log.address || '';
      const data = expenseSheet.getDataRange().getValues();
      let existingRow = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === String(log.id)) { existingRow = i + 1; break; }
      }

      if (log.sync_action === 'delete') {
        if (existingRow > 0) {
          expenseSheet.getRange(existingRow, COL_EXPENSE.ARCHIVE).setValue('Yes');
        }
      } else if (log.sync_action === 'update' && existingRow > 0) {
        const oldReceipt   = data[existingRow - 1][COL_EXPENSE.RECEIPT_URL - 1];
        const oldArchive   = data[existingRow - 1][COL_EXPENSE.ARCHIVE - 1] || 'No';
        const oldAutoFill  = data[existingRow - 1][COL_EXPENSE.AUTOFILL_COUNT - 1];
        const newSyncStatus = log.sync_status || data[existingRow - 1][COL_EXPENSE.SYNC_STATUS - 1] || 'Pending';
        const newArchive    = log.archive !== undefined ? log.archive : oldArchive;
        expenseSheet.getRange(existingRow, 1, 1, 14).setValues([[
          log.id,
          log.timestamp || data[existingRow - 1][COL_EXPENSE.TIMESTAMP - 1],
          log.date      || data[existingRow - 1][COL_EXPENSE.DATE - 1],
          log.category  || data[existingRow - 1][COL_EXPENSE.CATEGORY - 1],
          parseFloat(log.amount)   || 0,
          log.vendor               || '',
          resolvedAddress,
          log.notes                || '',
          parseFloat(log.distance) || 0,
          newSyncStatus,
          oldAutoFill,
          newArchive,
          log.receipt_url || oldReceipt,
          log.visit_id         || ''
        ]]);
      } else if (existingRow < 0) {
        expenseSheet.appendRow([
          log.id,
          log.timestamp || new Date().toISOString(),
          log.date      || new Date().toLocaleDateString('en-GB'),
          log.category  || 'Expense',
          parseFloat(log.amount)   || 0,
          log.vendor               || '',
          resolvedAddress,
          log.notes                || '',
          parseFloat(log.distance) || 0,
          log.sync_status || 'Pending',   
          0,             
          log.archive || 'No',          
          log.receipt_url || '',            
          log.visit_id  || ''
        ]);
      }
      itemsLogged++;
    });

    SpreadsheetApp.flush();
    return jsonResponse({ success: true, message: `Stored ${itemsLogged} expense(s).`, count: itemsLogged });
  } catch (err) {
    console.error('[doPost] Critical error:', err);
    return jsonResponse({ success: false, message: err.toString() });
  }
}

// ============================================================
//  doGet  —  ALL READ OPERATIONS (no writes)
// ============================================================
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action;
    const token  = params.token;

    if (!_checkAuth(token)) {
      return jsonResponse({ success: false, message: 'Unauthorized.' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── GET ALL EXPENSE LOGS ─────────────────────────────────
    if (action === 'get_all_logs') {
      const sheet = ss.getSheetByName('Expenses_Logs');
      if (!sheet) return jsonResponse({ success: true, rows: [] });

      const data    = sheet.getDataRange().getValues();
      const headers = data[0];
      const rows    = [];
      for (let i = 1; i < data.length; i++) {
        const row = { rowIndex: i + 1 };
        headers.forEach((h, idx) => {
          row[h.toString().toLowerCase().replace(/[\s\/]/g, '_')] = data[i][idx];
        });
        rows.push(row);
      }
      return jsonResponse({ success: true, rows });
    }

    // ── GET ALL VISITS ───────────────────────────────────────
    if (action === 'get_visits') {
      const sheet = ss.getSheetByName('Visits_Log');
      if (!sheet) return jsonResponse({ success: true, visits: [] });

      const data    = sheet.getDataRange().getValues();
      const headers = data[0];
      const visits  = [];
      for (let i = 1; i < data.length; i++) {
        const v = { rowIndex: i + 1 };
        headers.forEach((h, idx) => {
          v[h.toString().toLowerCase().replace(/[\s\/]/g, '_')] = data[i][idx];
        });
        visits.push(v);
      }
      return jsonResponse({ success: true, visits });
    }

    // ── GET LOCATIONS ────────────────────────────────────────
    if (action === 'get_locations') {
      const sheet = ss.getSheetByName('Locations_DB');
      if (!sheet) return jsonResponse({ success: true, locations: [] });

      const data      = sheet.getDataRange().getValues();
      const locations = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0]) continue;
        locations.push({
          name:               row[COL_LOCATION.NAME - 1],
          lat:                parseFloat(row[COL_LOCATION.LATITUDE - 1])          || 0,
          lng:                parseFloat(row[COL_LOCATION.LONGITUDE - 1])         || 0,
          radius:             parseInt(row[COL_LOCATION.RADIUS - 1])              || 50,
          default_category:   row[COL_LOCATION.DEFAULT_CATEGORY - 1]              || '',
          distance_from_home: parseFloat(row[COL_LOCATION.DISTANCE_FROM_HOME - 1])|| 0
        });
      }
      return jsonResponse({ success: true, locations });
    }

    // ── INCREMENT AUTOFILL COUNT ─────────────────────────────
    if (action === 'increment_autofill') {
      const sheet    = ss.getSheetByName('Expenses_Logs');
      const rowIndex = parseInt(params.row_index);
      if (sheet && rowIndex > 1 && rowIndex <= sheet.getLastRow()) {
        const cell  = sheet.getRange(rowIndex, COL_EXPENSE.AUTOFILL_COUNT);
        const count = (parseInt(cell.getValue()) || 0) + 1;
        cell.setValue(count);
        SpreadsheetApp.flush();
        return jsonResponse({ success: true, autofill_count: count });
      }
      return jsonResponse({ success: false, message: 'Invalid row index.' });
    }

    // ── MARK ROW AS SYNCED ───────────────────────────────────
    if (action === 'mark_synced') {
      const sheet    = ss.getSheetByName('Expenses_Logs');
      const rowIndex = parseInt(params.row_index);
      if (sheet && rowIndex > 1 && rowIndex <= sheet.getLastRow()) {
        sheet.getRange(rowIndex, COL_EXPENSE.SYNC_STATUS).setValue('Synced');
        SpreadsheetApp.flush();
        return jsonResponse({ success: true, message: `Row ${rowIndex} marked Synced.` });
      }
      return jsonResponse({ success: false, message: 'Invalid row index.' });
    }

    return jsonResponse({ success: false, message: `Unknown GET action: "${action}".` });

  } catch (err) {
    console.error('[doGet] Error:', err);
    return jsonResponse({ success: false, message: err.toString() });
  }
}

// ============================================================
//  UTILITY: JSON response
// ============================================================
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  UTILITY: Shared secret key (stored in Script Properties)
// ============================================================
function getSharedSecretKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(SECRET_PROPERTY_NAME);
  if (!key) {
    key = 'mavis123'; // ⚠️ Change this after first deployment via Script Properties
    props.setProperty(SECRET_PROPERTY_NAME, key);
  }
  return key;
}

// ============================================================
//  SETUP: Run once manually from Apps Script editor
//         Toolbar → Run → setupSpreadsheet
// ============================================================
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  _ensureSheet(ss, 'Expenses_Logs', [
    'ID', 'Timestamp', 'Date', 'Category', 'Amount',
    'Vendor_Place', 'Address', 'Notes', 'Distance_Miles',
    'Sync_Status', 'Autofill_Count', 'Archive', 'Receipt_URL', 'Visit_ID'
  ], '#8b5cf6', [
    ['EXP_SAMPLE_1', new Date().toISOString(), new Date().toLocaleDateString('en-GB'),
     'Client Visit', 0, 'Sample Client', 'Colchester, Essex', 'Sample visit', 12.4,
     'Pending', 0, 'No', '', '']
  ]);

  _ensureSheet(ss, 'Visits_Log', [
    'Visit_ID', 'Date', 'Destination', 'Distance_Miles',
    'Mileage_Rate', 'Mileage_Value', 'Notes', 'Status'
  ], '#0ea5e9', [
    ['VIS_SAMPLE_1', new Date().toLocaleDateString('en-GB'), 'Colchester', 12.4, 0.67, 8.31, 'Sample visit', 'Open']
  ]);

  _ensureSheet(ss, 'Locations_DB', [
    'Name', 'Latitude', 'Longitude', 'Radius_Meters',
    'Default_Category', 'Distance_From_Home_Miles'
  ], '#10b981', [
    ['Main Office',         51.8860, 0.8990, 50, 'Client Visit', 12.4],
    ['Colchester Hospital', 51.8750, 0.9100, 80, 'Client Visit', 11.8],
    ['Shell Petrol',        51.8820, 0.9050, 35, 'Fuel',         12.1]
  ]);

  SpreadsheetApp.flush();
  Logger.log('✅ MavisExpense spreadsheet setup complete.');
}


// ============================================================
//  AI: Analyse receipt image with Google Gemini
// ============================================================
function _analyzeReceiptWithGroq(image_base64) {
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GROQ_API_EXTRACT');
    if (!apiKey) {
      console.warn('[Groq] GROQ_API_EXTRACT not set in Script Properties.');
      return null;
    }

    const b64 = image_base64.includes(',') ? image_base64.split(',')[1] : image_base64;
    
    // ── FIX: Restored the missing blob definition ──────────────────
    console.log('[Groq/OCR] Converting image base64 data into transient blob...');
    const blob = Utilities.newBlob(
      Utilities.base64Decode(b64),
      'image/jpeg',
      `OcrTemp_${Utilities.getUuid()}.jpg`
    );

    console.log('[Groq/OCR] Initiating Google Drive structural OCR transcription...');
    let ocrText = '';
    try {
      // Drive API V3 Structure: 'name' replaces 'title'
      // Setting mimeType to Google Docs forces Drive to run its OCR engine on the image
      const resource = {
        name: blob.getName(),
        mimeType: 'application/vnd.google-apps.document' 
      };
      
      // V3 uses .create() instead of .insert()
      const tempFile = Drive.Files.create(resource, blob);
      const doc = DocumentApp.openById(tempFile.id);
      ocrText = doc.getBody().getText();
      
      // Clean up the temporary document instantly to avoid cluttering Drive
      Drive.Files.remove(tempFile.id);
      console.log('[Groq/OCR] Transcription finished cleanly. Characters found: ' + ocrText.length);
    } catch (ocrErr) {
      console.error('[Groq/OCR] Google native OCR engine failed: ', ocrErr.toString());
      return null; 
    }

    if (!ocrText || !ocrText.trim()) {
      console.warn('[Groq/OCR] No readable alpha-numeric data extracted from receipt image.');
      return null;
    }

    // ── STEP 2: GROQ REASONING ENGINE OVER THE EXTRACTED TEXT ──────
    const promptSystem = `You are an expert financial auditor and receipt parser. 
Analyze the raw OCR text extracted from a business receipt image and return a structured JSON output.
You must return ONLY a raw JSON string. Do not use code blocks, explanation markers, or markdown text.

Target fields to map:
{
  "amount": <total amount paid as a floating number, e.g. 14.20, or null>,
  "vendor": <shop, store, or supplier name as a text string, or null>,
  "category": <Strictly filter text context into one of these strings: "Fuel", "Meals", "Hotel", "Tolls", "Office Supplies", "Other">,
  "items": <comma-separated compilation list of individual objects/lines bought, or null>,
  "description": <(one short clear summary sentence tracking the operational target, or null)and(comma-separated compilation list of individual objects/lines bought, or null)>,
  "date": <The actual transaction date. Parse the textual information and output STRICTLY in standard DD/MM/YYYY formatting, or null>,
  "time": <time matching the purchase in standard 24-hour HH:MM format, or null>,
  "gps_lat": null,
  "gps_lng": null
}

Rules:
- Under no circumstances output sub-totals; extract the definitive finalized grand total paid.
- If data points are muddy or missing, return a literal null for that specific key configuration.`;

    const requestBody = {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: promptSystem },
        { role: "user", content: "Extracted Document OCR Transcription Data:\n\n" + ocrText }
      ],
      response_format: { type: "json_object" }, 
      temperature: 0.0
    };

    const endpoint = "https://api.groq.com/openai/v1/chat/completions";
    const response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + apiKey
      },
      payload: JSON.stringify(requestBody),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    console.log('[Groq] API HTTP Connection response code: ' + responseCode);

    if (responseCode !== 200) {
      console.error('[Groq] Remote endpoint returned an explicit error: ' + responseText.slice(0, 500));
      return null;
    }

    const groqResponse = JSON.parse(responseText);
    const structuredContent = groqResponse?.choices?.[0]?.message?.content || '';
    console.log('[Groq] Raw AI JSON text payload: ' + structuredContent.slice(0, 400));

    const parsed = JSON.parse(structuredContent.trim());
    console.log('[Groq] Document processing workflow finalized. Mapped: Date=' + parsed.date + ' Vendor=' + parsed.vendor);
    return parsed;

  } catch (err) {
    console.error('[Groq] Root execution tree analysis failed: ' + err.toString());
    return null;
  }
}

// ============================================================
//  AI: Match a receipt to an open Visit by GPS proximity + date
// ============================================================
function _matchVisitByLocation(ss, lat, lng, receiptDate) {
  try {
    const visitSheet    = ss.getSheetByName('Visits_Log');
    const locationSheet = ss.getSheetByName('Locations_DB');
    if (!visitSheet || !locationSheet) return '';

    const visitData    = visitSheet.getDataRange().getValues();
    const locationData = locationSheet.getDataRange().getValues();

    // ── Helper: Haversine distance in metres between two lat/lng points ──
    function haversineMetres(lat1, lng1, lat2, lng2) {
      const R    = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a    = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
                 * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ── Step 1: If GPS available, find which Location in Locations_DB matches ──
    let matchedLocationName = null;
    if (lat && lng) {
      for (let i = 1; i < locationData.length; i++) {
        const locLat    = parseFloat(locationData[i][COL_LOCATION.LATITUDE - 1]);
        const locLng    = parseFloat(locationData[i][COL_LOCATION.LONGITUDE - 1]);
        const radius    = parseFloat(locationData[i][COL_LOCATION.RADIUS - 1]) || 100;
        const locName   = locationData[i][COL_LOCATION.NAME - 1];
        if (!locLat || !locLng) continue;
        const dist = haversineMetres(lat, lng, locLat, locLng);
        console.log('[Match] ' + locName + ' distance: ' + Math.round(dist) + 'm (radius: ' + radius + 'm)');
        if (dist <= radius) {
          matchedLocationName = locName;
          console.log('[Match] GPS matched location: ' + matchedLocationName);
          break;
        }
      }
    }

    // ── Step 2: Parse receipt date (DD/MM/YYYY → comparable string) ──
    let receiptDateObj = null;
    if (receiptDate) {
      const parts = receiptDate.split('/');
      if (parts.length === 3) {
        receiptDateObj = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      }
    }

    // ── Step 3: Find best matching open visit ──────────────────
    // Priority: GPS location match on same date > same date > GPS match only
    let bestVisitId = '';
    let bestScore   = -1;

    for (let i = 1; i < visitData.length; i++) {
      const vid         = String(visitData[i][COL_VISIT.ID - 1]);
      const vDest       = String(visitData[i][COL_VISIT.DESTINATION - 1]);
      const vDateRaw    = visitData[i][COL_VISIT.DATE - 1];
      const vStatus     = String(visitData[i][COL_VISIT.STATUS - 1]).toLowerCase();
      if (!vid || vStatus === 'closed') continue;

      let score = 0;

      // Date match
      if (receiptDateObj && vDateRaw) {
        const vDate = new Date(vDateRaw);
        const sameDay = vDate.getDate()   === receiptDateObj.getDate()
                     && vDate.getMonth()  === receiptDateObj.getMonth()
                     && vDate.getFullYear() === receiptDateObj.getFullYear();
        if (sameDay) score += 2;
      }

      // GPS/Location name match: destination of visit matches location name
      if (matchedLocationName && vDest.toLowerCase().includes(matchedLocationName.toLowerCase())) {
        score += 3;
      }

      console.log('[Match] Visit ' + vid + ' (' + vDest + ') score: ' + score);
      if (score > bestScore) {
        bestScore   = score;
        bestVisitId = vid;
      }
    }

    // Only return a match if there is at least some evidence (score > 0)
    return bestScore > 0 ? bestVisitId : '';

  } catch (err) {
    console.error('[Match] Location matching failed: ' + err.toString());
    return '';
  }
}

// ============================================================
//  EXIF GPS EXTRACTION — Reads raw JPEG bytes to find GPS IFD
//  Returns { gps_lat, gps_lng } or null
// ============================================================
function _extractGpsFromExif(b64) {
  try {
    const bytes = Utilities.base64Decode(b64.includes(',') ? b64.split(',')[1] : b64);
    
    function u(pos) {
      return bytes[pos] & 0xFF;
    }

    // JPEG starts with FFD8, EXIF APP1 marker is FFE1
    if (u(0) !== 0xFF || u(1) !== 0xD8) {
      console.log('[EXIF] Not a valid JPEG');
      return null;
    }

    // Search for APP1 (0xFF, 0xE1) marker
    let offset = 2;
    while (offset < bytes.length - 1) {
      if (u(offset) !== 0xFF) { offset++; continue; }
      const marker = u(offset + 1);
      const segLen = (u(offset + 2) << 8) | u(offset + 3);

      if (marker === 0xE1) {
        // APP1 — check for "Exif" header at offset+4
        const exifHeader = String.fromCharCode(u(offset+4), u(offset+5), u(offset+6), u(offset+7));
        if (exifHeader === 'Exif') {
          // TIFF data starts at offset + 10 (after APP1 length word + "Exif\0\0")
          const tiffStart = offset + 10;
          const isLittleEndian = u(tiffStart) === 0x49; // 0x49 = 'I' (Intel/Little Endian)

          function readUint16(pos) {
            const b0 = u(tiffStart + pos);
            const b1 = u(tiffStart + pos + 1);
            return isLittleEndian ? (b0 | (b1 << 8)) : ((b0 << 8) | b1);
          }
          function readUint32(pos) {
            const b0 = u(tiffStart + pos);
            const b1 = u(tiffStart + pos + 1);
            const b2 = u(tiffStart + pos + 2);
            const b3 = u(tiffStart + pos + 3);
            return isLittleEndian
              ? ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0)
              : (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0);
          }
          function readRational(pos) {
            const num = readUint32(pos);
            const den = readUint32(pos + 4);
            return den !== 0 ? num / den : 0;
          }

          // IFD0 entries
          const ifd0Offset = readUint32(4);
          const entryCount = readUint16(ifd0Offset);
          let gpsIfdOffset = -1;

          for (let i = 0; i < entryCount; i++) {
            const entryOffset = ifd0Offset + 2 + i * 12;
            const tag = readUint16(entryOffset);
            if (tag === 0x8825) { // GPSInfo IFD pointer
              gpsIfdOffset = readUint32(entryOffset + 8);
              break;
            }
          }

          if (gpsIfdOffset < 0) {
            console.log('[EXIF] No GPS IFD found in EXIF data');
            return null;
          }

          // Read GPS IFD
          const gpsEntryCount = readUint16(gpsIfdOffset);
          let latRef = '', lat = null, lngRef = '', lng = null;

          for (let i = 0; i < gpsEntryCount; i++) {
            const eOff = gpsIfdOffset + 2 + i * 12;
            const tag  = readUint16(eOff);
            const valOffset = readUint32(eOff + 8);

            if (tag === 0x0001) { // GPSLatitudeRef
              latRef = String.fromCharCode(u(gpsIfdOffset + 2 + i * 12 + 8));
            } else if (tag === 0x0002) { // GPSLatitude (3 rationals)
              const deg = readRational(valOffset);
              const min = readRational(valOffset + 8);
              const sec = readRational(valOffset + 16);
              lat = deg + (min / 60) + (sec / 3600);
            } else if (tag === 0x0003) { // GPSLongitudeRef
              lngRef = String.fromCharCode(u(gpsIfdOffset + 2 + i * 12 + 8));
            } else if (tag === 0x0004) { // GPSLongitude (3 rationals)
              const deg = readRational(valOffset);
              const min = readRational(valOffset + 8);
              const sec = readRational(valOffset + 16);
              lng = deg + (min / 60) + (sec / 3600);
            }
          }

          if (lat !== null && lng !== null) {
            if (latRef === 'S') lat = -lat;
            if (lngRef === 'W') lng = -lng;
            console.log('[EXIF] GPS extracted: lat=' + lat.toFixed(6) + ' lng=' + lng.toFixed(6));
            return { gps_lat: parseFloat(lat.toFixed(6)), gps_lng: parseFloat(lng.toFixed(6)) };
          }
        }
        break; // APP1 found and processed
      }
      offset += 2 + segLen; // Jump to next marker
    }

    console.log('[EXIF] No GPS coordinates found');
    return null;
  } catch (err) {
    console.error('[EXIF] Extraction failed: ' + err.toString());
    return null;
  }
}

function _ensureSheet(ss, name, headers, color, samples) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const existingHeaders = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    : [];

  if (!headers.every((h, i) => existingHeaders[i] === h)) {
    sheet.clearContents();
    sheet.appendRow(headers);

    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange
      .setFontWeight('bold')
      .setBackground(color)
      .setFontColor('#ffffff')
      .setHorizontalAlignment('center');

    sheet.setFrozenRows(1);
    for (let i = 1; i <= headers.length; i++) sheet.setColumnWidth(i, 140);

    if (samples && samples.length > 0) {
      samples.forEach(row => sheet.appendRow(row));
    }
    Logger.log(`  → Sheet "${name}" created/reset.`);
  } else {
    Logger.log(`  → Sheet "${name}" already up to date.`);
  }
}

function testGroqPipeline() {
  Logger.log('=== Starting Groq + OCR Pipeline Test ===');
  
  // 1. CHOOSE A TEST IMAGE
  // Find a test receipt image in your Google Drive, copy its ID from the URL, and paste it here:
  const testFileId = '1zwR7s69o1Ufp1bYiHpFNVZjtVNdr39V5'; 
 
  try {
    const file = DriveApp.getFileById(testFileId);
    Logger.log('📷 Found test file: ' + file.getName() + ' (' + file.getMimeType() + ')');
    
    // 2. CONVERT TO BASE64 (Simulating your frontend payload)
    const blob = file.getBlob();
    const base64Data = Utilities.base64Encode(blob.getBytes());
    const simulatedPayload = 'data:' + file.getMimeType() + ';base64,' + base64Data;
    
    Logger.log('🔄 Simulated Base64 payload generated string length: ' + simulatedPayload.length);
    
    // 3. RUN THE EXTRACTION
    Logger.log('🚀 Triggering Groq extraction function...');
    const result = _analyzeReceiptWithGroq(simulatedPayload);
    
    // 4. VERIFY OBJECT
    if (result) {
      Logger.log('✅ TEST PASSED! Successfully parsed JSON object:');
      Logger.log(JSON.stringify(result, null, 2));
    } else {
      Logger.log('❌ TEST FAILED: Function returned null. Review execution logs above.');
    }
    
  } catch (err) {
    Logger.log('💥 Critical Test Script Error: ' + err.toString());
  }
}
