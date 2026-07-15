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


  _getDirectDriveUrl(url) {
    if (!url) return null;
    if (url.includes('/uc?') || url.startsWith('data:')) return url;

    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      // OLD: export=view&id=... (Very restrictive)
      // NEW: thumbnail?id=...&sz=w1000 (Much more reliable)
      return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1000`;
    }
    return url;
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
    const btnLoc = document.getElementById('pwa-view-btn-loc');
    const btnCal = document.getElementById('pwa-view-btn-cal');
    const btnArchive = document.getElementById('btn-archive-view');
    if (btnList) btnList.addEventListener('click', () => this._setHistoryView('list'));
    if (btnLoc) btnLoc.addEventListener('click', () => this._setHistoryView('loc'));
    if (btnCal) btnCal.addEventListener('click', () => this._setHistoryView('cal'));
    if (btnArchive) btnArchive.addEventListener('click', () => this._toggleArchiveView());

    // ── Calendar year navigation ──
    const prevYr = document.getElementById('pwa-cal-year-prev');
    const nextYr = document.getElementById('pwa-cal-year-next');
    if (prevYr) prevYr.addEventListener('click', () => { this._calDate.setFullYear(this._calDate.getFullYear() - 1); this.renderCalendarView(); });
    if (nextYr) nextYr.addEventListener('click', () => { this._calDate.setFullYear(this._calDate.getFullYear() + 1); this.renderCalendarView(); });

    // ── History list filters ──
    ['pwa-filter-year', 'pwa-filter-month', 'pwa-filter-status', 'pwa-filter-location'].forEach(id => {
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



    // ── Filter Accordion UI Logic ──
    document.querySelectorAll('.filter-select-case').forEach(caseEl => {
      caseEl.addEventListener('click', (e) => {

        // 1. Reset ALL other cases (Shrink them and close their selects)
        document.querySelectorAll('.filter-select-case').forEach(otherCase => {
          if (otherCase !== caseEl) {
            otherCase.classList.remove('grow');
            otherCase.querySelectorAll('.pwa-filter-select').forEach(sel => {
              sel.classList.remove('open');
            });
          }
        });

        // 2. Activate the CLICKED case (Grow it and open its selects)
        caseEl.classList.add('grow');
        caseEl.querySelectorAll('.pwa-filter-select').forEach(sel => {
          sel.classList.add('open');
        });

      });
    });


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

  toggleClaimStatus(logId, isSynced) {

    const log = this._allRows.find(r => r.id === logId);
    if (!log) return;

    const idx = this._allRows.indexOf(log);
    if (idx === -1) return;

    const newStatus = !isSynced ? 'synced' : 'pending';

    // Update local data
    const oldStatus = log.status || log.sync_status || '';
    log.status = newStatus;
    log.sync_status = newStatus;
    this._allRows[idx] = log;

    // Persist to Dexie (only if we have a DB instance)
    if (this.db) {
      // Find the log in the store
      this.db.logs.get(logId).then(l => {
        if (l) {
          l.status = newStatus;
          l.sync_status = newStatus;
          this.db.logs.put(l).catch(err => console.error('Failed to update log status in Dexie:', err));
        }
      }).catch(err => console.error('Failed to find log in Dexie:', err));

      // If this log has an image, we need to ensure it's synced
      if (log.receipt_image) {
        this._ensureImageSynced(logId, log.receipt_image);
      }
    }

    // Re-render to update UI immediately
    this.renderDashboard();
    this._showToast(`✅ ${newStatus === 'synced' ? 'Claimed' : 'Pending'}`);
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

    // 1. Always seed from local defaults first so the selector is never empty
    const localPlaces = this.settings.frequentPlaces?.length
      ? this.settings.frequentPlaces
      : this.defaultFrequentPlaces;
    this.locations = localPlaces;
    this._populateDestSel(localPlaces);

    // FIX #1: Instantly recalculate distances for your cached offline places 
    // so distances are accurate even when starting the app with no internet.
    this.recalculateDistances();

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
          this.recalculateDistances(); // Recalculate again with fresh online coordinates
          localStorage.setItem('mavis_settings', JSON.stringify(this.settings));
          this._populateDestSel(this.locations);
          this.log(`Locations loaded from sheet: ${this.locations.length}`);
        }
      } catch (_) {
        this.log('Locations fetch failed — using local defaults.');
      }
    }

    // FIX #2: Refresh the active visit bar now that locations are loaded.
    // This resolves the race condition in init() by instantly swapping out
    // the "Unknown" placeholder with the actual destination name.
    if (typeof this._renderVisitBar === 'function') {
      this._renderVisitBar();
    }

    // Refresh the locations panel if it's currently visible
    if (document.getElementById('pwa-view-loc')?.classList.contains('active')) {
      this.renderLocationsList();
    }
  }

  _populateDestSel(locs) {
    const sel = document.getElementById('visit-destination');
    if (!sel) return;
    const prev = sel.value; // preserve selection across refreshes
    //sel.innerHTML = '<option value="">Start New Visit</option>';
    locs.forEach(loc => {
      const mi = loc.distance_from_home || 0;
      const opt = document.createElement('option');
      opt.value = loc.name;
      opt.dataset.distance = mi;
      opt.textContent = loc.name;
      //opt.textContent = mi > 0 ? `${loc.name}  (${mi} mi)` : loc.name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }

  // ──────────────────────────────────────────────────────────
  //  VISIT BAR RENDER
  // ──────────────────────────────────────────────────────────
  _renderVisitBar() {
    const vBar = document.getElementById('visit-bar');
    if (!vBar) return;

    vBar.className = 'visit-section bar';
    vBar.innerHTML = '';

    const idSpan = document.getElementById('vbar-id');
    const statusText = document.getElementById('vbar-status');
    if (idSpan) { idSpan.style.display = 'none'; idSpan.textContent = this.activeVisit.id; }

    // ── STATE 1: ORPHAN MODE (No active or past visit selected) ──
    if (!this.activeVisit) {

      vBar.innerHTML = `
      <div class="switch-btn" style=" padding:0 10px; background-color: var(--secondary); color: white;">
        <select class="new-visit-selector" id="visit-destination" onchange="app.startVisit()"
          placeholder="Start New Visit">
          <option value="" disabled selected hidden>Start New Visit</option>
        </select>

        <div class="new-visit-date"
          onclick="const d = document.getElementById('visit-date'); d.focus(); try { d.showPicker(); } catch(e) {}">
          <svg width="17" height="17" stroke="#000" stroke-width="2" data-lucide="calendar"></svg>
        </div>

        <input type="date" id="visit-date"
          style="position: absolute; right: 10px; opacity: 0; pointer-events: none; width: 24px; height: 24px; border: none; background: transparent; padding: 0;">
      </div>`;

      // 1. Re-populate the newly created select menu with your locations
      const locs = (this.locations && this.locations.length) ? this.locations : (this.settings.frequentPlaces || []);
      this._populateDestSel(locs);

      // 2. Re-initialize Lucide icons so the new calendar SVG actually renders
      if (typeof lucide !== 'undefined') this._refreshIcons(vBar);

      return; // Exit early to avoid evaluating object configurations


    }


    // ── STATE 2: PAST VISIT MODE (Morphed Context) ──
    if (this.activeVisit.isPast) {
      vBar.style.borderBottom = '2px solid gray';
      vBar.style.background = '';
      vBar.style.boxShadow = 'var(--shadow-sm)';
      if (statusText) statusText.textContent = 'Past Visit';


      if (btnEnd) {
        btnEnd.textContent = 'Clear Visit';
        btnEnd.className = 'btn';
        btnEnd.onclick = () => this.logAsOrphan();
      }
    }
    // ── STATE 3: STANDARD ACTIVE VISIT MODE ──
    else {
      vBar.addEventListener('click', () => { this.switchTab('record'); });

      vBar.classList.add('bar');
      vBar.innerHTML = `
     
      <span class="active-visit"></span>

      <div class="group-title">
        <div class="visit-bar-dest">${this.activeVisit.destination}</div>
        <div class="visit-bar-meta">${formatDateFriendly(this.activeVisit.date)}</div>
      </div>

       <div style="display: flex; height:100%; align-items: center;gap:10px">



      <span onclick="event.stopPropagation(); app.endVisit('${this.activeVisit.id}')">
       <svg width="20" height="20" stroke="#000" stroke-width="2" data-lucide="x"></svg>
      </span>

      </div>
      `






      // Keep the carousel in sync whenever active visit changes
      this._rebuildCardTrack();
    }

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




  endVisit(visitId = null) {
    if (!confirm('End this visit? It will be marked Closed.')) return;

    let visitToClose = null;

    // Scenario A: End the globally Active Visit (triggered from the Top Nav Bar)
    if (!visitId || (this.activeVisit && this.activeVisit.id === visitId)) {
      if (this.activeVisit) {
        this.activeVisit.status = 'Closed';
        this._queueVisit(this.activeVisit);
      }
      this.activeVisit = null;
      localStorage.removeItem('mavis_active_visit');
      this._renderVisitBar();
      this._pastVisitsLoaded = false;
      this.toggleNewVisitModal(true); // Open modal for next action
    }
    // Scenario B: End a specific historical visit from the History List
    else {
      // Look up the visit details so we can queue it correctly to the backend
      const mapData = this._visitMap?.[visitId] || {};

      visitToClose = {
        id: visitId,
        date: mapData.date || new Date().toISOString().split('T')[0],
        destination: mapData.destination || 'Unknown',
        distanceMiles: mapData.distance_miles || mapData.distanceMiles || 0,
        status: 'Closed'
      };

      // Immediately update local map so the UI reflects it instantly
      if (this._visitMap && this._visitMap[visitId]) {
        this._visitMap[visitId].status = 'Closed';
      }
    }

    // Queue for sync and save to sheets
    if (visitToClose) {
      this._queueVisit(visitToClose);
    }

    this.log('Visit ended and marked Closed.');
    this._showToast('Visit closed.');


    this.renderHistory();
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
  flipCard(idx, targetFace) {
    const cardInner = document.getElementById(`card-inner-${idx}`);
    if (!cardInner) return;

    const backFace = document.getElementById(`card-back-${idx}`);
    const editFace = document.getElementById(`card-edit-${idx}`);
    const overlay = document.getElementById(`receipt-state-${idx}`);
    const statusMsg = overlay?.querySelector('.status-msg');

    // ==========================================
    // STATE 1: Return to Front
    // ==========================================
    if (targetFace === 'front') {
      cardInner.classList.remove('flipped');

      // Delay resetting display so it doesn't snap abruptly mid-flip
      setTimeout(() => {
        if (backFace) backFace.style.display = 'none';
        if (editFace) editFace.style.display = 'none';
      }, 400); // Match this timing to your CSS transition duration
    }

    // ==========================================
    // STATE 2: Show Image (Back)
    // ==========================================
    else if (targetFace === 'back') {
      if (backFace) backFace.style.display = 'block';
      if (editFace) editFace.style.display = 'none';

      const expenseData = this._cardExpenses[idx];

      // Handle Image Loading
      if (expenseData?.receipt_url) {
        if (overlay && statusMsg) {
          overlay.style.display = 'flex';
          statusMsg.innerHTML = `<div id="status-text-${idx}">Loading receipt...</div>`;
        }

        const directUrl = this._getDirectDriveUrl(expenseData.receipt_url);
        const img = new Image();
        const statusText = document.getElementById(`status-text-${idx}`);

        img.onload = () => {
          backFace.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.3)), url("${directUrl}")`;
          if (overlay) overlay.style.display = 'none';
        };

        img.onerror = () => {
          if (statusText) statusText.textContent = 'Error: Failed to load image.';
          setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 3000);
        };

        img.src = directUrl;
      }

      cardInner.classList.add('flipped');
    }

    // ==========================================
    // STATE 3: Show Edit Form
    // ==========================================
    else if (targetFace === 'edit') {
      if (backFace) backFace.style.display = 'none';
      if (editFace) editFace.style.display = 'block';
      cardInner.classList.add('flipped');
    }
  }

  editCard(idx) {
    // Tell the app which record is currently being edited
    const exp = this._cardExpenses[idx];
    if (exp) {
      this.editingExpenseId = exp.id;
    }
    // Trigger the flip to the edit face
    this.flipCard(idx, 'edit');
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

    let globalCardIdx = 1;

    visitGroups.forEach((group, groupIdx) => {
      // 1. PRE-BUILD THE DOTS FOR THIS SPECIFIC GROUP
      const groupStartIdx = globalCardIdx;
      let groupDotsHtml = '';

      group.expenses.forEach((_, idx) => {
        const dotExpenseIdx = groupStartIdx + idx;
        // Note: We use app._scrollToCard assuming 'app' is your global instance variable
        groupDotsHtml += `<div class="card-dot secondary visible" data-expense-index="${dotExpenseIdx}" style="--dot-color:${group.color}" onclick="app._scrollToCard(${dotExpenseIdx})"></div>`;
      });



      // 2. BUILD THE CARDS
      group.expenses.forEach(exp => {
        const cardIdx = globalCardIdx;
        globalCardIdx++; // Increment after assigning current index

        const card = document.createElement('div');
        card.className = 'expense-card';
        card.id = `expense-card-${cardIdx}`;
        card.dataset.index = cardIdx;
        card.setAttribute('data-card-index', cardIdx);
        card.setAttribute('data-expense-id', exp.id);



        const isActive = group.id === this.activeVisit?.id;
        const visitBadge = `<span class="exp-visit-badge" style="background:${group.color}">${isActive ? 'Current Visit' : formatDateFriendly(group.date)}</span>`;
        const gradient = this._visitGradient(group.colorIdx);
        const vendorInitial = (exp.vendor || 'N').charAt(0).toUpperCase();
        const imgUrl = exp.receipt_url || exp.image_base64 || '';
        const isZero = exp.amount === 0;
        const imageHtml = imgUrl
          ? `<img src="${imgUrl}" class="expense-card-img" onload="this.classList.add('loaded')" onerror="this.classList.add('error')" alt="Receipt">`
          : '';
        const notesHtml = exp.notes
          ? `<div class="fallback-notes-bubble" style="border-left-color:${group.color}">
          <div class="fallback-category-pill" style="border-color:${group.color}80;color:${group.color};">${exp.category || 'Other'}</div>
          “${exp.notes}”</div>` : '';

        card.innerHTML = `
  <div class="card-inner" id="card-inner-${cardIdx}">
    
    <div class="card-face card-front" style="border:2.5px solid ${group.color}; background:${gradient};">
      ${imageHtml}
      <div class="fallback-card-content">
        <div class="fallback-card-header">
          <div class="fallback-vendor-circle" style="background:${group.color};border:1.5px solid ${group.color};color:white;">${vendorInitial}</div>    
          <div class="fallback-vendor-large">${exp.vendor || 'No Vendor'}</div> 
        </div>
        
        <div class="fallback-card-header">
          <div class="card-title" style="flex-grow: 0;font-size: 1rem; padding:0;">Receipt</div>  
          <div class="fallback-date-badge" style="color:${group.color}; margin-left:auto">
            <svg data-lucide="calendar" width="12" height="12"></svg>
            <span>${formatDateFriendly(exp.date)}</span>
          </div>
        </div>
            
        <div class="fallback-card-body">
          ${notesHtml}
          <div class="fallback-amount-large">£${parseFloat(exp.amount || 0).toFixed(2)}</div>
        </div>
        
        <div class="fallback-card-footer">
          <div class="card-dots-container" style="display: flex; gap: 6px; justify-content: flex-start; width: 100%;">
            ${groupDotsHtml}
          </div>
        </div>

        <div class="expense-btn-row">
          <div class="eCardBtn" onclick="app.editCard(${cardIdx})" title="Edit Expense">
            <svg data-lucide="pencil"></svg>
          </div>
          <div class="eCardBtn" onclick="${imgUrl ? `app.flipCard(${cardIdx}, 'back')` : ``}" title="View Image">
            ${imgUrl ? `<svg data-lucide="image"></svg>` : `<svg data-lucide="camera"></svg>`}
          </div>
            ${isZero ? `<div class="eCardBtn" onclick="app.deleteCard(${cardIdx})">
            <svg data-lucide="trash-2"></svg>
          </div>`: ``}

        </div>
      </div>
    </div>

    <div class="card-face card-back" id="card-back-${cardIdx}" style="border:1px solid ${group.color}; display: none;">
      <div class="receipt-state-overlay" id="receipt-state-${cardIdx}" style="position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.6); z-index: 10;">
        <span class="status-msg" style="color: white;"></span>
      </div>

      <div class="expense-card-overlay">
        <div class="expense-card-vendor">${exp.vendor || 'No Vendor'}</div>
        <div class="expense-card-amount">£${parseFloat(exp.amount || 0).toFixed(2)}</div>
        ${visitBadge}
      </div>
      
      <div class="expense-btn-row">
        <div class="eCardBtn" onclick="app.editCard(${cardIdx})" title="Edit Expense">
          <svg data-lucide="pencil"></svg>
        </div>
        <div class="eCardBtn" onclick="app.flipCard(${cardIdx}, 'front')" title="Back to Info">
          <svg data-lucide="info"></svg>
        </div>
      </div>
    </div>

    <div class="card-face card-edit" id="card-edit-${cardIdx}" style="border:1px solid ${group.color}; background: white; display: none;">
      <form id="expense-form-details-${cardIdx}" onsubmit="app.saveExpense(event, ${cardIdx})" class="expense-form-details" style="padding: 15px; height: 100%; display: flex; flex-direction: column;">
        
        <div>
          <div class="card-title" style="flex-grow: 0;font-size: 1rem; padding:0; opacity: 0.5; color:black">EDIT ENTRY</div>
          <div class="card-title" style="flex-grow: 0; font-size: 2rem;padding-top: 0; opacity: 0.8; color:black">Receipt</div>
        </div>

        <input type="number" id="exp-amount-${cardIdx}" class="form-control" step="0.01" min="0" placeholder="Amount: £0.00" value="${exp.amount || ''}">

        <select id="exp-category-${cardIdx}" class="form-control" required>
          <option value="Snacks" ${exp.category === 'Snacks' ? 'selected' : ''}> Snacks</option>
          <option value="Fuel" ${exp.category === 'Fuel' ? 'selected' : ''}> Fuel</option>
          <option value="Hotel" ${exp.category === 'Hotel' ? 'selected' : ''}> Hotel / Accommodation</option>
          <option value="Tolls" ${exp.category === 'Tolls' ? 'selected' : ''}> Tolls / Parking</option>
          <option value="Other" ${exp.category === 'Other' ? 'selected' : ''}> Other</option>
        </select>

        <input type="text" id="exp-vendor-${cardIdx}" class="form-control" placeholder="Vendor e.g. KFC" value="${exp.vendor || ''}">

        <textarea id="exp-notes-${cardIdx}" class="form-control" rows="2" placeholder="Brief Note">${exp.notes || ''}</textarea>

        <select id="log-select-visit-${cardIdx}" class="form-control linked-visit-row">
          <option value="${exp.visit_id || ''}">${exp.visit_id ? 'Keep Current Visit' : '-- Select a visit --'}</option>
        </select>

        <div class="expense-btn-row" style="margin-top: auto;">
          <button type="button" class="btn btn-secondary" onclick="app.flipCard(${cardIdx}, 'front')">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>

  </div>`;

        track.appendChild(card);
      });
    });

    if (typeof lucide !== 'undefined') {
      lucide.createIcons({ attrs: { stroke: 'currentColor', 'stroke-width': '2' }, nameAttr: 'data-lucide', root: track });
    }

    this._initDots();
    this._initSwipe();
    this._scrollToCard(this._cardIndex || 0, true);
  }

  // ── Build dots once — CSS transitions remain alive between updates ──
  // Call this once during your App setup
  _initDots() {
    const dotsContainer = document.getElementById('card-dots');
    const gDotsContainer = document.getElementById('group-dots');

    // Wait if elements don't exist yet
    if (!dotsContainer || !gDotsContainer) {
      setTimeout(() => this._initDots(), 100);
      return;
    }

    this._buildDotsOnce();
  }

  _initDots() {
    const gDotsContainer = document.getElementById('group-dots');
    if (!gDotsContainer) {
      setTimeout(() => this._initDots(), 100);
      return;
    }
    this._buildDotsOnce();
  }

  _buildDotsOnce() {
    const gDotsContainer = document.getElementById('group-dots');
    gDotsContainer.innerHTML = '';

    const groups = this._cardVisitGroups || [];
    let globalCardIdx = 1;

    groups.forEach((group, groupIdx) => {
      if (!group.expenses.length) return;

      // Build Primary Group Dot
      const gDot = document.createElement('div');
      gDot.className = `group-dot ${groupIdx === 0 ? 'first-group' : ''}`;
      gDot.dataset.groupIndex = String(groupIdx);
      gDot.style.backgroundColor = 'var(--text-primary)';
      gDot.onclick = () => this._scrollToCard(this._getFirstIndexForGroup(groupIdx));

      const groupStartIdx = globalCardIdx;

      // Build Secondary Dots
      group.expenses.forEach((_, idx) => {
        const dotExpenseIdx = groupStartIdx + idx;
        const secDot = document.createElement('div');

        // Removed the 'visible' class. We will let CSS handle visibility.
        secDot.className = 'card-dot secondary';
        secDot.dataset.expenseIndex = String(dotExpenseIdx);
        secDot.dataset.groupIndex = String(groupIdx);
        secDot.style.setProperty('--dot-color', group.color);

        // CRITICAL FIX: Stop event bubbling
        secDot.onclick = (e) => {
          e.stopPropagation(); // Stops the parent gDot from being clicked too
          this._scrollToCard(dotExpenseIdx);
        };

        gDot.appendChild(secDot);
        globalCardIdx++;
      });

      gDotsContainer.appendChild(gDot);
    });

    this._updateActiveDot();
  }

  _updateActiveDot() {
    const gDotsContainer = document.getElementById('group-dots');
    if (!gDotsContainer) return;

    // 1. Determine which group we are currently looking at
    const currentGroupIdx = this._getGroupIndexFromExpenseIndex(this._cardIndex);

    // 2. Update Primary Group Dots
    gDotsContainer.querySelectorAll('.group-dot').forEach(gDot => {
      const isTargetGroup = parseInt(gDot.dataset.groupIndex) === currentGroupIdx;
      gDot.classList.toggle('active', isTargetGroup);
    });

    // 3. Update Secondary Dots (which are now nested inside)
    gDotsContainer.querySelectorAll('.card-dot.secondary').forEach(secDot => {
      const dotExpenseIdx = parseInt(secDot.dataset.expenseIndex);
      // Highlight if this is the currently active expense card
      secDot.classList.toggle('active', dotExpenseIdx === this._cardIndex);
    });

    // 4. Update Secondary Dots (which now live inside the cards)
    document.querySelectorAll('.card-dots-container .card-dot.secondary').forEach(dot => {
      const dotExpenseIdx = parseInt(dot.dataset.expenseIndex);
      dot.classList.toggle('active', dotExpenseIdx === this._cardIndex);
    });
  }


  // Ensure these helpers are in your class
  _getFirstIndexForGroup(targetGroupIdx) {
    let count = 1;
    for (let i = 0; i < targetGroupIdx; i++) {
      count += (this._cardVisitGroups[i].expenses?.length || 0);
    }
    return count;
  }

  _getGroupIndexFromExpenseIndex(expenseIdx) {
    // If we are looking at the "Add New" card (index 0), 
    // it doesn't belong to any visit group. Return -1 so no group dot highlights.
    if (expenseIdx === 0) return -1;

    // Start at 1 to account for the 'Add New' card offset
    let runningCount = 1;

    for (let i = 0; i < this._cardVisitGroups.length; i++) {
      const groupLength = this._cardVisitGroups[i].expenses?.length || 0;

      if (expenseIdx < runningCount + groupLength) {
        return i;
      }
      runningCount += groupLength;
    }

    return this._cardVisitGroups.length - 1; // Fallback to last group
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
      const scale = Math.max(0.88, 1 - Math.min(1, diff) * 0.12);
      const opacity = Math.max(0.4, 1 - Math.min(1, diff) * 0.6);
      card.style.transform = `scale(${scale.toFixed(4)})`;
      card.style.opacity = opacity.toFixed(4);
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
  _initSwipeNew() {
    const t = document.getElementById('card-track');
    if (!t) return;

    if (this._swipeBound) return;
    this._swipeBound = true;

    let isDragging = false;
    let hasMoved = false;
    let startX = 0;
    let currentTranslate = 0;

    const getCardWidth = () => t.parentElement ? t.parentElement.getBoundingClientRect().width : window.innerWidth;

    const endDrag = (clientX) => {
      if (!isDragging) return;
      isDragging = false;
      t.classList.remove('dragging');

      // RESET: Restore transition so the snap is smooth
      t.style.transition = 'transform 0.4s cubic-bezier(0.23, 1, 0.32, 1)';

      // LOGIC: Snap to the nearest card based on current drag position
      const cardWidth = getCardWidth();
      const currentPos = this._getTranslateX(); // Helper to get current matrix value
      const nearestIndex = Math.round(Math.abs(currentPos) / cardWidth);

      // Safety bounds
      const targetIndex = Math.max(0, Math.min(this._cardExpenses.length - 1, nearestIndex));

      this._scrollToCard(targetIndex);
    };

    t.addEventListener('pointerdown', (e) => {
      // Ignore if clicking a button (flip/close) or input
      const tag = e.target.tagName.toLowerCase();
      const isActionBtn = e.target.closest('.eCardBtn') || e.target.closest('.expense-detail-close');

      if (['input', 'select', 'textarea'].includes(tag) || isActionBtn) return;

      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      currentTranslate = this._getTranslateX();
      t.style.transition = 'none'; // Disable transition during drag
    });

    t.addEventListener('pointermove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      if (Math.abs(deltaX) > 6) hasMoved = true;
      if (!hasMoved) return;

      e.preventDefault();
      t.classList.add('dragging');

      // Calculate translate
      let newTranslate = currentTranslate + deltaX;

      // Elastic Resistance (The "Phone Feel"): 
      // If we go past the first or last card, slow down the drag speed
      const cardWidth = getCardWidth();
      const minTranslate = -(this._cardExpenses.length - 1) * cardWidth;

      if (newTranslate > 0) newTranslate *= 0.3; // Resistance at start
      if (newTranslate < minTranslate) newTranslate = minTranslate + (newTranslate - minTranslate) * 0.3; // Resistance at end

      t.style.transform = `translateX(${newTranslate}px)`;
    }, { passive: false });

    // ... pointerup and pointercancel remain similar, just ensure they call endDrag(e.clientX)
  }


  _getTranslateX() {
    const t = document.getElementById('card-track');
    const style = window.getComputedStyle(t);
    const matrix = new WebKitCSSMatrix(style.transform);
    return matrix.m41; // This gets the X value directly
  }

  _initSwipe() {
    const t = document.getElementById('card-track');
    if (!t) return;

    // FIX: Only bind the swipe events once! 
    // Cloning the node destroys the file input and amount input listeners.
    if (this._swipeBound) return;
    this._swipeBound = true;

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

    if (show) {
      // 1. Make sure the user is on the record tab where the form lives
      if (this.currentTab !== 'sync') {
        this.switchTab('sync');
      }
      // 3. Keep your reliable trigger to populate the past visits dropdown menu
      if (typeof this.loadPastVisits === 'function') {
        this.loadPastVisits();
      }

      // 4. Turn the bottom navigation bar into the Setup Control Panel
      this.updateNavbarLayout('VISIT_SETUP');

    } else {
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
    const vendor = (document.getElementById('exp-vendor').value || '').trim();
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

    document.getElementById('expense-form-title').textContent = 'Edit Receipt';

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

  async deleteVisit(visitId) {
    if (!visitId) return;
    if (!confirm('Are you sure you want to delete this empty visit? This cannot be undone.')) return;

    this.log(`Deleting visit: ${visitId}`);

    // 1. Remove from local memory arrays
    if (this._visitMap && this._visitMap[visitId]) {
      delete this._visitMap[visitId];
    }
    if (Array.isArray(this.visits)) {
      this.visits = this.visits.filter(v => (v.visit_id || v.id) !== visitId);
    }
    if (Array.isArray(this._allVisits)) {
      this._allVisits = this._allVisits.filter(v => (v.visit_id || v.id) !== visitId);
    }

    // 2. Remove from pending offline queue (if it hasn't synced to server yet)
    try {
      let pendingVisits = JSON.parse(localStorage.getItem('mavis_pending_visits') || '[]');
      pendingVisits = pendingVisits.filter(v => (v.visit_id || v.id) !== visitId);
      localStorage.setItem('mavis_pending_visits', JSON.stringify(pendingVisits));
    } catch (_) { }

    // 3. Backend Sync Placeholder
    const { webappUrl: url, secretKey: token } = this.settings;
    if (url) {
      try {
        /*
        // UNCOMMENT THIS WHEN 'delete_visit' IS BUILT IN CODE.GS
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            action: 'delete_visit',
            token,
            visit_id: visitId
          })
        });
        const data = await res.json();
        if (!data.success) {
          this.log('Server delete failed: ' + data.message);
        }
        */
        this.log('[Placeholder] Backend delete logic bypassed.');
      } catch (err) {
        this.log('Network error during delete: ' + err.message);
      }
    }

    // 4. Update the UI
    this._showToast('🗑 Visit deleted.');
    this.renderHistory();
  }

  cancelEdit() {
    this.editingExpenseId = null;
    const form = document.getElementById('expense-form-details');
    if (form) form.reset();
    const title = document.getElementById('expense-form-title');
    if (title) title.textContent = 'New Receipt';
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
    const locBtn = document.getElementById('pwa-view-btn-loc');
    const calBtn = document.getElementById('pwa-view-btn-cal');
    const listEl = document.getElementById('pwa-view-list');
    const locEl = document.getElementById('pwa-view-loc');
    const calEl = document.getElementById('pwa-view-calendar');
    const titleText = document.getElementById('history-title-text');
    const calTitle = document.getElementById('calender-title-text');
    const locTitle = document.getElementById('loc-title-text');
    const filterExpenses = document.getElementById('filter-expenses');

    if (listBtn) { listBtn.classList.toggle('active', view === 'list'); listBtn.setAttribute('aria-pressed', view === 'list'); }
    if (calBtn) { calBtn.classList.toggle('active', view === 'cal'); calBtn.setAttribute('aria-pressed', view === 'cal'); }
    if (locBtn) { locBtn.classList.toggle('active', view === 'loc'); locBtn.setAttribute('aria-pressed', view === 'loc'); }
    if (listEl) listEl.style.display = view === 'list' ? 'flex' : 'none';
    if (locEl) locEl.style.display = view === 'loc' ? 'flex' : 'none';
    if (calEl) calEl.style.display = view === 'cal' ? 'flex' : 'none';

    if (view === 'list') {
      if (titleText) titleText.textContent = 'Visit List';
      if (calTitle) calTitle.textContent = 'Calendar';
      if (filterExpenses) filterExpenses.style.display = 'flex';
      this.renderListView();
    }
    if (view === 'cal') {
      if (titleText) titleText.textContent = 'List';
      if (filterExpenses) filterExpenses.style.display = 'none';
      if (this._archiveMode) {
        this._archiveMode = false;
        const archiveBtn = document.getElementById('btn-archive-view');
        if (archiveBtn) archiveBtn.classList.remove('active');
      }
      this.renderCalendarView();
    }
    if (view === 'loc') {
      if (locTitle) titleText.textContent = '';
      if (filterExpenses) filterExpenses.style.display = 'none';
      this.renderLocationsList();
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


  _toggleFilter() {
    const filterBnt = document.getElementById('filter-expenses');
    const filterBar = document.getElementById('filter-bar');

    // If it's already open, close it. Otherwise, open it.
    if (filterBar.style.display === 'flex') {
      filterBar.style.display = 'none';
      filterBnt.classList.remove('active');
    } else {
      filterBar.style.display = 'flex';
      filterBnt.classList.add('active');
    }
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
    const locSel = document.getElementById('pwa-filter-location');
    if (!yearSel || !monthSel) return;

    const prevYear = yearSel.value;
    const prevMonth = monthSel.value;
    const prevLoc = locSel ? locSel.value : 'all';

    const years = new Set();
    const months = new Set();
    const locations = new Set();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Extract unique data
    (this._allRows || []).forEach(row => {
      // 1. Dates
      const key = this._parseDateToKey(row.date);
      if (key) {
        const [y, m] = key.split('-');
        if (y) years.add(y);
        if (m) months.add(m);
      }
      // 2. Locations via visitMap lookup
      const vId = row.visit_id;
      const dest = (this._visitMap && this._visitMap[vId]) ? this._visitMap[vId].destination : null;
      if (dest && dest.trim() !== '') locations.add(dest.trim());
    });

    // Populate Year Dropdown
    const yearArr = Array.from(years).sort().reverse();
    const yearLabel = yearArr.length === 1 ? yearArr[0] : (yearArr.length ? `${yearArr.length} Years` : 'All Yrs');
    yearSel.innerHTML = `<option value="all">${yearLabel}</option>`;
    yearArr.forEach(y => yearSel.appendChild(new Option(y, y)));

    // Populate Month Dropdown
    const monthArr = Array.from(months).sort();
    const monthLabel = monthArr.length === 1 ? monthNames[parseInt(monthArr[0], 10) - 1] : (monthArr.length ? `${monthArr.length} Months` : 'All Mos');
    monthSel.innerHTML = `<option value="all">${monthLabel}</option>`;
    monthArr.forEach(m => {
      const idx = parseInt(m, 10) - 1;
      if (monthNames[idx]) monthSel.appendChild(new Option(monthNames[idx], m));
    });

    // Populate Location Dropdown
    if (locSel) {
      const locArr = Array.from(locations).sort();
      const locLabel = locArr.length === 1 ? locArr[0] : (locArr.length ? `${locArr.length} Locations` : 'All Locations');
      locSel.innerHTML = `<option value="all">${locLabel}</option>`;
      locArr.forEach(l => locSel.appendChild(new Option(l, l)));
      // Restore location
      if (prevLoc !== 'all' && [...locSel.options].some(o => o.value === prevLoc)) locSel.value = prevLoc;
    }

    // Restore selections
    if ([...yearSel.options].some(o => o.value === prevYear)) yearSel.value = prevYear;
    if (prevMonth !== 'all' && [...monthSel.options].some(o => o.value === prevMonth)) monthSel.value = prevMonth;
  }


  _populateHistoryFiltersOld() {
    const yearSel = document.getElementById('pwa-filter-year');
    const monthSel = document.getElementById('pwa-filter-month');
    if (!yearSel || !monthSel) return;

    const prevYear = yearSel.value;
    const prevMonth = monthSel.value;

    // 1. Collect unique years and months from actual data
    const years = new Set();
    const months = new Set();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    (this._allRows || []).forEach(row => {
      const key = this._parseDateToKey(row.date); // Expecting "YYYY-MM"
      if (key) {
        const [y, m] = key.split('-');
        if (y) years.add(y);
        if (m) months.add(m);
      }
    });

    // 2. Populate Year Dropdown with dynamic dynamic default label
    const yearCount = years.size;
    const yearLabel = `${yearCount} Year${yearCount === 1 ? '' : 's'}`;

    yearSel.innerHTML = `<option value="all">${yearLabel}</option>`;
    Array.from(years).sort().reverse().forEach(y => {
      const o = document.createElement('option');
      o.value = y;
      o.textContent = y;
      yearSel.appendChild(o);
    });

    // 3. Populate Month Dropdown with dynamic default label & only existing months
    const monthCount = months.size;
    const monthLabel = `${monthCount} Month${monthCount === 1 ? '' : 's'}`;

    monthSel.innerHTML = `<option value="all">${monthLabel}</option>`;
    Array.from(months).sort().forEach(m => {
      const monthIndex = parseInt(m, 10) - 1;
      if (monthNames[monthIndex]) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = monthNames[monthIndex];
        monthSel.appendChild(o);
      }
    });

    // 4. Restore previous selections if valid
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



    // ── Filter values ─────────────────────────────────────────
    const yearFilter = document.getElementById('pwa-filter-year')?.value || 'all';
    const monthFilter = document.getElementById('pwa-filter-month')?.value || 'all';
    const statusFilter = document.getElementById('pwa-filter-status')?.value || 'all';
    const locationFilter = document.getElementById('pwa-filter-location')?.value || 'all';

    // ── Source rows ───────────────────────────────────────────
    const sourceRows = this._archiveMode
      ? (this._archivedRows || [])
      : (this._allRows || []).filter(row => (row.archive || '').toLowerCase() !== 'yes');

    // ── Filter Rows ───────────────────────────────────────────
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

      if (locationFilter !== 'all') {
        const vId = row.visit_id;
        const dest = (this._visitMap && this._visitMap[vId]) ? this._visitMap[vId].destination : (row.destination || '');
        if (dest.trim().toLowerCase() !== locationFilter.trim().toLowerCase()) return false;
      }

      return true;
    });

    // ── Filter Visits (Uses yearFilter & monthFilter) ─────────
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

    const open = group.status === 'Open';

    this._renderVisitBar();




    const hEl = document.createElement('div');
    hEl.className = 'history-group-header';
    // 1. Pre-calculate dynamic sub-elements
    const activeIndicator = open ? '<span class="active-visit"></span>' : '';

    const rightContent = open
      ? `<span class="btn btn-primary" onclick="event.stopPropagation(); app.endVisit('${group.visit_id}')">
      <div class="group-meta badge" style="background-color:${syncDotCol}">${expCount}</div>
      End Visit
      </span>`
      : `
    ${expCount > 0 ? `<div class="group-meta" style="background-color:${syncDotCol}">${expCount} item${expCount !== 1 ? 's' : ''}</div>` : ''}
    <div class="group-sum">£${expSum.toFixed(2)}</div>
  `;

    if (open || expCount === 0) {
      gEl.style.display = 'none';
    }
    // 2. Clean, straightforward HTML assignment
    hEl.innerHTML = `
      ${activeIndicator}
      <div class="group-title">
        <div class="visit-destination">${this._escHTML(destName)}</div>
        <div class="visit-date">${formatDateFriendly(dateStr)}</div>
      </div>
      ${rightContent}
    `;


    const cEl = document.createElement('div');
    cEl.className = 'history-group-content';

    group.expenses.forEach(log => cEl.appendChild(this._buildListLogItem(log)));


    hEl.addEventListener('click', () => {
      if (open) {
        this.switchTab('record');
      }
      else if (expCount > 0) {
        cEl.classList.toggle('open');
        hEl.classList.toggle('open');
      }
      else if (expCount === 0) {
        hEl.classList.toggle('open');
      }
    });


    const fEl = document.createElement('div');
    fEl.className = 'history-group-footer';
    fEl.innerHTML = `
      <div class="group-footer">
        ${distStr ? `<span class="group-mileage">${distStr ? `${distStr}` : ''}${mileVal ? ` &bull; ${mileVal}` : ''}</span>` : ''} </div>
        
        ${expCount === 0 ? `<button class="btn btn-sm btn-danger" onclick="(e)=>{e.stopPropagation();this.deleteVisit('${group.visit_id}')}">Delete</button>` :
        `<button class="btn btn-sm btn-success" onclick="(e)=>{e.stopPropagation();this.addExpense('${group.visit_id}')}">Add Expense</button>`}
        
    `;

    gEl.appendChild(hEl);
    gEl.appendChild(cEl);
    gEl.appendChild(fEl)
    return gEl;
  }

  _buildListLogItem(log) {
    const status = (log.status || log.sync_status || '').toLowerCase();
    const isSynced = status === 'synced';
    const isArchived = (log.archive || '').toLowerCase() === 'yes';
    const amountVal = parseFloat(log.amount);
    const amtText = amountVal > 0 ? `£${amountVal.toFixed(2)}` : '£0.00';

    // ── Status-aware swipe label config ──────────────────────────────────────
    const leftAction = isSynced ? 'pending' : 'synced';
    const leftLabel = isSynced ? 'Pending' : 'Claim';
    const leftIcon = isSynced ? 'check-circle-2' : 'check-circle';
    const rightAction = isArchived ? 'pending' : 'archive';
    const rightLabel = isArchived ? 'Restore' : 'Archive';
    const rightIcon = isArchived ? 'rotate-ccw' : 'archive';

    let attachmentIcon = '';
    if (log.receipt_url || log.image_base64) {
      attachmentIcon = `<span class="attachment-icon" title="Has attachment"> &bull; ${this._escHTML(log.category || '')} &nbsp; <svg data-lucide="paperclip" width="12" height="12"></svg></span>`;
    } else if (log.receipt_pending) {
      attachmentIcon = `<span title="Receipt upload pending" style="color:var(--warning)">&bull; ${this._escHTML(log.category || '')} &nbsp; <svg data-lucide="paperclip" width="12" height="12"></svg></span>`;
    }

    const imgSrc = log.receipt_url || log.image_base64 || '';
    const dummyId = `rd-${log.id}`;

    // Gradient palette reuses the visit-colour logic (index 0 as default)
    const dGradient = `linear-gradient(135deg, hsl(258, 50%, 22%) 0%, hsl(288, 40%, 10%) 100%)`;
    const dColor = 'hsl(258, 70%, 62%)';
    const dInitial = (log.vendor || 'E').charAt(0).toUpperCase();

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

      const content = div.querySelector('.receipt-dummy-card');
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

      const content = div.querySelector('.receipt-dummy-card');
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
          content.style.transition = 'transform 0.15s ease';
          content.style.transform = 'translateX(-8px)';
          setTimeout(() => snapBack(), 160);
          return;
        }
        content.style.transition = 'transform 0.15s ease';
        content.style.transform = `translateX(-${THRESHOLD}px)`;
        if (bgLeft) { bgLeft.innerHTML = '<span style="padding:0 1rem">Updating…</span>'; }
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

    // Swipe background labels
    const leftBgStyle = isSynced
      ? 'background: linear-gradient(90deg, hsla(0, 89%, 56%, 1.00), hsla(9, 100%, 50%, 0.96));'
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
      
        <div class="receipt-dummy-card" id="${dummyId}">
          

            <!-- FRONT: summary + actions -->
            <div class="receipt-dummy-front" 
            style="background:${dGradient};border:1px solid ${dColor}; 
            border-right:${isSynced ? '5px solid  var(--secondary)' : '5px solid  orange'};
            border-left:${isArchived ? '5px solid var(--text-primary)' : ''}">           

           
              <!-- Collapsed / Header state -->
              <div class="list-card-header">
                <div class="list-card-vendor-circle" style="background:${dColor};color:#fff;">${dInitial}</div>
                <div class="list-card-title-area">
                  <div class="receipt-dummy-vendor">${this._escHTML(log.vendor || 'Expense')}</div>
                  <div class="list-card-meta">  ${formatDateFriendly(log.date)} ${attachmentIcon}</div>
                </div>
                <div class="list-card-right-area">
                  <div class="receipt-dummy-amount">${amtText}</div>
                  <span class="log-badge ${isSynced ? 'badge-synced' : isArchived ? 'badge-archived' : 'badge-pending'}">${isSynced ? 'Claimed' : isArchived ? 'Archived' : 'Pending'}</span>
                </div>
              </div>

              <!-- Expanded state content -->
              <div class="list-card-expanded-content">



                ${log.notes ? `
                  <div class="fallback-notes-bubble"">
                  <div class="expense-card-category"> ${this._escHTML(log.category || '')} </div>
                   ${this._escHTML(log.notes)}
                  </div>` : ''}

                <div class="receipt-dummy-amount">${amtText}</div>
                
                ${log.receipt_pending && !log.receipt_url ? `
                  <div id="receipt-status-${log.id}" class="receipt-status receipt-status--failed" onclick="event.stopPropagation()" style="margin-bottom:0.5rem;">
                    ⚠️ Receipt not uploaded —
                    <button class="inline-retry-btn" onclick="event.stopPropagation(); app.retryReceiptUpload('${log.id}')">Retry</button>
                  </div>` : ''}

                <!-- Action buttons -->
                <div class="action-buttons" style="display:flex;gap:0.5rem;margin-top:auto;flex-wrap:wrap;width:100%">
                  <button class="action-btn" onclick="event.stopPropagation(); app.openExpenseForEdit(${this._escAttr(JSON.stringify(log))}); app.expenseMode(true)"><svg data-lucide="edit-3" width="14" height="14"></svg></button>
                  <button class="action-btn archive-btn ${isArchived ? 'active-action' : ''}" onclick="event.stopPropagation(); app.updateExpenseStatus('${log.id}', '${rightAction}')"><svg data-lucide="${rightIcon}" width="14" height="14"></svg></button>
                  <button class="action-btn trash-btn" onclick="event.stopPropagation(); app.updateExpenseStatus('${log.id}', 'trash')"><svg data-lucide="trash-2" width="14" height="14"></svg></button>
                  
                  <!-- Unified claimed/pending toggle button -->
                  <button class="action-btn claim-toggle-btn ${isSynced ? 'claimed' : 'pending'}" onclick="event.stopPropagation(); app.toggleClaimStatus('${log.id}', ${isSynced})">
                    <svg data-lucide="${isSynced ? 'check-circle' : 'clock'}" width="14" height="14"></svg>
                    <span>${isSynced ? 'Claimed' : 'Pending'}</span>
                  </button>
                   ${imgSrc ? `
                  <button type="button" class="receipt-dummy-flip-btn" onclick="event.stopPropagation(); document.getElementById('${dummyId}').classList.toggle('flipped')" title="View Receipt">
                    <svg data-lucide="paperclip" width="16" height="16"></svg>
                  </button>
                  ` : ''}
                </div>
              </div>

            
            </div>

            <!-- BACK: receipt image -->
            <div class="receipt-dummy-back" style="border:2px solid ${dColor};">
              <img src="${this._formatImageUrl(imgSrc)}" class="receipt-dummy-back-img" onload="this.classList.add('loaded')" onerror="this.style.display='none'" alt="Receipt">
              <div class="receipt-dummy-back-placeholder" style="${imgSrc ? 'display:none' : ''}">
                <svg data-lucide="image-off" width="28" height="28"></svg>
                <span>No receipt image</span>
              </div>
              <button type="button" class="receipt-dummy-close-btn" onclick="event.stopPropagation(); document.getElementById('${dummyId}').classList.remove('flipped')" title="Close">
                <svg data-lucide="x" width="16" height="16"></svg>
              </button>
            </div>

          
        </div>
    
    `;

    // Toggle expand/collapse on click of the log-item-info (unless swipe is active or child buttons are clicked)
    const infoEl = div.querySelector('.receipt-dummy-card');
    if (infoEl) {
      infoEl.addEventListener('click', (e) => {
        if (this._dragState && this._dragState.active) return;
        // Don't toggle if clicked a button or interactive child element
        if (e.target.closest('button') || e.target.closest('.action-btn') || e.target.closest('.receipt-dummy-flip-btn') || e.target.closest('.receipt-dummy-close-btn')) return;
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


  _formatImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('/')) return url;
    return 'receipts/' + url;
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
    const archiveVal = action === 'archive' ? 'Yes' : 'No';
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
