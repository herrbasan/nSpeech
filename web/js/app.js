import { nui } from '/lib/nui_wc2/NUI/nui.js';

document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const actionSpec = actionEl.dataset.action;
    const [actionPart] = actionSpec.split('@');
    const [action, param] = actionPart.split(':');

    switch (action) {
        case 'toggle-sidebar':
            const app = document.querySelector('nui-app');
            if (app?.toggleSidebar) {
                app.toggleSidebar(param || 'left');
            }
            break;

        case 'toggle-theme':
            const current = document.documentElement.style.colorScheme || 'light';
            document.documentElement.style.colorScheme = current === 'dark' ? 'light' : 'dark';
            break;
    }
});

const ENGINES = {
    kokoro: { label: 'Kokoro', icon: 'headphones' },
    'chatterbox-turbo': { label: 'CB Turbo', icon: 'headphones' },
    'chatterbox-eng': { label: 'CB English', icon: 'headphones' },
    'chatterbox-mtl': { label: 'CB Multilingual', icon: 'headphones' },
    dots: { label: 'dots.tts', icon: 'headphones' },
    f5tts: { label: 'F5-TTS', icon: 'headphones' },
    vibevoice: { label: 'VibeVoice', icon: 'headphones' },
    minimax: { label: 'MiniMax', icon: 'cloud' },
    elevenlabs: { label: 'ElevenLabs', icon: 'cloud' },
    xai: { label: 'xAI / Grok', icon: 'cloud' },
    gemini: { label: 'Gemini', icon: 'cloud' },
};

function buildNavigation(engine) {
    const nav = [
        { label: 'Home', href: '#page=home', icon: 'home' },
        { label: 'Docs', href: '#page=docs', icon: 'book' }
    ];

    const info = ENGINES[engine];
    if (info) {
        nav.push({
            label: info.label,
            icon: info.icon,
            items: [
                { label: 'Generate', href: `#page=${engine}/generate` },
                { label: 'Voices', href: `#page=${engine}/voices` }
            ]
        });
    }

    return nav;
}

function syncNavActive() {
    const sideNav = document.getElementById('main-navigation');
    if (!sideNav || typeof sideNav.setActive !== 'function') return;

    const hash = location.hash || '#page=home';
    // Match the page route, e.g. #page=elevenlabs/generate
    const pageMatch = hash.match(/#page=([^?&]+)/);
    const page = pageMatch ? pageMatch[1] : 'home';

    // Prefer exact item match, then fall back to the engine group header.
    const exact = sideNav.querySelector(`a[href="#page=${page}"]`);
    if (exact) {
        sideNav.setActive(exact);
        return;
    }

    const engine = page.split('/')[0];
    const groupLink = sideNav.querySelector(`a[href="#page=${engine}/generate"]`);
    if (groupLink) {
        sideNav.setActive(groupLink);
    }
}

function initNav() {
    window.nspeech.client.getEngine()
        .then(engine => {
            engine = engine || 'kokoro';
            const nav = buildNavigation(engine);
            renderNav(nav);
            syncEngineSwitcher(engine);
        })
        .catch(() => {
            const nav = buildNavigation('kokoro');
            renderNav(nav);
        });
}

// Attach initNav globally so that page-switches can trigger dynamic sidebar updates
window.initNav = initNav;

async function loadEngineList() {
    try {
        const data = await window.nspeech.client.listEngines();
        return data.engines || [];
    } catch {
        return [];
    }
}

function getEngineLabel(name) {
    const info = ENGINES[name];
    return info ? info.label : name.charAt(0).toUpperCase() + name.slice(1);
}

async function populateEngineSwitcher() {
    const engines = await loadEngineList();
    const switcher = document.getElementById('engine-switcher');
    if (!switcher) return;

    const items = engines.map(e => ({ label: getEngineLabel(e.name), value: e.name }));
    switcher.setItems(items);

    // Now that items are set, sync active selection to current engine.
    initNav();
}

function syncEngineSwitcher(activeEngine) {
    const switcher = document.getElementById('engine-switcher');
    if (!switcher) return;

    // Avoid loops when the change came from the switcher itself.
    if (typeof switcher.getValue === 'function' && switcher.getValue() === activeEngine) return;
    if (typeof switcher.setValue === 'function') {
        switcher.setValue(activeEngine);
    }
}

function setBusy(active) {
    const loader = document.getElementById('engine-busy');
    if (!loader) return;
    loader.classList.toggle('active', active);
}

async function switchEngine(engineName) {
    if (!engineName) return;

    const switcher = document.getElementById('engine-switcher');
    if (switcher && typeof switcher.disable === 'function') switcher.disable();
    setBusy(true);

    try {
        const result = await window.nspeech.client.switchEngine(engineName);

        if (result && result.engine) {
            initNav();
            syncEngineSwitcher(result.engine);
            // Always return to home after an engine switch; the previous
            // engine-specific page (e.g. gemini/generate) no longer exists.
            location.hash = '#page=home';
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Engine switch failed:', err);
        alert(`Engine switch failed: ${err.message}`);
        // Restore current engine selection from server state.
        initNav();
    } finally {
        setBusy(false);
        if (switcher && typeof switcher.enable === 'function') switcher.enable();
    }
}

function initEngineSwitcher() {
    const switcher = document.getElementById('engine-switcher');
    if (!switcher) return;

    switcher.addEventListener('nui-change', (e) => {
        const detail = e.detail || {};
        const values = detail.values || [];
        const engineName = values[0];
        if (engineName) switchEngine(engineName);
    });

    populateEngineSwitcher();
}

function renderNav(navData) {
    customElements.whenDefined('nui-link-list').then(() => {
        const sideNav = document.getElementById('main-navigation');
        if (sideNav && typeof sideNav.loadData === 'function') {
            sideNav.loadData(navData);
            syncNavActive();
        }
    });
}

// Keep sidebar active state in sync with the router hash.
window.addEventListener('hashchange', syncNavActive);

initNav();
initEngineSwitcher();

nui.setupRouter({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar#nav-sidebar',
    basePath: '/web/pages',
    defaultPage: 'home'
});
