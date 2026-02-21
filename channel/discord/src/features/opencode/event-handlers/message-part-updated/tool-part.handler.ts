import type { Client } from "discord.js";
import type { UserSession } from "../../opencode.types.js";
import { resolveChannel } from "../utils.js";

// Per-session tool call message tracking: sessionId -> (callID -> discordMessageId)
const sessionToolMessages = new Map<string, Map<string, string>>();

// Per-session active question message tracking
const sessionQuestionMessageIds = new Map<string, string | null>();

export function getActiveQuestionMessageId(sessionId: string): string | null {
    return sessionQuestionMessageIds.get(sessionId) ?? null;
}

export function setActiveQuestionMessageId(sessionId: string, id: string | null): void {
    if (id === null) {
        sessionQuestionMessageIds.delete(sessionId);
    } else {
        sessionQuestionMessageIds.set(sessionId, id);
    }
}

let nextQId = 0;
const questionCallbackMap = new Map<string, { sessionID: string; callID: string; qIdx: number; action: string; label: string }>();

export function getQuestionCallback(shortId: string) {
    return questionCallbackMap.get(shortId);
}

export async function handleToolPart(
    client: Client,
    part: any,
    userSession: UserSession
): Promise<void> {
    try {
        if (part.tool === "question") return;

        const { verbosity, stream, sessionId } = userSession;

        if (verbosity < 1) return;
        if (!stream) return;

        const callID: string | undefined = part.callID || part.id;
        if (!callID) return;

        const isCompleted = part.state?.status === "completed" || part.state?.output !== undefined;

        let toolText = `[Tool] ${part.tool}`;

        if (verbosity >= 2 && part.state?.input) {
            const argsSummary = summarizeArgs(part.state.input);
            if (argsSummary) toolText += `: ${argsSummary}`;
        }

        if (verbosity >= 3 && part.state?.output) {
            const outputSummary = summarizeOutput(part.state.output);
            if (outputSummary) toolText += `\n> ${outputSummary}`;
        }

        const channel = userSession.channelId
            ? await resolveChannel(client, userSession.channelId)
            : null;
        if (!channel) return;

        let toolMessages = sessionToolMessages.get(sessionId);
        if (!toolMessages) {
            toolMessages = new Map();
            sessionToolMessages.set(sessionId, toolMessages);
        }

        const existingMsgId = toolMessages.get(callID);

        if (existingMsgId) {
            // Always edit the existing message — never send a new one for the same callID
            try {
                const msg = await channel.messages.fetch(existingMsgId);
                await msg.edit(toolText);
            } catch {
                // Edit failed (deleted, identical text, etc.) — ignore
            }
        } else if (!isCompleted) {
            // Only send a new message for the initial (non-completed) event.
            // If a completed event arrives with no prior message, skip it —
            // this prevents the duplicate that occurs when the map was already cleared.
            const sentMessage = await channel.send(toolText);
            toolMessages.set(callID, sentMessage.id);
        }

    } catch (error) {
        console.log("Error in tool part handler:", error);
    }
}

export function clearToolCallMessages(sessionId: string): void {
    sessionToolMessages.delete(sessionId);
}

function summarizeArgs(input: any): string {
    if (!input || typeof input !== "object") return "";
    const parts: string[] = [];
    for (const [key, val] of Object.entries(input)) {
        if (typeof val === "string") {
            parts.push(val.length > 80 ? val.slice(0, 80) + "..." : val);
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
    if (str.length > 120) return str.slice(0, 120) + "...";
    return str;
}

export function makeQCallback(sessionID: string, callID: string, qIdx: number, action: string, label: string): string {
    const id = `q${nextQId++}`;
    questionCallbackMap.set(id, { sessionID, callID, qIdx, action, label });
    return id;
}

export function resetQuestionState(sessionId: string): void {
    sessionQuestionMessageIds.delete(sessionId);
}

export function cleanupToolState(sessionId: string): void {
    sessionToolMessages.delete(sessionId);
    sessionQuestionMessageIds.delete(sessionId);
}

export function cleanupCallbackMaps(sessionId: string): void {
    for (const [key, val] of questionCallbackMap.entries()) {
        if (val.sessionID === sessionId) {
            questionCallbackMap.delete(key);
        }
    }
}
