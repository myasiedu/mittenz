/**
 * MavisExpense — Core PWA Engine  v3.0
 *
 * Architecture:
 *  • 3 tabs: Sync & Logs | Record Expense | Settings
 *  • IndexedDB for offline queue (expenses pending sync)
 *  • Two-step image upload: metadata POST first, image POST second
 *  • Visit-centric model: activeVisit in localStorage
 *  • GPS/geofencing removed entirely
 */

// ============================================================
//  IndexedDB — Offline Queue
// ============================================================
const DB_NAME = 'mavis_idb';
const DB_VERSION = 3;
const STORE_EXPENSES = 'pending_expenses';
const STORE_HISTORY = 'history_expenses';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_EXPENSES)) {
        db.createObjectStore(STORE_EXPENSES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
      }
    };
    req.onsuccess = ev => resolve(ev.target.result);
    req.onerror = ev => reject(ev.target.error);
  });
}

async function dbPut(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(record);
    req.onsuccess = () => resolve();
    req.onerror = ev => reject(ev.target.error);
  });
}

async function dbGet(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = ev => resolve(ev.target.result);
    req.onerror = ev => reject(ev.target.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = ev => resolve(ev.target.result || []);
    req.onerror = ev => reject(ev.target.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = ev => reject(ev.target.error);
  });
}

async function dbClear(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = ev => reject(ev.target.error);
  });
}

// ============================================================
//  Image compression  — Returns Base64 JPEG data URL
// ============================================================
function compressImage(file, maxWidth = 900, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Use ObjectURL instead of FileReader to prevent mobile RAM crashes
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl); // Instantly free up device memory
      const ratio = Math.min(maxWidth / img.width, 1);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Camera image processing failed.'));
    };

    img.src = objectUrl;
  });
}

// ============================================================
//  Date helper — "Mon 09-Jun-26"
// ============================================================
function formatDateFriendly(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
    if (isNaN(d)) return dateStr;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  } catch (_) { return dateStr; }
}

// ============================================================
//  App Class
// ============================================================
class MavisExpenseApp {

  constructor() {
    // 1. Initialize primitive state arrays and flags
    this.logs = [];
    this.visits = [];
    this.locations = [];
    this.activeVisit = null;
    this._isSyncing = false;
    this.editingExpenseId = null;
    this._pendingReceiptBase64 = '';
    this._currentReceiptUrl = '';
    this.aiAutomation = true;
    this.inEditMode = false;

    // Carousel state
    this._cardIndex = 0;
    this._cardExpenses = [];
    this._cardVisitGroups = [];

    // History view state
    this._historyView = 'list'; // 'list' | 'cal'
    this._calDate = new Date();
    this._calDate.setDate(1);
    this._allRows = [];    // cached expense rows from sheet (non-archived)
    this._allVisits = [];  // cached visit rows from sheet
    this._archivedRows = [];  // cached archived expense rows (loaded on demand)
    this._archiveMode = false; // true when archive view is active

    // 2. Define default fallbacks FIRST so loadSettings() can safely reference them
    this.defaultFrequentPlaces = [
      { name: 'London offline', lat: 51.882, lng: 0.905, radius: 35, category: 'Fuel', distance_from_home: 12.1 },
      { name: 'Colchester offline', lat: 51.875, lng: 0.910, radius: 80, category: 'Client Visit', distance_from_home: 11.8 }
    ];

    // 3. Setup the initial safety empty structure for settings
    this.settings = {
      webappUrl: '',
      secretKey: '',
      frequentPlaces: [...this.defaultFrequentPlaces]
    };

    // 4. Now that everything is safely initialized, load user overrides from localStorage
    this.loadSettings();
  }

  // ──────────────────────────────────────────────────────────
  //  INIT
  // ──────────────────────────────────────────────────────────
  async init() {

    this.log('MavisExpense v3 initialising…');
    let cachedTheme = 'dark';
    try {
      cachedTheme = localStorage.getItem('mavis_theme') || 'dark';
    } catch (_) {
      this.log('localStorage access blocked. Using default theme.');
    }
    this.applyTheme(cachedTheme);
    this.loadSettings();
    this.registerSW();
    this.toggleNewVisitModal(false);

    // Default visit date = today
    const welcome = document.getElementById('welcome');
    const visitDateEl = document.getElementById('visit-date');
    if (visitDateEl) visitDateEl.value = new Date().toISOString().split('T')[0];

    // Restore active visit from last session
    try {
      const saved = localStorage.getItem('mavis_active_visit');
      if (saved) {
        this.activeVisit = JSON.parse(saved);
      } else {
        this.activeVisit = null;
      }
    } catch (_) {
      this.activeVisit = null;
      localStorage.removeItem('mavis_active_visit');
    }

    // Initialize visit bar display early to evaluate its natural visual state
    this._renderVisitBar();



    //this._updateFab();

    // Receipt input listener
    const receiptInput = document.getElementById('exp-receipt');
    if (receiptInput) {
      receiptInput.addEventListener('change', e => this._onReceiptSelected(e.target.files[0]));
    }

    // ═══════════════════════════════════════════════════════
    // INSERT THIS BLOCK HERE (With the ID corrected to 'exp-amount')
    // ═══════════════════════════════════════════════════════
    const amountInput = document.getElementById('exp-amount');
    if (amountInput) {
      ['input', 'change', 'keyup'].forEach(evt => {
        amountInput.addEventListener(evt, () => this.evaluateFormInputMaturity());
      });
    }

    // Theme toggle
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) themeBtn.addEventListener('click', () => this.toggleTheme());

    // ── History view switcher ──
    const btnList = document.getElementById('pwa-view-btn-list');
    const btnCal = document.getElementById('pwa-view-btn-cal');
    const btnArchive = document.getElementById('btn-archive-view');
    if (btnList) btnList.addEventListener('click', () => this._setHistoryView('list'));
    if (btnCal) btnCal.addEventListener('click', () => this._setHistoryView('cal'));
    if (btnArchive) btnArchive.addEventListener('click', () => this._toggleArchiveView());

    // ── Calendar year navigation ──
    const prevYr = document.getElementById('pwa-cal-year-prev');
    const nextYr = document.getElementById('pwa-cal-year-next');
    if (prevYr) prevYr.addEventListener('click', () => { this._calDate.setFullYear(this._calDate.getFullYear() - 1); this.renderCalendarView(); });
    if (nextYr) nextYr.addEventListener('click', () => { this._calDate.setFullYear(this._calDate.getFullYear() + 1); this.renderCalendarView(); });

    // ── History list filters ──
    ['pwa-filter-year', 'pwa-filter-month', 'pwa-filter-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { if (this._historyView === 'list') this.renderListView(); });
    });

    // ── Day popup dismiss ──
    const dayOverlay = document.getElementById('pwa-day-popup-overlay');
    if (dayOverlay) dayOverlay.addEventListener('click', e => {
      if (e.target === dayOverlay) this.closeDayPopup();
    });

    const url = this.settings?.webappUrl;
    const token = this.settings?.secretKey;
    const main = document.getElementById('fab-circle');
    const rightNav = document.getElementById('right-nav-btn');


    if (!url || !token) {
      this.log('Missing API credentials. Rerouting to Settings view.');
      this.switchTab('settings'); // Force UI focus onto settings tab
      this.toggleNewVisitModal(false); // Hide the modal screen so it doesn't mask the view
      if (welcome) {
        welcome.style.opacity = '0';
        welcome.style.visibility = 'hidden';
        setTimeout(() => { welcome.style.display = 'none'; }, 400);
      }
      this._showToast('⚠️ Please configure your WebApp URL and Secret Key.');
      return; // STOP execution loop completely to block unreachable fetch requests!
    }

    // Load backend network data safely wrapped to isolate connectivity errors
    try {
      await this.loadLocations();
      await this.renderHistory();
      await this.updateQueueUI();
      // Flush any visits queued from previous offline session
      this.syncPendingVisits();
    } catch (err) {
      this.log('Network sync postponed: ' + err.message);
      this._showToast('Offline fallback active. Data will sync when connected.');
    } finally {
      if (rightNav) rightNav.classList.remove('rotate');
      if (welcome) {
        welcome.style.opacity = '0';
        welcome.style.visibility = 'hidden';
        setTimeout(() => { welcome.style.display = 'none'; }, 400);
      }
    }

    // Determine the visibility profile of the modal sheet safely
    if (!this.activeVisit) {
      this.toggleNewVisitModal(true);
    } else {
      this.toggleNewVisitModal(false);
    }

    this.log('Ready.');
  }

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => this.log('[SW] Registered'))
        .catch(e => this.log('[SW] Failed: ' + e.message));
    }
  }

  // ──────────────────────────────────────────────────────────
  //  THEME
  // ──────────────────────────────────────────────────────────
  applyTheme(theme) {
    this._currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('mavis_theme', theme);
    } catch (_) { }
    const moon = document.getElementById('icon-moon');
    const sun = document.getElementById('icon-sun');
    if (moon) moon.style.display = theme === 'dark' ? 'block' : 'none';
    if (sun) sun.style.display = theme === 'light' ? 'block' : 'none';
  }

  toggleTheme() {
    this.applyTheme(this._currentTheme === 'dark' ? 'light' : 'dark');
  }

  // ──────────────────────────────────────────────────────────
  //  TABS
  // ──────────────────────────────────────────────────────────
  switchTab(tabId) {
    // Hide all tab screens safely
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const tab = document.getElementById(`tab-${tabId}`);
    if (tab) tab.classList.add('active');

    // Direct Navigation Routing Matrix
    if (tabId === 'sync') {
      if (typeof this.renderHistory === 'function') this.renderHistory();
      this.updateNavbarLayout('SYNC');
    } else if (tabId === 'settings') {
      this.updateNavbarLayout('SETTINGS');
      this.loadSettings();
      // Ensure the active settings sub-panel's icons are rendered
      const activePanel = document.querySelector('.settings-panel.active');
      if (activePanel) this._refreshIcons(activePanel);
      // Refresh locations list if on that tab
      const locPanel = document.getElementById('set-panel-locations');
      if (locPanel?.classList.contains('active')) this.renderLocationsList();
    } else if (tabId === 'record') {
      if (typeof this._refreshLinkedVisitDropdown === 'function') this._refreshLinkedVisitDropdown();

      // Evaluate active visit constraints before choosing the view mode
      if (!this.activeVisit) {
        this.updateNavbarLayout('VISIT_SETUP');
      } else {
        const cardInner0 = document.getElementById('card-inner-0');
        const isFlipped = cardInner0 && cardInner0.classList.contains('flipped');
        this.updateNavbarLayout(isFlipped ? 'AID_EDIT' : 'AUTO');
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SETTINGS
  // ──────────────────────────────────────────────────────────
  loadSettings() {
    try {
      const saved = localStorage.getItem('mavis_settings');
      if (saved) {
        this.settings = JSON.parse(saved);
      }
    } catch (_) {
      this.log('Failed to parse local settings string.');
    }

    // Hardened Fallback Guard: strictly ensures settings object and keys are valid
    if (!this.settings) this.settings = {};
    if (!this.settings.webappUrl) this.settings.webappUrl = '';
    if (!this.settings.secretKey) this.settings.secretKey = '';
    if (!this.settings.frequentPlaces || !this.settings.frequentPlaces.length) {
      this.settings.frequentPlaces = this.defaultFrequentPlaces || [];
    }

    // Unify category naming
    this.settings.frequentPlaces = this.settings.frequentPlaces.map(loc => ({
      ...loc,
      category: loc.category || loc.default_category || 'Other'
    }));

    // Recalculate distances based on the office location on load
    this.recalculateDistances();

    // Safely update the DOM elements if they exist in the current tab view
    const urlEl = document.getElementById('set-webapp-url');
    const keyEl = document.getElementById('set-secret-key');

    if (urlEl) urlEl.value = this.settings.webappUrl;
    if (keyEl) keyEl.value = this.settings.secretKey;
  }

  saveSettings() {
    const url = (document.getElementById('set-webapp-url')?.value || '').trim();
    const key = (document.getElementById('set-secret-key')?.value || '').trim();

    let db = this.settings.frequentPlaces;
    try {
      const raw = document.getElementById('set-frequent-db')?.value;
      if (raw) db = JSON.parse(raw);
    } catch (_) {
      alert('Invalid JSON in Locations Database — please fix and try again.');
      return;
    }

    this.settings = { webappUrl: url, secretKey: key, frequentPlaces: db };
    localStorage.setItem('mavis_settings', JSON.stringify(this.settings));
    this.log('Settings saved: ' + url);
    this._showToast('✅ Settings saved!');

    // Reload locations with new settings
    this.loadLocations();
  }

  _showToast(msg) {
    let toast = document.getElementById('settings-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'settings-toast';
      toast.className = 'settings-toast';
      document.querySelector('.app-container')?.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  resetFrequentPlaces() {
    if (!confirm('Restore default sample locations?')) return;
    this.settings.frequentPlaces = [...this.defaultFrequentPlaces];
    localStorage.setItem('mavis_settings', JSON.stringify(this.settings));
    this.renderLocationsList();
    this._showToast('✅ Sample locations restored!');
  }

  // ── Settings Tab Switcher ─────────────────────────────────
  switchSettingsTab(tab) {
    // Update pill buttons
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `set-tab-${tab}`);
      btn.setAttribute('aria-selected', btn.id === `set-tab-${tab}` ? 'true' : 'false');
    });

    // Show/hide panels (use display:none → display:flex via class)
    document.querySelectorAll('.settings-panel').forEach(panel => {
      const isTarget = panel.id === `set-panel-${tab}`;
      panel.classList.toggle('active', isTarget);
      if (isTarget) panel.style.display = '';
      else panel.style.display = 'none';
    });

    // Refresh icons in the newly shown panel
    const panel = document.getElementById(`set-panel-${tab}`);
    if (panel) this._refreshIcons(panel);

    // Render locations list whenever that tab becomes visible
    if (tab === 'locations') this.renderLocationsList();
  }

  _getDistanceMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(1));
  }

  recalculateDistances() {
    const locs = this.settings.frequentPlaces || [];
    const office = locs.find(loc => (loc.category || loc.default_category || '').toLowerCase() === 'office');
    if (!office) return;
    locs.forEach(loc => {
      if ((loc.category || loc.default_category || '').toLowerCase() === 'visit') {
        loc.distance_from_home = this._getDistanceMiles(office.lat, office.lng, loc.lat, loc.lng);
      }
    });
  }

  // ── Targeted Save to Google Sheet ────────────────────────
  async saveLocationToServer(loc, oldName = null) {
    const { webappUrl: url, secretKey: token } = this.settings;
    if (!url) return;
    try {
      const res = await fetch(`${url}?action=save_location&token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ location: loc, oldName })
      });
      const data = await res.json();
      if (data.success) {
        this.log(`[Locations] Synced "${loc.name}" to Google Sheet.`);
      } else {
        this.log(`[Locations] Sync "${loc.name}" rejected: ${data.message}`);
      }
    } catch (e) {
      this.log(`[Locations] Sync "${loc.name}" network error: ${e.message}`);
    }
  }

  // ── Targeted Delete from Google Sheet ────────────────────
  async deleteLocationFromServer(name) {
    const { webappUrl: url, secretKey: token } = this.settings;
    if (!url) return;
    try {
      const res = await fetch(`${url}?action=delete_location&token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.success) {
        this.log(`[Locations] Deleted "${name}" from Google Sheet.`);
      } else {
        this.log(`[Locations] Delete "${name}" rejected: ${data.message}`);
      }
    } catch (e) {
      this.log(`[Locations] Delete "${name}" network error: ${e.message}`);
    }
  }

  // ── Sync distances for all visit locations ────────────────
  async syncAllDistancesToServer() {
    const locs = this.settings.frequentPlaces || [];
    for (const loc of locs) {
      if ((loc.category || loc.default_category || '').toLowerCase() === 'visit') {
        await this.saveLocationToServer(loc);
      }
    }
  }

  // ── Toggle the Add Location card ─────────────────────────
  toggleAddLocation() {
    const card = document.getElementById('loc-add-card');
    if (card) card.classList.toggle('open');
    const addBody = document.getElementById('loc-add-body');
    if (addBody) this._refreshIcons(addBody);
  }

  // ── Render: 3-zone locations layout ──────────────────────
  renderLocationsList() {
    const officeSlot = document.getElementById('loc-office-slot');
    const container = document.getElementById('locations-list');
    if (!officeSlot || !container) return;

    const locs = this.settings.frequentPlaces || [];
    const office = locs.find(l => (l.category || l.default_category || '').toLowerCase() === 'office');
    const others = locs.filter(l => (l.category || l.default_category || '').toLowerCase() !== 'office');

    // ── Zone 1: Office card ──────────────────────────────────
    officeSlot.innerHTML = '';
    if (office) {
      const officeIdx = locs.indexOf(office);
      officeSlot.appendChild(this._buildLocationCard(office, officeIdx));
      this._refreshIcons(officeSlot);
    } else {
      officeSlot.innerHTML = `<div style="text-align:center; padding:0.5rem 0; font-size:0.78rem; color:var(--text-muted); font-style:italic;">No office location set</div>`;
    }

    // ── Zone 3: Scrollable non-office cards ─────────────────
    container.innerHTML = '';
    if (!others.length) {
      container.innerHTML = '<div class="empty-state">No visit locations yet.</div>';
    } else {
      others.forEach(loc => {
        const idx = locs.indexOf(loc);
        container.appendChild(this._buildLocationCard(loc, idx));
      });
      this._refreshIcons(container);
    }
  }

  // ── Build a single collapsible location card ──────────────
  _buildLocationCard(loc, index) {
    const isOffice = (loc.category || loc.default_category || '').toLowerCase() === 'office';

    // ── Outer card wrapper (flip scene) ──────────────────────
    const card = document.createElement('div');
    card.className = `location-card flippable${isOffice ? ' office' : ''}`;
    card.dataset.locIndex = index;

    // ── Inner flipper (rotates) ───────────────────────────────
    const flipper = document.createElement('div');
    flipper.className = 'loc-card-flipper';

    // ══════════════════════════════════════════════════════════
    //  FRONT FACE
    // ══════════════════════════════════════════════════════════
    const frontFace = document.createElement('div');
    frontFace.className = 'loc-card-front';

    // — Summary row ——————————————————————————————————————————
    const summary = document.createElement('div');
    summary.className = 'loc-card-summary';
    summary.innerHTML = `
      <div class="location-card-info">
        <div class="location-card-name">
          ${this._escHTML(loc.name)}
          ${isOffice ? '<span class="office-badge">HQ Office</span>' : ''}
        </div>
        <div class="location-card-meta">
          <span class="location-card-tag">
            <svg data-lucide="navigation" width="10" height="10"></svg>
            ${loc.lat?.toFixed(4) ?? '—'}, ${loc.lng?.toFixed(4) ?? '—'}
          </span>
          ${!isOffice && loc.distance_from_home != null ? `<span class="location-card-tag">
            <svg data-lucide="milestone" width="10" height="10"></svg>
            ${loc.distance_from_home} mi
          </span>` : ''}
          <span class="location-card-tag">
            <svg data-lucide="circle-dot" width="10" height="10"></svg>
            ${loc.radius ?? 100}m
          </span>
        </div>
      </div>
      <svg data-lucide="chevron-down" class="loc-chevron" width="14" height="14"></svg>
    `;

    // — Edit body —————————————————————————————————————————————
    const editView = document.createElement('div');
    editView.className = 'loc-card-edit';
    const cat = loc.category || loc.default_category || 'visit';
    editView.innerHTML = `
      <div class="btn-row" >
        <input type="text" class="form-control loc-edit-name" value="${this._escHTML(loc.name)}" placeholder="Name">
      </div>

      <div class="btn-row" >
        <select class="form-control loc-edit-category">
          <option value="visit"  ${cat === 'visit' ? 'selected' : ''}>Visit</option>
          <option value="office" ${cat === 'office' ? 'selected' : ''}>Office</option>
          <option value="Other"  ${cat === 'Other' ? 'selected' : ''}>Other</option>
        </select>
      </div>

      <div class="btn-row" >
        <input type="number" class="form-control loc-edit-lat" value="${loc.lat ?? ''}" placeholder="Latitude" step="0.00001" style="flex:1;">
        <input type="number" class="form-control loc-edit-lng" value="${loc.lng ?? ''}" placeholder="Longitude" step="0.00001" style="flex:1;">
        <button class="form-control" title="Use GPS" onclick="app.getDeviceGPS(this)" style="width: 100px; flex-grow:0;">
          <svg data-lucide="locate" width="15" height="15"></svg>
        </button>
        </div>
      <input type="number" style="display: none;" class="form-control loc-edit-radius" value="${loc.radius ?? 100}" placeholder="Radius (m)">

      <div class="loc-edit-actions">
         <button class="btn btn-outline loc-delete-btn">
          <svg data-lucide="trash-2" width="15" height="15"></svg>
        </button>

        <button class="btn btn-primary loc-save-btn">
          Update
        </button>
     
        <button class="btn btn-outline loc-flip-btn" id="loc-flip-to-back" type="button" title="View visit history">
          <svg data-lucide="flip-horizontal-2" width="15" height="15"></svg>
          
        </button>
      </div>
    `;

    frontFace.appendChild(summary);
    frontFace.appendChild(editView);

    // ══════════════════════════════════════════════════════════
    //  BACK FACE  (lazy-built on first flip)
    // ══════════════════════════════════════════════════════════
    const backFace = document.createElement('div');
    backFace.className = 'loc-card-back';
    let backBuilt = false;
    let isBackCollapsed = false;

    // Helper: applies the current collapse state to back-face elements
    const applyBackCollapse = (histList, summaryLine, collapseBtn) => {
      if (isBackCollapsed) {
        histList.style.display = 'none';
        summaryLine.style.display = 'flex';
        collapseBtn.innerHTML = `<svg data-lucide="chevron-down" width="12" height="12"></svg>`;
        collapseBtn.title = 'Expand history';
      } else {
        histList.style.display = '';
        summaryLine.style.display = 'none';
        collapseBtn.innerHTML = `<svg data-lucide="chevron-up" width="12" height="12"></svg>`;
        collapseBtn.title = 'Collapse history';
      }
      this._refreshIcons(backFace);
    };

    const buildBack = (showArchived = false) => {
      backFace.innerHTML = '';
      const history = this._buildLocationVisitHistory(loc, showArchived);

      // Compute summary stats for the collapsed view
      const allGroups = this._groupByVisit(this._allRows || [], this._allVisits || []);
      const locGroups = allGroups.filter(g => !g.isVirtual &&
        (g.destination || '').trim().toLowerCase() === (loc.name || '').trim().toLowerCase());
      const visitCount = locGroups.length;
      const totalMiles = locGroups.reduce((sum, g) => sum + (parseFloat(g.distance_miles) || 0), 0);

      // ── Back-face header ─────────────────────────────────────
      const backHeader = document.createElement('div');
      backHeader.className = 'loc-visit-back-header';

      const backTitle = document.createElement('span');
      backTitle.className = 'loc-visit-back-title';
      backTitle.textContent = loc.name;

      // Summary line (visible only when collapsed)
      const summaryLine = document.createElement('div');
      summaryLine.className = 'loc-back-summary-line';
      summaryLine.innerHTML = `
        <svg data-lucide="map-pin" width="11" height="11"></svg>
        ${visitCount} visit${visitCount !== 1 ? 's' : ''}· ${totalMiles.toFixed(1)} mi
      `;

      // Collapse / expand toggle
      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'loc-back-collapse-btn';
      collapseBtn.type = 'button';
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isBackCollapsed = !isBackCollapsed;
        applyBackCollapse(history, summaryLine, collapseBtn);
      });

      const archiveToggle = document.createElement('button');
      archiveToggle.className = `loc-archive-toggle-btn${showArchived ? ' active' : ''}`;
      archiveToggle.type = 'button';
      archiveToggle.innerHTML = `<svg data-lucide="archive" width="11" height="11"></svg> Archived`;
      archiveToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        buildBack(!showArchived);
      });

      const flipBackBtn = document.createElement('button');
      flipBackBtn.className = 'loc-flip-btn';
      flipBackBtn.type = 'button';
      flipBackBtn.title = 'Back to edit';
      flipBackBtn.innerHTML = `<svg data-lucide="flip-horizontal-2" width="13" height="13"></svg>`;
      flipBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Animate height from back face back to front face, then unflip
        const backH = backFace.offsetHeight;
        const frontH = frontFace.offsetHeight;
        flipper.style.height = backH + 'px';
        card.classList.remove('flip-complete');
        flipper.offsetHeight; // force reflow
        flipper.style.transition = 'transform 0.55s cubic-bezier(0.45, 0.05, 0.55, 0.95), height 0.55s cubic-bezier(0.45, 0.05, 0.55, 0.95)';
        flipper.style.height = frontH + 'px';
        card.classList.remove('flipped');
        const onEnd = (ev) => {
          if (ev.propertyName !== 'transform') return;
          flipper.style.height = '';
          flipper.style.transition = '';
          flipper.removeEventListener('transitionend', onEnd);
        };
        flipper.addEventListener('transitionend', onEnd);
      });

      backHeader.appendChild(backTitle);
      backHeader.appendChild(summaryLine);
      backHeader.appendChild(collapseBtn);
      backHeader.appendChild(archiveToggle);
      backHeader.appendChild(flipBackBtn);
      backFace.appendChild(backHeader);
      backFace.appendChild(history);
      backBuilt = true;

      // Restore the current collapse state on newly built content
      applyBackCollapse(history, summaryLine, collapseBtn);
    };

    // ── Flip-to-back button ───────────────────────────────────
    editView.querySelector('#loc-flip-to-back').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!backBuilt) buildBack(false);

      // Measure both faces before the animation starts
      const frontH = frontFace.offsetHeight;
      const backH = backFace.offsetHeight;

      // Lock height and kick off the flip
      flipper.style.transition = 'transform 0.55s cubic-bezier(0.45, 0.05, 0.55, 0.95), height 0.55s cubic-bezier(0.45, 0.05, 0.55, 0.95)';
      flipper.style.height = frontH + 'px';
      card.classList.add('flipped');
      this._refreshIcons(backFace);

      // Animate height toward back face simultaneously
      flipper.offsetHeight; // force reflow
      flipper.style.height = backH + 'px';

      // Once settled: hand layout control to the back face
      const onEnd = (ev) => {
        if (ev.propertyName !== 'transform') return;
        card.classList.add('flip-complete');
        flipper.style.height = '';
        flipper.style.transition = '';
        flipper.removeEventListener('transitionend', onEnd);
      };
      flipper.addEventListener('transitionend', onEnd);
    });

    // ── Assemble flipper ──────────────────────────────────────
    flipper.appendChild(frontFace);
    flipper.appendChild(backFace);
    card.appendChild(flipper);

    // — Toggle expand/collapse (front face only) ──────────────
    summary.addEventListener('click', () => {
      const wasOpen = card.classList.contains('expanded');
      // Close any other open cards first
      document.querySelectorAll('.location-card.expanded').forEach(c => c.classList.remove('expanded'));
      if (!wasOpen) {
        card.classList.add('expanded');
        this._refreshIcons(editView);
      }
    });

    // — Save ──────────────────────────────────────────────────
    editView.querySelector('.loc-save-btn').addEventListener('click', e => {
      e.stopPropagation();
      this.updateLocation(index, {
        name: editView.querySelector('.loc-edit-name').value.trim(),
        lat: parseFloat(editView.querySelector('.loc-edit-lat').value),
        lng: parseFloat(editView.querySelector('.loc-edit-lng').value),
        radius: parseFloat(editView.querySelector('.loc-edit-radius').value) || 100,
        category: editView.querySelector('.loc-edit-category').value,
      });
    });

    // — Delete ────────────────────────────────────────────────
    editView.querySelector('.loc-delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      this.removeLocation(index);
    });

    return card;
  }

  // ── Build Location Visit History for Card Flip ────────────
  _buildLocationVisitHistory(loc, showArchived) {
    const listContainer = document.createElement('div');
    listContainer.className = 'loc-visit-back-list';

    // Get all grouped visits
    const allGroups = this._groupByVisit(this._allRows || [], this._allVisits || []);

    // Filter to those matching this location's name
    const locGroups = allGroups.filter(g => !g.isVirtual && (g.destination || '').trim().toLowerCase() === (loc.name || '').trim().toLowerCase());

    const filteredGroups = [];
    locGroups.forEach(g => {
      // Clone group to not modify global cache
      const groupCopy = { ...g, expenses: [...g.expenses] };
      if (showArchived) {
        // Show ONLY archived expenses for this visit
        groupCopy.expenses = groupCopy.expenses.filter(e => (e.archive || '').toLowerCase() === 'yes');
      } else {
        // Show ONLY non-archived expenses for this visit
        groupCopy.expenses = groupCopy.expenses.filter(e => (e.archive || '').toLowerCase() !== 'yes');
      }

      // Only include this visit if it has expenses, or has a distance (non-zero mileage visit)
      if (groupCopy.expenses.length > 0 || (parseFloat(groupCopy.distance_miles) || 0) > 0) {
        filteredGroups.push(groupCopy);
      }
    });

    if (filteredGroups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'loc-visit-back-empty';
      empty.textContent = showArchived ? 'No archived visits here.' : 'No active visits here.';
      listContainer.appendChild(empty);
    } else {
      filteredGroups.forEach(g => {
        const grpEl = this._buildHistoryGroup(g);
        // Automatically expand the content inside the flipper history group
        const content = grpEl.querySelector('.history-group-content');
        if (content) content.classList.add('open');
        listContainer.appendChild(grpEl);
      });
    }

    return listContainer;
  }

  // ── Propagate Location Rename to Visits ────────────────────
  async _propagateLocationRename(oldName, newName) {
    this.log(`Propagating location rename: "${oldName}" -> "${newName}"`);
    let count = 0;

    // 1. Update in-memory visits
    if (Array.isArray(this._allVisits)) {
      this._allVisits.forEach(v => {
        if ((v.destination || '').trim().toLowerCase() === oldName.trim().toLowerCase()) {
          v.destination = newName;
          count++;
          // Sync this updated visit to the server
          this._syncVisitUpdate(v);
        }
      });
    }

    // 2. Update active visit if it matches
    if (this.activeVisit && (this.activeVisit.destination || '').trim().toLowerCase() === oldName.trim().toLowerCase()) {
      this.activeVisit.destination = newName;
      localStorage.setItem('mavis_active_visit', JSON.stringify(this.activeVisit));
      this._renderVisitBar();
    }

    // 3. Update pending visits queue in localStorage
    try {
      const pendingVisits = JSON.parse(localStorage.getItem('mavis_pending_visits') || '[]');
      if (Array.isArray(pendingVisits)) {
        let changed = false;
        pendingVisits.forEach(v => {
          if ((v.destination || '').trim().toLowerCase() === oldName.trim().toLowerCase()) {
            v.destination = newName;
            changed = true;
          }
        });
        if (changed) {
          localStorage.setItem('mavis_pending_visits', JSON.stringify(pendingVisits));
        }
      }
    } catch (_) { }

    if (count > 0) {
      this._showToast(`Updated destination on ${count} visit(s).`);
      // Re-render history view to show updated names
      await this.renderHistory();
    }
  }

  // ── Sync Renamed Visit to Server ───────────────────────────
  async _syncVisitUpdate(v) {
    const { webappUrl: url, secretKey: token } = this.settings;
    if (!url) return;
    const vId = v.visit_id || v.id;
    if (!vId) return;

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'log_visit',
          token,
          visit_id: vId,
          date: v.date,
          destination: v.destination,
          distance_miles: v.distance_miles || v.distanceMiles || 0,
          status: v.status || 'Open'
        })
      });
    } catch (err) {
      this.log(`Failed to sync renamed visit ${vId}: ${err.message}`);
    }
  }

  // ── Update an existing location ───────────────────────────
  async updateLocation(index, data) {
    const locs = this.settings.frequentPlaces || [];
    if (!locs[index]) return;

    if (!data.name) { this._showToast('⚠️ Name is required.'); return; }
    if (isNaN(data.lat) || isNaN(data.lng)) { this._showToast('⚠️ Valid coordinates required.'); return; }

    const oldName = locs[index].name;

    // Office replacement guard
    if (data.category === 'office') {
      const existing = locs.find((l, i) => (l.category || l.default_category || '').toLowerCase() === 'office' && i !== index);
      if (existing) {
        const replace = confirm(`"${existing.name}" is already the office. Replace it?`);
        if (!replace) return;
        existing.category = 'Other';
        await this.saveLocationToServer(existing);
      }
    }

    Object.assign(locs[index], data);
    const isOfficeUpdate = data.category === 'office' || (oldName === locs.find(l => (l.category || l.default_category || '').toLowerCase() === 'office')?.name);

    this.recalculateDistances();
    localStorage.setItem('mavis_settings', JSON.stringify(this.settings));

    // Propagate name change to visits if destination changed
    if (data.name !== oldName) {
      await this._propagateLocationRename(oldName, data.name);
    }

    this.renderLocationsList();
    this._populateDestSel(this.settings.frequentPlaces);
    this._showToast(`✅ "${data.name}" updated!`);

    // Sync specifically this location
    await this.saveLocationToServer(locs[index], oldName);

    // If the office changed or was updated, sync all visit distances as well
    if (isOfficeUpdate) {
      await this.syncAllDistancesToServer();
    }
  }

  // ── Add Location from Form ────────────────────────────────
  async addLocationFromForm() {
    const name = document.getElementById('loc-name')?.value.trim();
    const lat = parseFloat(document.getElementById('loc-lat')?.value);
    const lng = parseFloat(document.getElementById('loc-lng')?.value);
    const radius = parseFloat(document.getElementById('loc-radius')?.value) || 100;
    const category = document.getElementById('loc-category')?.value.trim();

    if (!name) { this._showToast('⚠️ Location name is required.'); return; }
    if (isNaN(lat) || isNaN(lng)) { this._showToast('⚠️ Valid latitude and longitude are required.'); return; }

    if (!this.settings.frequentPlaces) this.settings.frequentPlaces = [];

    // Office duplication guard
    if (category === 'office') {
      const existingOffice = this.settings.frequentPlaces.find(l => (l.category || l.default_category || '').toLowerCase() === 'office');
      if (existingOffice) {
        const replace = confirm(`"${existingOffice.name}" is already the office. Replace it?`);
        if (!replace) return;
        existingOffice.category = 'Other';
        await this.saveLocationToServer(existingOffice);
      }
    }

    const newLoc = { name, lat, lng, radius, category, distance_from_home: 0 };
    this.settings.frequentPlaces.push(newLoc);
    this.recalculateDistances();
    localStorage.setItem('mavis_settings', JSON.stringify(this.settings));

    // Collapse the add card and clear fields
    document.getElementById('loc-add-card')?.classList.remove('open');
    ['loc-name', 'loc-lat', 'loc-lng'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const radiusEl = document.getElementById('loc-radius');
    if (radiusEl) radiusEl.value = '100';

    this.renderLocationsList();
    this._populateDestSel(this.settings.frequentPlaces);
    this._showToast(`✅ "${name}" added!`);

    // Sync specifically this new location
    await this.saveLocationToServer(newLoc);

    // If we added an office, sync all visit distances as well
    if (category === 'office') {
      await this.syncAllDistancesToServer();
    }
  }

  // ── Remove Location ───────────────────────────────────────
  async removeLocation(index) {
    const locs = this.settings.frequentPlaces || [];
    const targetLoc = locs[index];
    if (!targetLoc) return;

    // Check if there are any visits associated with this location
    const allGroups = this._groupByVisit(this._allRows || [], this._allVisits || []);
    const hasVisits = allGroups.some(g => !g.isVirtual && (g.destination || '').trim().toLowerCase() === (targetLoc.name || '').trim().toLowerCase());

    if (hasVisits) {
      this._showToast(`⚠️ Cannot delete "${targetLoc.name}" because it has associated visits.`);
      return;
    }

    const removed = locs.splice(index, 1)[0];
    this.recalculateDistances();
    localStorage.setItem('mavis_settings', JSON.stringify(this.settings));
    this.renderLocationsList();
    this._populateDestSel(this.settings.frequentPlaces);
    if (removed) {
      this._showToast(`🗑 "${removed.name}" removed.`);
      await this.deleteLocationFromServer(removed.name);
    }
  }

  // ── Get Device GPS with Fallback ──────────────────────────
  getDeviceGPS(btnEl) {
    let latEl = document.getElementById('loc-lat');
    let lngEl = document.getElementById('loc-lng');

    if (btnEl) {
      const card = btnEl.closest('.location-card');
      if (card) {
        const editLat = card.querySelector('.loc-edit-lat');
        const editLng = card.querySelector('.loc-edit-lng');
        if (editLat && editLng) {
          latEl = editLat;
          lngEl = editLng;
        }
      }
    }

    if (!navigator.geolocation) {
      this._showToast('⚠️ GPS not supported. Trying IP fallback...');
      this.getIPGeolocation(latEl, lngEl);
      return;
    }

    this._showToast('📍 Getting GPS fix...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (latEl) latEl.value = pos.coords.latitude.toFixed(6);
        if (lngEl) lngEl.value = pos.coords.longitude.toFixed(6);
        this._showToast(`📍 GPS: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
      },
      err => {
        this.log(`[GPS] Error: ${err.message}. Trying IP fallback...`);
        this._showToast('📍 GPS blocked. Using IP location fallback...');
        this.getIPGeolocation(latEl, lngEl);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // ── IP Geolocation Fallback ──────────────────────────────
  async getIPGeolocation(latEl, lngEl) {
    try {
      const res = await fetch('https://ipapi.co/json/');
      const data = await res.json();
      if (data.latitude && data.longitude) {
        if (latEl) latEl.value = data.latitude.toFixed(6);
        if (lngEl) lngEl.value = data.longitude.toFixed(6);
        this._showToast(`📍 IP location (approx): ${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}`);
      } else {
        this._showToast('⚠️ IP location fallback failed.');
      }
    } catch (e) {
      this._showToast('⚠️ IP location network error.');
    }
  }

  async loadLocations() {
    const { webappUrl: url, secretKey: token } = this.settings;

    // Always seed from local defaults first so the selector is never empty
    const localPlaces = this.settings.frequentPlaces?.length
      ? this.settings.frequentPlaces
      : this.defaultFrequentPlaces;
    this.locations = localPlaces;
    this._populateDestSel(localPlaces);

    // Then try to fetch from backend and override
    if (url) {
      try {
        const res = await fetch(`${url}?action=get_locations&token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (data.success && data.locations?.length) {
          // Map default_category to category and normalize to lowercase
          this.locations = data.locations.map(loc => {
            const rawCat = (loc.default_category || loc.category || 'Other').trim().toLowerCase();
            return {
              ...loc,
              category: rawCat === 'office' ? 'office' : (rawCat === 'visit' ? 'visit' : 'Other')
            };
          });

          this.settings.frequentPlaces = this.locations;
          this.recalculateDistances();
          localStorage.setItem('mavis_settings', JSON.stringify(this.settings));
          this._populateDestSel(this.locations);
          this.log(`Locations loaded from sheet: ${this.locations.length}`);
        }
      } catch (_) {
        this.log('Locations fetch failed — using local defaults.');
      }
    }

    // Refresh the locations panel if it's currently visible
    if (document.getElementById('set-panel-locations')?.classList.contains('active')) {
      this.renderLocationsList();
    }
  }

  _populateDestSel(locs) {
    const sel = document.getElementById('visit-destination');
    if (!sel) return;
    const prev = sel.value; // preserve selection across refreshes
    sel.innerHTML = '<option value="">Start New Visit</option>';
    locs.forEach(loc => {
      const mi = loc.distance_from_home || 0;
      const opt = document.createElement('option');
      opt.value = loc.name;
      opt.dataset.distance = mi;
      opt.textContent = mi > 0 ? `${loc.name}  (${mi} mi)` : loc.name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }

  // ──────────────────────────────────────────────────────────
  //  VISIT BAR RENDER
  // ──────────────────────────────────────────────────────────
  _renderVisitBar() {
    const bar = document.getElementById('visit-bar-active');
    if (!bar) return;

    // The bar is now permanently visible across all application states
    bar.style.display = 'flex';

    // Target internal DOM nodes safely
    const destSpan = document.getElementById('vbar-destination');
    const dateSpan = document.getElementById('vbar-date');
    const idSpan = document.getElementById('vbar-id');
    const statusText = document.getElementById('vbar-status');
    const btnEnd = document.getElementById('btn-end-visit');
    if (idSpan) idSpan.style.display = 'none';

    // ── STATE 1: ORPHAN MODE (No active or past visit selected) ──
    if (!this.activeVisit) {
      if (destSpan) destSpan.textContent = 'Orphan';
      if (dateSpan) dateSpan.textContent = 'Expenses are not linked to any visit';
      if (statusText) statusText.textContent = 'Unlinked';

      // Unique Alert Styling: Gives a clean, warning/empty state aesthetic
      bar.style.borderBottom = '1px solid var(--border-glow)';
      bar.style.background = '';
      bar.style.display = 'none';

      // Transform the main action button into a gateway to the modal
      if (btnEnd) {
        btnEnd.textContent = 'Start Visit';
        btnEnd.className = 'btn btn-primary';
        btnEnd.onclick = () => this.toggleNewVisitModal(true);
      }
      return; // Exit early to avoid evaluating object configurations
    }

    // Populate foundational strings shared by both active and historical records
    if (destSpan) destSpan.textContent = this.activeVisit.destination || 'Unknown';
    if (dateSpan) dateSpan.textContent = formatDateFriendly(this.activeVisit.date);
    if (idSpan) {
      idSpan.textContent = this.activeVisit.id;
    }

    // ── STATE 2: PAST VISIT MODE (Morphed Context) ──
    if (this.activeVisit.isPast) {
      bar.style.borderBottom = '2px solid gray';
      bar.style.background = '';
      bar.style.boxShadow = 'var(--shadow-sm)';
      if (statusText) statusText.textContent = 'Past Visit';


      if (btnEnd) {
        btnEnd.textContent = 'Clear Visit';
        btnEnd.className = 'btn';
        btnEnd.onclick = () => this.logAsOrphan();
      }
    }
    // ── STATE 3: STANDARD ACTIVE VISIT MODE ──
    else {

      bar.style.background = 'transparent';
      bar.style.border = 'none';
      if (statusText) statusText.textContent = 'Open';


      if (btnEnd) {
        btnEnd.textContent = 'End Visit';
        btnEnd.className = 'btn btn-primary';
        btnEnd.onclick = () => this.endVisit();
      }
    }

    // Keep the carousel in sync whenever active visit changes
    this._rebuildCardTrack();
  }


  _updateFab() {
    const fab = document.getElementById('fab-circle');
    if (!fab) return;
    fab.style.background = this.activeVisit
      ? 'linear-gradient(135deg, hsla(0, 0%, 100%, 1.00), hsla(257, 95%, 8%, 1.00))'  //when active
      : 'linear-gradient(135deg, hsl(161,84%,48%), hsl(161,84%,36%))'; // when idle
  }


  logAsOrphan() {
    // 1. Clear Active Context entirely
    this.activeVisit = null;
    localStorage.removeItem('mavis_active_visit');

    // 2. Hide Visit Bar
    const bar = document.getElementById('visit-bar-active');
    if (bar) bar.style.display = 'flex';

    // 3. Clear Expense Form Dropdown
    const sel = document.getElementById('log-select-visit');
    if (sel) sel.value = '';

    // 4. Close Modal
    this._renderVisitBar();
    this.toggleNewVisitModal(false); // <--- CLOSES MODAL
    this._showToast('Logging without a visit context.');
  }

  // ──────────────────────────────────────────────────────────
  //  START VISIT
  // ──────────────────────────────────────────────────────────

  startVisit() {
    const dateEl = document.getElementById('visit-date');
    const destEl = document.getElementById('visit-destination');
    let date = dateEl?.value;
    const dest = destEl?.value;

    if (!date) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      date = `${yyyy}-${mm}-${dd}`;

      if (dateEl) {
        dateEl.value = date;
      }
    }

    if (!dest) {
      destEl?.focus();
      try { if (typeof destEl.showPicker === 'function') destEl.showPicker(); } catch (e) { }
      this.log('Missing destination: Please select a destination.');
      this._showToast('Please select a destination.');
      return;
    }

    const selectedOpt = destEl.options[destEl.selectedIndex];
    const distMiles = parseFloat(selectedOpt?.dataset.distance) || 0;

    // Generate Formatted Context ID
    const dateParts = date.split('-');
    const year2 = dateParts[0].slice(-2);
    const monthInt = parseInt(dateParts[1], 10);
    const dayInt = parseInt(dateParts[2], 10);
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const monthAbbr = monthNames[monthInt - 1] || 'UNK';
    const datePart = `${dayInt}${monthAbbr}${year2}`;
    const prefix = `VIS_${datePart}_`;

    let maxIdx = 0;
    if (this.visits && Array.isArray(this.visits)) {
      this.visits.forEach(v => {
        const vid = v.visit_id || v.id || '';
        if (vid.startsWith(prefix)) {
          const num = parseInt(vid.substring(prefix.length), 10);
          if (!isNaN(num) && num > maxIdx) maxIdx = num;
        }
      });
    }

    let pendingVisits = [];
    try { pendingVisits = JSON.parse(localStorage.getItem('mavis_pending_visits') || '[]'); } catch (_) { }
    if (Array.isArray(pendingVisits)) {
      pendingVisits.forEach(v => {
        const vid = v.id || v.visit_id || '';
        if (vid.startsWith(prefix)) {
          const num = parseInt(vid.substring(prefix.length), 10);
          if (!isNaN(num) && num > maxIdx) maxIdx = num;
        }
      });
    }

    if (this.activeVisit && this.activeVisit.id && this.activeVisit.id.startsWith(prefix)) {
      const num = parseInt(this.activeVisit.id.substring(prefix.length), 10);
      if (!isNaN(num) && num > maxIdx) maxIdx = num;
    }

    const visitId = prefix + (maxIdx + 1);

    // Set Active Context object (isPast: false)
    this.activeVisit = {
      id: visitId, date, destination: dest, distanceMiles: distMiles,
      status: 'Open', isPast: false
    };
    localStorage.setItem('mavis_active_visit', JSON.stringify(this.activeVisit));

    this._renderVisitBar();
    this._queueVisit(this.activeVisit);
    this.log(`Visit started: ${dest} (${formatDateFriendly(date)}) with ID ${visitId}`);
    this._showToast(`📍 Visit started: ${dest}`);

    this.updateNavbarLayout('AUTO');
    this.toggleNewVisitModal(false); // <--- CLOSES PATHWAY 1

  }




  // ──────────────────────────────────────────────────────────
  //  END VISIT
  // ──────────────────────────────────────────────────────────
  endVisit() {
    if (!confirm('End this visit? It will be marked Closed.')) return;
    if (this.activeVisit) {
      this.activeVisit.status = 'Closed';
      this._queueVisit(this.activeVisit);
    }
    this.activeVisit = null;
    localStorage.removeItem('mavis_active_visit');

    this._renderVisitBar();
    this._pastVisitsLoaded = false;
    this.log('Visit ended and marked Closed.');
    this._showToast('Visit closed.');

    // Force call creation interface overlay back open to establish continuous flow
    this.toggleNewVisitModal(true);
  }

  // ──────────────────────────────────────────────────────────
  //  PAST VISITS TOGGLE (inactive visit bar)
  // ──────────────────────────────────────────────────────────


  async loadPastVisits() {
    const { webappUrl: url, secretKey: token } = this.settings;
    const sel = document.getElementById('visit-select-past');
    if (!sel) return;

    sel.innerHTML = '<option value="">Loading Visits...</option>';

    if (!url) {
      this.log('No WebApp URL — cannot load past visits.');
      sel.innerHTML = '<option value="">No WebApp URL</option>';
      return;
    }

    try {
      const res = await fetch(`${url}?action=get_visits&token=${encodeURIComponent(token)}`);
      const data = await res.json();

      if (data.success && data.visits?.length) {
        this.visits = data.visits.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        sel.innerHTML = '<option value="">Select from History</option>';

        this.visits.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.visit_id || v.id || '';

          // This is your original logic, kept simple to ensure it doesn't break
          const status = (v.status || '').toLowerCase();
          const statusLabel = (status === 'open') ? ' - Open' : '';
          opt.textContent = `${formatDateFriendly(v.date)} — ${v.destination || ''} ${statusLabel}`;

          sel.appendChild(opt);
        });

        this._pastVisitsLoaded = true;
        this.log(`Past visits loaded: ${this.visits.length}`);
      }
    } catch (err) {
      this.log('Could not load past visits: ' + err.message);
      sel.innerHTML = '<option value="">Server Failed, Poor Network</option>';
    }
  }

  selectPastVisit(visitId) {
    if (!visitId) return;

    // Find detailed records matching the requested reference ID
    let pastVisit = this.visits?.find(v => (v.visit_id || v.id) === visitId);
    if (!pastVisit) {
      pastVisit = { id: visitId, destination: 'Past Record', date: new Date().toISOString().split('T')[0] };
    }

    // a. Update reference context configuration containing the dynamic past flag
    this.activeVisit = {
      id: visitId,
      date: pastVisit.date || pastVisit.visit_date,
      destination: pastVisit.destination || pastVisit.location,
      distanceMiles: parseFloat(pastVisit.distanceMiles || pastVisit.distance) || 0,
      status: 'Closed',
      isPast: true // <--- FLAG DRIVING THE CUSTOM STRUCTURAL VIEW SWAP
    };
    localStorage.setItem('mavis_active_visit', JSON.stringify(this.activeVisit));

    // Align master mapping dropdown inside log application forms
    const sel = document.getElementById('log-select-visit');
    if (sel) {
      sel.value = visitId;
      if (typeof this._updateLinkedVisitDisplay === 'function') {
        this._updateLinkedVisitDisplay();
      }
    }

    // b. Refresh rendering profile to handle custom structural styles
    this._renderVisitBar();
    this.updateNavbarLayout('AUTO');
    // c. Dismiss the modal window layer
    this.toggleNewVisitModal(false); // <--- CLOSES PATHWAY 2
    this._showToast('Working in historical visit view mode.');
  }




  // ──────────────────────────────────────────────────────────
  //  LINKED VISIT DROPDOWN (inside expense form)
  // ──────────────────────────────────────────────────────────
  async _refreshLinkedVisitDropdown() {
    const sel = document.getElementById('log-select-visit');
    if (!sel) return;

    const { webappUrl: url, secretKey: token } = this.settings;
    if (url && !this._pastVisitsLoaded) {
      try {
        const res = await fetch(`${url}?action=get_visits&token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (data.success && data.visits?.length) {
          this.visits = data.visits.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
          this._pastVisitsLoaded = true;
        }
      } catch (_) { }
    }

    // Remember current selection
    const prev = sel.value;
    sel.innerHTML = '<option value="">-- Select a visit --</option>';

    // Active visit always at the top
    if (this.activeVisit) {
      const opt = document.createElement('option');
      opt.value = this.activeVisit.id;
      opt.textContent = `📍 ${this.activeVisit.destination}  ${formatDateFriendly(this.activeVisit.date)}  [Active]`;
      sel.appendChild(opt);
    }

    // Past visits from backend
    this.visits.forEach(v => {
      const vId = v.visit_id || v.id;
      if (this.activeVisit && vId === this.activeVisit.id) return;
      const opt = document.createElement('option');
      opt.value = vId;
      opt.textContent = `${v.destination || '—'}  ${formatDateFriendly(v.date)}  [${v.status || 'Open'}]`;
      sel.appendChild(opt);
    });

    // Restore selection or default to active visit
    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
    } else if (this.activeVisit) {
      sel.value = this.activeVisit.id;
    }

    this._updateLinkedVisitDisplay();
  }

  onLinkedVisitChange() {
    this._updateLinkedVisitDisplay();
  }

  _updateLinkedVisitDisplay() {
    const sel = document.getElementById('log-select-visit');
    const disp = document.getElementById('linked-visit-display');
    if (!sel || !disp) return;
    const opt = sel.options[sel.selectedIndex];
    disp.textContent = opt?.text || '—';
  }

  // ──────────────────────────────────────────────────────────
  //  VISIT QUEUE + BACKEND SYNC
  // ──────────────────────────────────────────────────────────
  _queueVisit(visit) {
    let queue = [];
    try { queue = JSON.parse(localStorage.getItem('mavis_pending_visits') || '[]'); } catch (_) { }
    queue = queue.filter(v => v.id !== visit.id);
    queue.push(visit);
    localStorage.setItem('mavis_pending_visits', JSON.stringify(queue));
    this.syncPendingVisits(); // fire and forget
  }

  async syncPendingVisits() {
    const { webappUrl: url, secretKey: token } = this.settings;
    if (!url) {
      this.log('Visit sync skipped: WebApp URL not set.');
      return;
    }

    let queue = [];
    try { queue = JSON.parse(localStorage.getItem('mavis_pending_visits') || '[]'); } catch (_) { }
    if (!queue.length) return;

    this.log(`Attempting to sync ${queue.length} pending visit(s)…`);
    const remaining = [];
    for (const v of queue) {
      const vId = v.id || v.visit_id;
      if (!vId) {
        this.log(`Skipping queued visit with no ID: ${JSON.stringify(v)}`);
        continue;
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            action: 'log_visit',
            token,
            visit_id: vId,
            date: v.date,
            destination: v.destination,
            distance_miles: v.distanceMiles || 0,
            status: v.status || 'Open'
          })
        });
        const data = await res.json();
        if (data.success) {
          this.log(`Visit synced: ${v.destination} [${v.status}] (ID: ${vId})`);
        } else {
          this.log(`Visit sync failed: ${data.message}`);
          remaining.push(v);
        }
      } catch (err) {
        this.log(`Visit sync network/CORS error: ${err.message}`);
        remaining.push(v);
      }
    }
    localStorage.setItem('mavis_pending_visits', JSON.stringify(remaining));
  }



  // ── AI Toggle State ──
  toggleAiMode(isAuto) {
    this.aiAutomation = isAuto;
    this.log(`AI Mode switched to: ${isAuto ? 'AUTO' : 'AID'}`);

    // AID mode → flip card-0 to form face; AUTO mode → flip back to front
    this.expenseMode(!isAuto);
  }

  expenseMode(forceOpen = false) {
    const cardInner = document.getElementById('card-inner-0');
    if (!cardInner) return;
    const isFlipped = cardInner.classList.contains('flipped');
    if (forceOpen && isFlipped) return;
    this.inEditMode = forceOpen || !isFlipped;
    if (this.inEditMode) {
      cardInner.classList.add('flipped');
      this.updateNavbarLayout('AID_EDIT');
    } else {
      cardInner.classList.remove('flipped');
      this.updateNavbarLayout('AUTO');
    }
  }

  // ── Card Flip Helper ──
  flipCard(idx, toBack) {
    const cardInner = document.getElementById(`card-inner-${idx}`);
    if (cardInner) cardInner.classList.toggle('flipped', toBack);
  }

  // ── Visit colour palette ──
  _visitColor(idx) {
    const palette = [
      'hsl(258, 70%, 62%)',
      'hsl(161, 75%, 42%)',
      'hsl(38,  95%, 55%)',
      'hsl(205, 80%, 55%)',
      'hsl(340, 72%, 58%)',
      'hsl(280, 60%, 58%)',
      'hsl(15,  88%, 56%)',
    ];
    return palette[idx % palette.length];
  }

  // ── Visit-specific gradient backdrop ──
  _visitGradient(idx) {
    const hues = [258, 161, 38, 205, 340, 280, 15];
    const h = hues[idx % hues.length];
    return `linear-gradient(135deg, hsl(${h}, 50%, 20%) 0%, hsl(${(h + 30) % 360}, 40%, 8%) 100%)`;
  }

  // ── Destination-wide visit groups ──
  _getDestinationVisitGroups() {
    const dest = (this.activeVisit?.destination || '').trim().toLowerCase();
    if (!dest) return [];
    const activeId = this.activeVisit?.id;
    const seenIds = new Set();
    const candidates = [];

    if (Array.isArray(this._allVisits)) {
      this._allVisits.forEach(v => {
        const vId = v.visit_id || v.id;
        if (!vId) return;
        if ((v.destination || '').trim().toLowerCase() === dest) {
          seenIds.add(vId);
          candidates.push({ id: vId, destination: v.destination, date: v.date, status: v.status || 'Open' });
        }
      });
    }

    if (this._visitMap) {
      Object.entries(this._visitMap).forEach(([vId, v]) => {
        if (seenIds.has(vId)) return;
        if ((v.destination || '').trim().toLowerCase() === dest) {
          seenIds.add(vId);
          candidates.push({ id: vId, destination: v.destination, date: v.date, status: v.status || 'Open' });
        }
      });
    }

    if (activeId && !seenIds.has(activeId)) {
      candidates.push({ id: activeId, destination: this.activeVisit.destination, date: this.activeVisit.date, status: this.activeVisit.status || 'Open' });
    }

    candidates.sort((a, b) => {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
      return new Date(b.date || 0) - new Date(a.date || 0);
    });

    return candidates.map((v, colorIdx) => ({
      ...v,
      colorIdx,
      color: this._visitColor(colorIdx),
      expenses: (this._allRows || []).filter(e => e.visit_id === v.id),
    }));
  }

  // ── Carousel track builder ──
  _rebuildCardTrack() {
    const track = document.getElementById('card-track');
    if (!track) return;

    while (track.children.length > 1) track.lastElementChild.remove();

    const visitGroups = this._getDestinationVisitGroups();
    this._cardVisitGroups = visitGroups;
    this._cardExpenses = visitGroups.flatMap(g => g.expenses);

    let globalCardIdx = 0;
    visitGroups.forEach(group => {
      group.expenses.forEach(exp => {
        globalCardIdx++;
        const cardIdx = globalCardIdx;
        const card = document.createElement('div');
        card.className = 'expense-card';
        card.setAttribute('data-card-index', cardIdx);
        card.setAttribute('data-expense-id', exp.id);

        // Image fades in on successful load; hidden on error so gradient fallback shows
        const imgUrl = exp.receipt_url || exp.image_base64 || '';
        const imageHtml = imgUrl
          ? `<img src="${imgUrl}" class="expense-card-img" onload="this.classList.add('loaded')" onerror="this.classList.add('error')" alt="Receipt">`
          : '';

        const isActive = group.id === this.activeVisit?.id;
        const visitBadge = `<span class="exp-visit-badge" style="background:${group.color}">${isActive ? 'Current Visit' : formatDateFriendly(group.date)}</span>`;
        const gradient = this._visitGradient(group.colorIdx);
        const vendorInitial = (exp.vendor || 'N').charAt(0).toUpperCase();
        const notesHtml = exp.notes
          ? `<div class="fallback-notes-bubble" style="border-left-color:${group.color}">“${exp.notes}”</div>` : '';

        card.innerHTML = `
          <div class="card-inner" id="card-inner-${cardIdx}">
            <div class="card-face card-front" style="border:2.5px solid ${group.color};background:${gradient};">
              ${imageHtml}
              <div class="fallback-card-content">
                <div class="fallback-card-header">
                  <div class="fallback-vendor-circle" style="background:${group.color}25;border:1.5px solid ${group.color};color:${group.color};">${vendorInitial}</div>
                  <div class="fallback-category-pill" style="border-color:${group.color}80;color:${group.color};">${exp.category || 'Other'}</div>
                </div>
                <div class="fallback-card-body">
                  <div class="fallback-amount-large">£${parseFloat(exp.amount || 0).toFixed(2)}</div>
                  <div class="fallback-vendor-large">${exp.vendor || 'No Vendor'}</div>
                  ${notesHtml}
                </div>
                <div class="fallback-card-footer">
                  <div class="fallback-date-badge">
                    <svg data-lucide="calendar" width="12" height="12"></svg>
                    <span>${formatDateFriendly(exp.date)}</span>
                  </div>
                </div>
              </div>
              <div class="expense-card-overlay">
                ${visitBadge}
                <div class="expense-card-amount">£${parseFloat(exp.amount || 0).toFixed(2)}</div>
                <div class="expense-card-vendor">${exp.vendor || 'No Vendor'}</div>
                <div class="expense-card-category">${exp.category || 'Other'}</div>
              </div>
              <button type="button" class="expense-card-flip-btn" onclick="app.flipCard(${cardIdx}, true)" title="View Details">
                <svg data-lucide="info" width="18" height="18"></svg>
              </button>
            </div>
            <div class="card-face card-back" style="border:2.5px solid ${group.color};">
              <div class="expense-card-detail-back">
                <div class="expense-detail-close" onclick="app.flipCard(${cardIdx}, false)">
                  <svg data-lucide="x" width="18" height="18"></svg>
                </div>
                <div class="detail-visit-tag" style="background:${group.color}22;border:1px solid ${group.color};color:${group.color};">
                  ${group.destination} · ${formatDateFriendly(group.date)} · ${group.status}
                </div>
                <div class="detail-row" style="margin-bottom:.5rem">
                  <div class="detail-label">Amount</div>
                  <div class="detail-amount">£${parseFloat(exp.amount || 0).toFixed(2)}</div>
                </div>
                <div class="detail-row">
                  <div class="detail-label">Vendor</div>
                  <div class="detail-value">${exp.vendor || 'Manual Entry'}</div>
                </div>
                <div class="detail-row">
                  <div class="detail-label">Category</div>
                  <div class="detail-value">${exp.category || 'Other'}</div>
                </div>
                <div class="detail-row">
                  <div class="detail-label">Date</div>
                  <div class="detail-value">${formatDateFriendly(exp.date)}</div>
                </div>
                <div class="detail-row" style="flex-grow:1">
                  <div class="detail-label">Notes</div>
                  <div class="detail-value" style="font-style:italic;white-space:pre-wrap">${exp.notes || 'No notes.'}</div>
                </div>
              </div>
            </div>
          </div>`;
        track.appendChild(card);
      });
    });

    if (typeof lucide !== 'undefined') {
      lucide.createIcons({ attrs: { stroke: 'currentColor', 'stroke-width': '2' }, nameAttr: 'data-lucide', root: track });
    }

    this._buildDotsOnce();
    this._initSwipe();
    this._scrollToCard(this._cardIndex || 0, true);
  }

  // ── Build dots once — CSS transitions remain alive between updates ──
  _buildDotsOnce() {
    const dotsContainer = document.getElementById('card-dots');
    if (!dotsContainer) return;
    dotsContainer.innerHTML = '';

    const dot0 = document.createElement('div');
    dot0.className = 'card-dot';
    dot0.dataset.dotIndex = '0';
    dot0.style.setProperty('--dot-color', 'var(--text-muted)');
    dot0.onclick = () => this._scrollToCard(0);
    dotsContainer.appendChild(dot0);

    const groups = this._cardVisitGroups || [];
    let globalDotIdx = 0;

    groups.forEach(group => {
      if (!group.expenses.length) return;
      const sep = document.createElement('div');
      sep.className = 'card-dot-sep';
      dotsContainer.appendChild(sep);

      group.expenses.forEach(() => {
        globalDotIdx++;
        const cardPos = globalDotIdx;
        const dot = document.createElement('div');
        dot.className = 'card-dot';
        dot.dataset.dotIndex = String(cardPos);
        dot.style.setProperty('--dot-color', group.color);
        dot.onclick = () => this._scrollToCard(cardPos);
        dotsContainer.appendChild(dot);
      });
    });

    this._updateActiveDot();
  }

  // ── Toggle active dot only — no DOM teardown keeps CSS transitions alive ──
  _updateActiveDot() {
    const dotsContainer = document.getElementById('card-dots');
    if (!dotsContainer) return;
    dotsContainer.querySelectorAll('.card-dot').forEach(dot => {
      const idx = parseInt(dot.dataset.dotIndex, 10);
      dot.classList.toggle('active', idx === this._cardIndex);
    });
  }

  // ── Live card scale & opacity from fractional scroll progress ──
  _updateCardTransforms(currentX) {
    const track = document.getElementById('card-track');
    if (!track) return;
    const cardWidth = track.parentElement
      ? track.parentElement.getBoundingClientRect().width
      : window.innerWidth;
    if (!cardWidth) return;
    const progress = -currentX / cardWidth;
    track.querySelectorAll('.expense-card').forEach((card, idx) => {
      const diff = Math.abs(idx - progress);
      const scale  = Math.max(0.88, 1 - Math.min(1, diff) * 0.12);
      const opacity = Math.max(0.4,  1 - Math.min(1, diff) * 0.6);
      card.style.transform = `scale(${scale.toFixed(4)})`;
      card.style.opacity   = opacity.toFixed(4);
    });
  }

  // ── Snap Scroll ──
  _scrollToCard(idx, immediate = false) {
    const track = document.getElementById('card-track');
    if (!track) return;

    const maxIdx = this._cardExpenses.length;
    idx = Math.max(0, Math.min(idx, maxIdx));
    this._cardIndex = idx;

    const cardWidth = track.parentElement
      ? track.parentElement.getBoundingClientRect().width
      : window.innerWidth;

    const targetX = -idx * cardWidth;

    if (immediate) {
      track.style.transition = 'none';
      track.style.transform = `translateX(${targetX}px)`;
      this._updateCardTransforms(targetX);
      track.offsetHeight; // force reflow
      track.style.transition = '';
    } else {
      track.style.transform = `translateX(${targetX}px)`;
      this._updateCardTransforms(targetX);
    }

    this._updateActiveDot();
  }

  // ── Swipe / Drag ──
  _initSwipe() {
    const track = document.getElementById('card-track');
    if (!track) return;

    // Remove old listeners by cloning (cheapest approach)
    const fresh = track.cloneNode(true);
    track.parentNode.replaceChild(fresh, track);
    const t = document.getElementById('card-track');

    let isDragging = false;
    let hasMoved = false;
    let startX = 0;
    let startTime = 0;
    let currentTranslate = 0;
    let capturedPointerId = null;

    const getCardWidth = () =>
      t.parentElement ? t.parentElement.getBoundingClientRect().width : window.innerWidth;

    const getTranslateX = () => {
      const style = window.getComputedStyle(t);
      const matrix = new WebKitCSSMatrix(style.transform);
      return matrix.m41;
    };

    const endDrag = (clientX) => {
      if (!isDragging) return;
      isDragging = false;
      t.classList.remove('dragging');

      const deltaX = clientX - startX;
      const elapsed = Date.now() - startTime;
      const cardWidth = getCardWidth();
      const velocity = Math.abs(deltaX) / elapsed;
      const isSwipe = velocity > 0.3 || Math.abs(deltaX) > cardWidth * 0.3;

      let targetIndex = this._cardIndex;
      if (isSwipe) {
        if (deltaX < 0) {
          targetIndex = Math.min(this._cardExpenses.length, this._cardIndex + 1);
        } else {
          targetIndex = Math.max(0, this._cardIndex - 1);
        }
      }
      this._scrollToCard(targetIndex);
    };

    t.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // Only block actual text-input controls (not buttons or forms — they are fine for swipe)
      const tag = e.target.tagName.toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag)) return;

      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startTime = Date.now();
      currentTranslate = getTranslateX();
    });

    t.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - startX;

      if (!hasMoved && Math.abs(deltaX) > 6) {
        hasMoved = true;
        t.classList.add('dragging');
        // Capture pointer now that we're sure it's a drag
        try { t.setPointerCapture(e.pointerId); capturedPointerId = e.pointerId; } catch (_) { }
      }

      if (!hasMoved) return;
      e.preventDefault();
      const cardWidth = getCardWidth();
      const maxTranslate = 0;
      const minTranslate = -(this._cardExpenses.length) * cardWidth;
      let newTranslate = currentTranslate + deltaX;
      newTranslate = Math.max(minTranslate - cardWidth * 0.15, Math.min(maxTranslate + cardWidth * 0.15, newTranslate));
      t.style.transition = 'none';
      t.style.transform = `translateX(${newTranslate}px)`;

      // Live-update card scale/opacity and active dot during drag
      this._updateCardTransforms(newTranslate);
      const dragProgress = -newTranslate / cardWidth;
      const liveIdx = Math.max(0, Math.min(this._cardExpenses.length, Math.round(dragProgress)));
      if (this._cardIndex !== liveIdx) {
        this._cardIndex = liveIdx;
        this._updateActiveDot();
      }
    }, { passive: false });

    t.addEventListener('pointerup', (e) => {
      if (hasMoved && capturedPointerId !== null) {
        try { t.releasePointerCapture(capturedPointerId); } catch (_) { }
        capturedPointerId = null;
      }
      endDrag(e.clientX);
    });

    t.addEventListener('pointercancel', (e) => {
      if (capturedPointerId !== null) {
        try { t.releasePointerCapture(capturedPointerId); } catch (_) { }
        capturedPointerId = null;
      }
      endDrag(e.clientX);
    });

    // Block click-through if user was dragging
    t.addEventListener('click', (e) => {
      if (hasMoved) e.stopPropagation();
    }, true);
  }

  // ── Modal Controller ──
  toggleNewVisitModal(show) {
    // This targets your form container (formerly a modal, now the inline screen panel)
    const visitSection = document.getElementById('new-visit');

    if (show) {
      // 1. Make sure the user is on the record tab where the form lives
      if (this.currentTab !== 'record') {
        this.switchTab('record');
      }

      // 2. Display the inline form section
      if (visitSection) {
        visitSection.style.display = 'flex';
      }

      // 3. Keep your reliable trigger to populate the past visits dropdown menu
      if (typeof this.loadPastVisits === 'function') {
        this.loadPastVisits();
      }

      // 4. Turn the bottom navigation bar into the Setup Control Panel
      this.updateNavbarLayout('VISIT_SETUP');

    } else {
      // 1. Hide the inline visit form section since a visit is active or bypassed
      if (visitSection) {
        visitSection.style.display = 'none';
      }

      // 2. Revert the bottom navigation bar back to standard camera tracking mode
      this.updateNavbarLayout('AUTO');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  RECEIPT IMAGE SELECTION (AI First)
  // ──────────────────────────────────────────────────────────
  async _onReceiptSelected(file) {
    if (!file) return;
    const label = document.getElementById('receipt-label-text');
    const overlay = document.getElementById('ai-shimmer-overlay');

    if (label) label.textContent = 'Compressing…';

    try {
      this._pendingReceiptBase64 = await compressImage(file);
      const sizeKb = Math.round(this._pendingReceiptBase64.length / 1024);

      const preview = document.getElementById('receipt-preview');
      const wrap = document.getElementById('receipt-preview-wrap');
      if (preview) preview.src = this._pendingReceiptBase64;
      if (wrap) wrap.style.display = 'block';

      // Start Shimmer & Process
      if (overlay) overlay.style.display = 'flex';
      this.log(`Processing receipt via AI (${sizeKb} KB)...`);

      const { webappUrl: url, secretKey: token } = this.settings;

      // If offline or no URL, we skip AI and just keep the base64 for legacy upload
      if (!url || !navigator.onLine) {
        throw new Error("Offline or no backend URL. AI unavailable.");
      }

      // Call Backend 'process_receipt'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'process_receipt', token, image_base64: this._pendingReceiptBase64 })
      });

      const data = await res.json();

      if (data.success && data.ai_data) {
        const ai = data.ai_data;
        // Save the generated Drive URL so we don't need step 2
        this._currentReceiptUrl = data.receipt_url || '';
        this._pendingReceiptBase64 = ''; // Clear base64 so legacy upload doesn't run

        // Populate DOM
        if (ai.amount) document.getElementById('exp-amount').value = ai.amount;
        if (ai.vendor) document.getElementById('exp-vendor').value = ai.vendor;
        if (ai.description) document.getElementById('exp-notes').value = ai.description;
        if (ai.category) {
          const catEl = document.getElementById('exp-category');
          if ([...catEl.options].some(o => o.value === ai.category)) catEl.value = ai.category;
        }

        // Handle Visit Match
        if (data.suggested_visit_id) {
          const visitSel = document.getElementById('log-select-visit');
          if (visitSel && [...visitSel.options].some(o => o.value === data.suggested_visit_id)) {
            visitSel.value = data.suggested_visit_id;
            this.onLinkedVisitChange();
          }
        }

        if (overlay) overlay.style.display = 'none';

        // ── Dynamic AI Toast ──
        // Build lines shown one after another in a stacked toast
        const hasAmount = ai.amount && parseFloat(ai.amount) > 0;
        const hasVendor = !!ai.vendor;
        const hasGps = !!(ai.gps_lat && ai.gps_lng);
        const hasVisit = !!data.suggested_visit_id;

        const lines = [];
        if (hasAmount && hasVendor) {
          lines.push(`✨ £${parseFloat(ai.amount).toFixed(2)} · ${ai.vendor}`);
        } else if (hasAmount) {
          lines.push(`✨ Amount: £${parseFloat(ai.amount).toFixed(2)}`);
        } else if (hasVendor) {
          lines.push(`✨ Vendor: ${ai.vendor}`);
        } else {
          lines.push('✨ Receipt analysed — fields partially filled');
        }
        lines.push(hasGps ? '📍 Location data found from photo' : '📍 No GPS in photo');
        if (hasVisit) lines.push(`🔗 Matched to existing visit`);

        this._showAiToast(lines, 'success');

        // ── AUTOMATION CHECK ──
        if (this.aiAutomation) {
          this.log('AI Automation is ON. Auto-saving expense...');
          // Trigger the save sequence programmatically
          this.saveExpense(new Event('submit'));
        }
      } else if (data.success && !data.ai_data) {
        // Backend responded OK but AI found no receipt content
        if (overlay) overlay.style.display = 'none';
        if (label) label.textContent = 'Photo saved — please fill in details manually.';
        this._showAiToast(['🖼️ Image not recognised as a receipt', 'Please fill in the details manually.'], 'warning');
      } else {
        throw new Error(data.message || 'AI could not read the receipt.');
      }

    } catch (err) {
      if (overlay) overlay.style.display = 'none';
      const isOffline = !navigator.onLine || err.message.toLowerCase().includes('offline');
      if (label) label.textContent = isOffline ? '📵 Offline — fill in manually.' : '⚠️ AI Failed — fill in manually.';
      this.log('Pre-processing failed: ' + err.message);
      this._showAiToast(
        isOffline
          ? ['📵 You are offline', 'AI extraction unavailable — fill in details manually.']
          : ['⚠️ AI could not read this image', 'Please fill in the details manually.'],
        isOffline ? 'info' : 'error'
      );
      // Failsafe: leave _pendingReceiptBase64 intact so legacy step-2 upload runs later
    }
  }

  removeReceipt() {
    this._pendingReceiptBase64 = '';
    this.updateNavbarLayout('AUTO');
    this._currentReceiptUrl = '';
    const input = document.getElementById('exp-receipt');
    if (input) input.value = '';
    const wrap = document.getElementById('receipt-preview-wrap');
    if (wrap) wrap.style.display = 'none';
    const overlay = document.getElementById('ai-shimmer-overlay');
    if (overlay) overlay.style.display = 'none';
    const label = document.getElementById('receipt-label-text');
    if (label) label.textContent = 'Tap to add photo';
  }

  // ──────────────────────────────────────────────────────────
  //  SAVE EXPENSE
  // ──────────────────────────────────────────────────────────
  async saveExpense(e) {
    if (e && e.preventDefault) e.preventDefault();

    const category = document.getElementById('exp-category').value;
    const amount = parseFloat(document.getElementById('exp-amount').value) || 0;
    const vendor = (document.getElementById('exp-vendor').value || '').trim() || 'Manual Entry';
    const notes = (document.getElementById('exp-notes').value || '').trim();

    const selVisit = document.getElementById('log-select-visit');
    let visit_id = selVisit?.value || '';
    if (!visit_id && this.activeVisit) visit_id = this.activeVisit.id;

    if (!visit_id) {
      alert('Every expense must be linked to a visit. Please start a visit or select a visit first.');
      return;
    }

    let destination = '';
    let date = new Date().toISOString().split('T')[0];
    if (visit_id && this.activeVisit && visit_id === this.activeVisit.id) {
      destination = this.activeVisit.destination;
      date = this.activeVisit.date;
    } else if (visit_id) {
      const v = this.visits.find(x => (x.visit_id || x.id) === visit_id);
      if (v) {
        destination = v.destination || '';
        if (v.date) date = v.date;
      }
    }

    const id = this.editingExpenseId || ('EXP_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    const sync_action = this.editingExpenseId ? 'update' : 'create';
    const timestamp = new Date().toISOString();

    // Check if we have an image waiting for offline legacy upload
    const hasPendingImage = !!this._pendingReceiptBase64;
    const imageToUpload = this._pendingReceiptBase64;


    const record = {
      id, timestamp, date, visit_id, destination, category,
      amount: amount.toFixed(2),
      vendor, notes, distance: '0.00',
      receipt_url: this._currentReceiptUrl || '', // Directly attach the URL if AI got it
      image_base64: '',
      status: 'pending', sync_action,
      receipt_pending: hasPendingImage // Only true if AI failed/offline
    };

    // Clean up memory
    this._pendingReceiptBase64 = '';
    this._currentReceiptUrl = '';

    await dbPut(STORE_EXPENSES, record);
    await dbPut(STORE_HISTORY, { ...record });

    document.getElementById('expense-form-details').reset();
    this.removeReceipt();
    if (this.editingExpenseId) this.cancelEdit();

    await this.renderHistory();
    await this.updateQueueUI();

    // Only switch to sync tab if NOT in automation mode
    if (!this.aiAutomation) {
      this.switchTab('sync');
    }



    // Sync Metadata (which now includes the receipt_url)
    const synced = await this.syncSingleExpense(record);

    // Fallback: If AI failed earlier (offline), we trigger the legacy Step 2 upload now
    if (hasPendingImage && synced) {
      await this._uploadReceipt(id, imageToUpload);
    } else if (hasPendingImage && !synced) {
      const hist = await dbGet(STORE_HISTORY, id);
      if (hist) await dbPut(STORE_HISTORY, { ...hist, _receipt_b64_retry: imageToUpload });
    }

    await this.renderHistory();
    await this.updateQueueUI();
  }

  // ── Sync single expense metadata ──────────────────────────
  async syncSingleExpense(record) {
    const { webappUrl: url, secretKey: token } = this.settings;
    if (!url) {
      this.log('[Expense] Sync skipped: WebApp URL not set.');
      return false;
    }

    this.log(`[Expense] Syncing metadata for ${record.vendor || 'Expense'} (£${record.amount})…`);
    try {
      const payload = { ...record, image_base64: '' }; // never send image here
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ token, logs: [payload] })
      });

      this.log(`[Expense] Sync response status: ${res.status}`);
      const rawText = await res.text();
      this.log(`[Expense] Raw response body: ${rawText.slice(0, 250)}`);

      let result;
      try {
        result = JSON.parse(rawText);
      } catch (parseErr) {
        this.log(`[Expense] JSON parse error: ${parseErr.message}`);
        return false;
      }

      if (result.success) {
        await dbDelete(STORE_EXPENSES, record.id);
        await dbPut(STORE_HISTORY, { ...record, status: 'synced' });
        this.log(`[Expense] Successfully synced to sheet: ${record.vendor}`);
        return true;
      }
      this.log(`[Expense] Sync rejected by server: ${result.message}`);
      return false;
    } catch (err) {
      this.log(`[Expense] Sync network error: ${err.message}`);
      return false;
    }
  }

  // ── Upload receipt image (Step 2) ─────────────────────────
  async _uploadReceipt(expenseId, image_base64) {
    const { webappUrl: url, secretKey: token } = this.settings;
    if (!url) {
      this.log('[Receipt] Upload skipped: WebApp URL not set.');
      return;
    }
    if (!image_base64) {
      this.log('[Receipt] Upload skipped: no image data.');
      return;
    }

    this.log(`[Receipt] Starting upload for ${expenseId} (Base64 length: ${image_base64.length} chars)…`);
    this._setReceiptStatusEl(expenseId, 'uploading');

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'upload_receipt',
          token,
          expense_id: expenseId,
          image_base64
        })
      });

      this.log(`[Receipt] Upload response status: ${res.status}`);
      const rawText = await res.text();
      this.log(`[Receipt] Raw response body: ${rawText.slice(0, 250)}`);

      let result;
      try {
        result = JSON.parse(rawText);
      } catch (parseErr) {
        this.log(`[Receipt] JSON parse error: ${parseErr.message}`);
        const hist = await dbGet(STORE_HISTORY, expenseId);
        if (hist) await dbPut(STORE_HISTORY, { ...hist, receipt_pending: true, _receipt_b64_retry: image_base64 });
        this._setReceiptStatusEl(expenseId, 'failed');
        return;
      }

      if (result.success) {
        this.log(`[Receipt] Successfully saved to Drive and linked! URL: ${result.receipt_url}`);
        const hist = await dbGet(STORE_HISTORY, expenseId);
        if (hist) await dbPut(STORE_HISTORY, { ...hist, receipt_pending: false, receipt_url: result.receipt_url, _receipt_b64_retry: '' });
        this._setReceiptStatusEl(expenseId, 'done');

        // ── AI Data: pre-fill expense form + auto-select visit ───────
        const ai = result.ai_data;
        if (ai) {
          this.log(`[AI] Extracted — amount: ${ai.amount}, vendor: ${ai.vendor}, date: ${ai.date}, gps: ${ai.gps_lat},${ai.gps_lng}`);

          // Pre-fill form fields only if currently empty
          const amountEl = document.getElementById('exp-amount');
          const vendorEl = document.getElementById('exp-vendor');
          const notesEl = document.getElementById('exp-notes');
          const categoryEl = document.getElementById('exp-category');

          if (amountEl && !amountEl.value && ai.amount) amountEl.value = ai.amount;
          if (vendorEl && !vendorEl.value && ai.vendor) vendorEl.value = ai.vendor;
          if (notesEl && !notesEl.value && ai.description) notesEl.value = ai.description;
          if (categoryEl && ai.category) {
            const opt = [...categoryEl.options].find(o => o.value === ai.category);
            if (opt) categoryEl.value = ai.category;
          }

          // Auto-select matched visit in dropdown
          const suggestedVid = result.suggested_visit_id;
          if (suggestedVid) {
            const visitSel = document.getElementById('log-select-visit');
            if (visitSel) {
              const matchOpt = [...visitSel.options].find(o => o.value === suggestedVid);
              if (matchOpt) {
                visitSel.value = suggestedVid;
                this.onLinkedVisitChange();
                this.log(`[AI] Auto-selected visit: ${suggestedVid}`);
              }
            }
          }

          // Build a friendly toast summary
          const parts = [];
          if (ai.amount) parts.push(`£${parseFloat(ai.amount).toFixed(2)}`);
          if (ai.vendor) parts.push(`at ${ai.vendor}`);
          if (ai.gps_lat) parts.push(`📍 GPS`);
          if (suggestedVid) parts.push(`→ linked to visit`);
          const toastMsg = parts.length ? `✨ AI: ${parts.join(' ')}` : '✨ AI analysis complete';
          this._showAiToast(toastMsg);

          // Switch to record tab so user can review + confirm
          this.switchTab('log');
        }
      } else {
        this.log(`[Receipt] Upload rejected by server: ${result.message}`);
        const hist = await dbGet(STORE_HISTORY, expenseId);
        if (hist) await dbPut(STORE_HISTORY, { ...hist, receipt_pending: true, _receipt_b64_retry: image_base64 });
        this._setReceiptStatusEl(expenseId, 'failed');
      }
    } catch (err) {
      this.log(`[Receipt] Upload network/fetch error: ${err.message}`);
      const hist = await dbGet(STORE_HISTORY, expenseId);
      if (hist) await dbPut(STORE_HISTORY, { ...hist, receipt_pending: true, _receipt_b64_retry: image_base64 });
      this._setReceiptStatusEl(expenseId, 'failed');
    }

    await this.renderHistory();
  }

  _setReceiptStatusEl(expenseId, status) {
    const el = document.getElementById(`receipt-status-${expenseId}`);
    if (!el) return;
    const msgs = { uploading: '⏫ Uploading receipt…', done: '✅ Receipt saved to Drive', failed: '⚠️ Receipt failed — tap Retry' };
    el.textContent = msgs[status] || '';
    el.className = `receipt-status receipt-status--${status}`;
  }

  /**
   * Show a dynamic AI status toast.
   * @param {string|string[]} message - Single string or array of lines.
   * @param {'success'|'warning'|'error'|'info'} type - Visual style variant.
   */
  _showAiToast(message, type = 'success') {
    // Remove any existing AI toast
    const existing = document.getElementById('ai-toast');
    if (existing) existing.remove();

    // Palette per type
    const palettes = {
      success: { bg: 'linear-gradient(135deg, #7c3aed, #4f46e5)', shadow: 'rgba(124,58,237,0.45)', icon: '✨' },
      warning: { bg: 'linear-gradient(135deg, #b45309, #d97706)', shadow: 'rgba(217,119,6,0.45)', icon: '⚠️' },
      error: { bg: 'linear-gradient(135deg, #be123c, #e11d48)', shadow: 'rgba(225,29,72,0.45)', icon: '❌' },
      info: { bg: 'linear-gradient(135deg, #0369a1, #0284c7)', shadow: 'rgba(2,132,199,0.45)', icon: 'ℹ️' },
    };
    const p = palettes[type] || palettes.success;

    // Normalise to array of lines
    const lines = Array.isArray(message) ? message : [message];

    const toast = document.createElement('div');
    toast.id = 'ai-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      top: '72px',
      left: '50%',
      transform: 'translateX(-50%) translateY(0)',
      background: p.bg,
      color: '#fff',
      padding: '0.6rem 1.1rem',
      borderRadius: '1rem',
      fontSize: '0.82rem',
      fontWeight: '600',
      boxShadow: `0 4px 24px ${p.shadow}`,
      zIndex: '9999',
      opacity: '1',
      transition: 'opacity 0.5s ease, transform 0.5s ease',
      maxWidth: '88vw',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.22rem',
      lineHeight: '1.45',
      pointerEvents: 'none',
    });

    // Render each line as its own row
    lines.forEach((line, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        opacity: i === 0 ? '1' : '0.82',
        fontSize: i === 0 ? '0.85rem' : '0.78rem',
        fontWeight: i === 0 ? '700' : '500',
      });
      row.textContent = line;
      toast.appendChild(row);
    });

    document.body.appendChild(toast);

    // Slide in
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    // Fade + slide out after 5 s
    const hideAt = type === 'success' ? 5000 : 6000;
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-8px)';
    }, hideAt);
    setTimeout(() => { toast.remove(); }, hideAt + 600);
  }

  async retryReceiptUpload(expenseId) {
    const hist = await dbGet(STORE_HISTORY, expenseId);
    if (!hist?._receipt_b64_retry) {
      alert('No receipt data to retry. Please re-attach the image and save the expense again.');
      return;
    }
    await this._uploadReceipt(expenseId, hist._receipt_b64_retry);
  }

  // ──────────────────────────────────────────────────────────
  //  SYNC ALL PENDING EXPENSES
  // ──────────────────────────────────────────────────────────
  async syncPendingLogs() {
    if (this._isSyncing) return;
    this._isSyncing = true;
    this._showSyncError(null);

    const { webappUrl: url } = this.settings;
    if (!url) {
      this._showSyncError('No WebApp URL configured. Go to Settings and enter your Apps Script URL.');
      this._isSyncing = false;
      return;
    }

    const pending = await dbGetAll(STORE_EXPENSES);
    if (!pending.length) { this._isSyncing = false; this.log('Nothing to sync.'); return; }

    const syncBtn = document.getElementById('btn-sync-now');
    if (syncBtn) { syncBtn.textContent = `Syncing 0/${pending.length}…`; syncBtn.disabled = true; }

    let successCount = 0;
    const errors = [];

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      if (syncBtn) syncBtn.textContent = `Syncing ${i + 1}/${pending.length}…`;

      const synced = await this.syncSingleExpense(item);
      if (synced) {
        successCount++;
        if (item.receipt_pending && item._receipt_b64_retry) {
          await this._uploadReceipt(item.id, item._receipt_b64_retry);
        }
      } else {
        errors.push(item.vendor || item.id);
      }
    }

    if (errors.length === 0) {
      this.log(`✅ All ${successCount} expense(s) synced.`);
      this._showOnlineBadge(true);
    } else {
      this._showSyncError(`${successCount} synced, ${errors.length} failed: ${errors.join(', ')}`);
    }

    this._isSyncing = false;
    if (syncBtn) { syncBtn.textContent = 'Sync with Google Sheets'; syncBtn.disabled = false; }
    await this.renderHistory();
    await this.updateQueueUI();
  }

  // ──────────────────────────────────────────────────────────
  //  TEST CONNECTION
  // ──────────────────────────────────────────────────────────
  async testConnection() {
    const { webappUrl: url, secretKey: token } = this.settings;
    this._showSyncError(null);

    if (!url) {
      this._showSyncError('No WebApp URL set. Go to Settings first.');
      this.switchTab('settings');
      return;
    }

    this.log('Testing connection…');
    try {
      const res = await fetch(`${url}?action=get_all_logs&token=${encodeURIComponent(token)}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) {
        this._showSyncError('Server returned non-JSON. Check Apps Script deployment and make sure it is set to "Execute as Me" and "Anyone" access.<br><small>' + text.slice(0, 200) + '</small>');
        return;
      }
      if (typeof data.success !== 'undefined') {
        const msg = `✅ Connected!\n\nSheet has ${data.rows?.length ?? 0} expense rows.\nToken: ${data.success ? 'Accepted ✓' : 'Rejected ✗'}`;
        this.log(msg.replace(/\n/g, ' '));
        alert(msg);
      } else {
        this._showSyncError('Unexpected response: ' + JSON.stringify(data).slice(0, 200));
      }
    } catch (err) {
      this._showSyncError('Network error: ' + err.message + '<br>Check the URL and Apps Script deployment.');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  EDIT / DELETE
  // ──────────────────────────────────────────────────────────
  openExpenseForEdit(log) {
    this.editingExpenseId = log.id;
    this.updateNavbarLayout('AID_EDIT');

    document.getElementById('expense-form-title').textContent = 'Edit Expense';

    document.getElementById('exp-category').value = log.category || 'Other';
    document.getElementById('exp-amount').value = log.amount || '';
    document.getElementById('exp-vendor').value = log.vendor || '';
    document.getElementById('exp-notes').value = log.notes || '';

    const sel = document.getElementById('log-select-visit');
    if (sel && log.visit_id) {
      sel.value = log.visit_id;
      this._updateLinkedVisitDisplay();
    }

    this.switchTab('record');
    window.scrollTo(0, 0);
  }

  cancelEdit() {
    this.editingExpenseId = null;
    const form = document.getElementById('expense-form-details');
    if (form) form.reset();
    const title = document.getElementById('expense-form-title');
    if (title) title.textContent = 'New Expense';
    this.removeReceipt();
    this._updateLinkedVisitDisplay();

    // Reset card-0 to front face and scroll back to it
    const cardInner0 = document.getElementById('card-inner-0');
    if (cardInner0) cardInner0.classList.remove('flipped');
    this._cardIndex = 0;
    this._scrollToCard(0, true);
    this.inEditMode = false;
    this.updateNavbarLayout('AUTO');
  }


  deleteCurrentExpense() {
    // a. Clear persistent state contexts entirely
    this.activeVisit = null;
    this.updateNavbarLayout('AUTO')
    localStorage.removeItem('mavis_active_visit');

    // Sync master forms selection inputs
    const sel = document.getElementById('log-select-visit');
    if (sel) {
      sel.value = '';
      if (typeof this._updateLinkedVisitDisplay === 'function') {
        this._updateLinkedVisitDisplay();
      }
    }

    // b. Transform into permanent status indicator profile
    this._renderVisitBar();

    // c. Dismiss the overlay layer frame
    this.toggleNewVisitModal(false); // <--- CLOSES PATHWAY 3
    this.log('Switched tracking mode to Unlinked.');
    this._showToast('Logging entries without a connected visit.');
  }

  async deleteCurrentExpenseOLD() {
    if (!this.editingExpenseId) return;
    if (!confirm('Delete this expense? This cannot be undone.')) return;

    const id = this.editingExpenseId;
    const hist = await dbGet(STORE_HISTORY, id);

    if (hist?.status === 'synced') {
      // Queue a delete sync
      await dbPut(STORE_EXPENSES, { id, sync_action: 'delete', status: 'pending', vendor: hist.vendor || '' });
    } else {
      await dbDelete(STORE_EXPENSES, id);
    }
    await dbDelete(STORE_HISTORY, id);

    this.cancelEdit();
    await this.renderHistory();
    await this.updateQueueUI();
    this.syncPendingLogs();
    this.switchTab('sync');
  }

  // ──────────────────────────────────────────────────────────
  //  HISTORY VIEW CONTROLLER
  // ──────────────────────────────────────────────────────────

  _setHistoryView(view) {
    this._historyView = view;
    const listBtn = document.getElementById('pwa-view-btn-list');
    const calBtn = document.getElementById('pwa-view-btn-cal');
    const listEl = document.getElementById('pwa-view-list');
    const calEl = document.getElementById('pwa-view-calendar');

    if (listBtn) { listBtn.classList.toggle('active', view === 'list'); listBtn.setAttribute('aria-pressed', view === 'list'); }
    if (calBtn) { calBtn.classList.toggle('active', view === 'cal'); calBtn.setAttribute('aria-pressed', view === 'cal'); }
    if (listEl) listEl.style.display = view === 'list' ? 'flex' : 'none';
    if (calEl) calEl.style.display = view === 'cal' ? 'flex' : 'none';

    if (view === 'list') {
      const titleText = document.getElementById('history-title-text');
      if (titleText) titleText.textContent = 'Visit List';
      const calTitle = document.getElementById('calender-title-text');
      if (calTitle) calTitle.textContent = 'Calendar View';
      this.renderListView();
    }
    if (view === 'cal') {
      const listTitle = document.getElementById('history-title-text');
      if (listTitle) listTitle.textContent = 'List View';
      // Exit archive mode if user switches to calendar
      if (this._archiveMode) {
        this._archiveMode = false;
        const archiveBtn = document.getElementById('btn-archive-view');
        if (archiveBtn) archiveBtn.classList.remove('active');
      }
      this.renderCalendarView();
    }
    if (typeof lucide !== 'undefined') this._refreshIcons();
  }

  // ──────────────────────────────────────────────────────────
  //  ARCHIVE VIEW TOGGLE
  // ──────────────────────────────────────────────────────────
  async _toggleArchiveView() {
    const archiveBtn = document.getElementById('btn-archive-view');

    if (this._archiveMode) {
      // ── Exit archive mode ─────────────────────────────────
      this._archiveMode = false;
      if (archiveBtn) archiveBtn.classList.remove('active');
      this._setHistoryView('list');
      return;
    }

    // ── Enter archive mode ────────────────────────────────
    this._archiveMode = true;
    if (archiveBtn) archiveBtn.classList.add('active');

    // Switch to list view first
    this._setHistoryView('list');

    // Fetch all logs INCLUDING archived from server
    const { webappUrl: url, secretKey: token } = this.settings;
    if (url) {
      this._showToast('📦 Loading archived items…');
      try {
        const res = await fetch(`${url}?action=get_all_logs&token=${encodeURIComponent(token)}&include_archived=true`);
        const data = await res.json();
        if (data.success && Array.isArray(data.rows)) {
          this._archivedRows = data.rows
            .filter(r => (r.archive || '').toString().toLowerCase() === 'yes')
            .map(r => ({
              id: r.id || '',
              timestamp: r.timestamp || '',
              date: r.date || '',
              category: r.category || '',
              amount: r.amount || '0',
              vendor: r.vendor_place || r.vendor || '',
              address: r.address || '',
              notes: r.notes || '',
              visit_id: r.visit_id || '',
              status: (r.sync_status || 'Pending').toLowerCase() === 'synced' ? 'synced' : 'pending',
              sync_status: r.sync_status || 'Pending',
              receipt_url: r.receipt_url || '',
              receipt_pending: false,
              rowIndex: r.rowIndex || 0,
              image_base64: '',
              archive: 'Yes'
            }));
        }
      } catch (err) {
        // Fall back to IDB cache if offline
        this.log('Archive fetch failed, using IDB cache: ' + err.message);
        const cached = await dbGetAll(STORE_HISTORY);
        this._archivedRows = cached.filter(r => (r.archive || '').toLowerCase() === 'yes');
      }
    } else {
      // No server — check IDB
      const cached = await dbGetAll(STORE_HISTORY);
      this._archivedRows = cached.filter(r => (r.archive || '').toLowerCase() === 'yes');
    }

    // Re-render list in archive mode
    this.renderListView();
  }

  // ──────────────────────────────────────────────────────────
  //  RENDER HISTORY — main entry point (fetches + dispatches)
  // ──────────────────────────────────────────────────────────
  async renderHistory() {

    const { webappUrl: url, secretKey: token } = this.settings;

    // ── 1. Fetch from Sheets ──────────────────────────────────
    let sheetLogs = [];
    let sheetVisits = [];
    if (url) {
      try {
        const [logsRes, visitsRes] = await Promise.all([
          fetch(`${url}?action=get_all_logs&token=${encodeURIComponent(token)}`),
          fetch(`${url}?action=get_visits&token=${encodeURIComponent(token)}`)
        ]);
        const logsData = await logsRes.json();
        const visitsData = await visitsRes.json();

        if (logsData.success && Array.isArray(logsData.rows)) {
          sheetLogs = logsData.rows
            .filter(r => (r.archive || '').toString().toLowerCase() !== 'yes')
            .map(r => ({
              id: r.id || '',
              timestamp: r.timestamp || '',
              date: r.date || '',
              category: r.category || '',
              amount: r.amount || '0',
              vendor: r.vendor_place || r.vendor || '',
              address: r.address || '',
              notes: r.notes || '',
              visit_id: r.visit_id || '',
              status: (r.sync_status || 'Pending').toLowerCase() === 'synced' ? 'synced' : 'pending',
              sync_status: r.sync_status || 'Pending',
              receipt_url: r.receipt_url || '',
              receipt_pending: false,
              rowIndex: r.rowIndex || 0,
              image_base64: ''
            }));

          // Refresh local cache
          await dbClear(STORE_HISTORY);
          for (const log of sheetLogs) {
            if (log.id) await dbPut(STORE_HISTORY, log);
          }
        }

        if (visitsData.success && Array.isArray(visitsData.visits)) {
          sheetVisits = visitsData.visits;
          this.visits = sheetVisits;
          this._allVisits = sheetVisits;
          this._pastVisitsLoaded = true;
        }
      } catch (_) {
        this.log('History fetch failed — using cached data.');
      }
    }

    // ── 2. Merge local pending with cache ─────────────────────
    const pending = await dbGetAll(STORE_EXPENSES);
    const cached = await dbGetAll(STORE_HISTORY);
    const seenIds = new Set(cached.map(l => l.id));
    const extra = pending.filter(p => !seenIds.has(p.id));
    const merged = [...cached, ...extra]
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, 200);

    this._allRows = merged;

    // ── 3. Build visit lookup ─────────────────────────────────
    const visitMap = {};
    let pendingVisits = [];
    try { pendingVisits = JSON.parse(localStorage.getItem('mavis_pending_visits') || '[]'); } catch (_) { }
    if (Array.isArray(pendingVisits)) {
      pendingVisits.forEach(v => {
        const vid = v.id || v.visit_id;
        if (vid) visitMap[vid] = { destination: v.destination || '', date: v.date || '', status: v.status || 'Open', distance_miles: v.distanceMiles || v.distance_miles || '0', mileage_rate: v.mileage_rate || '' };
      });
    }
    if (this.activeVisit?.id) {
      visitMap[this.activeVisit.id] = { destination: this.activeVisit.destination || '', date: this.activeVisit.date || '', status: this.activeVisit.status || 'Open', distance_miles: this.activeVisit.distanceMiles || '0', mileage_rate: '' };
    }
    if (Array.isArray(sheetVisits)) {
      sheetVisits.forEach(v => {
        const vid = v.visit_id || v.id;
        if (vid) visitMap[vid] = { destination: v.destination || '', date: v.date || '', status: v.status || 'Open', distance_miles: v.distance_miles || '0', mileage_rate: v.mileage_rate || '' };
      });
    }
    this._visitMap = visitMap;

    // Build the richer allVisits structure for calendar grouping
    if (!this._allVisits.length) {
      // Fall back to visitMap if we have no sheet visits
      this._allVisits = Object.entries(visitMap).map(([id, v]) => ({ visit_id: id, ...v, expenses: [] }));
    }

    // ── 4. Populate filters then render ──────────────────────
    this._populateHistoryFilters();
    this._setHistoryView(this._historyView);

    // Rebuild the carousel cards when database records refresh
    this._rebuildCardTrack();
  }

  // ──────────────────────────────────────────────────────────
  //  POPULATE FILTER DROPDOWNS
  // ──────────────────────────────────────────────────────────
  _populateHistoryFilters() {
    const yearSel = document.getElementById('pwa-filter-year');
    const monthSel = document.getElementById('pwa-filter-month');
    if (!yearSel || !monthSel) return;

    const prevYear = yearSel.value;
    const prevMonth = monthSel.value;

    const years = new Set();
    (this._allRows || []).forEach(row => {
      const key = this._parseDateToKey(row.date);
      if (key) years.add(key.split('-')[0]);
    });

    yearSel.innerHTML = '<option value="all">All Yrs</option>';
    Array.from(years).sort().reverse().forEach(y => {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      yearSel.appendChild(o);
    });

    monthSel.innerHTML = '<option value="all">All Mos</option>';
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].forEach((m, i) => {
      const o = document.createElement('option');
      o.value = String(i + 1).padStart(2, '0');
      o.textContent = m;
      monthSel.appendChild(o);
    });

    if ([...yearSel.options].some(o => o.value === prevYear)) yearSel.value = prevYear;
    if (prevMonth !== 'all' && [...monthSel.options].some(o => o.value === prevMonth)) monthSel.value = prevMonth;
  }

  // ──────────────────────────────────────────────────────────
  //  RENDER LIST VIEW
  // ──────────────────────────────────────────────────────────
  renderListView() {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '';

    // ── Archive mode banner ───────────────────────────────────
    if (this._archiveMode) {
      const banner = document.createElement('div');
      banner.className = 'archive-mode-banner';
      banner.innerHTML = `<svg data-lucide="archive" width="13" height="13"></svg> Archived Items — <span style="opacity:0.75; margin-left:0.2rem;">click the archive icon again to return</span>`;
      container.appendChild(banner);
    }

    const yearFilter = document.getElementById('pwa-filter-year')?.value || 'all';
    const monthFilter = document.getElementById('pwa-filter-month')?.value || 'all';
    const statusFilter = document.getElementById('pwa-filter-status')?.value || 'all';

    // ── Source rows: archived mode uses _archivedRows; normal mode filters OUT archived ──
    const sourceRows = this._archiveMode
      ? (this._archivedRows || [])
      : (this._allRows || []).filter(row => (row.archive || '').toLowerCase() !== 'yes');

    const filteredRows = sourceRows.filter(row => {
      const key = this._parseDateToKey(row.date);
      if (!key) return false;
      const [y, m] = key.split('-');
      if (yearFilter !== 'all' && y !== yearFilter) return false;
      if (monthFilter !== 'all' && m !== monthFilter) return false;
      if (statusFilter !== 'all') {
        const s = (row.status || row.sync_status || '').toLowerCase();
        const isSynced = s === 'synced';
        if (statusFilter === 'synced' && !isSynced) return false;
        if (statusFilter === 'pending' && isSynced) return false;
      }
      return true;
    });

    const filteredVisits = (this._allVisits || []).filter(v => {
      const key = this._parseDateToKey(v.date);
      if (!key) return false;
      const [y, m] = key.split('-');
      if (yearFilter !== 'all' && y !== yearFilter) return false;
      if (monthFilter !== 'all' && m !== monthFilter) return false;
      return true;
    });

    const grouped = this._groupByVisit(filteredRows, filteredVisits);

    if (!grouped.length && !filteredRows.length) {
      const emptyMsg = this._archiveMode
        ? 'No archived expenses found.'
        : 'No visits or expenses match the filters.';
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.textContent = emptyMsg;
      container.appendChild(emptyEl);
      this._refreshIcons(container);
      return;
    }

    // Render each group
    grouped.forEach(g => container.appendChild(this._buildHistoryGroup(g)));

    this._refreshIcons(container);
  }

  _buildHistoryGroup(group) {
    const gEl = document.createElement('div');
    gEl.className = 'history-group';

    const isVirtual = group.isVirtual;
    const destName = isVirtual ? 'Untagged Expenses' : (group.destination || 'Unknown Destination');
    const dist = isVirtual ? 0 : (parseFloat(group.distance_miles) || 0);
    const distStr = dist > 0 ? `${dist} mi` : '';
    const dateStr = isVirtual ? (group.expenses[0]?.date || '') : group.date;
    const rate = parseFloat(group.mileage_rate) || 0.67;
    const mileVal = dist > 0 ? `£${(dist * rate).toFixed(2)}` : '';

    const syncStatus = this._computeVisitSyncStatus(group.expenses);
    const syncDotCol = syncStatus === 'ALL' ? 'var(--secondary)' : (syncStatus === 'PART' ? 'hsl(38,95%,55%)' : 'var(--danger)');
    const expCount = group.expenses.length;
    const expSum = group.expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    const hEl = document.createElement('div');
    hEl.className = 'history-group-header';
    hEl.innerHTML = `
      <div class="group-title">
        <strong class="visit-destination">${formatDateFriendly(dateStr)} &bull; ${this._escHTML(destName)}</strong>
        <div class="group-meta">
          <span class="group-items" style="border-color:${syncDotCol}">
          ${expCount > 0 ? `<span style="color:${syncDotCol}">&#9679;</span>` : ''} ${expCount} item${expCount !== 1 ? 's' : ''} &bull; £${expSum.toFixed(2)}</span>
          ${distStr ? `<span class="group-mileage">${distStr ? `${distStr}` : ''}${mileVal ? ` &bull; ${mileVal}` : ''}</span>` : ''}
          </div>
      </div>
      `;


    const cEl = document.createElement('div');
    cEl.className = 'history-group-content';

    group.expenses.forEach(log => cEl.appendChild(this._buildListLogItem(log)));

    hEl.addEventListener('click', () => {
      cEl.classList.toggle('open');
      hEl.classList.toggle('open');
    });

    gEl.appendChild(hEl);
    gEl.appendChild(cEl);
    return gEl;
  }

  _buildListLogItem(log) {
    const status = (log.status || log.sync_status || '').toLowerCase();
    const isSynced = status === 'synced';
    const isArchived = (log.archive || '').toLowerCase() === 'yes';
    const amountVal = parseFloat(log.amount);
    const amtText = amountVal > 0 ? `£${amountVal.toFixed(2)}` : '£0.00';

    // ── Status-aware swipe label config ──────────────────────────────────────
    // LEFT swipe: Claim — only meaningful when NOT already synced
    const leftAction = isSynced ? 'pending' : 'synced';
    const leftLabel = isSynced ? 'Pending' : 'Claim';
    const leftIcon = isSynced ? 'check-circle-2' : 'check-circle';
    // RIGHT swipe: Archive pending items; Restore (→pending) archived/synced items
    const rightAction = isArchived ? 'pending' : 'archive';
    const rightLabel = isArchived ? 'Restore' : 'Archive';
    const rightIcon = isArchived ? 'rotate-ccw' : 'archive';

    let attachmentIcon = '';
    let attachmentButton = '';
    if (log.receipt_url || log.image_base64) {
      attachmentIcon = `<span class="attachment-icon" title="Has attachment"><svg data-lucide="paperclip" width="12" height="12"></svg></span>`;
      attachmentButton = `<div class="btn btn-outline btn-sm action-btn-attach" style="display:flex; flex-direction:column; align-items:stretch; height:auto; text-align:left; cursor:pointer;" role="button" tabindex="0" > 
       ${log.notes ? `
        <div class="receipt-dummy" >
         <div>${this._escHTML(log.vendor || 'Expense')}</div>
         <div>${this._escHTML(log.category)} Receipt</div>
         <div class="log-item-more">${formatDateFriendly(log.date)}</div>
         <div class="receipt-note" >${this._escHTML(log.notes)}</div>
         <div>${amtText}</div>

         <div class="action-buttons" style="display:flex; gap:0.5rem; margin-top:0.5rem;">
             <button class="action-btn" onclick="event.stopPropagation(); app.openExpenseForEdit(${this._escAttr(JSON.stringify(log))}); app.expenseMode(true)"><svg data-lucide="edit-3" width="14" height="14"></svg></button>
             <button class="action-btn" onclick="event.stopPropagation(); app.openAttachmentModalForExpense('${log.id}')"><svg data-lucide="paperclip" width="14" height="14"></svg></button>
             <button class="action-btn archive-btn ${isArchived ? 'active-action' : ''}" onclick="event.stopPropagation(); app.updateExpenseStatus('${log.id}', '${rightAction}')"><svg data-lucide="${rightIcon}" width="14" height="14"></svg></button>
             <button class="action-btn trash-btn" onclick="event.stopPropagation(); app.updateExpenseStatus('${log.id}', 'trash')"><svg data-lucide="trash-2" width="14" height="14"></svg></button>
         </div>

         <div class="action-buttons" style="display:flex; gap:0.5rem; margin-top:0.5rem;">
              
            <button class="action-btn ${status === 'pending' && !isArchived ? 'active-action' : ''}" onclick="event.stopPropagation(); app.updateExpenseStatus('${log.id}', 'pending')"><svg data-lucide="clock" width="14" height="14"></svg> Pending</button>
            <button class="action-btn claim-btn ${isSynced ? 'active-action' : ''}" onclick="event.stopPropagation(); app.updateExpenseStatus('${log.id}', 'synced')"><svg data-lucide="check-circle" width="14" height="14"></svg> Claimed</button>
  
         
            </div>


        </div>
        ` : `<div style="display:flex; align-items:center; justify-content:center; gap:0.5rem; width:100%;"><svg data-lucide="image" width="14" height="14"></svg> View Receipt</div>`}
      </div>`;
    } else if (log.receipt_pending) {
      attachmentIcon = `<span title="Receipt upload pending" style="color:var(--warning)">⏳</span>`;
    }

    // ── Status-aware swipe label config moved up ─────────────────────────────
    const div = document.createElement('div');
    div.className = 'log-item';
    div.dataset.id = log.id;

    // ── Swipe logic ─────────────────────────────────────────────────────────
    const THRESHOLD = 100; // px to commit action
    const ACTIVATE = 8;   // px before entering drag mode

    const handleStart = (clientX) => {
      this._dragState = { id: log.id, div, startX: clientX, currentX: clientX, active: false };
    };

    const handleMove = (clientX) => {
      const state = this._dragState;
      if (!state || state.id !== log.id) return;
      state.currentX = clientX;
      const diff = clientX - state.startX;

      if (!state.active && Math.abs(diff) < ACTIVATE) return;
      state.active = true;

      const content = div.querySelector('.log-item-info');
      if (!content) return;

      // Clamp at ±THRESHOLD so item stays visible at edge
      const clamped = Math.max(-THRESHOLD, Math.min(THRESHOLD, diff));
      content.style.transform = `translateX(${clamped}px)`;

      if (diff < -ACTIVATE) {
        div.classList.add('swipe-left-ready');
        div.classList.remove('swipe-right-ready');
      } else if (diff > ACTIVATE) {
        div.classList.add('swipe-right-ready');
        div.classList.remove('swipe-left-ready');
      } else {
        div.classList.remove('swipe-left-ready', 'swipe-right-ready');
      }
    };

    const handleEnd = () => {
      const state = this._dragState;
      if (!state || state.id !== log.id) return;
      const diff = state.currentX - state.startX;
      const wasActive = state.active;
      this._dragState = null;

      const content = div.querySelector('.log-item-info');
      const bgLeft = div.querySelector('.log-item-swipe-left');
      const bgRight = div.querySelector('.log-item-swipe-right');
      if (!wasActive || !content) return;

      div.classList.remove('swipe-left-ready', 'swipe-right-ready');

      const snapBack = () => {
        content.style.transition = 'transform 0.35s cubic-bezier(0.34,1.4,0.64,1)';
        content.style.transform = 'translateX(0)';
        setTimeout(() => { content.style.transition = ''; }, 380);
      };

      if (diff < -THRESHOLD) {
        // LEFT swipe
        if (!leftAction) {
          // Synced — bounce back with a small shake to signal "no action"
          content.style.transition = 'transform 0.15s ease';
          content.style.transform = 'translateX(-8px)';
          setTimeout(() => snapBack(), 160);
          return;
        }
        // Freeze at threshold, update background to "Updating…"
        content.style.transition = 'transform 0.15s ease';
        content.style.transform = `translateX(-${THRESHOLD}px)`;
        if (bgLeft) { bgLeft.innerHTML = '<span style="padding:0 1rem">Updating…</span>'; }
        // Perform action, then slide back, then update DOM node
        this.updateExpenseStatus(log.id, leftAction, true).then(() => {
          snapBack();
          setTimeout(() => this.refreshSingleItemNode(log.id), 380);
        });

      } else if (diff > THRESHOLD) {
        // RIGHT swipe
        content.style.transition = 'transform 0.15s ease';
        content.style.transform = `translateX(${THRESHOLD}px)`;
        if (bgRight) { bgRight.innerHTML = '<span style="padding:0 1rem">Updating…</span>'; }
        this.updateExpenseStatus(log.id, rightAction, true).then(() => {
          snapBack();
          setTimeout(() => this.refreshSingleItemNode(log.id), 380);
        });

      } else {
        snapBack();
      }
    };

    // Touch events (mobile)
    div.addEventListener('touchstart', e => handleStart(e.touches[0].clientX), { passive: true });
    div.addEventListener('touchmove', e => {
      const state = this._dragState;
      if (!state || state.id !== log.id) return;
      const diff = e.touches[0].clientX - state.startX;
      if (state.active || Math.abs(diff) >= ACTIVATE) e.preventDefault();
      handleMove(e.touches[0].clientX);
    }, { passive: false });
    div.addEventListener('touchend', () => handleEnd());
    div.addEventListener('touchcancel', () => handleEnd());

    // Mouse events (desktop)
    div.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      handleStart(e.clientX);
      const onMove = (ev) => handleMove(ev.clientX);
      const onUp = () => { handleEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // ── Swipe background labels (status-aware) ───────────────────────────
    const leftBgStyle = isSynced
      ? 'background: linear-gradient(90deg, hsla(258,60%,40%,0.6), hsla(258,60%,55%,0.4));'
      : 'background: linear-gradient(90deg, hsla(161,84%,36%,1), hsla(161,84%,48%,0.85));';

    div.innerHTML = `
      <div class="log-item-swipe-bg log-item-swipe-left" style="${leftBgStyle}">
        <svg data-lucide="${leftIcon}" width="22" height="22"></svg>
        <span>${leftLabel}</span>
      </div>
      <div class="log-item-swipe-bg log-item-swipe-right">
        <span>${rightLabel}</span>
        <svg data-lucide="${rightIcon}" width="22" height="22"></svg>
      </div>
      <div class="log-item-info">
        <div class="log-item-header">
          <div class="log-info">
            <div class="log-item-title"> ${this._escHTML(log.vendor || 'Expense')} ${log.category ? ' &bull; ' + this._escHTML(log.category) : ''}</div>
            ${log.receipt_pending && !log.receipt_url ? `
              <div id="receipt-status-${log.id}" class="receipt-status receipt-status--failed" onclick="event.stopPropagation()">
                ⚠️ Receipt not uploaded —
                <button class="inline-retry-btn" onclick="event.stopPropagation(); app.retryReceiptUpload('${log.id}')">Retry</button>
              </div>` : ''}
            <div class="log-item-more"><svg class="chevron" data-lucide="chevron-down" width="16" height="16"></svg> ${formatDateFriendly(log.date)} ${attachmentIcon}</div>
          </div>
          <div class="log-item-right">
            <span class="log-amount">${amtText}</span>
            <span class="log-badge ${isSynced ? 'badge-synced' : isArchived ? 'badge-archived' : 'badge-pending'}">${isSynced ? 'Synced' : isArchived ? 'Archived' : 'Pending'}</span>
          </div>
        </div>
        <div class="log-item-details">
          ${attachmentButton}
         
        </div>
      </div>
    `;

    // Expand/collapse on content click (only if not a swipe)
    const headerEl = div.querySelector('.log-item-header');
    const detailsEl = div.querySelector('.log-item-details');

    if (headerEl) {
      headerEl.addEventListener('click', () => {
        if (this._dragState && this._dragState.active) return;
        div.classList.toggle('expanded');
        this._refreshIcons(div);
      });
    }

    if (detailsEl) {
      detailsEl.addEventListener('click', (e) => {
        if (this._dragState && this._dragState.active) return;
        // Don't close if they clicked an actual button inside details
        if (e.target.closest('button') || e.target.closest('.action-btn')) return;
        div.classList.toggle('expanded');
        this._refreshIcons(div);
      });
    }

    return div;
  }

  // ──────────────────────────────────────────────────────────
  //  RENDER CALENDAR VIEW
  // ──────────────────────────────────────────────────────────
  renderCalendarView() {
    const year = this._calDate.getFullYear();
    const month = this._calDate.getMonth(); // 0-indexed

    const label = document.getElementById('pwa-cal-year-label');
    if (label) label.textContent = year;

    // Update history title
    const titleText = document.getElementById('calender-title-text');
    if (titleText) {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      titleText.textContent = `${monthNames[month]}, ${year}`;
    }

    // Group visits by YYYY-MM-DD key
    const visitsByDay = {};
    const visitGroups = this._groupByVisit(this._allRows || [], this._allVisits || []);
    visitGroups.forEach(v => {
      const dStr = v.isVirtual ? (v.expenses[0]?.date || '') : v.date;
      const key = this._parseDateToKey(dStr);
      if (!key) return;
      if (!visitsByDay[key]) visitsByDay[key] = [];
      visitsByDay[key].push(v);
    });

    // Month navigation buttons
    const monthNav = document.getElementById('pwa-cal-month-nav');
    if (monthNav) {
      monthNav.innerHTML = '';
      const mos = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      mos.forEach((m, mIdx) => {
        let synced = 0, pending = 0;
        visitGroups.forEach(v => {
          const dStr = v.isVirtual ? (v.expenses[0]?.date || '') : v.date;
          const key = this._parseDateToKey(dStr);
          if (key && key.startsWith(`${year}-${String(mIdx + 1).padStart(2, '0')}`)) {
            const ss = this._computeVisitSyncStatus(v.expenses);
            if (ss === 'ALL') synced++; else pending++;
          }
        });

        const btn = document.createElement('button');
        btn.className = 'pwa-cal-month-btn';
        btn.textContent = m;

        if (synced > 0 && pending > 0) btn.classList.add('status-mixed');
        else if (synced > 0) btn.classList.add('status-synced');
        else if (pending > 0) btn.classList.add('status-unsynced');

        if (mIdx === month) {
          btn.style.fontWeight = 'bold';
          btn.style.background = 'var(--text-primary) !important';
          btn.style.color = 'var(--bg-dark)';
          btn.style.borderColor = 'transparent';
        }
        btn.addEventListener('click', () => { this._calDate.setMonth(mIdx); this.renderCalendarView(); });
        monthNav.appendChild(btn);
      });
    }

    // Day grid
    const grid = document.getElementById('pwa-cal-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMo = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Day-of-week header
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
      const cell = document.createElement('div');
      cell.className = 'pwa-cal-day-label';
      cell.textContent = d;
      grid.appendChild(cell);
    });

    // Leading cells from prev month
    for (let i = 0; i < firstDay; i++) {
      grid.appendChild(this._buildCalCell(daysInPrevMo - firstDay + 1 + i, null, false, false, null));
    }

    // Current month cells
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const visits = visitsByDay[key] || [];
      grid.appendChild(this._buildCalCell(d, visits, true, key === todayKey, key));
    }

    // Trailing cells
    const total = firstDay + daysInMonth;
    const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let i = 1; i <= trailing; i++) {
      grid.appendChild(this._buildCalCell(i, null, false, false, null));
    }

    // Monthly summary
    let vCount = 0, daysSet = new Set(), milage = 0, exCount = 0, exSum = 0, synced = 0, pending = 0;
    Object.entries(visitsByDay).forEach(([key, dayVisits]) => {
      if (key.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`) && dayVisits) {
        daysSet.add(key);
        dayVisits.forEach(v => {
          if (!v.isVirtual) vCount++;
          milage += parseFloat(v.distance_miles) || 0;
          v.expenses.forEach(e => { exCount++; exSum += parseFloat(e.amount) || 0; });
          const ss = this._computeVisitSyncStatus(v.expenses);
          if (ss === 'ALL') synced++; else pending++;
        });
      }
    });
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('pwa-sum-visits', vCount);
    setTxt('pwa-sum-days', daysSet.size);
    setTxt('pwa-sum-mileage', milage.toFixed(1));
    setTxt('pwa-sum-exp-count', exCount);
    setTxt('pwa-sum-pending', pending);

    this._refreshIcons();
  }

  _buildCalCell(dayNum, visits, isCurrentMonth, isToday, dateKey) {
    const cell = document.createElement('div');
    cell.className = 'pwa-cal-cell';
    if (isToday) cell.classList.add('today');
    if (!isCurrentMonth) cell.classList.add('other-month');

    const numEl = document.createElement('div');
    numEl.className = 'pwa-cal-day-num';
    numEl.textContent = dayNum;
    cell.appendChild(numEl);

    if (isCurrentMonth && visits && visits.length > 0) {
      cell.classList.add('has-items');
      let synced = 0, pend = 0;
      visits.forEach(v => {
        const ss = this._computeVisitSyncStatus(v.expenses);
        if (ss === 'ALL') synced++; else pend++;
      });
      if (synced > 0 && pend > 0) cell.classList.add('status-mixed');
      else if (synced > 0) cell.classList.add('status-synced');
      else if (pend > 0) cell.classList.add('status-unsynced');

      const dots = document.createElement('div');
      dots.className = 'pwa-cal-dots';
      visits.slice(0, 4).forEach(v => {
        const dot = document.createElement('div');
        dot.className = 'pwa-cal-dot';
        const ss = this._computeVisitSyncStatus(v.expenses);
        dot.style.background = ss === 'ALL' ? 'var(--secondary)' : (ss === 'PART' ? 'hsl(38,95%,55%)' : 'var(--danger)');
        dots.appendChild(dot);
      });
      cell.appendChild(dots);
      cell.addEventListener('click', () => this.openDayPopup(dateKey, visits));
    }
    return cell;
  }

  openDayPopup(dateKey, visits) {
    const overlay = document.getElementById('pwa-day-popup-overlay');
    const titleEl = document.getElementById('pwa-popup-date-title');
    const itemsEl = document.getElementById('pwa-popup-items-container');
    if (!overlay || !titleEl || !itemsEl) return;

    const d = new Date(dateKey + 'T00:00:00');
    titleEl.textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    itemsEl.innerHTML = '';
    visits.forEach(v => {
      const grp = this._buildHistoryGroup(v);
      // auto-expand popup groups
      const content = grp.querySelector('.history-group-content');
      if (content) content.classList.add('open');
      itemsEl.appendChild(grp);
    });

    overlay.classList.add('open');
    this._refreshIcons(itemsEl);
  }

  closeDayPopup() {
    const overlay = document.getElementById('pwa-day-popup-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  // ──────────────────────────────────────────────────────────
  //  DATA HELPERS
  // ──────────────────────────────────────────────────────────
  _groupByVisit(expenses, visits) {
    const groups = {};
    const untagged = { isVirtual: true, expenses: [] };
    const safeV = visits || [];
    const safeE = expenses || [];

    safeV.forEach(v => {
      const vid = v.visit_id || v.id;
      if (vid) groups[vid] = { ...v, expenses: [] };
    });

    safeE.forEach(exp => {
      const vid = exp.visit_id;
      if (vid) {
        if (!groups[vid]) {
          groups[vid] = {
            visit_id: vid,
            destination: this._visitMap?.[vid]?.destination || 'Unknown Visit',
            date: this._visitMap?.[vid]?.date || exp.date || '',
            distance_miles: this._visitMap?.[vid]?.distance_miles || '0',
            mileage_rate: this._visitMap?.[vid]?.mileage_rate || '',
            expenses: []
          };
        }
        groups[vid].expenses.push(exp);
      } else {
        untagged.expenses.push(exp);
      }
    });

    const result = Object.values(groups).filter(g => g.expenses.length > 0 || parseFloat(g.distance_miles) > 0);
    if (untagged.expenses.length > 0) result.push(untagged);

    result.sort((a, b) => {
      const da = a.isVirtual ? (a.expenses[0]?.date || '') : a.date;
      const db = b.isVirtual ? (b.expenses[0]?.date || '') : b.date;
      const ka = this._parseDateToKey(da) || '1970-01-01';
      const kb = this._parseDateToKey(db) || '1970-01-01';
      return new Date(kb) - new Date(ka);
    });
    return result;
  }

  _computeVisitSyncStatus(expenses) {
    if (!expenses || expenses.length === 0) return 'ALL';
    let synced = 0;
    expenses.forEach(e => {
      const s = (e.status || e.sync_status || '').toLowerCase();
      if (s === 'synced') synced++;
    });
    if (synced === expenses.length) return 'ALL';
    if (synced > 0) return 'PART';
    return 'NONE';
  }

  _parseDateToKey(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parts = s.split(/[\/\-\.]/);
    if (parts.length === 3) {
      const [p1, p2, p3] = parts.map(Number);
      if (parts[0].length === 4) return `${p1}-${String(p2).padStart(2, '0')}-${String(p3).padStart(2, '0')}`;
      if (parts[2].length === 4) {
        let mo = p1, dy = p2;
        if (p1 > 12 && p2 <= 12) { dy = p1; mo = p2; }
        return `${p3}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
      }
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return null;
  }

  _escHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Safe attribute value encoder (for use in onclick= strings with JSON payloads)
  _escAttr(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Safe scoped Lucide icon initialisation ────────────────
  // Scopes createIcons to a specific container to prevent re-processing
  // already-replaced SVGs (which causes iOS Safari's setAttribute error)
  _refreshIcons(container) {
    if (typeof lucide === 'undefined') return;
    try {
      // Only target placeholder SVG elements that still have data-lucide
      // and haven't been replaced yet (they have no children)
      const placeholders = (container || document).querySelectorAll('svg[data-lucide]:not(.lucide)');
      if (!placeholders.length) return;
      if (container) {
        lucide.createIcons({ nodes: [container] });
      } else {
        // For document-wide calls, process only uninitialized placeholders
        placeholders.forEach(el => {
          const name = el.getAttribute('data-lucide');
          if (!name) return;
          try {
            const parentNode = el.parentNode;
            if (!parentNode) return;
            // Use a temporary wrapper approach
            const tempDiv = document.createElement('div');
            tempDiv.appendChild(el.cloneNode(true));
            lucide.createIcons({ nodes: [tempDiv] });
            const newSvg = tempDiv.querySelector('svg');
            if (newSvg) parentNode.replaceChild(newSvg, el);
          } catch (_) { }
        });
      }
    } catch (err) {
      console.warn('[Lucide] createIcons failed:', err.message);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  QUEUE UI
  // ──────────────────────────────────────────────────────────
  async updateQueueUI() {
    const pending = await dbGetAll(STORE_EXPENSES);
    const count = pending.length;

    const countEl = document.getElementById('unsynced-count');
    if (countEl) countEl.textContent = count;

    const badge = document.getElementById('nav-sync-badge');
    if (badge) {
      badge.textContent = count > 0 ? count : '';
      badge.style.display = count > 0 ? 'flex' : 'none';
    }

    const normHead = document.getElementById('normalHead');
    const syncHead = document.getElementById('syncHead');
    if (normHead && syncHead) {
      normHead.style.display = count > 0 ? 'none' : 'flex';
      syncHead.style.display = count > 0 ? 'flex' : 'none';
    }

    const syncBtn = document.getElementById('btn-sync-now');
    if (syncBtn && !this._isSyncing) {
      syncBtn.disabled = count === 0;
      syncBtn.textContent = 'Sync with Google Sheets';
    }
  }

  _showOnlineBadge(online) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    badge.style.display = 'inline-block';
    badge.className = 'status-badge ' + (online ? 'badge-synced' : 'badge-pending');
    badge.textContent = online ? 'Synced' : 'Offline Queue';
  }

  _showSyncError(msg) {
    ['sync-error-msg', 'sync-error-msg-settings'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (msg) { el.style.display = 'block'; el.innerHTML = `<strong>⚠</strong> ${msg}`; }
      else { el.style.display = 'none'; el.innerHTML = ''; }
    });
  }

  // ──────────────────────────────────────────────────────────
  //  Dev console
  // ──────────────────────────────────────────────────────────
  log(text) {
    console.log('[Mavis]', text);
    const box = document.getElementById('dev-console');
    if (box) {
      box.innerHTML += `<br>&gt; [${new Date().toLocaleTimeString()}] ${text}`;
      box.scrollTop = box.scrollHeight;
    }
  }


  // ──────────────────────────────────────────────────────────
  //  Dynamic Navigation State Routing Engine
  // ──────────────────────────────────────────────────────────

  /**
   * Orchestrates the navbar presentation layout and interactive roles.
   * @param {string} mode - 'AUTO', 'AID_EDIT', 'VISIT_SETUP', 'SYNC', or 'SETTINGS'
   */
  updateNavbarLayout(mode) {
    this.currentNavMode = mode;

    const photoBtn = document.getElementById('detail-toggle');

    const navContainer = document.getElementById('dynamic-bottom-nav');
    const leftBtn = document.getElementById('left-nav-btn');
    const mainBtn = document.getElementById('main-nav-btn');
    const rightBtn = document.getElementById('right-nav-btn');
    const syncBadge = document.getElementById('nav-sync-badge');

    if (!navContainer || !leftBtn || !mainBtn || !rightBtn) return;

    // Update state attribute
    navContainer.setAttribute('data-nav-state', mode);

    // Reset active/disabled classes on all buttons
    [leftBtn, mainBtn, rightBtn].forEach(btn => {
      btn.classList.remove('active-nav-tab', 'disabled-nav');
      btn.disabled = false;
    });

    // Sync badge visibility
    if (syncBadge) {
      const currentCount = parseInt(syncBadge.textContent || '0', 10);
      syncBadge.style.display = (currentCount > 0) ? 'flex' : 'none';
    }

    // ── Helper: re-inject a fresh SVG placeholder so Lucide can replace it ──
    // Lucide replaces the <svg> element entirely on first pass; calling
    // setAttribute on the already-replaced element is a no-op. We must
    // inject a brand-new placeholder each time we want a different icon.
    const setIcon = (btn, iconName, extraAttrs = '') => {
      // Remove any existing icon SVG inside the button (but keep badge spans)
      btn.querySelectorAll('svg').forEach(s => s.remove());
      // Insert fresh placeholder that Lucide will replace
      const placeholder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      placeholder.setAttribute('data-lucide', iconName);
      placeholder.setAttribute('width', '24');
      placeholder.setAttribute('height', '24');
      placeholder.setAttribute('stroke', 'currentColor');
      placeholder.setAttribute('stroke-width', '2');
      if (extraAttrs === 'fab') {
        placeholder.setAttribute('width', '26');
        placeholder.setAttribute('height', '26');
      }
      // For the FAB, inject into the .fab-circle; otherwise directly into btn
      const fabCircle = btn.querySelector('.fab-circle');
      if (fabCircle) {
        fabCircle.querySelectorAll('svg').forEach(s => s.remove());
        fabCircle.appendChild(placeholder);
      } else {
        // Insert before the badge span so badge stays last
        const badge = btn.querySelector('.nav-badge');
        badge ? btn.insertBefore(placeholder, badge) : btn.appendChild(placeholder);
      }
    };

    switch (mode) {
      case 'VISIT_SETUP':
        setIcon(leftBtn, 'calendar');
        setIcon(mainBtn, 'check', 'fab');
        setIcon(rightBtn, 'settings');
        if (syncBadge) syncBadge.style.display = 'none';
        break;

      case 'AUTO':
        setIcon(leftBtn, 'calendar');
        setIcon(mainBtn, 'camera', 'fab');
        setIcon(rightBtn, 'settings');
        mainBtn.classList.add('active-nav-tab');
        if (photoBtn) photoBtn.style.display = 'flex';
        break;

      case 'AID_EDIT':
        setIcon(leftBtn, 'arrow-left');
        setIcon(mainBtn, 'save', 'fab');
        setIcon(rightBtn, 'trash-2');
        if (photoBtn) photoBtn.style.display = 'none';
        if (syncBadge) syncBadge.style.display = 'none';
        this.evaluateFormInputMaturity();
        break;

      case 'SYNC':
        setIcon(leftBtn, 'calendar');
        setIcon(mainBtn, 'home', 'fab');
        setIcon(rightBtn, 'settings');
        leftBtn.classList.add('active-nav-tab');
        break;

      case 'SETTINGS':
        setIcon(leftBtn, 'calendar');
        setIcon(mainBtn, 'home', 'fab');
        setIcon(rightBtn, 'settings');
        rightBtn.classList.add('active-nav-tab');
        break;
    }

    // Re-run Lucide on the nav only (scoped, no document-wide thrash)
    if (typeof lucide !== 'undefined') {
      this._refreshIcons(navContainer);
    }
  }

  /**
   * Disables or enables actions based on whether the form contains data.
   */
  evaluateFormInputMaturity() {
    if (this.currentNavMode !== 'AID_EDIT') return;

    const mainBtn = document.getElementById('main-nav-btn');
    const rightBtn = document.getElementById('right-nav-btn');
    const amountInput = document.getElementById('exp-amount');

    const rawAmount = amountInput ? parseFloat(amountInput.value) : 0;
    const isFormPopulated = (rawAmount > 0 || (amountInput && amountInput.value.trim() !== ''));

    // Save is disabled until there is a valid amount input
    if (mainBtn) {
      mainBtn.disabled = !isFormPopulated;
      mainBtn.classList.toggle('disabled-nav', !isFormPopulated);
    }

    // Delete button stays fully active to discard bad scans immediately
    if (rightBtn) {
      rightBtn.disabled = false;
      rightBtn.classList.remove('disabled-nav');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Centralized Navigation Event Handlers
  // ──────────────────────────────────────────────────────────

  handleNavLeft() {
    switch (this.currentNavMode) {
      case 'AID_EDIT':
        this.cancelEdit();
        break;
      case 'VISIT_SETUP':
      case 'AUTO':
      case 'SETTINGS':
      default:
        this.switchTab('sync');
        break;
    }
  }

  handleNavMain() {
    switch (this.currentNavMode) {
      case 'VISIT_SETUP':
        // Direct integration into your core startVisit logic flow
        if (typeof this.startVisit === 'function') {
          this.startVisit();
        }
        break;

      case 'AID_EDIT':
        // Triggers HTML5 form validation before submission
        const detailsForm = document.getElementById('expense-form-details');
        if (detailsForm) {
          detailsForm.requestSubmit();
        }
        break;

      case 'AUTO':
        const fileTrigger = document.getElementById('exp-receipt');
        if (fileTrigger) fileTrigger.click();
        break;

      case 'SYNC':
      case 'SETTINGS':
      default:
        this.switchTab('record');
        break;
    }
  }

  handleNavRight() {
    switch (this.currentNavMode) {
      case 'AID_EDIT':
        if (typeof this.deleteCurrentExpense === 'function') {
          this.deleteCurrentExpense();
        } else {
          this.expenseMode(false);
        }
        break;

      case 'VISIT_SETUP':
      /* 1. FIX: Targeted 'visit-select-past' to match your index.html definition
      const selectMenu = document.getElementById('visit-select-past');
      if (selectMenu) {
        selectMenu.focus();

        // 2. FIX: Use standard native .showPicker() invocation rather than fake events
        if (typeof selectMenu.showPicker === 'function') {
          try {
            selectMenu.showPicker();
          } catch (err) {
            this.log(`Failed to trigger native selection picker: ${err.message}`);
          }
        } else {
          // Legacy/fallback fallback for older browsers
          const clickEvent = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          selectMenu.dispatchEvent(clickEvent);
        }
      }
      break; */

      case 'AUTO':
      case 'SYNC':
      default:
        this.switchTab('settings');
        break;
    }
  }



  // ──────────────────────────────────────────────────────────
  //  EXTENDED ACTIONS & MODALS
  // ──────────────────────────────────────────────────────────

  openAttachmentModal(url) {
    const modal = document.getElementById('attachment-modal');
    const img = document.getElementById('attachment-modal-img');
    if (modal && img) {
      img.src = url;
      modal.style.display = 'flex';
    }
  }

  closeAttachmentModal() {
    const modal = document.getElementById('attachment-modal');
    if (modal) modal.style.display = 'none';
  }

  async openAttachmentModalForExpense(id) {
    const hist = await dbGet(STORE_HISTORY, id);
    if (!hist) return;
    const url = hist.receipt_url || hist.image_base64;
    if (url) {
      this.openAttachmentModal(url);
    } else {
      this.log('No receipt found for this expense');
      this._showToast('No receipt available');
    }
  }

  async refreshSingleItemNode(id) {
    const existingItem = document.querySelector(`.log-item[data-id="${id}"]`);
    if (!existingItem) return;

    const updatedLog = await dbGet(STORE_HISTORY, id);
    if (updatedLog) {
      const newItem = this._buildListLogItem(updatedLog);
      if (existingItem.classList.contains('expanded')) newItem.classList.add('expanded');
      existingItem.replaceWith(newItem);
      if (typeof lucide !== 'undefined') this._refreshIcons(newItem);
    } else {
      // Must have been deleted
      existingItem.remove();
    }
  }

  async updateExpenseStatus(id, action, skipRender = false) {
    // action: 'pending', 'synced', 'archive', 'trash'
    this.log(`Updating expense ${id} status => ${action}`);

    const hist = await dbGet(STORE_HISTORY, id);
    if (!hist) { this.log('updateExpenseStatus: record not found in IDB'); return; }

    // Confirm destructive actions
    if (action === 'trash') {
      if (!confirm('Permanently remove this expense?')) return;
    }

    const isSyncedAction = action === 'synced';
    const newStatus = isSyncedAction ? 'synced' : 'pending';
    const archiveVal = action === 'archive' ? 'Yes' : (hist.archive || 'No');
    const newSyncAction = action === 'trash' ? 'delete' : 'update';

    const updated = {
      ...hist,
      status: newStatus,
      sync_status: isSyncedAction ? 'Synced' : 'Pending',
      sync_action: newSyncAction,
      archive: archiveVal
    };

    // ── Update local IDB immediately ───────────────────────────────────────
    if (action === 'trash') {
      await dbDelete(STORE_HISTORY, id);
      await dbDelete(STORE_EXPENSES, id);
    } else {
      await dbPut(STORE_HISTORY, updated);
      // Queue in pending_expenses so it gets picked up by bulk sync
      await dbPut(STORE_EXPENSES, updated);
    }

    // ── Immediately attempt a direct backend sync ─────────────────────────
    const { webappUrl: url, secretKey: token } = this.settings;
    if (url) {
      try {
        const payload = {
          token,
          action: 'update_status',
          expense_id: id,
          sync_status: updated.sync_status,
          archive: archiveVal,
          row_index: hist.rowIndex || 0
        };
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (result.success) {
          this.log(`[Status Sync] ✓ Expense ${id} updated on Sheet => ${updated.sync_status}`);
          // Remove from pending queue since we synced directly
          if (action !== 'trash') await dbDelete(STORE_EXPENSES, id);
        } else {
          this.log(`[Status Sync] Backend returned failure: ${result.message}`);
        }
      } catch (err) {
        this.log(`[Status Sync] Network error, will retry later: ${err.message}`);
      }
    }

    // ── Refresh UI ───────────────────────────────────────────────────
    await this.updateQueueUI();

    if (!skipRender) {
      // Targeted DOM update instead of full renderHistory
      await this.refreshSingleItemNode(id);
    }

    const labels = { pending: 'Pending', synced: '✓ Claimed & Synced', archive: 'Archived', trash: 'Deleted' };
    this._showToast(labels[action] || `Updated to ${action}`);
  }

}

// ── Bootstrap ──────────────────────────────────────────────
window.app = new MavisExpenseApp();
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => window.app.init());
} else {
  window.app.init();
}
