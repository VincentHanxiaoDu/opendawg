import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type InstallationUpdateAvailableEvent = Extract<Event, { type: "installation.update-available" }>;

export default async function installationUpdateAvailableHandler(
    event: InstallationUpdateAvailableEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
