import type { Message, TextChannel } from "discord.js";

/**
 * Utility class for message-related operations in Discord
 */
export class MessageUtils {
    /**
     * Schedules a message for automatic deletion after a timeout
     */
    static scheduleMessageDeletion(
        message: Message,
        timeoutMs: number = 10000
    ): void {
        if (timeoutMs <= 0) return;

        setTimeout(async () => {
            try {
                if (message.deletable) {
                    await message.delete();
                }
            } catch (error) {
                console.error('Failed to delete message:', error);
            }
        }, timeoutMs);
    }

    /**
     * Escapes special Markdown characters for Discord messages.
     * Discord uses a subset of Markdown formatting.
     */
    static escapeMarkdown(text: string): string {
        return text.replace(/[_*~`|\\>]/g, '\\$&');
    }
}
