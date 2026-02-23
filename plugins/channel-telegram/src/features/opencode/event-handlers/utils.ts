export function escapeHtml(text: string): string {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function formatAsHtml(text: string): string {
    // Convert markdown-style formatting to HTML
    // Note: Telegram HTML doesn't support <br> tags well, so we keep newlines
    return escapeHtml(text)
        // Convert code blocks ``` to <pre><code>
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        // Convert inline code ` to <code>
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Convert **bold** to <b>
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        // Convert *italic* to <i>
        .replace(/\*([^*]+)\*/g, '<i>$1</i>')
        // Convert __underline__ to <u>
        .replace(/__([^_]+)__/g, '<u>$1</u>')
        // Convert ~~strikethrough~~ to <s>
        .replace(/~~([^~]+)~~/g, '<s>$1</s>')
        // Convert headers # ## ### to <b> (simple approach)
        .replace(/^###\s+(.*)$/gm, '<b>$1</b>')
        .replace(/^##\s+(.*)$/gm, '<b>$1</b>')
        .replace(/^#\s+(.*)$/gm, '<b>$1</b>');
    // Keep newlines as-is - Telegram HTML supports them natively
}

const typingIntervals = new Map<string, NodeJS.Timeout>();

export function startTypingIndicator(sessionId: string, api: any, chatId: number): void {
    stopTypingIndicator(sessionId);
    const send = () => { api.sendChatAction(chatId, "typing").catch(() => {}); };
    send();
    typingIntervals.set(sessionId, setInterval(send, 4000));
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

export async function sendAndAutoDelete(
    ctx: any,
    message: string,
    deleteAfterMs: number = 2500
): Promise<void> {
    try {
        const chatId = ctx.chat?.id;
        if (!chatId) return;
        const sentMessage = await ctx.reply(message);
        setTimeout(async () => {
            try {
                await ctx.api.deleteMessage(chatId, sentMessage.message_id);
            } catch (error) {
                console.log("Error deleting auto-delete message:", error);
            }
        }, deleteAfterMs);
    } catch (error) {
        console.log("Error sending auto-delete message:", error);
    }
}
