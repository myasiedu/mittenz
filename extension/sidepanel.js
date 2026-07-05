/**
 * MavisCompanion - Extension Sidebar Controller v2
 * Features: Light/Dark theme, Card/List/Calendar views, day-cell popup
 */

class MavisCompanionSidePanel {



  constructor() {
    this.config = null;
    this.allRows = [];
    this.pendingRows = [];
    this.allVisits = []; // Prevent TypeErrors before data is loaded
    this.selectedRow = null;

    // Calendar state
    this._calDate = new Date(); // year/month being displayed
    this._calDate.setDate(1);
    this._currentTheme = 'dark';

    // Active view: 'card' | 'list' | 'cal'
    this._activeView = 'cal';
  }

  // =========================================================
  // INIT
  // =========================================================
  init() {
    console.log('[Companion] SidePanel v2 active.');

    // Load persisted theme + view
    this._loadPreferences().then(() => {
      this.loadConfigurationAndFetch();
    });

    // Config tab button in switcher bar
    const btnMenu = document.getElementById('view-btn-config');
    if (btnMenu) btnMenu.addEventListener('click', () => this.setView('config'));

    const btnSaveConfig = document.getElementById('btn-save-config');
    if (btnSaveConfig) btnSaveConfig.addEventListener('click', () => this.saveConfig());

    // Load Defaults button in configuration tab
    const btnLoadDefaults = document.getElementById('btn-load-defaults');
    if (btnLoadDefaults) btnLoadDefaults.addEventListener('click', () => this.loadDefaults());

    // Settings theme toggle button in configuration tab
    const btnCfgTheme = document.getElementById('cfg-theme-toggle');
    if (btnCfgTheme) btnCfgTheme.addEventListener('click', () => this.toggleTheme());

    // Open settings page in a new tab button in configuration tab
    const btnOpenSettingsTab = document.getElementById('btn-open-settings-tab');
    if (btnOpenSettingsTab) btnOpenSettingsTab.addEventListener('click', () => window.open('config.html', '_blank'));

    // Settings button in bottom vertical menu (still keep it as an option if visible)
    const btnSettings = document.getElementById('btn-open-settings');
    if (btnSettings) btnSettings.addEventListener('click', () => this.showConfigTab());

    // Refresh button in bottom vertical menu
    const btnRefresh = document.getElementById('btn-refresh-extension');
    if (btnRefresh) btnRefresh.addEventListener('click', () => this.fetchPendingLogs());

    // Refresh button in header next to gear
    // Re-bind configuration listeners
    const configPanel = document.getElementById('configPanel');
    if (configPanel) {
      configPanel.addEventListener('input', (e) => {
        if (e.target.id === 'cfg-webapp-url' || e.target.id === 'cfg-secret-key') {
          const btn = document.getElementById('btn-save-config');
          if (btn) {
            btn.textContent = 'Save Configuration';
            btn.className = 'btn btn-primary';
          }
        }
      });
    }

    // Top bar connect click delegation
    document.addEventListener('click', (e) => {
      const btnRefresh = e.target.closest('#btn-refresh-header');
      if (btnRefresh) {
        const status = btnRefresh.getAttribute('data-status');
        if (status === 'required') {
          this.setView('config');
        } else {
          this.fetchPendingLogs();
        }
      }

      const btnSaveConfig = e.target.closest('#btn-save-config');
      if (btnSaveConfig) {
        this.saveConfig();
      }
    });

    // Theme toggle button
    const btnTheme = document.getElementById('btn-theme-toggle');
    if (btnTheme) btnTheme.addEventListener('click', () => this.toggleTheme());

    // View switcher buttons
    //document.getElementById('view-btn-card').addEventListener('click', () => this.setView('list')); 
    document.getElementById('view-btn-list').addEventListener('click', () => this.setView('list'));
    document.getElementById('view-btn-cal').addEventListener('click', () => this.setView('cal'));
    // Calendar navigation
    const prevYearBtn = document.getElementById('cal-year-prev');
    if (prevYearBtn) prevYearBtn.addEventListener('click', () => this._calShiftYear(-1));
    const nextYearBtn = document.getElementById('cal-year-next');
    if (nextYearBtn) nextYearBtn.addEventListener('click', () => this._calShiftYear(+1));

    // List filters
    ['filter-year', 'filter-month', 'filter-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
        if (this._activeView === 'list') this.renderAllLog();
      });
    });

    // Day popup dismiss (tap backdrop)
    document.getElementById('day-popup-overlay').addEventListener('click', (e) => {
      if (e.target === document.getElementById('day-popup-overlay')) this.closeDayPopup();
    });
  }

  // =========================================================
  // PREFERENCES  (theme + view mode)
  // =========================================================
  _loadPreferences() {
    return new Promise((resolve) => {
      const storage = this._getStorage();
      if (storage) {
        storage.get(['mavis_theme', 'mavis_view', 'mavis_companion_config'], (data) => {
          const theme = data.mavis_theme || 'light';
          const view = data.mavis_view || 'cal';
          if (data.mavis_companion_config) {
            this.config = data.mavis_companion_config;
          }
          this.applyTheme(theme);
          this.setView(view);
          resolve();
        });
      } else {
        this.applyTheme('light');
        this.setView('config');
        resolve();
      }
    });
  }

  _formatDateFriendly(dateStr) {
    if (!dateStr) return '—';
    try {
      let s = typeof dateStr === 'string' ? dateStr.trim() : dateStr.toISOString();
      const key = this._parseDateToKey(s);
      if (!key) return s;
      const [year, month, day] = key.split('-');
      const d = new Date(`${year}-${month}-${day}T00:00:00`);
      if (isNaN(d.getTime())) return s;

      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
    } catch (_) {
      return dateStr;
    }
  }

  _getStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
    return null;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================================================
  // THEME
  // =========================================================
  applyTheme(theme) {
    this._currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const moon = document.getElementById('sp-icon-moon');
    const sun = document.getElementById('sp-icon-sun');
    if (moon) moon.style.display = theme === 'dark' ? 'block' : 'none';
    if (sun) sun.style.display = theme === 'light' ? 'block' : 'none';

    const cfgMoon = document.getElementById('cfg-icon-moon');
    const cfgSun = document.getElementById('cfg-icon-sun');
    if (cfgMoon) cfgMoon.style.display = theme === 'dark' ? 'block' : 'none';
    if (cfgSun) cfgSun.style.display = theme === 'light' ? 'block' : 'none';

    const storage = this._getStorage();
    if (storage) storage.set({ mavis_theme: theme });
  }

  toggleTheme() {
    this.applyTheme(this._currentTheme === 'dark' ? 'light' : 'dark');
  }

  // =========================================================
  // VIEW MODE
  // =========================================================
  setView(view) {
    this._activeView = view;

    // Update pill buttons
    ['cal', 'card', 'list', 'config'].forEach(v => {
      const btn = document.getElementById(`view-btn-${v}`);
      if (btn) {
        btn.classList.toggle('active', v === view);
        btn.setAttribute('aria-pressed', v === view ? 'true' : 'false');
      }
    });

    // Show/hide containers
    const views = { card: 'view-cards', list: 'view-list', cal: 'view-calendar', config: 'configPanel' };
    Object.entries(views).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = key === view ? '' : 'none';
    });

    // Persist
    const storage = this._getStorage();
    if (storage) storage.set({ mavis_view: view });

    // Re-render whatever is current
    this._renderCurrentView();
  }

  _renderCurrentView() {
    if (this._activeView === 'list') this.renderAllLog();
    if (this._activeView === 'cal') this.renderCalendarView();
    if (this._activeView === 'config') this.showConfigTab();
  }

  // =========================================================
  // CONFIGURATION & FETCH
  // =========================================================
  loadConfigurationAndFetch() {
    if (this.config && this.config.webappUrl) {
      this.applyConfig();
      return;
    }
    const storage = this._getStorage();
    if (storage) {
      storage.get('mavis_companion_config', (data) => {
        if (data.mavis_companion_config) {
          this.config = data.mavis_companion_config;
          this.applyConfig();
        } else {
          this.setView('config');
        }
      });
    } else {
      const saved = localStorage.getItem('mavis_companion_config_mock');
      if (saved) {
        try { this.config = JSON.parse(saved); } catch (e) { }
      }
      this.applyConfig();
    }
  }

  applyConfig() {
    const btnSaveConfig = document.getElementById('btn-save-config');
    if (btnSaveConfig) {
      btnSaveConfig.textContent = 'Save Configuration';
      btnSaveConfig.className = 'btn btn-secondary';
    }

    if (!this.config || !this.config.webappUrl) {
      this._setConnStatus('required');
      this.setView('config');
      return;
    }

    this._setConnStatus('connecting');
    this.fetchPendingLogs();
  }

  async fetchPendingLogs() {

    if (!this.config || !this.config.webappUrl) return;

    const url = `${this.config.webappUrl}?action=get_all_logs&token=${encodeURIComponent(this.config.secretKey)}`;


    try {
      const response = await fetch(url, { credentials: 'omit' });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error("Raw response:", text);
        throw new Error(`Invalid JSON response from Google. First 100 chars: ${text.substring(0, 100)}`);
      }

      if (data.success) {
        this.allRows = data.rows || [];
        this.pendingRows = this.allRows.filter(r => r.sync_status === 'Pending');

        // Also fetch visits
        const visitRes = await fetch(`${this.config.webappUrl}?action=get_visits&token=${encodeURIComponent(this.config.secretKey)}`, { credentials: 'omit' });
        const visitData = await visitRes.json();
        if (visitData.success) {
          this.allVisits = visitData.visits || [];
          console.log(this.allVisits);
        } else {
          this.allVisits = [];
          console.warn("Could not fetch visits:", visitData.message);
        }

        this._setConnStatus('connected');

        const listBtn = document.getElementById('view-btn-list');
        if (this.pendingRows.length > 0) {
          if (listBtn) {
            let badge = listBtn.querySelector('.pending-badge-sup');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'pending-badge-sup';
              badge.style.cssText = 'position:absolute; top:-5px; right:-5px; background:var(--danger); color:white; border-radius:50%; font-size:0.6rem; width:14px; height:14px; display:flex; align-items:center; justify-content:center; font-weight:bold;';
              listBtn.appendChild(badge);
            }
            badge.textContent = this.pendingRows.length;
          }
          this.setView('list');
          const filterStatus = document.getElementById('filter-status');
          if (filterStatus) filterStatus.value = 'pending';
        } else {
          if (listBtn) {
            const badge = listBtn.querySelector('.pending-badge-sup');
            if (badge) badge.remove();
          }
          this.setView('cal');
        }

        this._populateFilters();
        this._renderCurrentView();
      } else {
        throw new Error(data.message || 'Apps Script rejected request.');
      }
    } catch (err) {
      console.error('[Extension] Fetch failed:', err);
      this._setConnStatus('failed');
      this.setView('config');
    }
  }

  _populateFilters() {
    const yearSelect = document.getElementById('filter-year');
    const monthSelect = document.getElementById('filter-month');
    if (!yearSelect || !monthSelect) return;

    const currentYear = yearSelect.value;
    const currentMonth = monthSelect.value;

    const years = new Set();
    this.allRows.forEach(row => {
      const key = this._parseDateToKey(row.date);
      if (key) years.add(key.split('-')[0]);
    });

    yearSelect.innerHTML = '<option value="all">All Yrs</option>';
    Array.from(years).sort().reverse().forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    });

    monthSelect.innerHTML = '<option value="all">All Mos</option>';
    const mos = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    mos.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1).padStart(2, '0');
      opt.textContent = m;
      monthSelect.appendChild(opt);
    });

    if (Array.from(years).includes(currentYear)) yearSelect.value = currentYear;
    if (currentMonth !== 'all') monthSelect.value = currentMonth;
  }

  _setConnStatus(status) {
    const headerBtn = document.getElementById('btn-refresh-header');
    const dot = document.getElementById('conn-dot');
    const gear = document.getElementById('gear-icon');

    if (gear) gear.classList.remove('gear-rotate');
    if (dot) dot.className = 'conn-status-dot';

    if (!headerBtn) return;
    headerBtn.setAttribute('data-status', status);

    if (status === 'connecting') {
      headerBtn.textContent = 'Connecting...';
      headerBtn.className = 'log-badge';
      if (dot) dot.classList.add('warn');
      if (gear) gear.classList.add('gear-rotate');
    } else if (status === 'connected') {
      headerBtn.textContent = 'CONNECTED';
      headerBtn.className = 'log-badge badge-synced';
      if (dot) dot.classList.add('live');
    } else if (status === 'failed') {
      headerBtn.textContent = 'RETRY';
      headerBtn.className = 'log-badge badge-pending';
      if (dot) dot.classList.add('err');
    } else if (status === 'required') {
      headerBtn.textContent = 'REQUIRED';
      headerBtn.className = 'log-badge badge-red';
      if (dot) dot.classList.add('err');
    }
  }

  // =========================================================
  // DATA GROUPING HELPER
  // =========================================================
  _groupByVisit(expenses, visits) {
    const groups = {};
    const untagged = { isVirtual: true, expenses: [] };

    const safeVisits = visits || [];
    const safeExpenses = expenses || [];

    // Initialize groups for all known visits
    safeVisits.forEach(v => {
      groups[v.visit_id] = { ...v, expenses: [] };
    });

    // Assign expenses to their visits, creating virtual/placeholder groups for unknown visit IDs
    safeExpenses.forEach(exp => {
      const vid = exp.visit_id;
      if (vid) {
        if (!groups[vid]) {
          groups[vid] = {
            visit_id: vid,
            destination: 'Unknown Visit',
            date: exp.date || '',
            distance_miles: '0',
            expenses: []
          };
        }
        groups[vid].expenses.push(exp);
      } else {
        untagged.expenses.push(exp);
      }
    });

    const result = Object.values(groups).filter(g => g.expenses.length > 0 || (g.distance_miles && parseFloat(g.distance_miles) > 0));
    if (untagged.expenses.length > 0) {
      result.push(untagged);
    }

    // Sort by date (descending) using YYYY-MM-DD parsing for robust ordering
    result.sort((a, b) => {
      const dateAStr = a.isVirtual ? (a.expenses[0]?.date || '') : a.date;
      const dateBStr = b.isVirtual ? (b.expenses[0]?.date || '') : b.date;
      const keyA = this._parseDateToKey(dateAStr) || '1970-01-01';
      const keyB = this._parseDateToKey(dateBStr) || '1970-01-01';
      return new Date(keyB) - new Date(keyA);
    });

    return result;
  }

  _computeVisitSyncStatus(expenses) {
    if (!expenses || expenses.length === 0) return 'ALL';
    let synced = 0;
    expenses.forEach(e => { if (e.sync_status === 'Synced') synced++; });
    if (synced === expenses.length) return 'ALL';
    if (synced > 0) return 'PART';
    return 'NONE';
  }

  // =========================================================
  // LIST VIEW
  // =========================================================
  renderAllLog() {
    const container = document.getElementById('view-list-items');
    if (!container) return;

    container.innerHTML = '';

    const yearFilter = document.getElementById('filter-year')?.value || 'all';
    const monthFilter = document.getElementById('filter-month')?.value || 'all';
    const statusFilter = document.getElementById('filter-status')?.value || 'all';

    // Filter expenses based on selected filters
    const filteredExpenses = (this.allRows || []).filter(exp => {
      const key = this._parseDateToKey(exp.date);
      if (!key) return false;
      const [y, m, d] = key.split('-');

      if (yearFilter !== 'all' && y !== yearFilter) return false;
      if (monthFilter !== 'all' && m !== monthFilter) return false;
      if (statusFilter !== 'all') {
        const syncStatus = (exp.sync_status || '').toLowerCase();
        if (syncStatus !== statusFilter) return false;
      }
      return true;
    });

    // Filter visits based on selected filters
    const filteredVisits = (this.allVisits || []).filter(v => {
      const key = this._parseDateToKey(v.date);
      if (!key) return false;
      const [y, m, d] = key.split('-');
      if (yearFilter !== 'all' && y !== yearFilter) return false;
      if (monthFilter !== 'all' && m !== monthFilter) return false;
      return true;
    });

    const grouped = this._groupByVisit(filteredExpenses, filteredVisits);

    if (grouped.length === 0) {
      container.innerHTML = `<div class="empty-state">No visits or expenses match the filters.</div>`;
      return;
    }

    grouped.forEach(g => {
      const card = this._buildVisitCard(g);
      container.appendChild(card);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  _buildVisitCard(group) {
    const card = document.createElement('div');


    const header = document.createElement('div');
    header.className = 'visit-card-header';

    const isVirtual = group.isVirtual;
    const destName = isVirtual ? 'Untagged Expenses' : (group.destination || 'Unknown Destination');
    const dist = isVirtual ? 0 : (parseFloat(group.distance_miles) || 0);
    const distStr = dist > 0 ? `${dist} mi` : '';
    const dateStr = isVirtual ? (group.expenses[0]?.date || '') : group.date;
    const formattedDate = this._formatDateFriendly(dateStr);

    const visitId = isVirtual ? '' : (group.visit_id || '');
    const rate = isVirtual ? 0 : (parseFloat(group.mileage_rate) || 0.67);
    const mileageVal = isVirtual ? 0 : (parseFloat(group.mileage_value) || (dist * rate));
    const mileageValStr = mileageVal > 0 ? `£${mileageVal.toFixed(2)}` : '';
    const visitStatus = isVirtual ? '' : (group.status || 'Open');

    const expCount = group.expenses.length;
    let expSum = 0;
    group.expenses.forEach(e => expSum += (parseFloat(e.amount) || 0));

    const syncStatus = this._computeVisitSyncStatus(group.expenses);
    const syncClass = syncStatus === 'ALL' ? 'badge-synced' : (syncStatus === 'PART' ? 'badge-part' : 'badge-pending');
    const statusClass = visitStatus === 'Open' ? 'badge-synced' : '';
    const syncDotColor = syncStatus === 'ALL' ? 'green' : (syncStatus === 'PART' ? 'orange' : 'red');

    const mileageDetails = distStr
      ? `<span class="visit-mileage-details" style="font-size: 0.75rem; color: var(--text-secondary);">${distStr} @ £${rate.toFixed(2)}/mi (${mileageValStr})</span>`
      : '';

    card.className = `visit-card ${statusClass}`;

    header.innerHTML = `
      <div class="visit-header-info " style="width: 100%; display: flex; flex-direction: column; gap: 4px;">
        <div class="visit-header-top" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span class="visit-date">${formattedDate}</span>
          <div style="display: flex; align-items: center; gap: 6px;">
           <span class="visit-stats">${expCount} exp | £${expSum.toFixed(2)}</span>
            ${expCount > 0 ? `<span style="color: ${syncDotColor};">●</span>` : '<span>—</span>'}
          </div>
        </div>
        <div class="visit-header-mid" style="display: flex; justify-content: space-between; align-items: baseline; width: 100%;">
          <span class="visit-dest">${this.escapeHTML(destName)}</span>
         ${mileageDetails}
        </div>
      </div>
    `;

    // Mileage button
    if (!isVirtual && dist > 0) {
      const btnMil = document.createElement('button');
      btnMil.className = 'btn btn-secondary btn-small btn-post-mileage';
      btnMil.textContent = 'Post Mileage';
      btnMil.onclick = (e) => {
        e.stopPropagation();
        this.triggerAutofill(group.rowIndex, 'mileage');
      };
      header.appendChild(btnMil);
    }

    const body = document.createElement('div');
    body.className = 'visit-card-body';
    body.style.display = 'none';

    group.expenses.forEach(exp => {
      body.appendChild(this._buildExpenseRow(exp));
    });

    header.addEventListener('click', () => {
      const expanded = body.style.display === 'block';
      body.style.display = expanded ? 'none' : 'block';
      card.classList.toggle('expanded', !expanded);
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  _buildExpenseRow(row) {
    const item = document.createElement('div');
    item.className = 'expense-row';

    const catClass = this._catClass(row.category);
    const valText = parseFloat(row.amount) > 0
      ? `£${parseFloat(row.amount).toFixed(2)}`
      : `${parseFloat(row.distance_miles || 0).toFixed(2)} mi`;

    const thumbHtml = row.receipt_url
      ? `<a href="${row.receipt_url}" target="_blank" class="receipt-thumb has-image" title="View Receipt">🖼️</a>`
      : `<div class="receipt-thumb receipt-placeholder" title="No Receipt">📄</div>`;

    item.innerHTML = `
      <div class="expense-row-left">
        ${thumbHtml}
        <div class="expense-row-info">
          <div class="expense-row-title">${this.escapeHTML(row.vendor_place || 'Unspecified')}</div>
          <div class="expense-row-sub">
            <span class="list-cat-chip ${catClass}">${this._catShort(row.category)}</span> 
            <span class="expense-row-status ${row.sync_status === 'Synced' ? 'synced-text' : 'pending-text'}">${row.sync_status}</span>
          </div>
        </div>
      </div>
      <div class="expense-row-right">
        <div class="expense-row-amount">${valText}</div>
        <div class="expense-row-actions"></div>
      </div>
    `;

    const actionsContainer = item.querySelector('.expense-row-actions');

    if (row.sync_status === 'Pending') {
      const btnFill = document.createElement('button');
      btnFill.className = 'btn btn-secondary btn-small';
      btnFill.textContent = 'Fill';
      btnFill.onclick = (e) => { e.stopPropagation(); this.triggerAutofill(row.rowIndex); };
      actionsContainer.appendChild(btnFill);

      if (row.autofill_count > 0) {
        const btnDone = document.createElement('button');
        btnDone.className = 'btn btn-outline btn-small';
        btnDone.style.borderColor = 'var(--primary-glow)';
        btnDone.style.color = 'var(--primary)';
        btnDone.textContent = 'Done';
        btnDone.onclick = (e) => { e.stopPropagation(); this.markRowAsSynced(row.rowIndex); };
        actionsContainer.appendChild(btnDone);
      }
    } else {
      const moreToggle = document.createElement('div');
      moreToggle.className = 'expense-more-toggle';
      moreToggle.innerHTML = `More <i data-lucide="chevron-down" style="width:14px;height:14px"></i>`;

      const hiddenActions = document.createElement('div');
      hiddenActions.className = 'expense-hidden-actions';
      hiddenActions.style.display = 'none';

      const btnReFill = document.createElement('button');
      btnReFill.className = 'btn btn-secondary btn-small';
      btnReFill.textContent = 'ReFill';
      btnReFill.onclick = (e) => { e.stopPropagation(); this.triggerAutofill(row.rowIndex); };

      const btnArchive = document.createElement('button');
      btnArchive.className = 'btn btn-outline btn-small';
      btnArchive.textContent = 'Archive';
      btnArchive.onclick = (e) => { e.stopPropagation(); this.archiveRow(row.rowIndex); };

      hiddenActions.appendChild(btnReFill);
      hiddenActions.appendChild(btnArchive);

      moreToggle.onclick = (e) => {
        e.stopPropagation();
        const expanded = hiddenActions.style.display === 'flex';
        hiddenActions.style.display = expanded ? 'none' : 'flex';
        moreToggle.innerHTML = expanded
          ? `More <i data-lucide="chevron-down" style="width:14px;height:14px"></i>`
          : `Less <i data-lucide="chevron-up" style="width:14px;height:14px"></i>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      };

      actionsContainer.appendChild(moreToggle);
      actionsContainer.appendChild(hiddenActions);
    }

    return item;
  }


  /**
 * Renders only the items that are currently Pending (not Synced).
 * Designed for a summary dashboard or focused view.
 */
  renderPendingLog() {
    const container = document.getElementById('view-list-items');
    if (!container) return;

    container.innerHTML = '';

    // Filter: Only rows where sync_status is NOT 'Synced'
    const pendingRows = (this.allRows || []).filter(row =>
      (row.sync_status || '').toLowerCase() !== 'synced'
    );

    if (pendingRows.length === 0) {
      container.innerHTML = `
      <div style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:2rem 0;">
        <i data-lucide="check-circle" style="margin-bottom:10px;"></i><br>
        All items are synced!
      </div>
    `;
      // Re-run Lucide icons if you are using them to render the icon above
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }

    pendingRows.forEach(row => {
      const catClass = this._catClass(row.category);
      const valText = parseFloat(row.amount) > 0
        ? `£${parseFloat(row.amount).toFixed(2)}`
        : `${parseFloat(row.distance_miles || 0).toFixed(2)} mi`;

      const item = document.createElement('div');
      item.className = 'log-item unsynced-row';

      item.innerHTML = `
      <div class="row-header">
        <span class="list-date">${row.date || ''}</span>
        <span class="list-cat-chip ${catClass}">${this._catShort(row.category)}</span>
        <span class="list-amount">${valText}</span>
      </div>
      <div class="log-details">
        <strong>Vendor:</strong> ${row.vendor_place || 'Unspecified'}<br>
        <strong>Notes:</strong> ${row.notes || 'None'}
      </div>
    `;

      // Add expansion logic for details
      item.querySelector('.row-header').addEventListener('click', () => {
        item.classList.toggle('expanded');
      });

      container.appendChild(item);
    });

    // Ensure icons load if you're using Lucide inside the items
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  _catClass(category) {
    const c = (category || '').toLowerCase();
    if (c.includes('visit') || c.includes('mile')) return 'cat-visit';
    if (c.includes('fuel') || c.includes('gas')) return 'cat-fuel';
    if (c.includes('meal') || c.includes('coffee')) return 'cat-meals';
    if (c.includes('park') || c.includes('toll')) return 'cat-parking';
    return 'cat-other';
  }

  _catShort(category) {
    const c = (category || '').toLowerCase();
    if (c.includes('visit') || c.includes('mile')) return 'Visit';
    if (c.includes('fuel') || c.includes('gas')) return 'Fuel';
    if (c.includes('meal') || c.includes('coffee')) return 'Meals';
    if (c.includes('park') || c.includes('toll')) return 'Park';
    return 'Other';
  }

  // =========================================================
  // CALENDAR VIEW
  // =========================================================
  renderCalendarView() {
    const year = this._calDate.getFullYear();
    const month = this._calDate.getMonth(); // 0-indexed

    // Update year label
    const label = document.getElementById('cal-year-label');
    if (label) {
      label.textContent = year;
    }

    // Group visits by YYYY-MM-DD key
    const visitsByDay = {};
    const visitGroups = this._groupByVisit(this.allRows, this.allVisits);
    visitGroups.forEach(v => {
      const dStr = v.isVirtual ? (v.expenses[0]?.date || '') : v.date;
      const key = this._parseDateToKey(dStr);
      if (!key) return;
      if (!visitsByDay[key]) visitsByDay[key] = [];
      visitsByDay[key].push(v);
    });

    const monthNav = document.getElementById('cal-month-nav');
    monthNav.innerHTML = '';
    const mos = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    mos.forEach((m, mIdx) => {
      let syncedVisits = 0;
      let pendingVisits = 0;

      visitGroups.forEach(v => {
        const dStr = v.isVirtual ? (v.expenses[0]?.date || '') : v.date;
        const key = this._parseDateToKey(dStr);
        if (key && key.startsWith(`${year}-${String(mIdx + 1).padStart(2, '0')}`)) {
          const syncStatus = this._computeVisitSyncStatus(v.expenses);
          if (syncStatus === 'ALL') syncedVisits++;
          else pendingVisits++;
        }
      });

      const btn = document.createElement('div');
      btn.className = 'cal-month-btn';
      btn.textContent = m;

      const hasLog = (syncedVisits + pendingVisits) > 0;
      if (hasLog) {
        if (syncedVisits > 0 && pendingVisits > 0) {
          btn.classList.add('status-mixed');
        } else if (syncedVisits > 0 && pendingVisits === 0) {
          btn.classList.add('status-synced');
        } else if (pendingVisits > 0 && syncedVisits === 0) {
          btn.classList.add('status-unsynced');
        }
      }
      if (mIdx === month) {
        btn.style.fontWeight = 'bold';
        btn.style.background = 'var(--text-primary)';
        btn.style.color = 'var(--bg-dark)';
      }
      btn.addEventListener('click', () => {
        this._calDate.setMonth(mIdx);
        this.renderCalendarView();
      });
      monthNav.appendChild(btn);
    });

    const grid = document.getElementById('cal-grid');
    grid.innerHTML = '';

    // First day of month and how many days in month
    const firstDay = new Date(year, month, 1).getDay();  // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // days of week header
    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    daysOfWeek.forEach(day => {
      const cell = document.createElement('div');
      cell.className = 'cal-day-label';
      cell.textContent = day;
      grid.appendChild(cell);
    });

    // Leading empty cells from previous month
    for (let i = 0; i < firstDay; i++) {
      const prevDay = daysInPrevMonth - firstDay + 1 + i;
      const cell = this._buildCalCell(prevDay, null, false, false, null);
      cell.classList.add('other-month');
      grid.appendChild(cell);
    }

    // Current month cells
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const visits = visitsByDay[key] || [];
      const isToday = key === todayKey;
      const cell = this._buildCalCell(d, visits, true, isToday, key);
      grid.appendChild(cell);
    }

    // Trailing cells for next month
    const totalCells = firstDay + daysInMonth;
    const trailingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= trailingCells; i++) {
      const cell = this._buildCalCell(i, null, false, false, null);
      cell.classList.add('other-month');
      grid.appendChild(cell);
    }

    // Compute Summary for the selected month
    let visitsCount = 0, daysWithVisits = new Set(), mileage = 0, expCount = 0, expSum = 0, synced = 0, pending = 0;

    Object.entries(visitsByDay).forEach(([key, dayVisits]) => {
      if (key.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`) && dayVisits) {
        daysWithVisits.add(key);
        dayVisits.forEach(v => {
          if (!v.isVirtual) visitsCount++;
          mileage += parseFloat(v.distance_miles) || 0;
          v.expenses.forEach(e => {
            expCount++;
            expSum += parseFloat(e.amount) || 0;
          });
          const syncStatus = this._computeVisitSyncStatus(v.expenses);
          if (syncStatus === 'ALL') synced++;
          else pending++;
        });
      }
    });

    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('sum-visits', visitsCount);
    setTxt('sum-days', daysWithVisits.size);
    setTxt('sum-mileage', mileage.toFixed(1));
    setTxt('sum-exp-count', expCount);
    setTxt('sum-exp-sum', expSum.toFixed(2));
    setTxt('sum-synced', synced);
    setTxt('sum-pending', pending);
  }

  _buildCalCell(dayNum, visits, isCurrentMonth, isToday, dateKey) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (isToday) cell.classList.add('today');

    const numEl = document.createElement('div');
    numEl.className = 'cal-day-num';
    numEl.textContent = dayNum;
    cell.appendChild(numEl);

    if (isCurrentMonth && visits && visits.length > 0) {
      cell.classList.add('has-items');

      let syncedVisits = 0;
      let pendingVisits = 0;
      visits.forEach(v => {
        const syncStatus = this._computeVisitSyncStatus(v.expenses);
        if (syncStatus === 'ALL') syncedVisits++;
        else pendingVisits++;
      });

      if (syncedVisits > 0 && pendingVisits > 0) {
        cell.classList.add('status-mixed');
      } else if (syncedVisits > 0 && pendingVisits === 0) {
        cell.classList.add('status-synced');
      } else if (pendingVisits > 0 && syncedVisits === 0) {
        cell.classList.add('status-unsynced');
      }

      const dots = document.createElement('div');
      dots.className = 'cal-dots';

      // One dot per visit
      visits.slice(0, 4).forEach(v => {
        const dot = document.createElement('div');
        dot.className = 'cal-dot';
        const syncStatus = this._computeVisitSyncStatus(v.expenses);
        if (syncStatus === 'ALL') dot.style.background = 'var(--secondary)';
        else if (syncStatus === 'PART') dot.style.background = 'hsl(40, 100%, 50%)';
        else dot.style.background = 'var(--danger)';
        dots.appendChild(dot);
      });
      cell.appendChild(dots);

      cell.addEventListener('click', () => this.openDayPopup(dateKey, visits));
    }

    return cell;
  }

  _catDotClass(category) {
    const c = (category || '').toLowerCase();
    if (c.includes('visit') || c.includes('mile')) return 'dot-visit';
    if (c.includes('fuel') || c.includes('gas')) return 'dot-fuel';
    if (c.includes('meal') || c.includes('coffee')) return 'dot-meals';
    if (c.includes('park') || c.includes('toll')) return 'dot-parking';
    return 'dot-other';
  }

  _parseDateToKey(dateStr) {
    if (!dateStr) return null;
    if (typeof dateStr !== 'string') {
      dateStr = String(dateStr);
    }
    dateStr = dateStr.trim();

    // Handle full ISO date-time strings (e.g. "2026-05-26T22:29:44.000Z")
    const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    // Split by slash, dash, or dot to parse components safely across locales (e.g. "26/05/2026")
    const parts = dateStr.split(/[\/\-\.]/);
    if (parts.length === 3) {
      let p1 = parseInt(parts[0], 10);
      let p2 = parseInt(parts[1], 10);
      let p3 = parseInt(parts[2], 10);

      // Case A: YYYY in part 1
      if (parts[0].length === 4 && !isNaN(p1) && !isNaN(p2) && !isNaN(p3)) {
        let month = p2;
        let day = p3;
        if (p2 > 12 && p3 <= 12) {
          month = p3;
          day = p2;
        }
        return `${p1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }

      // Case B: YYYY in part 3
      if (parts[2].length === 4 && !isNaN(p1) && !isNaN(p2) && !isNaN(p3)) {
        let month = p1;
        let day = p2;
        if (p1 > 12 && p2 <= 12) {
          // Must be DD/MM/YYYY
          day = p1;
          month = p2;
        } else if (p2 > 12 && p1 <= 12) {
          // Must be MM/DD/YYYY
          month = p1;
          day = p2;
        }
        return `${p3}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    // Fallback: let JS Date try to parse it
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    return null;
  }

  _calShiftYear(delta) {
    this._calDate.setFullYear(this._calDate.getFullYear() + delta);
    this.renderCalendarView();
  }


  // =========================================================
  // MONTH POPUP
  // =========================================================

  openMonthPopup(month, year, rows) {
    const overlay = document.getElementById('month-popup-overlay');
    const titleEl = document.getElementById('month-popup-date-title');
    const itemsEl = document.getElementById('month-popup-items-container');

    // Format date nicely
    const d = new Date(year, month, 1);
    titleEl.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    itemsEl.innerHTML = '';
    rows.forEach(row => {
      const valText = parseFloat(row.amount) > 0
        ? `£${parseFloat(row.amount).toFixed(2)}`
        : `${parseFloat(row.distance_miles || 0).toFixed(2)} mi`;

      const item = document.createElement('div');
      item.className = 'popup-item';

      const dot = document.createElement('div');
      dot.className = `popup-dot ${this._catDotClass(row.category)}`;

      const info = document.createElement('div');
      info.className = 'popup-item-info';

      const name = document.createElement('div');
      name.className = 'popup-item-name';
      name.textContent = row.vendor_place || 'Unspecified';

      const sub = document.createElement('div');
      sub.className = 'popup-item-sub';
      sub.textContent = row.category || '';

      info.append(name, sub);

      const amount = document.createElement('div');
      amount.className = 'popup-item-amount';
      amount.textContent = valText;

      item.append(dot, info, amount);

      if (row.sync_status === 'Pending') {
        const actions = document.createElement('div');
        actions.className = 'popup-item-actions';

        const btn = document.createElement('button');
        btn.className = 'primary-btn';
        btn.textContent = 'Upload';
        btn.addEventListener('click', () => this._uploadUnsynced(row));

        actions.appendChild(btn);
        item.appendChild(actions);
      }

      itemsEl.appendChild(item);
    });

    overlay.classList.add('open');
  }

  closeMonthPopup() {
    document.getElementById('month-popup-overlay').classList.remove('open');
  }

  // =========================================================
  // DAY POPUP
  // =========================================================
  openDayPopup(dateKey, visits) {
    const overlay = document.getElementById('day-popup-overlay');
    const titleEl = document.getElementById('popup-date-title');
    const itemsEl = document.getElementById('popup-items-container');

    // Format date nicely
    const d = new Date(dateKey + 'T00:00:00');
    titleEl.textContent = d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    itemsEl.innerHTML = '';

    visits.forEach(v => {
      // Build a visit card for the popup
      const card = this._buildVisitCard(v);

      // Make it expanded by default in the popup for convenience
      const body = card.querySelector('.visit-card-body');
      if (body) {
        body.style.display = 'block';
        card.classList.add('expanded');
      }

      itemsEl.appendChild(card);
    });

    overlay.classList.add('open');
  }

  closeDayPopup() {
    document.getElementById('day-popup-overlay').classList.remove('open');
  }

  // =========================================================
  // AUTOFILL & SYNC (preserved from previous session)
  // =========================================================
  async triggerAutofill(rowIndex, type = 'expense') {
    let row;
    if (type === 'mileage') {
      row = (this.allVisits || []).find(r => r.rowIndex === rowIndex);
    } else {
      row = this.allRows.find(r => r.rowIndex === rowIndex);
    }

    if (!row) return;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) { alert('No active tab found.'); return; }
    if (!this.config || !this.config.selectors) { alert('Selectors not configured.'); return; }

    let payload;
    if (type === 'mileage') {
      payload = {
        amount: '',
        date: row.date || '',
        category: 'Mileage',
        vendor: row.destination || '',
        notes: row.notes || '',
        distance: row.distance_miles ? parseFloat(row.distance_miles).toFixed(2) : ''
      };
    } else {
      payload = {
        amount: row.amount ? parseFloat(row.amount).toFixed(2) : '',
        date: row.date || '',
        category: row.category || '',
        vendor: row.vendor_place || '',
        notes: row.notes || '',
        distance: row.distance_miles ? parseFloat(row.distance_miles).toFixed(2) : ''
      };
    }

    chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (payload, selectors) => {
        const fill = (selector, val) => {
          if (!selector || !val) return;
          const el = document.querySelector(selector);
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }
        };
        if (selectors) {
          fill(selectors.amount, payload.amount);
          fill(selectors.date, payload.date);
          fill(selectors.category, payload.category);
          fill(selectors.vendor, payload.vendor);
          fill(selectors.notes, payload.notes);
          fill(selectors.distance, payload.distance);
        }
      },
      args: [payload, this.config.selectors]
    }, async () => {
      if (chrome.runtime.lastError) {
        console.error('Autofill failed:', chrome.runtime.lastError);
      } else {
        // Increment autofill count in backend
        const url = `${this.config.webappUrl}?action=increment_autofill&row_index=${rowIndex}&token=${encodeURIComponent(this.config.secretKey)}`;
        try {
          const res = await fetch(url, { credentials: 'omit' });
          const result = await res.json();
          if (result.success) {
            row.autofill_count = result.autofill_count;
            this.renderPendingLog();
          }
        } catch (err) {
          console.error('Failed to update autofill count:', err);
        }
      }
    });
  }

  async markRowAsSynced(rowIndex) {
    if (!this.config || !this.config.webappUrl) return;

    if (!confirm(`Mark row #${rowIndex} as synced in the spreadsheet? It will disappear from this panel.`)) return;

    const url = `${this.config.webappUrl}?action=mark_synced&row_index=${rowIndex}&token=${encodeURIComponent(this.config.secretKey)}`;

    try {
      const response = await fetch(url, { credentials: 'omit' });
      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch (e) {
        throw new Error("Invalid JSON response from Google. First 100 chars: " + text.substring(0, 100));
      }

      if (result.success) {
        this.fetchPendingLogs();
      } else {
        throw new Error(result.message || 'Failed to mark synced.');
      }
    } catch (err) {
      alert(`Error updating Google Sheet: ${err.message}`);
    }
  }

  // =========================================================
  // INTEGRATED CONFIGURATION
  // =========================================================
  showConfigTab() {
    const mainPanel = document.getElementById('mainPanel');
    const friends = document.querySelectorAll('.view-cards, .view-list, .view-calendar');
    const configPanel = document.getElementById('configPanel');
    if (mainPanel && configPanel) {
      friends.forEach(friend => friend.style.display = 'none');
      configPanel.style.display = 'flex';
      this.populateConfigFields();
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  hideConfigTab() {
    this.setView('cal');
  }

  populateConfigFields() {
    const config = this.config || {};
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };
    setVal('cfg-webapp-url', config.webappUrl);
    setVal('cfg-secret-key', config.secretKey);

    if (config.selectors) {
      setVal('sel-amount', config.selectors.amount);
      setVal('sel-date', config.selectors.date);
      setVal('sel-category', config.selectors.category);
      setVal('sel-vendor', config.selectors.vendor);
      setVal('sel-notes', config.selectors.notes);
      setVal('sel-distance', config.selectors.distance);
    }
  }

  saveConfig() {
    const url = document.getElementById('cfg-webapp-url').value.trim();
    const key = document.getElementById('cfg-secret-key').value.trim();

    this.config = {
      webappUrl: url,
      secretKey: key,
      selectors: {
        amount: document.getElementById('sel-amount').value.trim(),
        date: document.getElementById('sel-date').value.trim(),
        category: document.getElementById('sel-category').value.trim(),
        vendor: document.getElementById('sel-vendor').value.trim(),
        notes: document.getElementById('sel-notes').value.trim(),
        distance: document.getElementById('sel-distance').value.trim()
      }
    };

    const storage = this._getStorage();
    if (storage) {
      storage.set({ mavis_companion_config: this.config }, () => {
        this.applyConfig();
        this.hideConfigTab();
      });
    } else {
      localStorage.setItem('mavis_companion_config_mock', JSON.stringify(this.config));
      this.applyConfig();
      this.hideConfigTab();
    }
  }

  loadDefaults() {
    if (confirm("Load standard selectors? This will overwrite your current inputs.")) {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
      };
      setVal('sel-amount', "input[name='amount']");
      setVal('sel-date', "input[type='date']");
      setVal('sel-category', "select[name='category']");
      setVal('sel-vendor', "input[name='vendor']");
      setVal('sel-notes', "textarea[name='notes']");
      setVal('sel-distance', "input[name='miles']");
    }
  }

  async archiveRow(rowIndex) {
    if (!this.config || !this.config.webappUrl) return;

    this._setConnStatus('connecting');

    const url = `${this.config.webappUrl}?action=archive_log&token=${encodeURIComponent(this.config.secretKey)}&rowIndex=${rowIndex}`;
    try {
      const response = await fetch(url, { method: 'POST', credentials: 'omit' });
      const data = await response.json();
      if (data.success) {
        console.log(`[Extension] Row ${rowIndex} archived successfully.`);
        await this.fetchPendingLogs(); // Refresh the list
      } else {
        throw new Error(data.message || 'Apps Script returned error.');
      }
    } catch (err) {
      console.error(`[Extension] Failed to archive row ${rowIndex}:`, err);
      this._setConnStatus('failed');
    }
  }

}

const sidePanel = new MavisCompanionSidePanel();
window.sidePanel = sidePanel;
document.addEventListener('DOMContentLoaded', () => sidePanel.init());
