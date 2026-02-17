import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type FileWatcherUpdatedEvent = Extract<Event, { type: "file.watcher.updated" }>;

export default async function fileWatcherUpdatedHandler(
    event: FileWatcherUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    console.log(event.type);
    
    return null;
}
