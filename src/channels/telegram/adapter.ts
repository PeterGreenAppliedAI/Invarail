import type {
  Attachment,
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';

const TELEGRAM_MAX_LENGTH = 4096;

/** Harness commands reachable from Telegram as "/". The "!"-spelling is the single authority. */
const SLASH_TO_BANG: Record<string, string> = {
  new: '!new', reset: '!reset', save: '!save', discard: '!discard',
  cleanup: '!cleanup', promote: '!promote', forget: '!forget',
};

/**
 * Translate a Telegram "/"-spelling into the harness "!"-spelling, keeping the arguments.
 * `/forget coffee` → `!forget coffee`; `/forget@yourbot term` → `!forget term` (the @mention is
 * the bot's address, not part of the command — only the first whitespace token is consumed).
 * Returns null when `text` is no known harness command so the caller lets it travel to the model
 * as an ordinary message.
 */
export function translateSlashCommand(text: string): { bang: string; content: string } | null {
  const first = text.split(/\s+/)[0] ?? '';
  const name = first.replace(/^\//, '').split('@')[0].toLowerCase();
  const bang = SLASH_TO_BANG[name];
  if (!bang) return null;
  return { bang, content: bang + text.slice(first.length) };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';
  private bot: any = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom: Set<string> | null = null;
  /** "/" menu registered with Telegram via setMyCommands — see setCommandMenu. */
  private commandMenu: { command: string; description: string }[] | null = null;
  /** Commands answered locally, without a model turn — see setLocalCommands. */
  private localCommands: Map<string, (msg: InboundMessage) => Promise<string>> | null = null;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    if (!config.token) {
      throw channelConnectError('telegram', new Error('Missing token'));
    }

    this.currentStatus = 'connecting';

    let grammy: any;
    try {
      // Dynamic import to avoid hard dependency
      const mod = 'grammy';
      grammy = await import(/* webpackIgnore: true */ mod);
    } catch {
      throw channelConnectError('telegram', new Error('grammy not installed. Run: npm i grammy'));
    }

    const bot = new grammy.Bot(config.token);
    this.bot = bot;

    // Store allowFrom list for access control (schema: {users?: string[], channels?: string[]})
    const allowFromConfig = (config as any).allowFrom;
    if (allowFromConfig?.users?.length) {
      this.allowFrom = new Set(allowFromConfig.users as string[]);
      console.log(`[Telegram] allowFrom: ${this.allowFrom.size} user(s)`);
    }

    bot.on('message', async (ctx: any) => {
      if (!this.handler) return;
      const handler = this.handler;

      const msg = ctx.message;

      // Access control: reject messages from users not in allowFrom list
      if (this.allowFrom && !this.allowFrom.has(String(msg.from.id))) {
        return; // silently ignore
      }

      // Slash commands (Telegram users type "/", this harness's own commands are "!-prefixed").
      // Answered locally or translated — see handleSlash.
      const slashText = (msg.text ?? '').trim();
      if (slashText.startsWith('/') && (await this.handleSlash(slashText, msg))) return;

      const content = msg.text ?? msg.caption ?? '';

      // Download photo/document attachments
      const attachments: Attachment[] = [];

      if (msg.photo && msg.photo.length > 0) {
        try {
          // Use the largest photo size (last in array)
          const photo = msg.photo[msg.photo.length - 1];
          const file = await bot.api.getFile(photo.file_id);
          const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const ext = file.file_path?.split('.').pop() ?? 'jpg';
            attachments.push({
              filename: `photo.${ext}`,
              mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              size: buffer.length,
              data: buffer,
            });
          }
        } catch (err) {
          console.warn('[Telegram] CHANNEL_CONNECT_ERROR: Failed to download photo —', err instanceof Error ? err.message : err);
        }
      }

      if (msg.document) {
        try {
          const file = await bot.api.getFile(msg.document.file_id);
          const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            attachments.push({
              filename: msg.document.file_name ?? 'document',
              mimeType: msg.document.mime_type ?? 'application/octet-stream',
              size: buffer.length,
              data: buffer,
            });
          }
        } catch (err) {
          console.warn('[Telegram] CHANNEL_CONNECT_ERROR: Failed to download document —', err instanceof Error ? err.message : err);
        }
      }

      // Download voice messages (OGG/Opus) for STT processing
      let audio: { data: Buffer; mimeType: string } | undefined;
      const voiceFile = msg.voice ?? msg.video_note;
      if (voiceFile) {
        try {
          const file = await bot.api.getFile(voiceFile.file_id);
          const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            audio = {
              data: Buffer.from(await res.arrayBuffer()),
              mimeType: 'audio/ogg',
            };
            console.log(`[Telegram] Voice message: ${audio.data.length} bytes (${voiceFile.duration}s)`);
          }
        } catch (err) {
          console.warn('[Telegram] Failed to download voice message:', err instanceof Error ? err.message : err);
        }
      }

      if (!content && !audio && attachments.length === 0) return;

      const inbound: InboundMessage = {
        id: String(msg.message_id),
        channel: 'telegram',
        content,
        senderId: String(msg.from.id),
        senderName: msg.from.first_name,
        channelId: String(msg.chat.id),
        timestamp: new Date(msg.date * 1000),
        raw: msg,
        audio,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await this.withTyping(inbound.channelId, () => handler(inbound));
    });

    // Button presses (inline keyboard) synthesize the equivalent TYPED message
    // ("confirm <id>") through the normal inbound path — reply sugar, not a
    // second security surface. Ledger sender-binding/single-use apply unchanged.
    bot.on('callback_query:data', async (ctx: any) => {
      if (!this.handler) return;
      const handler = this.handler;
      const from = ctx.callbackQuery.from;
      if (this.allowFrom && !this.allowFrom.has(String(from.id))) return;
      const command = ctx.callbackQuery.data as string;
      console.log(`[Telegram] Button press from=${from.id} command="${command}"`);
      // Ack + strip the keyboard so the message shows it was acted on
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      const inbound: InboundMessage = {
        id: String(ctx.callbackQuery.id),
        channel: 'telegram',
        content: command,
        senderId: String(from.id),
        senderName: from.first_name,
        channelId: String(ctx.callbackQuery.message?.chat?.id ?? from.id),
        timestamp: new Date(),
        raw: ctx.callbackQuery,
      };
      try {
        await this.withTyping(inbound.channelId, () => handler(inbound));
      } catch (err) {
        console.warn('[Telegram] Button handler failed:', err instanceof Error ? err.message : err);
      }
    });

    // grammy's bot.start() handles long-polling with automatic retry on transient errors.
    // Catch fatal errors (e.g., invalid token) and update status.
    bot.catch((err: any) => {
      console.warn('[Telegram] Bot error:', err.message ?? err);
      this.currentStatus = 'error';
    });

    bot.start();
    this.currentStatus = 'connected';
    console.log('[Telegram] Bot started');

    // The "/" menu in the Telegram client. Registered here because the adapter is configured
    // (setCommandMenu) before connect() runs.
    if (this.commandMenu?.length) {
      try {
        await bot.api.setMyCommands(this.commandMenu);
        console.log(`[Telegram] Command menu: ${this.commandMenu.map(c => '/' + c.command).join(' ')}`);
      } catch (err) {
        console.warn('[Telegram] setMyCommands failed —', err instanceof Error ? err.message : err);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot && typeof this.bot.stop === 'function') {
      this.bot.stop();
    }
    this.bot = null;
    this.currentStatus = 'disconnected';
  }

  /** Show Telegram's "typing…" indicator while inbound work runs. The action
   *  expires after ~5s, so re-send it every 4s; stop once the work resolves. */
  private async withTyping(chatId: string | undefined, work: () => Promise<void>): Promise<void> {
    const ping = () => {
      if (!chatId) return;
      this.bot?.api?.sendChatAction(chatId, 'typing')?.catch((err: unknown) => console.warn('[Telegram] typing indicator failed:', err instanceof Error ? err.message : err));
    };
    ping();
    const timer = setInterval(ping, 4000);
    try {
      await work();
    } finally {
      clearInterval(timer);
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Commands offered as the Telegram "/" menu (call before connect()). */
  setCommandMenu(commands: { command: string; description: string }[]): void {
    this.commandMenu = commands;
  }

  /** Commands answered from real harness state, with no model turn in between. */
  setLocalCommands(commands: Record<string, (msg: InboundMessage) => Promise<string>>): void {
    this.localCommands = new Map(Object.entries(commands).map(([name, fn]) => [name.toLowerCase(), fn]));
    console.log(`[Telegram] Local commands: ${[...this.localCommands.keys()].map(c => '/' + c).join(' ')}`);
  }

  private inboundFrom(msg: any, content: string): InboundMessage {
    return {
      id: String(msg.message_id),
      channel: 'telegram',
      content,
      senderId: String(msg.from.id),
      senderName: msg.from.first_name,
      channelId: String(msg.chat.id),
      timestamp: new Date(msg.date * 1000),
      raw: msg,
    };
  }

  /**
   * Slash commands.
   *
   * Telegram users expect the "/" menu, but this harness's commands are "!"-prefixed
   * (!new, !reset, !save, …). The slash spellings are translated to the bang spelling and
   * pushed through the normal inbound path, so ONE command implementation stays
   * authoritative. Commands with no bang equivalent (/tools, /status, /help) are answered
   * locally, from the orchestrator's real registries and WITHOUT a model turn — a small
   * local model asked about its own tools invents them, which is the bug this fixes.
   * Unknown "/" text (e.g. a German sentence starting with "/etc/hosts …") is NOT consumed
   * and travels to the model as a normal message.
   */
  private async handleSlash(text: string, msg: any): Promise<boolean> {
    const name = (text.split(/\s+/)[0] ?? '').replace(/^\//, '').split('@')[0].toLowerCase();
    // The tested translation is the one that runs (it keeps arguments: `/forget coffee` →
    // `!forget coffee`, and drops the @bot suffix).
    const translated = translateSlashCommand(text);
    const local = this.localCommands?.get(name);
    if (!translated && !local) return false;

    if (translated && !local) {
      if (!this.handler) return true;
      console.log(`[Telegram] /${name} → ${translated.bang} (harness command)`);
      await this.handler(this.inboundFrom(msg, translated.content));
      return true;
    }

    let answer: string;
    try {
      answer = await local!(this.inboundFrom(msg, text));
    } catch (err) {
      answer = `/${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      await this.bot.api.sendMessage(String(msg.chat.id), answer.slice(0, TELEGRAM_MAX_LENGTH), {
        reply_to_message_id: msg.message_id,
      });
    } catch (err) {
      console.warn(`[Telegram] could not send /${name} reply —`, err instanceof Error ? err.message : err);
    }
    console.log(`[Telegram] /${name} answered locally (${answer.length} chars, no model turn)`);
    return true;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.bot) {
      throw channelSendError('telegram', new Error('Not connected'));
    }

    try {
      // Send voice/audio message if present
      if (content.audio) {
        try {
          const mod = 'grammy';
          const grammy = await import(/* webpackIgnore: true */ mod);
          const replyOpts = { reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined };

          if (content.audio.mimeType === 'audio/ogg') {
            // OGG/Opus → sendVoice (plays inline as voice note)
            const inputFile = new grammy.InputFile(content.audio.data, 'response.ogg');
            await this.bot.api.sendVoice(target.channelId, inputFile, replyOpts);
          } else {
            // MP3/WAV → sendAudio (plays as audio file)
            const ext = content.audio.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
            const inputFile = new grammy.InputFile(content.audio.data, `response.${ext}`);
            await this.bot.api.sendAudio(target.channelId, inputFile, replyOpts);
          }
        } catch (err) {
          console.warn('[Telegram] Audio send failed:', err instanceof Error ? err.message : err);
        }
      }

      // Send image attachments
      if (content.attachments) {
        try {
          const mod = 'grammy';
          const grammy = await import(/* webpackIgnore: true */ mod);
          const replyOpts = { reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined };
          for (const att of content.attachments) {
            if (att.mimeType.startsWith('image/')) {
              const inputFile = new grammy.InputFile(att.data, att.filename);
              await this.bot.api.sendPhoto(target.channelId, inputFile, replyOpts);
            } else {
              const inputFile = new grammy.InputFile(att.data, att.filename);
              await this.bot.api.sendDocument(target.channelId, inputFile, replyOpts);
            }
          }
        } catch (err) {
          console.warn('[Telegram] Attachment send failed:', err instanceof Error ? err.message : err);
        }
      }

      // Buttons ride on the LAST chunk so they sit under the full message
      const keyboard = content.actions?.length
        ? { inline_keyboard: [content.actions.slice(0, 5).map(a => ({ text: a.label, callback_data: a.command.slice(0, 64) }))] }
        : undefined;

      const chunks = splitTelegramMessage(content.text, TELEGRAM_MAX_LENGTH);
      for (let i = 0; i < chunks.length; i++) {
        await this.bot.api.sendMessage(target.channelId, chunks[i], {
          reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined,
          reply_markup: i === chunks.length - 1 ? keyboard : undefined,
        });
      }
    } catch (err) {
      throw channelSendError('telegram', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }
}

function splitTelegramMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit / 2) {
      splitAt = remaining.lastIndexOf(' ', limit);
    }
    if (splitAt === -1 || splitAt < limit / 2) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
