import type { TextChannel, DMChannel, Client } from "discord.js";

/**
 * Escape Discord markdown special characters.
 */
export function escapeMarkdown(text: string): string {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/\|/g, '\\|')
        .replace(/>/g, '\\>');
}

/**
 * Truncate text to a max length, appending "..." if truncated.
 */
export function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + '...';
}

// ─── Typing indicators ──────────────────────────────────────────────────────

const typingIntervals = new Map<string, NodeJS.Timeout>();

export function startTypingIndicator(sessionId: string, channel: TextChannel | DMChannel): void {
    stopTypingIndicator(sessionId);
    const send = () => { channel.sendTyping().catch(() => {}); };
    send();
    // Discord typing indicator lasts ~10s, refresh every 9s
    typingIntervals.set(sessionId, setInterval(send, 9000));
}

export function stopTypingIndicator(sessionId: string): void {
    const interval = typingIntervals.get(sessionId);
    if (interval) {
        clearInterval(interval);
        typingIntervals.delete(sessionId);
    }
}

export function stopAllTypingIndicators(): void {
    for (const interval of typingIntervals.values()) {
        clearInterval(interval);
    }
    typingIntervals.clear();
}

// ─── Send and auto-delete ────────────────────────────────────────────────────

export async function sendAndAutoDelete(
    channel: TextChannel | DMChannel,
    message: string,
    deleteAfterMs: number = 2500
): Promise<void> {
    try {
        const sent = await channel.send(message);
        setTimeout(async () => {
            try {
                if (sent.deletable) await sent.delete();
            } catch {}
        }, deleteAfterMs);
    } catch (error) {
        console.log("Error sending auto-delete message:", error);
    }
}

/**
 * Resolve a Discord channel by ID from the client.
 */
export async function resolveChannel(
    client: Client,
    channelId: string
): Promise<TextChannel | DMChannel | null> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && (channel.isTextBased())) {
            return channel as TextChannel | DMChannel;
        }
        return null;
    } catch {
        return null;
    }
}
