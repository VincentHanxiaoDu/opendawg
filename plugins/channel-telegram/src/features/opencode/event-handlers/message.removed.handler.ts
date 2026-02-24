import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type MessageRemovedEvent = Extract<Event, { type: "message.removed" }>;

export default async function messageRemovedHandler(
    event: MessageRemovedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
