import type { PipelineDefinition } from '../types.js';
import { CRON_JOB_CATEGORIES } from '../../cron/types.js';

const CRON_CLASSIFY_PROMPT = `You are a scheduling intent classifier. Given the user's message, decide what they want to do with scheduled jobs.

- "add" — the user wants to CREATE or SCHEDULE a new recurring job (e.g., "schedule a daily search", "run this every Friday", "set up a weekly task")
- "list" — the user wants to VIEW current scheduled jobs or is asking a question about them (e.g., "what's scheduled", "show my cron jobs", "any recurring tasks?")
- "remove" — the user wants to DELETE or CANCEL a scheduled job (e.g., "remove the daily search", "cancel that cron job", "stop the weekly task")
- "edit" — the user wants to CHANGE an existing job's schedule, message, or settings (e.g., "change it to run at 10am", "update the search query", "disable that job")`;

export const cronPipeline: PipelineDefinition = {
  name: 'cron',
  stages: [
    {
      name: 'route',
      type: 'llm_branch',
      prompt: CRON_CLASSIFY_PROMPT,
      options: ['add', 'list', 'remove', 'edit'],
      fallback: 'list',
      branches: {
        // --- ADD ---
        add: [
          {
            name: 'extract_add',
            type: 'extract',
            // Array extraction of long reminder texts blows the 256-token default
            maxTokens: 2048,
            schema: {
              jobs: {
                type: 'array',
                required: true,
                description: 'EVERY job the user asked to schedule — one element per job. "Set up three reminders" MUST produce three elements; never drop any.',
                items: {
                  name: { type: 'string', description: 'Job name', required: true },
                  schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *" for daily at 9am; "0 9 15 9 *" for Sep 15 at 9am)', required: true },
                  category: {
                    type: 'string',
                    description: 'Specialist category to handle the job. Use "message" for reminders — the message text is delivered as-is.',
                    required: true,
                    enum: [...CRON_JOB_CATEGORIES],
                  },
                  message: { type: 'string', description: 'The prompt to run when triggered. For reminders, carry over ALL context the user gave so the future message is self-contained.', required: true },
                  once: { type: 'boolean', description: 'true when the job fires at ONE specific future date (a reminder for Sep 15, 2026); false for a repeating schedule (daily, every Friday)' },
                },
              },
              channel: { type: 'string', description: 'Delivery channel (e.g., "discord", "telegram")', required: true },
              target: { type: 'string', description: 'Channel ID for results', required: true },
            },
            examples: [
              {
                input: 'schedule a daily web search for AI news at 9am',
                output: {
                  jobs: [
                    { name: 'Daily AI News', schedule: '0 9 * * *', category: 'web_search', message: 'Search for the latest AI news and summarize top stories', once: false },
                  ],
                  channel: 'discord',
                  target: '',
                },
              },
              {
                input: 'remind me on March 3, 2027 to renew the domain, and every Friday to send invoices',
                output: {
                  jobs: [
                    { name: 'Renew Domain Reminder', schedule: '0 9 3 3 *', category: 'message', message: 'Reminder: renew the domain (it expires soon)', once: true },
                    { name: 'Friday Invoices', schedule: '0 9 * * 5', category: 'message', message: 'Reminder: send this week\'s invoices', once: false },
                  ],
                  channel: '',
                  target: '',
                },
              },
            ],
          },
          {
            name: 'fill_defaults',
            type: 'code',
            execute: (ctx) => {
              // Use source context for channel/target if not extracted
              if (!ctx.params.channel && ctx.sourceContext?.channel) {
                ctx.params.channel = ctx.sourceContext.channel;
              }
              if (!ctx.params.target && ctx.sourceContext?.channelId) {
                ctx.params.target = ctx.sourceContext.channelId;
              }
            },
          },
          {
            name: 'add',
            type: 'parallel_tool',
            tool: 'cron_add',
            resolveParamsList: (ctx) => {
              const jobs = Array.isArray(ctx.params.jobs) ? ctx.params.jobs as Record<string, unknown>[] : [];
              return jobs.map(j => ({
                name: j.name,
                schedule: j.schedule,
                category: j.category,
                message: j.message,
                once: j.once === true,
                channel: ctx.params.channel,
                target: ctx.params.target,
              }));
            },
          },
          {
            name: 'confirm_add',
            type: 'code',
            execute: (ctx) => {
              const results = Array.isArray(ctx.stageResults.add) ? ctx.stageResults.add as string[] : [];
              const requested = Array.isArray(ctx.params.jobs) ? (ctx.params.jobs as unknown[]).length : 0;
              if (results.length === 0) {
                ctx.answer = 'I couldn\'t extract any schedulable jobs from that. Tell me what to schedule, when, and (for reminders) the date — e.g. "remind me on Sep 15, 2026 at 9am to renew the token".';
                return;
              }
              ctx.answer = results.join('\n');
              // A silent partial (asked for 3, created 1) caused the July 20 incident — always disclose
              if (results.length < requested) {
                ctx.answer += `\n⚠️ Only ${results.length} of ${requested} requested jobs were created — the rest failed. Check the errors above and re-send the missing ones.`;
              }
            },
          },
        ],

        // --- LIST ---
        list: [
          {
            name: 'list',
            type: 'tool',
            tool: 'cron_list',
            resolveParams: () => ({}),
          },
          {
            name: 'format_list',
            type: 'llm',
            stream: true,
            temperature: 0.2,
            maxTokens: 1024,
            buildPrompt: (ctx) => ({
              system: 'Format the cron job list into a clear, readable response. Be concise. Include job names, schedules, and status.',
              user: `User asked: "${ctx.userMessage}"\n\nCron jobs:\n${ctx.stageResults.list as string}`,
            }),
          },
        ],

        // --- REMOVE ---
        remove: [
          {
            name: 'extract_remove',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'The job ID to remove', required: true },
            },
            examples: [
              { input: 'remove cron job abc123', output: { id: 'abc123' } },
              { input: 'delete the daily news schedule', output: { id: '' } },
            ],
          },
          {
            name: 'remove',
            type: 'tool',
            tool: 'cron_remove',
            resolveParams: (ctx) => ({ id: ctx.params.id }),
          },
          {
            name: 'confirm_remove',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.remove as string;
            },
          },
        ],

        // --- EDIT ---
        edit: [
          {
            name: 'extract_edit',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'Job ID to edit', required: true },
              name: { type: 'string', description: 'New name' },
              schedule: { type: 'string', description: 'New cron expression' },
              category: {
                type: 'string',
                description: 'New specialist category',
                enum: [...CRON_JOB_CATEGORIES],
              },
              message: { type: 'string', description: 'New prompt/message' },
              enabled: { type: 'string', description: '"true" or "false"' },
              once: { type: 'boolean', description: 'true to make the job one-shot (run once, then auto-disable); false to make it recurring' },
            },
            examples: [
              { input: 'change cron job abc to run at 10am', output: { id: 'abc', schedule: '0 10 * * *' } },
              { input: 'disable job xyz', output: { id: 'xyz', enabled: 'false' } },
              { input: 'make job abc a one-time reminder', output: { id: 'abc', once: true } },
            ],
          },
          {
            name: 'edit',
            type: 'tool',
            tool: 'cron_edit',
            resolveParams: (ctx) => {
              const p: Record<string, unknown> = { id: ctx.params.id };
              for (const key of ['name', 'schedule', 'category', 'message', 'enabled']) {
                if (ctx.params[key]) p[key] = ctx.params[key];
              }
              // once is a boolean — truthiness would drop an explicit false
              if (ctx.params.once !== undefined && ctx.params.once !== '') p.once = ctx.params.once;
              return p;
            },
          },
          {
            name: 'confirm_edit',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.edit as string;
            },
          },
        ],
      },
    },
  ],
};
