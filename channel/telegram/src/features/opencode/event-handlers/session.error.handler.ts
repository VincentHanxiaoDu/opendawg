import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml } from "./utils.js";

type SessionErrorEvent = Extract<Event, { type: "session.error" }>;

export default async function sessionErrorHandler(
    event: SessionErrorEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.error("session.error:", JSON.stringify(event.properties));

    try {
        const props = event.properties as any;
        const errorMsg = props?.error || props?.message || JSON.stringify(props);
        const truncated = String(errorMsg).slice(0, 500);
        await ctx.api.sendMessage(
            userSession.chatId!,
            `⚠️ <b>Session Error</b>\n<pre>${escapeHtml(truncated)}</pre>`,
            { parse_mode: "HTML" }
        );
    } catch (sendErr) {
        console.error("Failed to send error to user:", sendErr);
    }

    return null;
}
