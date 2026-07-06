import type { LocalClawTool } from './types.js';
import type { ChannelRegistry } from '../channels/registry.js';

export function createSendMessageTool(channelRegistry: ChannelRegistry): LocalClawTool {
  return {
    name: 'send_message',
    description: 'Send a message to a channel or user',
    parameterDescription: 'channel (required): Channel adapter ID (e.g., "discord", "telegram"). channelId (required): Target channel/chat ID. text (required): Message text.',
    example: 'send_message[{"channel": "discord", "channelId": "1234567890", "text": "Deployment complete!"}]',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel adapter ID (e.g., "discord", "telegram")' },
        channelId: { type: 'string', description: 'Target channel/chat ID' },
        text: { type: 'string', description: 'Message text' },
      },
      required: ['channel', 'channelId', 'text'],
    },
    category: 'message',
    // Visible to other people — ladder default is propose-and-confirm.
    // Promote per channel with autoApproveTools once the track record supports it.
    autonomy: { tier: 'propose_confirm', reversible: false, blastRadius: 'external' },

    async execute(params: Record<string, unknown>): Promise<string> {
      const channel = params.channel as string;
      const channelId = params.channelId as string;
      const text = params.text as string;

      if (!channel || !channelId || !text) {
        return 'Error: channel, channelId, and text are all required';
      }

      try {
        await channelRegistry.send(
          { channel, channelId },
          { text },
        );
        return `Message sent to ${channel}:${channelId}`;
      } catch (err) {
        return `Error sending message: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
