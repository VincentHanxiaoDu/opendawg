import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import * as fs from 'fs';
import * as path from 'path';
import { cleanupReasoningMessages } from "./message-part-updated/reasoning-part.handler.js";
import { finalizeTextMessage } from "./message-part-updated/text-part.handler.js";
import { clearToolCallMessages } from "./message-part-updated/tool-part.handler.js";
import { stopTypingIndicator } from "./utils.js";

type SessionIdleEvent = Extract<Event, { type: "session.idle" }>;

export default async function sessionIdleHandler(
    event: SessionIdleEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);

    stopTypingIndicator();
    await finalizeTextMessage(ctx);
    await cleanupReasoningMessages(ctx);
    clearToolCallMessages();
    
    const eventsDir = path.join(process.cwd(), 'events');
    if (!fs.existsSync(eventsDir)) {
        fs.mkdirSync(eventsDir, { recursive: true });
    }

    const eventType = event.type.replace(/\./g, '-');
    const filePath = path.join(eventsDir, `${eventType}.last.json`);
    fs.writeFileSync(filePath, JSON.stringify(event, null, 2), 'utf8');
    
    return null;
}
