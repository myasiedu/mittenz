# Google Apps Script Setup & Deployment Guide

This backend script lives inside your own Google Drive under a Google Sheet. It handles secure synchronization requests, automatically performs Google Maps reverse geocoding to resolve coordinates to street addresses, and stores all transactions.

---

## Step-by-Step Setup Instruction

### 1. Create a New Google Sheet
1. Visit [sheets.google.com](https://sheets.google.com) and create a brand-new blank spreadsheet.
2. Give your spreadsheet a clear name (e.g., `Mavis Expenses & Mileage logs`).

### 2. Open the Apps Script Editor
1. In the spreadsheet top menu bar, click on **Extensions** -> **Apps Script**.
2. This opens the browser-based code editor environment. Rename the project to `MavisExpense Backend`.

### 3. Insert backend Code
1. Erase all code inside the editor's default `Code.gs` file.
2. Copy the entire contents from [Code.gs](file:///c:/Users/mysym/Documents/antigravity/MavisExpense/backend/Code.gs) in this repository and paste it into the editor.
3. Save the project by clicking the disk icon (or `Ctrl + S`).

### 4. Initialize Database Tables
1. In the toolbar dropdown selection box (next to the "Run" button), make sure **`setupSpreadsheet`** is selected.
2. Click **Run**.
3. A popup will ask for permissions to access your Drive and Spreadsheet documents. Click **Review Permissions**, select your Google account, click **Advanced** (at the bottom), and choose **Go to MavisExpense Backend (unsafe)**.
4. Click **Allow** to finalize permissions.
5. Watch the execution log. Once completed, return to your original Google Sheet window. You will see two beautifully formatted tabs (`Expenses_Logs` and `Locations_DB`) fully prepared!

### 5. Deploy as Web App
To allow the mobile PWA and the Chrome desktop extension to synchronize data with this spreadsheet, you must publish the script as a Web App:
1. In the top-right corner of the Apps Script window, click the blue **Deploy** button -> **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Configure the following settings exactly:
   - **Description**: `Initial Version`
   - **Execute as**: **Me (your-email@gmail.com)** *(This is critical to let the script write to your own sheet)*
   - **Who has access**: **Anyone** *(This is critical to allow CORS calls from the mobile browser and extension)*
4. Click **Deploy**.
5. Copy the generated **Web App URL** shown under "URL" (e.g., `https://script.google.com/macros/s/AKfycb.../exec`).
6. **Save this URL!** You will paste it into the PWA settings page and the Chrome extension options page.

### 6. Adjust Secure API Key Token (Optional)
By default, the script validates a shared security token `"mavis123"`.
If you wish to change this to a stronger custom key:
1. In the Apps Script sidebar on the left, click the gear icon (**Project Settings**).
2. Scroll to **Script Properties** at the bottom.
3. Click **Add script property**:
   - Property: `SHARED_SECRET_KEY`
   - Value: `YourCustomTokenKeyHere`
4. Click **Save script properties**.
5. Update your PWA and Chrome Extension settings with this new custom key!
