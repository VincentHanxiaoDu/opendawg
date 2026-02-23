import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type InstallationUpdatedEvent = Extract<Event, { type: "installation.updated" }>;

export default async function installationUpdatedHandler(
    event: InstallationUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
