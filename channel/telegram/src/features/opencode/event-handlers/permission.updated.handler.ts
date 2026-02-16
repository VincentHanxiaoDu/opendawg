import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml } from "./utils.js";

// v2 uses "permission.asked" instead of "permission.updated"
type PermissionUpdatedEvent = Extract<Event, { type: "permission.updated" }> | Extract<Event, { type: "permission.asked" }>;

// Short ID counter for callback_data (Telegram 64-byte limit)
let nextPermId = 0;
const permCallbackMap = new Map<string, { sessionID: string; permissionID: string; reply: string }>();

export function getPermissionCallback(shortId: string) {
    return permCallbackMap.get(shortId);
}

function makePermCallback(sessionID: string, permissionID: string, reply: string): string {
    const id = `p${nextPermId++}`;
    permCallbackMap.set(id, { sessionID, permissionID, reply });
    return id;
}

export default async function permissionUpdatedHandler(
    event: PermissionUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const permission = event.properties;
        const title = permission.title || "Permission request";
        const permissionId = permission.id;
        const sessionId = permission.sessionID;

        // Build metadata display
        let details = "";
        if (permission.metadata) {
            const meta = permission.metadata as Record<string, unknown>;
            if (meta.tool) details += `\nTool: <code>${escapeHtml(String(meta.tool))}</code>`;
            if (meta.command) details += `\nCommand: <code>${escapeHtml(String(meta.command))}</code>`;
            if (meta.path) details += `\nPath: <code>${escapeHtml(String(meta.path))}</code>`;
            if (meta.description) details += `\n${escapeHtml(String(meta.description))}`;
        }

        if (permission.pattern) {
            const patterns = Array.isArray(permission.pattern) ? permission.pattern : [permission.pattern];
            details += `\nPattern: <code>${escapeHtml(patterns.join(", "))}</code>`;
        }

        const message = `🔐 <b>${escapeHtml(title)}</b>${details}`;

        // Send with approve/reject buttons using short callback IDs
        await ctx.reply(message, {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Allow Once", callback_data: makePermCallback(sessionId, permissionId, "once") },
                        { text: "✅ Always", callback_data: makePermCallback(sessionId, permissionId, "always") },
                        { text: "❌ Deny", callback_data: makePermCallback(sessionId, permissionId, "reject") },
                    ]
                ]
            }
        });
    } catch (error) {
        console.error("Error in permission.updated handler:", error);
    }

    return null;
}
