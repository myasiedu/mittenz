const isExtensionContext = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

function saveConfiguration() {
    const config = {
        webappUrl: document.getElementById('ext-webapp-url').value.trim(),
        secretKey: document.getElementById('ext-secret-key').value.trim(),
        selectors: {
            amount: document.getElementById('sel-amount').value.trim(),
            date: document.getElementById('sel-date').value.trim(),
            category: document.getElementById('sel-category').value.trim(),
            vendor: document.getElementById('sel-vendor').value.trim(),
            notes: document.getElementById('sel-notes').value.trim(),
            distance: document.getElementById('sel-distance').value.trim()
        }
    };

    if (isExtensionContext) {
        chrome.storage.local.set({ 'mavis_companion_config': config }, () => {
            alert("Configuration saved successfully!");
        });
    } else {
        localStorage.setItem('mavis_companion_config_mock', JSON.stringify(config));
        alert("Saved in mock sandbox.");
    }
}

function loadConfiguration() {
    if (isExtensionContext) {
        chrome.storage.local.get('mavis_companion_config', (data) => {
            if (data.mavis_companion_config) populateFields(data.mavis_companion_config);
        });
    } else {
        const mockSaved = localStorage.getItem('mavis_companion_config_mock');
        if (mockSaved) populateFields(JSON.parse(mockSaved));
    }
}

function populateFields(config) {
    document.getElementById('ext-webapp-url').value = config.webappUrl || '';
    document.getElementById('ext-secret-key').value = config.secretKey || '';
    if (config.selectors) {
        document.getElementById('sel-amount').value = config.selectors.amount || '';
        document.getElementById('sel-date').value = config.selectors.date || '';
        document.getElementById('sel-category').value = config.selectors.category || '';
        document.getElementById('sel-vendor').value = config.selectors.vendor || '';
        document.getElementById('sel-notes').value = config.selectors.notes || '';
        document.getElementById('sel-distance').value = config.selectors.distance || '';
    }
}

function loadDefaults() {
    if (confirm("Load standard selectors? This will overwrite your current inputs.")) {
        document.getElementById('sel-amount').value = "input[name='amount']";
        document.getElementById('sel-date').value = "input[type='date']";
        document.getElementById('sel-category').value = "select[name='category']";
        document.getElementById('sel-vendor').value = "input[name='vendor']";
        document.getElementById('sel-notes').value = "textarea[name='notes']";
        document.getElementById('sel-distance').value = "input[name='miles']";
    }
}

// Ensure the HTML is fully loaded before trying to attach button clicks
document.addEventListener('DOMContentLoaded', () => {
    loadConfiguration();
    loadTheme();

    // Attach event listeners to replace the old HTML "onclick" attributes
    const btnSave = document.getElementById('btn-save-config');
    if (btnSave) btnSave.addEventListener('click', saveConfiguration);

    const btnLoad = document.getElementById('btn-load-defaults');
    if (btnLoad) btnLoad.addEventListener('click', loadDefaults);

    const btnTheme = document.getElementById('cfg-theme-toggle');
    if (btnTheme) btnTheme.addEventListener('click', toggleTheme);
});

function loadTheme() {
    if (isExtensionContext) {
        chrome.storage.local.get('mavis_theme', (data) => {
            applyTheme(data.mavis_theme || 'dark');
        });
    } else {
        applyTheme('dark');
    }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const moon = document.getElementById('cfg-icon-moon');
    const sun  = document.getElementById('cfg-icon-sun');
    if (moon) moon.style.display = theme === 'dark'  ? 'block' : 'none';
    if (sun)  sun.style.display  = theme === 'light' ? 'block' : 'none';
    document.documentElement._cfgTheme = theme;
}

function toggleTheme() {
    const current = document.documentElement._cfgTheme || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    if (isExtensionContext) chrome.storage.local.set({ mavis_theme: next });
}