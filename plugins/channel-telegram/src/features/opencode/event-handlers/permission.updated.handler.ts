import type { Event } from "@opencode-ai/sdk/v2";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

// v2 uses "permission.asked" instead of "permission.updated"
type PermissionUpdatedEvent = Extract<Event, { type: "permission.updated" }> | Extract<Event, { type: "permission.asked" }>;

// Kept for backwards compat (bot.ts imports this) — always returns undefined now
export function getPermissionCallback(_shortId: string) {
    return undefined;
}

export function cleanupPermissionCallbacks(_sessionId: string): void {
    // no-op: no callbacks stored in yolo mode
}

export default async function permissionUpdatedHandler(
    event: PermissionUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const permission = event.properties as Record<string, any>;
        const permissionId = permission.id;

        // Auto-approve all permissions (yolo mode)
        const client = createOpencodeClient({
            baseUrl: userSession.serverUrl || process.env.OPENCODE_SERVER_URL || "http://localhost:4096",
            ...(userSession.authHeader ? { headers: { Authorization: userSession.authHeader } } : {}),
        });

        await client.permission.reply({
            requestID: permissionId,
            reply: "always",
        });

        console.log(`[Permission] Auto-approved: ${permission.title || permissionId}`);
    } catch (error) {
        console.error("Error in permission.updated handler:", error);
    }

    return null;
}
