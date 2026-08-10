/**
 * One-time interactive OAuth for a remote MCP server — the ONLY code path
 * that may open a browser. Run from a real terminal:
 *   npx tsx scripts/mcp-oauth-setup.ts <server-name>
 * The server must be configured in tools.mcp.servers[] with transport "http"
 * and oauth: true. Tokens land in the secret store; Invarail then refreshes
 * silently forever.
 */

import { loadConfig } from '../src/config/loader.js';
import { interactiveAuthorize } from '../src/mcp/oauth.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: npx tsx scripts/mcp-oauth-setup.ts <server-name>');
    process.exit(1);
  }
  const config = loadConfig('invarail.config.json5');
  const server = config.tools?.mcp?.servers.find(s => s.name === name);
  if (!server) {
    console.error(`No MCP server named "${name}" in tools.mcp.servers`);
    process.exit(1);
  }
  if (server.transport !== 'http' || !server.url) {
    console.error(`Server "${name}" is not an http-transport server`);
    process.exit(1);
  }
  await interactiveAuthorize(name, server.url);
}

main().catch(err => {
  console.error('OAuth setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
