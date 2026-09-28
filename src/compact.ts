/**
 * Stoppable manual compaction for Telegram.
 *
 * pi's `ctx.compact()` runs its summarization LLM call internally with an
 * abort controller that is NOT exposed to extensions (checked 0.84.4: no
 * `abortCompaction`, no `isCompacting` on the context) — a Telegram Stop
 * button could never cancel it. So for TG-initiated `/compact` the bridge
 * still calls `ctx.compact()` (which first aborts any in-flight run and then
 * fires the `session_before_compact` hook) and THIS module performs the
 * summarization itself — replaying pi's default compaction exactly — but
 * with our own AbortController: the Stop button aborts the in-flight LLM
 * call and the hook returns `{cancel: true}` ("Compaction cancelled").
 *
 * The prompt texts, prompt assembly, max-token math, thinking/reasoning
 * passthrough, file-ops sections, and split-turn composition replicate pi
 * 0.84.4's default compaction (bundle: `compact`, `generateSummaryWithUsage`,
 * `generateTurnPrefixSummary`, `computeFileLists`, `formatFileOperations`,
 * `combineUsage`, `serializeConversation`) so the stored summary is identical
 * in format and quality to what pi would have produced.
 *
 * Module boundary: this file is pi-FREE (enforced by tests/boundary.test.ts).
 * index.ts converts pi's session messages with pi's own `convertToLlm` before
 * passing them in, and injects `ctx.modelRegistry.complete` as `complete`.
 *
 * Only TG-initiated manual compactions go through here: the hook skips
 * `reason !== "manual"` (threshold/overflow auto-compaction keeps pi's
 * default path) and compactions with no pending TG state (e.g. `/compact`
 * typed in the TUI).
 */

// ─────────────────────────── pi 0.84.4 prompt texts ───────────────────────────
// Copied verbatim from the pi 0.84.4 bundle — keep in sync when upgrading pi.

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ─────────────────────────── structural pi mirrors ───────────────────────────
// (keep this file testable without pi's types; index.ts maps real pi values
// into these at the boundary)

/** A content block of an LLM message (pi-ai's Content, structurally). */
export interface TgLlmContentBlock {
  type: string; // "text" | "image" | "thinking" | "toolCall"
  text?: string;
  thinking?: string;
  name?: string; // toolCall
  arguments?: Record<string, unknown>; // toolCall
}

/** An already-converted LLM message (pi-ai's Message, structurally). */
export interface TgLlmMessage {
  role: string; // "user" | "assistant" | "toolResult" (others are skipped)
  content: string | TgLlmContentBlock[];
}

export interface TgModel {
  id: string;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface TgContentPart {
  type: string;
  text?: string;
}

export interface TgUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface TgAssistantResponse {
  stopReason: string; // "stop" | "length" | "error" | "aborted"
  errorMessage?: string;
  content: TgContentPart[];
  usage: TgUsage;
}

export interface TgCompleteOptions {
  maxTokens: number;
  signal: AbortSignal;
  cacheRetention: "none";
  reasoning?: string;
}

/** One LLM completion — `ctx.modelRegistry.complete`, injected for tests. */
export type TgComplete = (
  model: TgModel,
  context: { systemPrompt: string; messages: unknown[] },
  options: TgCompleteOptions,
) => Promise<TgAssistantResponse>;

export interface TgFileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface TgCompactionPreparation {
  firstKeptEntryId: string;
  /** Session messages to summarize — pi's convertToLlm output (index.ts does the conversion). */
  messagesToSummarize: TgLlmMessage[];
  /** Messages of the split turn's prefix (empty unless isSplitTurn). */
  turnPrefixMessages: TgLlmMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: TgFileOperations;
  settings: { reserveTokens: number };
}

export interface TgCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: TgUsage;
  details: { readFiles: string[]; modifiedFiles: string[] };
}

export type TgCompactionOutcome = { aborted: true } | { compaction: TgCompactionResult };

export interface TgCompactionOptions {
  preparation: TgCompactionPreparation;
  model: TgModel;
  thinkingLevel?: string;
  customInstructions?: string;
  /** Our own signal — the Telegram Stop button aborts it. */
  signal: AbortSignal;
  complete: TgComplete;
}

/** The error pi raises (and reports to `onError`) when a compaction is cancelled. */
export const COMPACT_CANCELLED_MSG = "Compaction cancelled";

/** Thrown inside runTgCompaction when OUR signal was aborted (user pressed Stop). */
export class CompactionAbortError extends Error {
  constructor() {
    super(COMPACT_CANCELLED_MSG);
  }
}

// ─────────────────────────── file-ops & usage (pi replicas) ───────────────────────────

export function computeFileLists(fileOps: TgFileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

export function combineUsage(first: TgUsage, second: TgUsage): TgUsage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

// ─────────────────────────── conversation serialization (pi replica) ───────────────────────────

const TOOL_RESULT_MAX_CHARS = 2000;

function contentText(content: string | TgLlmContentBlock[], separator = "\n"): string {
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(separator);
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** pi's serializeConversation, verbatim (role lines + tool-arg rendering + truncation). */
export function serializeLlmConversation(messages: TgLlmMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      const blocks = (typeof msg.content === "string" ? [] : msg.content) as TgLlmContentBlock[];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of blocks) {
        if (block.type === "thinking") thinkingParts.push(block.thinking ?? "");
        else if (block.type === "toolCall") {
          const args = block.arguments ?? {};
          const argsStr = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
          toolCalls.push(`${block.name ?? ""}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (blocks.some((b) => b.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

// ─────────────────────────── summarization calls ───────────────────────────

function textOf(parts: TgContentPart[]): string {
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function failureOf(response: TgAssistantResponse, label: string): string | undefined {
  if (response.stopReason === "error") return `${label} failed: ${response.errorMessage || "Unknown error"}`;
  if (response.stopReason === "length") return `${label} failed: generation hit the token cap and the summary is incomplete`;
  return undefined;
}

function assertNotToolCall(content: TgContentPart[], label: string): void {
  if (content.some((b) => b.type === "toolCall")) throw new Error(`${label} attempted to call a tool`);
}

/** One summarization completion: prompt build + max-token math + validation. */
async function summarize(
  messages: TgLlmMessage[],
  model: TgModel,
  opts: {
    maxTokensFactor: number;
    reserveTokens: number;
    prompt: string;
    label: string;
    signal: AbortSignal;
    thinkingLevel?: string;
    complete: TgComplete;
    previousSummary?: string;
  },
): Promise<{ text: string; usage: TgUsage }> {
  // Same math as pi: floor(factor * reserveTokens), capped by the model's maxTokens.
  const cap = model.maxTokens ?? 0;
  const maxTokens = Math.min(Math.floor(opts.maxTokensFactor * opts.reserveTokens), cap > 0 ? cap : Number.POSITIVE_INFINITY);
  // pi's prompt build: conversation, THEN the previous summary in its tags (when
  // updating an existing one), THEN the base prompt.
  let promptText = `<conversation>\n${serializeLlmConversation(messages)}\n</conversation>\n\n`;
  if (opts.previousSummary) promptText += `<previous-summary>\n${opts.previousSummary}\n</previous-summary>\n\n`;
  promptText += opts.prompt;
  let response: TgAssistantResponse;
  try {
    response = await opts.complete(
      model,
      {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
      },
      {
        maxTokens,
        signal: opts.signal,
        cacheRetention: "none",
        // pi passes the thinking level through only for reasoning models.
        ...(model.reasoning && opts.thinkingLevel && opts.thinkingLevel !== "off" ? { reasoning: opts.thinkingLevel } : {}),
      },
    );
  } catch (err) {
    // The provider rejects the in-flight stream when our signal aborts.
    if (opts.signal.aborted) throw new CompactionAbortError();
    throw err;
  }
  if (response.stopReason === "aborted" || opts.signal.aborted) throw new CompactionAbortError();
  const failure = failureOf(response, opts.label);
  if (failure) throw new Error(failure);
  assertNotToolCall(response.content, opts.label);
  return { text: textOf(response.content), usage: response.usage };
}

/**
 * Run a TG-initiated manual compaction (pi's default `compact()` replayed with
 * our own abort signal). Returns `{aborted: true}` when our signal was
 * aborted (the hook maps that to `{cancel: true}`); throws for real failures
 * (the hook rethrows → pi's runner catches it → the default compaction runs
 * as a fallback).
 */
export async function runTgCompaction(opts: TgCompactionOptions): Promise<TgCompactionOutcome> {
  const { preparation, model, signal, complete } = opts;
  const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;

  if (signal.aborted) return { aborted: true };
  try {
    return await summarizeAll(opts);
  } catch (err) {
    // Stop button: not an error — the hook maps this to {cancel: true}.
    if (err instanceof CompactionAbortError || signal.aborted) return { aborted: true };
    throw err; // real failure — the hook rethrows → pi's default compaction runs instead
  }
}

async function summarizeAll(opts: TgCompactionOptions): Promise<TgCompactionOutcome> {
  const { preparation, model, signal, complete } = opts;
  const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;
  const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  const prompt = opts.customInstructions ? `${basePrompt}\n\nAdditional focus: ${opts.customInstructions}` : basePrompt;
  const summarizer = async (messages: TgLlmMessage[]): Promise<{ text: string; usage: TgUsage }> =>
    summarize(messages, model, {
      maxTokensFactor: 0.8,
      reserveTokens: settings.reserveTokens,
      prompt,
      label: "Summarization",
      signal,
      thinkingLevel: opts.thinkingLevel,
      complete,
      previousSummary,
    });

  let summary: string;
  let summaryUsage: TgUsage | undefined;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    // pi's split-turn composition: [history summary] --- **Turn Context (split turn):** [prefix summary]
    let historyText = "No prior history.";
    let historyUsage: TgUsage | undefined;
    if (messagesToSummarize.length > 0) {
      const historyResult = await summarizer(messagesToSummarize);
      historyText = historyResult.text;
      historyUsage = historyResult.usage;
    }
    const turnPrefixResult = await summarize(turnPrefixMessages, model, {
      maxTokensFactor: 0.5,
      reserveTokens: settings.reserveTokens,
      prompt: TURN_PREFIX_SUMMARIZATION_PROMPT,
      label: "Turn prefix summarization",
      signal,
      thinkingLevel: opts.thinkingLevel,
      complete,
    });
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
    summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
  } else {
    const result = await summarizer(messagesToSummarize);
    summary = result.text;
    summaryUsage = result.usage;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  if (!firstKeptEntryId) throw new Error("First kept entry has no UUID - session may need migration");
  return {
    compaction: { summary, firstKeptEntryId, tokensBefore, usage: summaryUsage, details: { readFiles, modifiedFiles } },
  };
}
