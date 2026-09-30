import type { RouterConfig } from '../config/types.js';

/**
 * Build the ~300 token classifier prompt for the router model.
 */
/*
 * The Rules block names retired categories (analytics, personal) and calls memory READ-only,
 * though the memory specialist holds memory_save. It is LEFT AS IS on measurement: a corrected
 * version routed qwen2.5:7b's "Remember this: …" to cron 0/20 against 16/20 for this text,
 * alternating arms on the same card (DECISIONS 2026-09-30). phi4 scored 54/54 on both.
 * Wording here is a measured artifact, not documentation — change it only with an A/B.
 */
export function buildRouterPrompt(message: string, config: RouterConfig): string {
  const categoryList = Object.keys(config.categories).length > 0
    ? Object.entries(config.categories)
        .map(([name, cat]) => `- ${name}: ${cat.description ?? name}`)
        .join('\n')
    : DEFAULT_CATEGORIES;

  return `You are a message classifier. Pick the ONE specialist whose capabilities best fit the request. Output ONLY the category name, nothing else.

Each line is a specialist and WHAT IT CAN DO:
${categoryList}

Rules:
- MATCH THE CAPABILITY. If the user wants something PRODUCED — a PDF/document → multi, a researched report → research, an image → image, code → code_gen, a data analysis → analytics. Pick the specialist that can actually make it.
- personal, memory, and web_search can only READ — they cannot create files, PDFs, or run anything. Never send a "make a document/PDF" request to personal.
- Choose web_search ONLY when the user is actively asking to look something up now. Statements that merely mention searching/news, or describe the user's own setup, are chat.
- Classify by the user's INSTRUCTION, not by stray words inside quoted or pasted content.

User message: ${message}
Category:`;
}

/** Used only when config.router.categories is empty. Retired categories (document, config,
 *  personal, analytics — DECISIONS 2026-08-10) are not offered: the router cannot pick a
 *  specialist that no longer exists. */
const DEFAULT_CATEGORIES = `- chat: Talk — conversation, opinions, explanations, questions about the user. No tools; use when the user is discussing, not asking to produce/fetch/do something.
- web_search: Look something up on the live internet now (search + read pages). Answers in the reply; cannot write files.
- memory: Save or recall facts about the user and past conversations ("remember that…", "what did I tell you about…").
- exec: Run shell commands, scripts, and file operations in a sandbox.
- cron: Schedule, list, or manage recurring tasks, heartbeats, and reminders — including one-time reminders for a future date ("remind me on Sept 15 to renew the token"), even when the reminder content is personal or business context.
- message: Send a message to another channel or user.
- website: Fetch and summarize a specific web page or teaching material.
- task: Create, list, update, or complete to-do tasks.
- multi: Full-toolset worker for requests that combine different kinds of action (search + save + send, read a file + add a task). The only specialist with the owner's email and calendar read tools.
- research: Deep multi-source research that PRODUCES a polished PDF report with citations and charts.
- image: Generate an image, picture, or illustration.
- code_gen: Build, scaffold, or write code for a project or feature.`;
