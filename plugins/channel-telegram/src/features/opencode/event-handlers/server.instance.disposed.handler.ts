import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type ServerInstanceDisposedEvent = Extract<Event, { type: "server.instance.disposed" }>;

export default async function serverInstanceDisposedHandler(
    event: ServerInstanceDisposedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
