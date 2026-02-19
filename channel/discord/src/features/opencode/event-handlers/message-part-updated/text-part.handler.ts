import { AttachmentBuilder, type Client, type TextChannel, type DMChannel } from "discord.js";
import type { UserSession } from "../../opencode.types.js";
import { resolveChannel } from "../utils.js";

const STREAM_LINE_LIMIT = 500;
const FINAL_LINE_LIMIT = 500;
const DISCORD_MSG_CHAR_LIMIT = 1950; // slightly under 2000 for safety

interface TextPartState {
    updateMessageId: string | null;
    lastUpdateTime: number;
    finalizeTimeout: NodeJS.Timeout | null;
    latestFullText: string;
    latestChannelId: string | null;
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
            latestChannelId: null,
            isStreaming: true,
        };
        sessionTextState.set(sessionId, state);
    }
    return state;
}

export async function handleTextPart(
    client: Client,
    text: string,
    userSession: UserSession
): Promise<void> {
    try {
        const sessionId = userSession.sessionId;
        const stream = userSession.stream ?? true;
        const now = Date.now();
        const state = getState(sessionId);

        if (state.finalizeTimeout) {
            clearTimeout(state.finalizeTimeout);
            state.finalizeTimeout = null;
        }

        state.latestFullText = text;
        state.latestChannelId = userSession.channelId ?? null;
        state.isStreaming = stream;

        if (!stream) {
            state.finalizeTimeout = setTimeout(() => {
                finalizeTextMessage(sessionId, client);
            }, 5000);
            return;
        }

        const lines = text.split('\n');
        const limitedText = lines.length > STREAM_LINE_LIMIT
            ? lines.slice(-STREAM_LINE_LIMIT).join('\n')
            : text;

        // Truncate for Discord's message limit
        const streamingPrefix = "[Streaming...]\n";
        const maxContent = DISCORD_MSG_CHAR_LIMIT - streamingPrefix.length;
        const displayText = limitedText.length > maxContent
            ? "..." + limitedText.slice(-maxContent + 3)
            : limitedText;
        const streamingText = `${streamingPrefix}${displayText}`;

        const channel = userSession.channelId
            ? await resolveChannel(client, userSession.channelId)
            : null;
        if (!channel) return;

        if (!state.updateMessageId) {
            const sentMessage = await channel.send(streamingText);
            state.updateMessageId = sentMessage.id;
            state.lastUpdateTime = now;
        } else {
            const timeSinceLastUpdate = now - state.lastUpdateTime;
            if (timeSinceLastUpdate < 2500) {
                // Throttle: schedule finalization instead
                state.finalizeTimeout = setTimeout(() => {
                    finalizeTextMessage(sessionId, client);
                }, 5000);
                return;
            }

            try {
                const msg = await channel.messages.fetch(state.updateMessageId);
                await msg.edit(streamingText);
            } catch {}
            state.lastUpdateTime = now;
        }

        state.finalizeTimeout = setTimeout(() => {
            finalizeTextMessage(sessionId, client);
        }, 5000);

    } catch (error) {
        console.log("Error in text part handler:", error);
    }
}

export async function finalizeTextMessage(sessionId: string, client: Client): Promise<void> {
    const state = sessionTextState.get(sessionId);
    if (!state) return;

    if (state.finalizeTimeout) {
        clearTimeout(state.finalizeTimeout);
        state.finalizeTimeout = null;
    }

    const msgId = state.updateMessageId;
    const savedText = state.latestFullText;
    const channelId = state.latestChannelId;
    state.updateMessageId = null;
    state.latestFullText = "";
    state.latestChannelId = null;

    if (!channelId) return;
    const channel = await resolveChannel(client, channelId);
    if (!channel) return;

    if (!savedText.trim()) {
        if (msgId) {
            try {
                const msg = await channel.messages.fetch(msgId);
                if (msg.deletable) await msg.delete();
            } catch {}
        }
        return;
    }

    const lines = savedText.split('\n');
    const needsFile = lines.length > FINAL_LINE_LIMIT || savedText.length > DISCORD_MSG_CHAR_LIMIT;

    if (needsFile) {
        // Delete the streaming message
        if (msgId) {
            try {
                const msg = await channel.messages.fetch(msgId);
                if (msg.deletable) await msg.delete();
            } catch {}
        }
        // Send as file attachment
        try {
            const buf = Buffer.from(savedText, "utf-8");
            const attachment = new AttachmentBuilder(buf, { name: "response.md" });
            await channel.send({ files: [attachment] });
        } catch {
            // Fallback: send truncated text
            const truncated = '... (truncated)\n' + lines.slice(-FINAL_LINE_LIMIT).join('\n');
            const safe = truncated.length > DISCORD_MSG_CHAR_LIMIT ? truncated.slice(-DISCORD_MSG_CHAR_LIMIT) : truncated;
            try { await channel.send(safe); } catch {}
        }
        return;
    }

    // Edit existing message or send new one
    if (msgId) {
        try {
            const msg = await channel.messages.fetch(msgId);
            await msg.edit(savedText);
        } catch {
            try {
                const msg = await channel.messages.fetch(msgId);
                if (msg.deletable) await msg.delete();
            } catch {}
            try { await channel.send(savedText); } catch {}
        }
    } else {
        try { await channel.send(savedText); } catch {}
    }
}

export function cleanupTextState(sessionId: string): void {
    const state = sessionTextState.get(sessionId);
    if (state?.finalizeTimeout) {
        clearTimeout(state.finalizeTimeout);
    }
    sessionTextState.delete(sessionId);
}
