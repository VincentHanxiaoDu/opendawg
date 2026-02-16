import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
import { escapeHtml } from "../utils.js";

let toolMessageId: number | null = null;
let toolDeleteTimeout: NodeJS.Timeout | null = null;

let activeQuestionMessageId: number | null = null;

let nextQId = 0;
const questionCallbackMap = new Map<string, { sessionID: string; callID: string; qIdx: number; action: string; label: string }>();

export function getQuestionCallback(shortId: string) {
    return questionCallbackMap.get(shortId);
}

export async function handleToolPart(ctx: Context, part: any, userSession: UserSession): Promise<void> {
    try {
        if (part.tool === "question" && part.state?.input) {
            await handleQuestionTool(ctx, part);
            return;
        }

        const { verbosity, stream } = userSession;

        if (verbosity < 1 && !stream) return;

        let toolText = `[Tool] 🔧 ${part.tool}`;

        if (verbosity >= 2 && part.state?.input) {
            const argsSummary = summarizeArgs(part.state.input);
            if (argsSummary) toolText += `: ${argsSummary}`;
        }

        if (verbosity >= 3 && part.state?.output) {
            const outputSummary = summarizeOutput(part.state.output);
            if (outputSummary) toolText += `\n→ ${outputSummary}`;
        }

        if (verbosity >= 2) {
            // Each tool call gets its own persistent message
            await ctx.reply(toolText);
        } else {
            // Low verbosity: reuse single message, auto-delete
            if (toolDeleteTimeout) {
                clearTimeout(toolDeleteTimeout);
                toolDeleteTimeout = null;
            }

            if (!toolMessageId) {
                const sentMessage = await ctx.reply(toolText);
                toolMessageId = sentMessage.message_id;
            } else {
                try {
                    await ctx.api.editMessageText(ctx.chat!.id, toolMessageId, toolText);
                } catch {}
            }

            toolDeleteTimeout = setTimeout(async () => {
                try {
                    if (toolMessageId) {
                        await ctx.api.deleteMessage(ctx.chat!.id, toolMessageId);
                        toolMessageId = null;
                    }
                } catch {}
            }, 2500);
        }

    } catch (error) {
        console.log("Error in tool part handler:", error);
    }
}

function summarizeArgs(input: any): string {
    if (!input || typeof input !== "object") return "";
    const parts: string[] = [];
    for (const [key, val] of Object.entries(input)) {
        if (typeof val === "string") {
            parts.push(val.length > 80 ? val.slice(0, 80) + "…" : val);
        } else if (typeof val === "number" || typeof val === "boolean") {
            parts.push(`${key}=${val}`);
        }
        if (parts.length >= 2) break;
    }
    return parts.join(", ");
}

function summarizeOutput(output: any): string {
    if (!output) return "";
    const str = typeof output === "string" ? output : JSON.stringify(output);
    if (str.length > 120) return str.slice(0, 120) + "…";
    return str;
}

function makeQCallback(sessionID: string, callID: string, qIdx: number, action: string, label: string): string {
    const id = `q${nextQId++}`;
    questionCallbackMap.set(id, { sessionID, callID, qIdx, action, label });
    return id;
}

async function handleQuestionTool(ctx: Context, part: any): Promise<void> {
    try {
        const input = part.state.input;

        // input may have "questions" array (AskUserQuestion format)
        const questions: any[] = input.questions || [];
        if (questions.length === 0) return;

        // If we already sent a question message for this tool call, skip
        if (activeQuestionMessageId) return;

        for (let qIdx = 0; qIdx < questions.length; qIdx++) {
            const q = questions[qIdx];
            const questionText = q.question || "Question";
            const header = q.header || "";
            const options: any[] = q.options || [];

            // Build message
            let msg = `❓ <b>${escapeHtml(header)}</b>\n\n${escapeHtml(questionText)}`;

            // Build option descriptions
            for (let i = 0; i < options.length; i++) {
                const opt = options[i];
                msg += `\n\n<b>${i + 1}. ${escapeHtml(opt.label)}</b>`;
                if (opt.description) {
                    msg += `\n${escapeHtml(opt.description)}`;
                }
            }

            // Build inline keyboard with short callback IDs
            const buttons = options.map((opt: any, i: number) => ({
                text: opt.label,
                callback_data: makeQCallback(part.sessionID, part.callID, qIdx, String(i), opt.label),
            }));

            // Put max 2 per row
            const rows: any[][] = [];
            for (let i = 0; i < buttons.length; i += 2) {
                rows.push(buttons.slice(i, i + 2));
            }
            // Add skip/custom row
            rows.push([
                { text: "✍️ Custom", callback_data: makeQCallback(part.sessionID, part.callID, qIdx, "custom", "") },
                { text: "⏭ Skip", callback_data: makeQCallback(part.sessionID, part.callID, qIdx, "skip", "") },
            ]);

            const sentMessage = await ctx.reply(msg, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: rows },
            });
            activeQuestionMessageId = sentMessage.message_id;
        }
    } catch (error) {
        console.log("Error handling question tool:", error);
    }
}

// Reset active question state (called after answer is sent)
export function resetQuestionState(): void {
    activeQuestionMessageId = null;
}
