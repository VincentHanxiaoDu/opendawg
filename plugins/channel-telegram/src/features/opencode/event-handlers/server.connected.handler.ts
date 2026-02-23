import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type ServerConnectedEvent = Extract<Event, { type: "server.connected" }>;

export default async function serverConnectedHandler(
    event: ServerConnectedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
