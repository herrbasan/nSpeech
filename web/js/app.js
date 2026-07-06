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
    cosyvoice: { label: 'CosyVoice', icon: 'headphones' },
    'chatterbox-turbo': { label: 'CB Turbo', icon: 'headphones' },
    'chatterbox-eng': { label: 'CB English', icon: 'headphones' },
    'chatterbox-mtl': { label: 'CB Multilingual', icon: 'headphones' },
    dots: { label: 'dots.tts', icon: 'headphones' },
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
    fetch('/engine')
        .then(r => r.json())
        .then(d => {
            const engine = d.engine || 'kokoro';
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
        const res = await fetch('/v1/admin/engines');
        if (!res.ok) return [];
        const data = await res.json();
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
        const res = await fetch('/v1/admin/engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: engineName }),
        });

        if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
            const err = await res.json();
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }
        if (!res.ok) {
            throw new Error(`Engine switch failed: HTTP ${res.status}`);
        }

        // SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        let finalResult = null;

        while (!done) {
            const { value, done: rd } = await reader.read();
            done = rd;
            if (value) buffer += decoder.decode(value, { stream: !done });

            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';

            for (const block of blocks) {
                const eventMatch = block.match(/^event:\s*(.+)$/m);
                const dataMatch = block.match(/^data:\s*(.+)$/m);
                if (!dataMatch) continue;

                const eventType = eventMatch ? eventMatch[1].trim() : 'message';
                const data = JSON.parse(dataMatch[1].trim());

                if (eventType === 'result') {
                    finalResult = data;
                } else if (eventType === 'error') {
                    throw new Error(data.error?.message || JSON.stringify(data.error));
                }
            }
        }

        if (finalResult && finalResult.engine) {
            initNav();
            syncEngineSwitcher(finalResult.engine);
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
