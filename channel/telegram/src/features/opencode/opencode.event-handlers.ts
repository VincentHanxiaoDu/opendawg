import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession, UserState } from "./opencode.types.js";
import { escapeHtml } from "./event-handlers/utils.js";

import messageUpdated from "./event-handlers/message.updated.handler.js";
import messageRemoved from "./event-handlers/message.removed.handler.js";
import sessionStatus from "./event-handlers/session.status.handler.js";
import sessionIdle from "./event-handlers/session.idle.handler.js";
import sessionError from "./event-handlers/session.error.handler.js";
import fileEdited from "./event-handlers/file.edited.handler.js";
import ptyCreated from "./event-handlers/pty.created.handler.js";
import ptyExited from "./event-handlers/pty.exited.handler.js";
import serverInstanceDisposed from "./event-handlers/server.instance.disposed.handler.js";
import installationUpdated from "./event-handlers/installation.updated.handler.js";
import installationUpdateAvailable from "./event-handlers/installation.update-available.handler.js";
import lspClientDiagnostics from "./event-handlers/lsp.client.diagnostics.handler.js";
import lspUpdated from "./event-handlers/lsp.updated.handler.js";
import messagePartUpdated from "./event-handlers/message.part.updated.handler.js";
import messagePartRemoved from "./event-handlers/message.part.removed.handler.js";
import permissionUpdated from "./event-handlers/permission.updated.handler.js";
import permissionReplied from "./event-handlers/permission.replied.handler.js";
import sessionCompacted from "./event-handlers/session.compacted.handler.js";
import todoUpdated from "./event-handlers/todo.updated.handler.js";
import commandExecuted from "./event-handlers/command.executed.handler.js";
import sessionCreated from "./event-handlers/session.created.handler.js";
import sessionUpdated from "./event-handlers/session.updated.handler.js";
import sessionDeleted from "./event-handlers/session.deleted.handler.js";
import sessionDiff from "./event-handlers/session.diff.handler.js";
import fileWatcherUpdated from "./event-handlers/file.watcher.updated.handler.js";
import vcsBranchUpdated from "./event-handlers/vcs.branch.updated.handler.js";
import tuiPromptAppend from "./event-handlers/tui.prompt.append.handler.js";
import tuiCommandExecute from "./event-handlers/tui.command.execute.handler.js";
import tuiToastShow from "./event-handlers/tui.toast.show.handler.js";
import ptyUpdated from "./event-handlers/pty.updated.handler.js";
import ptyDeleted from "./event-handlers/pty.deleted.handler.js";
import serverConnected from "./event-handlers/server.connected.handler.js";
import questionAsked from "./event-handlers/question.asked.handler.js";


/**
 * Handler function signature for processing events
 * Returns a message string to send to the user, or null to ignore the event
 */
type EventHandlerFn<T extends Event> = (
    event: T,
    ctx: Context,
    userSession: UserSession
) => Promise<string | null>;

/**
 * Strongly-typed map of event handlers
 * Keys must be valid event types from the Event union
 * Values are handler functions that receive the specific event type
 */
type EventHandlerMap = {
    [K in Event["type"]]?: EventHandlerFn<Extract<Event, { type: K }>>;
};

/**
 * Event handler rules
 * Add or modify handlers for specific event types here
 */
export const eventHandlers: EventHandlerMap = {
    "message.updated": messageUpdated,
    "message.removed": messageRemoved,
    "message.part.updated": messagePartUpdated,
    "message.part.removed": messagePartRemoved,
    "permission.asked": permissionUpdated as any,
    "permission.replied": permissionReplied,
    "question.asked": questionAsked as any,
    "session.status": sessionStatus,
    "session.idle": sessionIdle,
    "session.compacted": sessionCompacted,
    "session.error": sessionError,
    "session.created": sessionCreated,
    "session.updated": sessionUpdated,
    "session.deleted": sessionDeleted,
    "session.diff": sessionDiff,
    "file.edited": fileEdited,
    "file.watcher.updated": fileWatcherUpdated,
    "todo.updated": todoUpdated,
    "command.executed": commandExecuted,
    "vcs.branch.updated": vcsBranchUpdated,

    "installation.updated": installationUpdated,
    "installation.update-available": installationUpdateAvailable,
    "lsp.client.diagnostics": lspClientDiagnostics,
    "lsp.updated": lspUpdated,

    "tui.prompt.append": tuiPromptAppend,
    "tui.command.execute": tuiCommandExecute,
    "tui.toast.show": tuiToastShow,

    "pty.created": ptyCreated,
    "pty.updated": ptyUpdated,
    "pty.exited": ptyExited,
    "pty.deleted": ptyDeleted,

    "server.instance.disposed": serverInstanceDisposed,
    "server.connected": serverConnected,
};

// Legacy event name from v1 SDK — not in the v2 Event type union
(eventHandlers as Record<string, any>)["permission.updated"] = permissionUpdated;

function extractSessionID(event: Event): string | undefined {
    const props = (event as any).properties;
    if (!props) return undefined;
    if (props.sessionID) return props.sessionID;
    if (props.info?.sessionID) return props.info.sessionID;
    if (props.info?.id && event.type.startsWith("session.")) return props.info.id;
    if (props.part?.sessionID) return props.part.sessionID;
    return undefined;
}

/**
 * Send a brief background notification to the user about a background session event.
 */
async function notifyBackgroundSession(
    event: Event,
    ctx: Context,
    userSession: UserSession,
    messageDeleteTimeout: number
): Promise<void> {
    if (!userSession.chatId) return;

    const title = escapeHtml(userSession.session?.title || userSession.sessionId.substring(0, 8));
    const shortId = userSession.sessionId.substring(0, 8);

    let text: string | null = null;

    if (event.type === "session.idle") {
        userSession.serverStatus = "idle";
        text = `✅ <b>${title}</b> done — <code>/session ${shortId}</code> to view`;
    } else if (event.type === "session.error") {
        userSession.serverStatus = "error";
        const props = (event as any).properties;
        const errMsg = props?.error || props?.message || "";
        userSession.lastError = errMsg ? String(errMsg).slice(0, 200) : undefined;
        text = `❌ Error in <b>${title}</b>${errMsg ? ` — ${escapeHtml(String(errMsg).slice(0, 100))}` : ""}\n<code>/session ${shortId}</code> to view`;
    }

    if (!text) return;

    try {
        const sent = await ctx.api.sendMessage(userSession.chatId, text, { parse_mode: "HTML" });
        // Auto-delete if configured
        if (messageDeleteTimeout > 0) {
            setTimeout(() => {
                ctx.api.deleteMessage(userSession.chatId!, sent.message_id).catch(() => {});
            }, messageDeleteTimeout);
        }
    } catch (err) {
        console.error("Failed to send background session notification:", err);
    }
}

export async function processEvent(
    event: Event,
    ctx: Context,
    userState: UserState,
    messageDeleteTimeout = 0
): Promise<void> {
    try {
        const eventSessionID = extractSessionID(event);

        if (eventSessionID) {
            // Route to matching session
            const targetSession = userState.sessions.get(eventSessionID);
            if (!targetSession) {
                // Not one of our attached sessions — ignore
                return;
            }

            // Update serverStatus from status events for any attached session
            if (event.type === "session.status") {
                const status = (event as any).properties?.status;
                if (status === "busy" || status === "idle" || status === "error") {
                    targetSession.serverStatus = status;
                }
            }

            if (targetSession.isActive) {
                // Active session: full processing
                const handler = eventHandlers[event.type];
                if (handler) {
                    await handler(event as any, ctx, targetSession);
                }
            } else {
                // Background session: light notification only
                await notifyBackgroundSession(event, ctx, targetSession, messageDeleteTimeout);
            }
            return;
        }

        // No session ID — global event: use active session context if available
        const activeSession = userState.activeSessionId
            ? userState.sessions.get(userState.activeSessionId)
            : undefined;

        if (activeSession) {
            const handler = eventHandlers[event.type];
            if (handler) {
                await handler(event as any, ctx, activeSession);
            }
        }
    } catch (error) {
        console.error(`Error handling event ${event.type}:`, error);
    }
}
