/**
 * Plugin loader — discovers and loads plugins from filesystem directories.
 *
 * Plugin structure:
 *   plugins/my-tool/
 *     plugin.json    — { name, version, type, main, description }
 *     index.js       — exports { tool } or { tools }
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolRegistry } from '../tools/registry.js';
import type { PluginManifest, PluginExport } from './types.js';

// Split literal keeps the mechanical rename sweep from rewriting the LEGACY path
const LEGACY_USER_DIR = join(process.env.HOME ?? '', '.local' + 'claw', 'plugins');

// Precedence order: project-level, then Invarail user dir, then LEGACY dir
// (TEMPORARY shim — see DECISIONS for the removal condition). A plugin name
// already loaded from an earlier dir is SKIPPED, never double-registered.
const PLUGIN_DIRS = [
  'plugins',                                              // project-level
  join(process.env.HOME ?? '', '.invarail', 'plugins'),   // user-level
  LEGACY_USER_DIR,                                        // legacy user-level (deprecated)
];

export async function loadPlugins(toolRegistry: ToolRegistry): Promise<number> {
  let loaded = 0;
  const seen = new Set<string>();

  for (const dir of PLUGIN_DIRS) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(dir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      if (seen.has(entry.name)) {
        console.log(`[Plugins] Skipping duplicate "${entry.name}" in ${dir} — already loaded from a higher-precedence dir`);
        continue;
      }
      seen.add(entry.name);
      if (dir === LEGACY_USER_DIR) {
        console.warn(`[Plugins] DEPRECATED: "${entry.name}" loaded from legacy ${LEGACY_USER_DIR} — move it to ~/.invarail/plugins`);
      }

      try {
        const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        if (manifest.type === 'tool') {
          const mainPath = resolve(dir, entry.name, manifest.main);
          if (!existsSync(mainPath)) {
            console.warn(`[Plugins] ${manifest.name}: main file not found at ${mainPath}`);
            continue;
          }

          const mod = await import(mainPath) as PluginExport;

          if (mod.tool) {
            toolRegistry.register(mod.tool);
            loaded++;
            console.log(`[Plugins] Loaded tool: ${manifest.name} (${manifest.version})`);
          } else if (mod.tools) {
            for (const tool of mod.tools) {
              toolRegistry.register(tool);
              loaded++;
            }
            console.log(`[Plugins] Loaded ${mod.tools.length} tools from: ${manifest.name} (${manifest.version})`);
          } else {
            console.warn(`[Plugins] ${manifest.name}: no 'tool' or 'tools' export found`);
          }
        }
        // Channel and pipeline plugin loading can be added later
      } catch (err) {
        console.warn(`[Plugins] Failed to load ${entry.name}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return loaded;
}
