import type { Event } from "@opencode-ai/sdk/v2";
import type { Client } from "discord.js";
import type { UserSession, UserState } from "./opencode.types.js";
import { escapeMarkdown, resolveChannel } from "./event-handlers/utils.js";
import { handleTextPart, finalizeTextMessage } from "./event-handlers/message-part-updated/text-part.handler.js";
import { handleToolPart } from "./event-handlers/message-part-updated/tool-part.handler.js";
import { stopTypingIndicator, startTypingIndicator } from "./event-handlers/utils.js";
import { cleanupTextState } from "./event-handlers/message-part-updated/text-part.handler.js";
import { clearToolCallMessages } from "./event-handlers/message-part-updated/tool-part.handler.js";

/**
 * Handler function signature for processing events.
 * Returns a message string to send to the user, or null to ignore the event.
 */
type EventHandlerFn<T extends Event> = (
    event: T,
    client: Client,
    userSession: UserSession
) => Promise<string | null>;

/**
 * Strongly-typed map of event handlers.
 */
type EventHandlerMap = {
    [K in Event["type"]]?: EventHandlerFn<Extract<Event, { type: K }>>;
};

// ─── Individual event handlers ───────────────────────────────────────────────

async function handleMessagePartUpdated(
    event: Extract<Event, { type: "message.part.updated" }>,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    const part = (event as any).properties?.part;
    if (!part) return null;

    if (part.type === "text" && part.text) {
        await handleTextPart(client, part.text, userSession);
    } else if (part.type === "tool") {
        await handleToolPart(client, part, userSession);
    }
    // Reasoning parts: could add here if desired

    return null;
}

async function handleSessionStatus(
    event: Extract<Event, { type: "session.status" }>,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    const status = (event as any).properties?.status;
    if (status === "busy" && userSession.channelId) {
        const channel = await resolveChannel(client, userSession.channelId);
        if (channel) {
            startTypingIndicator(userSession.sessionId, channel as any);
        }
    }
    return null;
}

async function handleSessionIdle(
    event: Extract<Event, { type: "session.idle" }>,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    const { sessionId } = userSession;
    stopTypingIndicator(sessionId);
    await finalizeTextMessage(sessionId, client);
    clearToolCallMessages(sessionId);
    return null;
}

async function handleSessionError(
    event: Extract<Event, { type: "session.error" }>,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    const { sessionId } = userSession;
    stopTypingIndicator(sessionId);
    await finalizeTextMessage(sessionId, client);

    const props = (event as any).properties;
    const rawErr = props?.error || props?.message || props;
    const errMsg = typeof rawErr === "object" ? JSON.stringify(rawErr) : String(rawErr ?? "");
    userSession.lastError = errMsg ? errMsg.slice(0, 200) : undefined;
    userSession.serverStatus = "error";

    if (userSession.channelId) {
        const channel = await resolveChannel(client, userSession.channelId);
        if (channel) {
            const displayErr = errMsg ? errMsg.slice(0, 500) : "Unknown error";
            await channel.send(`**Error:** ${displayErr}`).catch(() => {});
        }
    }

    return null;
}

async function handleMessageUpdated(
    event: Extract<Event, { type: "message.updated" }>,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    // Auto-update session title if the server suggests it
    const props = (event as any).properties;
    if (props?.info?.title && props.info.title !== userSession.lastTitle) {
        userSession.lastTitle = props.info.title;
    }
    return null;
}

async function handlePermissionAsked(
    event: any,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    // Permission handling is done via the bot's interaction handler
    // This handler stores the event data for the button handler to use
    const props = (event as any).properties;
    if (!props || !userSession.channelId) return null;

    const channel = await resolveChannel(client, userSession.channelId);
    if (!channel) return null;

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");

    const title = props.info?.title || props.title || "Permission Request";
    const description = props.info?.description || props.description || "";

    const permId = props.info?.id || props.id || "";
    const sessionID = userSession.sessionId;

    // Store permission data for callback resolution
    storePermissionData(permId, sessionID);

    const row = new ActionRowBuilder<typeof ButtonBuilder.prototype>().addComponents(
        new ButtonBuilder()
            .setCustomId(`perm:${permId}:allow`)
            .setLabel("Allow Once")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`perm:${permId}:always`)
            .setLabel("Always Allow")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`perm:${permId}:deny`)
            .setLabel("Deny")
            .setStyle(ButtonStyle.Danger),
    );

    const text = `**Permission Request**\n${title}${description ? '\n' + description : ''}`;
    await channel.send({ content: text, components: [row as any] });

    return null;
}

async function handleQuestionAsked(
    event: any,
    client: Client,
    userSession: UserSession
): Promise<string | null> {
    const props = (event as any).properties;
    if (!props || !userSession.channelId) return null;

    const channel = await resolveChannel(client, userSession.channelId);
    if (!channel) return null;

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");

    const questionId = props.info?.id || props.id || "";
    const questionText = props.info?.question || props.question || "Question";
    const options: string[] = props.info?.options || props.options || [];

    storeQuestionData(questionId, userSession.sessionId);

    const rows: any[] = [];
    let currentRow = new ActionRowBuilder<typeof ButtonBuilder.prototype>();
    let btnCount = 0;

    for (let i = 0; i < options.length && i < 20; i++) {
        if (btnCount >= 5) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder<typeof ButtonBuilder.prototype>();
            btnCount = 0;
        }
        currentRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`q:${questionId}:${i}`)
                .setLabel(options[i].substring(0, 80))
                .setStyle(ButtonStyle.Secondary)
        );
        btnCount++;
    }

    // Add "Custom Answer" and "Skip" buttons
    if (btnCount >= 4) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder<typeof ButtonBuilder.prototype>();
        btnCount = 0;
    }
    currentRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`q:${questionId}:custom`)
            .setLabel("Custom Answer")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`q:${questionId}:skip`)
            .setLabel("Skip")
            .setStyle(ButtonStyle.Danger)
    );
    rows.push(currentRow);

    // Limit to 5 action rows max
    const limitedRows = rows.slice(0, 5);

    const text = `**Question**\n${questionText}`;
    await channel.send({ content: text, components: limitedRows });

    return null;
}

// Catch-all no-op handler
async function noopHandler(): Promise<string | null> {
    return null;
}

// ─── Event handler map ───────────────────────────────────────────────────────

const eventHandlers: EventHandlerMap = {
    "message.part.updated": handleMessagePartUpdated as any,
    "message.updated": handleMessageUpdated as any,
    "session.status": handleSessionStatus as any,
    "session.idle": handleSessionIdle as any,
    "session.error": handleSessionError as any,
    "permission.asked": handlePermissionAsked as any,
    "question.asked": handleQuestionAsked as any,

    // No-op handlers for events we acknowledge but don't display
    "message.removed": noopHandler as any,
    "message.part.removed": noopHandler as any,
    "permission.replied": noopHandler as any,
    "session.created": noopHandler as any,
    "session.updated": noopHandler as any,
    "session.deleted": noopHandler as any,
    "session.compacted": noopHandler as any,
    "session.diff": noopHandler as any,
    "file.edited": noopHandler as any,
    "file.watcher.updated": noopHandler as any,
    "todo.updated": noopHandler as any,
    "command.executed": noopHandler as any,
    "vcs.branch.updated": noopHandler as any,
    "installation.updated": noopHandler as any,
    "installation.update-available": noopHandler as any,
    "lsp.client.diagnostics": noopHandler as any,
    "lsp.updated": noopHandler as any,
    "tui.prompt.append": noopHandler as any,
    "tui.command.execute": noopHandler as any,
    "tui.toast.show": noopHandler as any,
    "pty.created": noopHandler as any,
    "pty.updated": noopHandler as any,
    "pty.exited": noopHandler as any,
    "pty.deleted": noopHandler as any,
    "server.instance.disposed": noopHandler as any,
    "server.connected": noopHandler as any,
};

// Legacy event name from v1 SDK
(eventHandlers as Record<string, any>)["permission.updated"] = handlePermissionAsked;

// ─── Permission & Question data storage (for button callbacks) ───────────────

const permissionDataStore = new Map<string, string>(); // permId -> sessionID
const questionDataStore = new Map<string, string>(); // questionId -> sessionID

export function storePermissionData(permId: string, sessionID: string): void {
    permissionDataStore.set(permId, sessionID);
}

export function getPermissionData(permId: string): string | undefined {
    return permissionDataStore.get(permId);
}

export function clearPermissionData(permId: string): void {
    permissionDataStore.delete(permId);
}

export function storeQuestionData(questionId: string, sessionID: string): void {
    questionDataStore.set(questionId, sessionID);
}

export function getQuestionData(questionId: string): string | undefined {
    return questionDataStore.get(questionId);
}

export function clearQuestionData(questionId: string): void {
    questionDataStore.delete(questionId);
}

// ─── Event dispatcher ────────────────────────────────────────────────────────

function extractSessionID(event: Event): string | undefined {
    const props = (event as any).properties;
    if (!props) return undefined;
    if (props.sessionID) return props.sessionID;
    if (props.info?.sessionID) return props.info.sessionID;
    if (props.info?.id && event.type.startsWith("session.")) return props.info.id;
    if (props.part?.sessionID) return props.part.sessionID;
    return undefined;
}

async function notifyBackgroundSession(
    event: Event,
    client: Client,
    userSession: UserSession,
    messageDeleteTimeout: number
): Promise<void> {
    if (!userSession.channelId) return;

    const title = userSession.session?.title || userSession.sessionId.substring(0, 8);
    const shortId = userSession.sessionId.substring(0, 8);

    let text: string | null = null;

    if (event.type === "session.idle") {
        userSession.serverStatus = "idle";
        text = `**${title}** done — \`/session ${shortId}\` to view`;
    } else if (event.type === "session.error") {
        userSession.serverStatus = "error";
        const props = (event as any).properties;
        const rawErr = props?.error || props?.message || props;
        const errMsg = typeof rawErr === "object" ? JSON.stringify(rawErr) : String(rawErr ?? "");
        userSession.lastError = errMsg ? errMsg.slice(0, 200) : undefined;
        text = `Error in **${title}**${errMsg ? ` — ${errMsg.slice(0, 100)}` : ""}\n\`/session ${shortId}\` to view`;
    }

    if (!text) return;

    try {
        const channel = await resolveChannel(client, userSession.channelId);
        if (!channel) return;
        const sent = await channel.send(text);
        if (messageDeleteTimeout > 0) {
            setTimeout(() => {
                if (sent.deletable) sent.delete().catch(() => {});
            }, messageDeleteTimeout);
        }
    } catch (err) {
        console.error("Failed to send background session notification:", err);
    }
}

export async function processEvent(
    event: Event,
    client: Client,
    userState: UserState,
    messageDeleteTimeout = 0
): Promise<void> {
    try {
        const eventSessionID = extractSessionID(event);

        if (eventSessionID) {
            const targetSession = userState.sessions.get(eventSessionID);
            if (!targetSession) return;

            // Update serverStatus from status events
            if (event.type === "session.status") {
                const status = (event as any).properties?.status;
                if (status === "busy" || status === "idle" || status === "error") {
                    targetSession.serverStatus = status;
                }
            }

            if (targetSession.isActive) {
                const handler = eventHandlers[event.type];
                if (handler) {
                    await handler(event as any, client, targetSession);
                }
            } else {
                await notifyBackgroundSession(event, client, targetSession, messageDeleteTimeout);
            }
            return;
        }

        // No session ID — global event: use active session context
        const activeSession = userState.activeSessionId
            ? userState.sessions.get(userState.activeSessionId)
            : undefined;

        if (activeSession) {
            const handler = eventHandlers[event.type];
            if (handler) {
                await handler(event as any, client, activeSession);
            }
        }
    } catch (error) {
        console.error(`Error handling event ${event.type}:`, error);
    }
}
