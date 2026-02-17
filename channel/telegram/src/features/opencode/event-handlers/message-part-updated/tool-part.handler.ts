import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
import { escapeHtml } from "../utils.js";

const toolCallMessages = new Map<string, number>();

export let activeQuestionMessageId: number | null = null;

export function setActiveQuestionMessageId(id: number | null): void {
    activeQuestionMessageId = id;
}

let nextQId = 0;
const questionCallbackMap = new Map<string, { sessionID: string; callID: string; qIdx: number; action: string; label: string }>();

export function getQuestionCallback(shortId: string) {
    return questionCallbackMap.get(shortId);
}

export async function handleToolPart(ctx: Context, part: any, userSession: UserSession): Promise<void> {
    try {
        if (part.tool === "question") return;

        const { verbosity, stream } = userSession;

        if (verbosity < 1) return;
        if (!stream) return;

        const callID: string | undefined = part.callID || part.id;
        if (!callID) return;

        let toolText = `[Tool] 🔧 ${part.tool}`;

        if (verbosity >= 2 && part.state?.input) {
            const argsSummary = summarizeArgs(part.state.input);
            if (argsSummary) toolText += `: ${argsSummary}`;
        }

        if (verbosity >= 3 && part.state?.output) {
            const outputSummary = summarizeOutput(part.state.output);
            if (outputSummary) toolText += `\n→ ${outputSummary}`;
        }

        const existingMsgId = toolCallMessages.get(callID);

        if (existingMsgId) {
            try {
                await ctx.api.editMessageText(ctx.chat!.id, existingMsgId, toolText);
            } catch {}
        } else {
            const sentMessage = await ctx.reply(toolText);
            toolCallMessages.set(callID, sentMessage.message_id);
        }

    } catch (error) {
        console.log("Error in tool part handler:", error);
    }
}

export function clearToolCallMessages(): void {
    toolCallMessages.clear();
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

export function makeQCallback(sessionID: string, callID: string, qIdx: number, action: string, label: string): string {
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

export function resetQuestionState(): void {
    activeQuestionMessageId = null;
}


