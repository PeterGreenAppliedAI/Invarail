import type { InvarailTool } from '../tools/types.js';

export interface PluginManifest {
  name: string;
  version: string;
  type: 'tool' | 'channel' | 'pipeline';
  main: string;
  description?: string;
}

export interface PluginExport {
  tool?: InvarailTool;
  tools?: InvarailTool[];
}
