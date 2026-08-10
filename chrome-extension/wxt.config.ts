import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Invarail',
    description: 'Invarail AI browser companion — local-first, private, always by your side',
    permissions: ['sidePanel', 'contextMenus', 'scripting', 'storage', 'tabs', 'debugger'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: {
      default_title: 'Open Invarail',
    },
  },
});
