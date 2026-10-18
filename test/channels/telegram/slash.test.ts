import { describe, it, expect } from 'vitest';
import { translateSlashCommand } from '../../../src/channels/telegram/adapter.js';

// Pins the Telegram "/" → harness "!" translation (adapter.handleSlash), so a reviewer can see
// that /forget keeps its argument, @bot mentions stay out of the term, and unknown "/" text is
// never consumed.
describe('translateSlashCommand', () => {
  it('/forget term reaches the harness as !forget term', () => {
    expect(translateSlashCommand('/forget coffee')).toEqual({ bang: '!forget', content: '!forget coffee' });
  });

  it('keeps /forget@yourbot term working (the @mention is the bot address, not the term)', () => {
    expect(translateSlashCommand('/forget@yourbot dirty cup')).toEqual({ bang: '!forget', content: '!forget dirty cup' });
  });

  it('bare /new maps to !new with no arguments', () => {
    expect(translateSlashCommand('/new')).toEqual({ bang: '!new', content: '!new' });
  });

  it('unknown /… text is not consumed', () => {
    expect(translateSlashCommand('/etc/hosts is not a command')).toBeNull();
    expect(translateSlashCommand('hello')).toBeNull();
  });
});
