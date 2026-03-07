import { InputFile, type Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";
import { formatAsHtml } from "../utils.js";

const STREAM_LINE_LIMIT = 500;
const FINAL_LINE_LIMIT = 500;
const TELEGRAM_MSG_CHAR_LIMIT = 4000;

interface TextPartState {
    updateMessageId: number | null;
    lastUpdateTime: number;
    finalizeTimeout: NodeJS.Timeout | null;
    latestFullText: string;
    latestCtx: Context | null;
    isStreaming: boolean;
}

const sessionTextState = new Map<string, TextPartState>();

function getState(sessionId: string): TextPartState {
    let state = sessionTextState.get(sessionId);
    if (!state) {
        state = {
            updateMessageId: null,
            lastUpdateTime: 0,
            finalizeTimeout: null,
            latestFullText: "",
            latestCtx: null,
            isStreaming: true,
        };
        sessionTextState.set(sessionId, state);
    }
    return state;
}

export async function handleTextPart(ctx: Context, text: string, userSession: UserSession): Promise<void> {
    try {
        const sessionId = userSession.sessionId;
        const stream = userSession.stream ?? true;
        const verbosity = userSession.verbosity ?? 1;
        const now = Date.now();
        const state = getState(sessionId);

        // Always store the latest text and ctx so that finalizeTextMessage (called
        // from session.idle) can deliver the final answer even in quiet mode (verbosity=0).
        state.latestFullText = text;
        state.latestCtx = ctx;
        state.isStreaming = stream;

        // Accumulate for TTS (always keep latest full text)
        if (userSession.ttsEnabled) {
            userSession.pendingTtsText = text;
        }

        // Skip streaming previews at verbosity=0, but text is already stored above
        // so the final message will still be delivered when session.idle fires.
        if (verbosity < 1) return;

        if (state.finalizeTimeout) {
            clearTimeout(state.finalizeTimeout);
            state.finalizeTimeout = null;
        }

        if (!stream) {
            state.finalizeTimeout = setTimeout(() => {
                finalizeTextMessage(sessionId, ctx);
            }, 5000);
            return;
        }

        const lines = text.split('\n');
        const limitedText = lines.length > STREAM_LINE_LIMIT
            ? lines.slice(-STREAM_LINE_LIMIT).join('\n')
            : text;

        const streamingText = `[Streaming] ✍️\n${formatAsHtml(limitedText)}`;

        if (!state.updateMessageId) {
            // Don't send an empty streaming placeholder — wait until there's actual content.
            // This avoids a blank "[Streaming] ✍️" message when the first text part event
            // arrives with an empty or whitespace-only string.
            if (!text.trim()) {
                state.finalizeTimeout = setTimeout(() => {
                    finalizeTextMessage(sessionId, ctx);
                }, 5000);
                return;
            }
            const sentMessage = await ctx.reply(streamingText, { parse_mode: "HTML" });
            state.updateMessageId = sentMessage.message_id;
            state.lastUpdateTime = now;
        } else {
            const timeSinceLastUpdate = now - state.lastUpdateTime;
            if (timeSinceLastUpdate < 2000) {
                state.finalizeTimeout = setTimeout(() => {
                    finalizeTextMessage(sessionId, ctx);
                }, 5000);
                return;
            }

            const chatId = ctx.chat?.id;
            if (!chatId) return;
            try {
                await ctx.api.editMessageText(
                    chatId,
                    state.updateMessageId,
                    streamingText,
                    { parse_mode: "HTML" }
                );
            } catch {}
            state.lastUpdateTime = now;
        }

        state.finalizeTimeout = setTimeout(() => {
            finalizeTextMessage(sessionId, ctx);
        }, 5000);

    } catch (error) {
        console.log("Error in text part handler:", error);
    }
}

export async function finalizeTextMessage(sessionId: string, ctx?: Context): Promise<void> {
    const state = sessionTextState.get(sessionId);
    if (!state) return;

    if (state.finalizeTimeout) {
        clearTimeout(state.finalizeTimeout);
        state.finalizeTimeout = null;
    }

    const msgId = state.updateMessageId;
    const savedText = state.latestFullText;
    const resolvedCtx = ctx || state.latestCtx;
    state.updateMessageId = null;
    state.latestFullText = "";
    state.latestCtx = null;

    if (!resolvedCtx) return;
    const chatId = resolvedCtx.chat?.id;
    if (!chatId) return;

    if (!savedText.trim()) {
        if (msgId) {
            try { await resolvedCtx.api.deleteMessage(chatId, msgId); } catch {}
        }
        return;
    }

    const lines = savedText.split('\n');
    const needsFile = lines.length > FINAL_LINE_LIMIT || savedText.length > TELEGRAM_MSG_CHAR_LIMIT;

    if (needsFile) {
        if (msgId) {
            try { await resolvedCtx.api.deleteMessage(chatId, msgId); } catch {}
        }
        try {
            const buf = Buffer.from(savedText, "utf-8");
            await resolvedCtx.api.sendDocument(chatId, new InputFile(buf, "response.txt"));
        } catch {
            const truncated = '… (truncated)\n' + lines.slice(-FINAL_LINE_LIMIT).join('\n');
            const safe = truncated.length > TELEGRAM_MSG_CHAR_LIMIT ? truncated.slice(-TELEGRAM_MSG_CHAR_LIMIT) : truncated;
            try { await resolvedCtx.reply(formatAsHtml(safe), { parse_mode: "HTML" }); } catch {}
        }
        return;
    }

    const finalHtml = formatAsHtml(savedText);
    if (msgId) {
        try {
            await resolvedCtx.api.editMessageText(chatId, msgId, finalHtml, { parse_mode: "HTML" });
        } catch {
            // Edit failed — send new message first, then delete old one async to prevent gap/duplicate
            try { await resolvedCtx.reply(finalHtml, { parse_mode: "HTML" }); } catch {}
            resolvedCtx.api.deleteMessage(chatId, msgId).catch(() => {});
        }
    } else {
        try { await resolvedCtx.reply(finalHtml, { parse_mode: "HTML" }); } catch {}
    }
}

export function cleanupTextState(sessionId: string): void {
    const state = sessionTextState.get(sessionId);
    if (state?.finalizeTimeout) {
        clearTimeout(state.finalizeTimeout);
    }
    sessionTextState.delete(sessionId);
}