import { describe, it, expect } from 'vitest';
import { detectObsidian, obsidianInstallArgs, INSTALL_HINTS } from '../../src/setup/detect.js';

describe('Obsidian detection (optional viewer for the vault tier)', () => {
  it('every platform has an install hint and an offerable install command', () => {
    for (const p of ['mac', 'linux', 'windows'] as const) {
      expect(INSTALL_HINTS.obsidian[p]).toMatch(/obsidian/i);
      const cmd = obsidianInstallArgs(p)!;
      expect(cmd.cmd).toBeTruthy();
      expect(cmd.args.join(' ')).toMatch(/obsidian/i);
    }
  });

  it('reports a Probe either way: found with a location, or not found with the hint for this platform', async () => {
    const probe = await detectObsidian();
    expect(typeof probe.found).toBe('boolean');
    expect(probe.detail).toBeTruthy();
    if (!probe.found) expect(probe.install).toBe(INSTALL_HINTS.obsidian[process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux']);
  });
});
