import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
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

export function resetQuestionState(): void {
    activeQuestionMessageId = null;
}
