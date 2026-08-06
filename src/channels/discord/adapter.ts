import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from 'discord.js';
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

const DISCORD_MAX_LENGTH = 2000;

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord';
  private client: Client | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];

  async connect(config: ChannelAdapterConfig): Promise<void> {
    if (!config.token) {
      throw channelConnectError('discord', new Error('Missing token'));
    }

    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('messageCreate', async (msg: Message) => {
      console.log(`[Discord] messageCreate from=${msg.author.tag} bot=${msg.author.bot} content="${msg.content}" guild=${msg.guildId ?? 'DM'}`);
      if (msg.author.bot) return;
      if (!this.handler) { console.log('[Discord] No handler set'); return; }
      if (!this.isAllowed(msg)) { console.log('[Discord] Not allowed'); return; }

      const content = msg.content
        .replace(/<@!?\d+>/g, '')
        .trim();

      // Allow ! commands without mention, require mention for everything else
      const isCommand = content.startsWith('!');
      if (!isCommand && msg.guild && this.client?.user && !msg.mentions.has(this.client.user)) {
        console.log('[Discord] Not mentioned, ignoring');
        return;
      }

      if (!content && msg.attachments.size === 0) return;

      // Download attachments
      const attachments: Attachment[] = [];
      for (const att of msg.attachments.values()) {
        try {
          const res = await fetch(att.url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            attachments.push({
              filename: att.name ?? 'unknown',
              mimeType: att.contentType ?? 'application/octet-stream',
              size: buffer.length,
              data: buffer,
            });
          }
        } catch (err) {
          console.warn(`[Discord] CHANNEL_CONNECT_ERROR: Failed to download attachment ${att.name} —`, err instanceof Error ? err.message : err);
        }
      }

      // Show typing indicator while processing
      const sendTyping = () => {
        if ('sendTyping' in msg.channel) {
          (msg.channel as any).sendTyping().catch((err: unknown) => {
            console.warn('[Discord] CHANNEL_SEND_ERROR: Typing indicator failed —', err instanceof Error ? err.message : err);
          });
        }
      };
      const typingInterval = setInterval(sendTyping, 5000);
      sendTyping();

      const inbound: InboundMessage = {
        id: msg.id,
        channel: 'discord',
        content,
        senderId: msg.author.id,
        senderName: msg.author.displayName ?? msg.author.username,
        guildId: msg.guildId ?? undefined,
        channelId: msg.channelId,
        threadId: msg.thread?.id,
        timestamp: msg.createdAt,
        raw: msg,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      try {
        await this.handler(inbound);
      } finally {
        clearInterval(typingInterval);
      }
    });

    // Button presses synthesize the equivalent TYPED message ("confirm <id>")
    // and flow through the normal inbound path — buttons are reply sugar, never
    // a second security surface. The ledger's sender-binding and single-use
    // semantics apply unchanged (a second press gets "doesn't match").
    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isButton() || !this.handler) return;
      const command = interaction.customId;
      console.log(`[Discord] Button press from=${interaction.user.tag} command="${command}"`);
      // Ack + strip the buttons so the message shows it was acted on
      await interaction.update({ components: [] }).catch((err: unknown) => {
        console.warn('[Discord] Button ack failed:', err instanceof Error ? err.message : err);
      });
      const inbound: InboundMessage = {
        // The MESSAGE id (the preview the button sits on), NOT the interaction
        // id — downstream replies use this as a Discord message reference, and
        // an interaction id there makes every reply send fail ("Unknown message")
        id: interaction.message?.id ?? interaction.id,
        channel: 'discord',
        content: command,
        senderId: interaction.user.id,
        senderName: interaction.user.displayName ?? interaction.user.username,
        guildId: interaction.guildId ?? undefined,
        channelId: interaction.channelId ?? undefined,
        timestamp: new Date(),
        raw: interaction,
      };
      try {
        await this.handler(inbound);
      } catch (err) {
        console.warn('[Discord] Button handler failed:', err instanceof Error ? err.message : err);
      }
    });

    // Track connection state changes (discord.js handles reconnection internally)
    this.client.on('error', (err) => {
      console.warn('[Discord] Client error:', err.message);
      this.currentStatus = 'error';
    });
    this.client.on('shardDisconnect', () => {
      console.warn('[Discord] Shard disconnected');
      this.currentStatus = 'connecting';
    });
    this.client.on('shardReconnecting', () => {
      console.log('[Discord] Reconnecting...');
      this.currentStatus = 'connecting';
    });
    this.client.on('shardResume', () => {
      console.log('[Discord] Reconnected');
      this.currentStatus = 'connected';
    });

    await this.client.login(config.token);
    this.currentStatus = 'connected';
    console.log(`[Discord] Logged in as ${this.client.user?.tag}`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.client) {
      throw channelSendError('discord', new Error('Not connected'));
    }

    try {
      let sendable: any;

      // Try fetching as a server channel first
      const channel = await this.client.channels.fetch(target.channelId).catch(() => null);
      if (channel && 'send' in channel) {
        sendable = channel;
      } else {
        // Fallback: treat target as a user ID and open a DM
        const user = await this.client.users.fetch(target.channelId);
        sendable = await user.createDM();
      }

      // Build file attachments (audio + images)
      const files: Array<{ attachment: Buffer; name: string }> = [];
      if (content.audio) {
        files.push({ attachment: content.audio.data, name: 'response.ogg' });
      }
      if (content.attachments) {
        for (const att of content.attachments) {
          files.push({ attachment: att.data, name: att.filename });
        }
      }

      const chunks = splitMessage(content.text, DISCORD_MAX_LENGTH);

      // Buttons ride on the LAST chunk so they sit under the full message
      const styleMap = { primary: ButtonStyle.Primary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const;
      const components = content.actions?.length
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
            content.actions.slice(0, 5).map(a =>
              new ButtonBuilder()
                .setCustomId(a.command)
                .setLabel(a.label)
                .setStyle(styleMap[a.style ?? 'primary']),
            ),
          )]
        : undefined;

      for (let i = 0; i < chunks.length; i++) {
        await sendable.send({
          content: chunks[i],
          reply: target.replyToId ? { messageReference: target.replyToId } : undefined,
          files: i === 0 && files.length > 0 ? files : undefined,
          components: i === chunks.length - 1 ? components : undefined,
        });
      }
    } catch (err) {
      throw channelSendError('discord', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  /** Expose the client for streaming message edits */
  getClient(): Client | null {
    return this.client;
  }

  private isAllowed(msg: Message): boolean {
    if (!this.allowFrom) return true;

    if (this.allowFrom.guilds?.length && msg.guildId) {
      if (!this.allowFrom.guilds.includes(msg.guildId)) return false;
    }
    if (this.allowFrom.channels?.length) {
      if (!this.allowFrom.channels.includes(msg.channelId)) return false;
    }
    if (this.allowFrom.users?.length) {
      if (!this.allowFrom.users.includes(msg.author.id)) return false;
    }
    return true;
  }
}

function splitMessage(text: string, limit: number): string[] {
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
