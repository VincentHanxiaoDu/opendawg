import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type MessagePartRemovedEvent = Extract<Event, { type: "message.part.removed" }>;

export default async function messagePartRemovedHandler(
    event: MessagePartRemovedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
