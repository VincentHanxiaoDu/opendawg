import type { Event } from "@opencode-ai/sdk/v2";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml } from "./utils.js";

type MessageUpdatedEvent = Extract<Event, { type: "message.updated" }>;

export default async function messageUpdatedHandler(
    event: MessageUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const { info } = event.properties;
        const summary = info?.summary as Record<string, unknown> | undefined;
        
        if (summary?.title && typeof summary.title === "string") {
            const title = summary.title;
            
            if (title === userSession.lastTitle) return null;
            userSession.lastTitle = title;
            
            const baseUrl = userSession.serverUrl || process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
            const clientConfig: Parameters<typeof createOpencodeClient>[0] = { baseUrl };
            if (userSession.authHeader) {
                clientConfig.headers = { Authorization: userSession.authHeader };
            }
            const client = createOpencodeClient(clientConfig);
            
            await client.session.update({
                sessionID: userSession.sessionId,
                title,
            });
            
            console.log(`✓ Updated session title: "${title}"`);
            
            await ctx.reply(`📝 New topic: ${escapeHtml(title)}`, { parse_mode: "HTML" });
        }
    } catch (error) {
        console.log("Error in message.updated handler:", error);
    }
    
    return null;
}
