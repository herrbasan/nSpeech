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

function buildNavigation(engine) {
    const nav = [
        { label: 'Home', href: '#page=home', icon: 'home' },
        { label: 'Docs', href: '/docs', icon: 'book' }
    ];

    if (engine === 'kokoro') {
        nav.push({
            label: 'Kokoro',
            icon: 'headphones',
            items: [
                { label: 'Generate', href: '#page=kokoro/generate' },
                { label: 'Voices', href: '#page=kokoro/voices' }
            ]
        });
    } else if (engine === 'cosyvoice') {
        nav.push({
            label: 'CosyVoice',
            icon: 'headphones',
            items: [
                { label: 'Generate', href: '#page=cosyvoice/generate' },
                { label: 'Voices', href: '#page=cosyvoice/voices' }
            ]
        });
    } else if (engine === 'chatterbox') {
        nav.push({
            label: 'Chatterbox',
            icon: 'headphones',
            items: [
                { label: 'Generate', href: '#page=chatterbox/generate' },
                { label: 'Voices', href: '#page=chatterbox/voices' }
            ]
        });
    } else if (engine === 'dots') {
        nav.push({
            label: 'dots.tts',
            icon: 'headphones',
            items: [
                { label: 'Generate', href: '#page=dots/generate' },
                { label: 'Voices', href: '#page=dots/voices' }
            ]
        });
    } else if (engine === 'chatterbox') {
        nav.push({
            label: 'Chatterbox',
            icon: 'headphones',
            items: [
                { label: 'Generate', href: '#page=chatterbox/generate' },
                { label: 'Voices', href: '#page=chatterbox/voices' }
            ]
        });
    }

    return nav;
}

function initNav() {
    fetch('/engine')
        .then(r => r.json())
        .then(d => {
            const engine = d.engine || 'kokoro';
            const nav = buildNavigation(engine);
            renderNav(nav);
        })
        .catch(() => {
            const nav = buildNavigation('kokoro');
            renderNav(nav);
        });
}

// Attach initNav globally so that page-switches can trigger dynamic sidebar updates
window.initNav = initNav;

function renderNav(navData) {
    customElements.whenDefined('nui-link-list').then(() => {
        const sideNav = document.getElementById('main-navigation');
        if (sideNav && typeof sideNav.loadData === 'function') {
            sideNav.loadData(navData);
        }
    });
}

initNav();

nui.setupRouter({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar#nav-sidebar',
    basePath: '/web/pages',
    defaultPage: 'home'
});
