import type { PipelineDefinition } from '../types.js';

/**
 * Message pipeline: extract(channel, channelId, text) → tool(send_message) → code(confirm)
 *
 * Replaces the ReAct loop for the "message" category.
 * The LLM only extracts parameters — the workflow is deterministic.
 */
export const messagePipeline: PipelineDefinition = {
  name: 'message',
  stages: [
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        channel: {
          type: 'string',
          description: 'Channel adapter ID to send the message through',
          required: true,
          enum: ['discord', 'telegram', 'slack', 'whatsapp'],
        },
        channelId: {
          type: 'string',
          description: 'Target channel or chat ID (e.g., Discord channel ID, Telegram chat ID)',
          required: true,
        },
        text: {
          type: 'string',
          description: 'The message text to send',
          required: true,
        },
      },
      examples: [
        {
          input: 'send a message to #general saying hello everyone',
          output: { channel: 'discord', channelId: 'general', text: 'hello everyone' },
        },
        {
          input: 'tell the telegram group that the meeting is at 3pm',
          output: { channel: 'telegram', channelId: '', text: 'The meeting is at 3pm' },
        },
      ],
    },
    {
      name: 'use_source_defaults',
      type: 'code',
      execute: (ctx) => {
        // If the user didn't specify a channel, use the source channel
        if (!ctx.params.channel && ctx.sourceContext?.channel) {
          ctx.params.channel = ctx.sourceContext.channel;
        }
        if (!ctx.params.channelId && ctx.sourceContext?.channelId) {
          ctx.params.channelId = ctx.sourceContext.channelId;
        }
        return ctx.params;
      },
    },
    {
      name: 'validate_target',
      type: 'code',
      execute: (ctx) => {
        // Fabricated-target guard: extraction has invented ids before (a
        // Discord-shaped snowflake as a WhatsApp target, July 7 — only the
        // confirm gate stopped it). A target the extractor produced must be
        // FORMAT-plausible for its channel, or plausibly sourced (== the
        // conversation's own channelId). Otherwise abort with a question
        // instead of proposing a send to nowhere/someone-unknown.
        const channel = String(ctx.params.channel ?? '');
        const channelId = String(ctx.params.channelId ?? '');
        const fromSource = channelId === ctx.sourceContext?.channelId;

        const plausible: Record<string, RegExp> = {
          whatsapp: /@(s\.whatsapp\.net|g\.us)$|^\d{7,15}$/,   // jid or bare phone number
          telegram: /^-?\d{6,14}$/,                             // chat id
          discord: /^\d{17,20}$/,                               // snowflake
          slack: /^[CDG][A-Z0-9]{6,12}$/,                       // channel id
        };
        const re = plausible[channel];
        if (channelId && re && !re.test(channelId) && !fromSource) {
          ctx.answer = `I couldn't determine a valid ${channel} destination — "${channelId}" doesn't look like a real ${channel} target. Who should this go to?`;
          ctx.abort = true;
        }
        return ctx.params;
      },
    },
    {
      name: 'send',
      type: 'tool',
      tool: 'send_message',
      resolveParams: (ctx) => ({
        channel: ctx.params.channel,
        channelId: ctx.params.channelId,
        text: ctx.params.text,
      }),
    },
    {
      name: 'confirm',
      type: 'code',
      execute: (ctx) => {
        const result = ctx.stageResults.send as string;
        if (result.startsWith('Message sent')) {
          ctx.answer = `Done — message sent to ${ctx.params.channel}:${ctx.params.channelId}.`;
        } else if (result.includes('Confirmation required')) {
          // Confirm-gate preview is NOT a failure — present it plainly, with the
          // target spelled out in words a skim-reader catches
          ctx.answer = `⏸️ Not sent yet. I'm ready to send this ${ctx.params.channel} message to \`${ctx.params.channelId}\`:\n> ${String(ctx.params.text).slice(0, 200)}\n\nReply "confirm" to send it, or ignore to cancel (expires in 10 minutes).`;
        } else {
          ctx.answer = `Failed to send message: ${result}`;
        }
        return ctx.answer;
      },
    },
  ],
};
