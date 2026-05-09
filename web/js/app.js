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

const navigationData = [
    { label: 'Home', href: '#page=home', icon: 'home' },
    {
        label: 'Kokoro',
        icon: 'headphones',
        items: [
            { label: 'Generate', href: '#page=kokoro-generate' },
            { label: 'Voices', href: '#page=kokoro-voices' }
        ]
    }
];

const sideNav = document.getElementById('main-navigation');
if (sideNav && sideNav.loadData) {
    sideNav.loadData(navigationData);
}

nui.setupRouter({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar#nav-sidebar',
    basePath: '/web/pages',
    defaultPage: 'home'
});
