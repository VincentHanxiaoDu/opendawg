import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Event } from "@opencode-ai/sdk/v2";
import type { Context } from "grammy";
import type { UserSession, UserState } from "./opencode.types.js";
import { processEvent } from "./opencode.event-handlers.js";
import { cleanupTextState } from "./event-handlers/message-part-updated/text-part.handler.js";
import { cleanupReasoningState } from "./event-handlers/message-part-updated/reasoning-part.handler.js";
import { cleanupToolState, cleanupCallbackMaps } from "./event-handlers/message-part-updated/tool-part.handler.js";
import { cleanupPermissionCallbacks } from "./event-handlers/permission.updated.handler.js";
import { stopTypingIndicator } from "./event-handlers/utils.js";
import type { ServerRegistry } from "../../services/server-registry.service.js";

// messageDeleteTimeout passed through from bot layer for background notifications
let globalMessageDeleteTimeout = 0;
export function setMessageDeleteTimeout(ms: number): void {
    globalMessageDeleteTimeout = ms;
}

export class OpenCodeService {
    private userStates: Map<number, UserState> = new Map();
    private eventAbortControllers: Map<number, AbortController> = new Map();
    private serverRegistry: ServerRegistry | null;

    constructor(baseUrl?: string, serverRegistry?: ServerRegistry) {
        // baseUrl kept for backward compat but now resolved per-user from serverRegistry
        this.serverRegistry = serverRegistry ?? null;
    }

    // ─────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────

    private getOrCreateUserState(userId: number): UserState {
        if (!this.userStates.has(userId)) {
            const activeServer = this.serverRegistry?.getActive(userId) ?? null;
            this.userStates.set(userId, {
                userId,
                sessions: new Map(),
                activeSessionId: null,
                activeServerId: activeServer?.id ?? null,
            });
        }
        return this.userStates.get(userId)!;
    }

    getServerUrl(userId: number): string {
        return this.getBaseUrl(userId);
    }

    private getBaseUrl(userId: number): string {
        if (this.serverRegistry) {
            const server = this.serverRegistry.getActive(userId);
            if (server) return server.url;
        }
        return process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
    }

    private cleanupSessionState(sessionId: string): void {
        stopTypingIndicator(sessionId);
        cleanupTextState(sessionId);
        cleanupReasoningState(sessionId);
        cleanupToolState(sessionId);
        cleanupCallbackMaps(sessionId);
        cleanupPermissionCallbacks(sessionId);
    }

    // ─────────────────────────────────────────────
    // UserState / UserSession accessors
    // ─────────────────────────────────────────────

    getUserState(userId: number): UserState | undefined {
        return this.userStates.get(userId);
    }

    getUserSession(userId: number): UserSession | undefined {
        const state = this.userStates.get(userId);
        if (!state || !state.activeSessionId) return undefined;
        return state.sessions.get(state.activeSessionId);
    }

    updateSessionContext(userId: number, chatId: number, messageId: number): void {
        const session = this.getUserSession(userId);
        if (session) {
            session.chatId = chatId;
            session.lastMessageId = messageId;
        }
    }

    hasActiveSession(userId: number): boolean {
        const state = this.userStates.get(userId);
        return !!(state?.activeSessionId);
    }

    // ─────────────────────────────────────────────
    // Session lifecycle
    // ─────────────────────────────────────────────

    async createSession(userId: number, title?: string): Promise<UserSession> {
        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            const result = await client.session.create({
                title: title || `Telegram Session ${new Date().toISOString()}`,
            });

            if (!result.data) {
                throw new Error("Failed to create session");
            }

            const state = this.getOrCreateUserState(userId);

            // Move current active session to background
            if (state.activeSessionId) {
                const currentActive = state.sessions.get(state.activeSessionId);
                if (currentActive) currentActive.isActive = false;
            }

            const userSession: UserSession = {
                userId,
                sessionId: result.data.id,
                session: result.data,
                createdAt: new Date(),
                currentAgent: "build",
                verbosity: 1,
                stream: true,
                isActive: true,
                serverStatus: "idle",
            };

            state.sessions.set(result.data.id, userSession);
            state.activeSessionId = result.data.id;

            return userSession;
        } catch (error) {
            if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
                const baseUrl = this.getBaseUrl(userId);
                throw new Error(`Cannot connect to OpenCode server at ${baseUrl}. Please ensure:\n1. OpenCode server is running\n2. OPENCODE_SERVER_URL is configured correctly`);
            }
            throw error;
        }
    }

    async attachSession(userId: number, sessionIdOrPrefix: string): Promise<{ session: UserSession; alreadyAttached: boolean } | null> {
        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });
        const state = this.getOrCreateUserState(userId);

        // Check if already in local sessions map (exact or prefix)
        for (const [sid, sess] of state.sessions) {
            if (sid === sessionIdOrPrefix || sid.startsWith(sessionIdOrPrefix)) {
                return { session: sess, alreadyAttached: true };
            }
        }

        // Try to resolve from server: exact match first, then prefix search
        try {
            let targetSessionId = sessionIdOrPrefix;

            // If it looks like a prefix (< 32 chars), search the list
            if (sessionIdOrPrefix.length < 32) {
                const listResult = await client.session.list();
                const sessions = listResult.data ?? [];

                // Exact match takes priority
                const exact = sessions.find((s: any) => s.id === sessionIdOrPrefix);
                if (exact) {
                    targetSessionId = exact.id;
                } else {
                    const matches = sessions.filter((s: any) => s.id.startsWith(sessionIdOrPrefix));
                    if (matches.length === 0) return null;
                    if (matches.length > 1) {
                        // Return null with a special marker — caller handles ambiguity
                        throw Object.assign(new Error("AMBIGUOUS"), { matches: matches.map((s: any) => s.id) });
                    }
                    targetSessionId = matches[0].id;
                }
            }

            const result = await client.session.get({ sessionID: targetSessionId });
            if (!result.data) return null;

            const defaultSession = this.getUserSession(userId);
            const userSession: UserSession = {
                userId,
                sessionId: result.data.id,
                session: result.data,
                createdAt: new Date(),
                currentAgent: defaultSession?.currentAgent ?? "build",
                verbosity: defaultSession?.verbosity ?? 1,
                stream: defaultSession?.stream ?? true,
                isActive: false,
                serverStatus: "idle",
            };

            state.sessions.set(result.data.id, userSession);
            return { session: userSession, alreadyAttached: false };
        } catch (error) {
            if ((error as any)?.message === "AMBIGUOUS") throw error;
            return null;
        }
    }

    switchSession(userId: number, sessionId: string): boolean {
        const state = this.userStates.get(userId);
        if (!state) return false;

        // Find session (exact or prefix)
        let targetId = sessionId;
        if (!state.sessions.has(sessionId)) {
            for (const [sid] of state.sessions) {
                if (sid.startsWith(sessionId)) {
                    targetId = sid;
                    break;
                }
            }
        }

        const target = state.sessions.get(targetId);
        if (!target) return false;

        // Update active flags
        if (state.activeSessionId) {
            const prev = state.sessions.get(state.activeSessionId);
            if (prev) prev.isActive = false;
        }
        target.isActive = true;
        state.activeSessionId = targetId;
        return true;
    }

    detachSession(userId: number): UserSession | null {
        const state = this.userStates.get(userId);
        if (!state || !state.activeSessionId) return null;

        const session = state.sessions.get(state.activeSessionId);
        if (session) session.isActive = false;
        state.activeSessionId = null;
        return session ?? null;
    }

    async deleteSession(userId: number): Promise<{ success: boolean; switchedTo?: UserSession }> {
        const state = this.userStates.get(userId);
        const userSession = this.getUserSession(userId);

        if (!userSession || !state) {
            return { success: false };
        }

        const { sessionId } = userSession;

        // Clean up only this session's local state (typing, text, tool, etc.)
        // Do NOT stop the event stream — it's shared across all sessions for
        // this user.  Stopping it would break background sessions and can
        // cause reconnect attempts to a session that no longer exists.
        this.cleanupSessionState(sessionId);

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            await client.session.delete({ sessionID: sessionId });
        } catch (error) {
            console.error(`Failed to delete session for user ${userId}:`, error);
        }

        state.sessions.delete(sessionId);
        state.activeSessionId = null;

        return { success: true };
    }

    async abortSession(userId: number): Promise<boolean> {
        const userSession = this.getUserSession(userId);
        if (!userSession) return false;

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            await client.session.abort({ sessionID: userSession.sessionId });
            return true;
        } catch (error) {
            console.error(`Failed to abort session for user ${userId}:`, error);
            return false;
        }
    }

    // ─────────────────────────────────────────────
    // Server switching
    // ─────────────────────────────────────────────

    async switchServer(userId: number, serverId: string, ctx: Context): Promise<boolean> {
        if (!this.serverRegistry) return false;

        const newServer = this.serverRegistry.setActive(userId, serverId);
        if (!newServer) return false;

        // Stop existing SSE
        this.stopEventStream(userId);

        // Clean up all session states for the old server
        const state = this.getOrCreateUserState(userId);
        for (const [sid] of state.sessions) {
            this.cleanupSessionState(sid);
        }
        state.sessions.clear();
        state.activeSessionId = null;
        state.activeServerId = newServer.id;

        // Start new SSE for new server
        this.startEventStream(userId, ctx).catch(error => {
            console.error("Event stream error after server switch:", error);
        });

        return true;
    }

    // ─────────────────────────────────────────────
    // SSE event stream
    // ─────────────────────────────────────────────

    async startEventStream(userId: number, ctx: Context): Promise<void> {
        const state = this.userStates.get(userId);
        if (!state) return;

        this.stopEventStream(userId);

        const abortController = new AbortController();
        this.eventAbortControllers.set(userId, abortController);

        const MAX_RETRIES = 10;
        const BASE_DELAY_MS = 1000;
        let retries = 0;

        while (!abortController.signal.aborted) {
            try {
                const baseUrl = this.getBaseUrl(userId);
                const client = createOpencodeClient({ baseUrl });
                const events = await client.event.subscribe();

                retries = 0;

                for await (const event of events.stream) {
                    if (abortController.signal.aborted) break;
                    const currentState = this.userStates.get(userId);
                    if (currentState) {
                        await processEvent(event, ctx, currentState, globalMessageDeleteTimeout);
                    }
                }

                if (abortController.signal.aborted) break;
            } catch (error) {
                if (abortController.signal.aborted) break;
                console.error(`Event stream error (retry ${retries + 1}/${MAX_RETRIES}):`, error);
            }

            retries++;
            if (retries > MAX_RETRIES) {
                console.error(`Event stream: giving up after ${MAX_RETRIES} retries for user ${userId}`);
                break;
            }

            const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retries - 1), 30000);
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, delay);
                const onAbort = () => { clearTimeout(timer); resolve(); };
                abortController.signal.addEventListener("abort", onAbort, { once: true });
            });
        }

        this.eventAbortControllers.delete(userId);
    }

    hasEventStream(userId: number): boolean {
        return this.eventAbortControllers.has(userId);
    }

    stopEventStream(userId: number): void {
        const controller = this.eventAbortControllers.get(userId);
        if (controller) {
            controller.abort();
            this.eventAbortControllers.delete(userId);
        }
    }

    stopAllEventStreams(): void {
        for (const [, controller] of this.eventAbortControllers.entries()) {
            controller.abort();
        }
        this.eventAbortControllers.clear();

        for (const [, state] of this.userStates.entries()) {
            for (const [sid] of state.sessions) {
                this.cleanupSessionState(sid);
            }
        }
        this.userStates.clear();
    }

    // ─────────────────────────────────────────────
    // Prompts & commands
    // ─────────────────────────────────────────────

    async sendPrompt(userId: number, text: string, fileContext?: string): Promise<void> {
        const userSession = this.getUserSession(userId);
        if (!userSession) {
            throw new Error("No active session. Please use /opencode to start a session first.");
        }

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });
        const fullPrompt = fileContext ? `${fileContext}\n\n${text}` : text;

        client.session.prompt({
            sessionID: userSession.sessionId,
            parts: [{ type: "text", text: fullPrompt }],
            agent: userSession.currentAgent,
        }).catch((error) => {
            if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
                console.error(`Cannot connect to OpenCode server at ${baseUrl}`);
            } else {
                console.error("Prompt error:", error);
            }
        });
    }

    async resolveCommandName(input: string, userId: number): Promise<string | null> {
        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });
        try {
            const result = await client.command.list();
            if (!result.data) return null;

            const commands = result.data as Array<{ name: string }>;
            const exact = commands.find(c => c.name === input);
            if (exact) return exact.name;

            const normalize = (s: string) => s.toLowerCase().replace(/[-\s]+/g, " ").trim();
            const normalized = normalize(input);
            const match = commands.find(c => normalize(c.name) === normalized);
            return match ? match.name : null;
        } catch (error) {
            console.error("Failed to resolve command name:", error);
            return null;
        }
    }

    async sendCommand(userId: number, command: string, args: string): Promise<boolean> {
        const userSession = this.getUserSession(userId);
        if (!userSession) {
            throw new Error("No active session. Please use /opencode to start a session first.");
        }

        const resolvedName = await this.resolveCommandName(command, userId);
        if (!resolvedName) return false;

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        client.session.command({
            sessionID: userSession.sessionId,
            command: resolvedName,
            arguments: args,
            agent: userSession.currentAgent,
        }).catch((error) => {
            if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
                console.error(`Cannot connect to OpenCode server at ${baseUrl}`);
            } else {
                console.error("Command error:", error);
            }
        });

        return true;
    }

    async undoLastMessage(userId: number): Promise<{ success: boolean; message?: string }> {
        const userSession = this.getUserSession(userId);
        if (!userSession) return { success: false, message: "No active session found" };

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            if (typeof client.session.revert !== 'function') {
                return { success: false, message: "Undo is not available in this SDK version" };
            }
            await client.session.revert({ sessionID: userSession.sessionId });
            return { success: true };
        } catch (error) {
            console.error(`Failed to undo message for user ${userId}:`, error);
            return { success: false, message: "Failed to undo last message" };
        }
    }

    async redoLastMessage(userId: number): Promise<{ success: boolean; message?: string }> {
        const userSession = this.getUserSession(userId);
        if (!userSession) return { success: false, message: "No active session found" };

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            if (typeof client.session.unrevert !== 'function') {
                return { success: false, message: "Redo is not available in this SDK version" };
            }
            await client.session.unrevert({ sessionID: userSession.sessionId });
            return { success: true };
        } catch (error) {
            console.error(`Failed to redo message for user ${userId}:`, error);
            return { success: false, message: "Failed to redo last message" };
        }
    }

    // ─────────────────────────────────────────────
    // Session history
    // ─────────────────────────────────────────────

    async getSessionHistory(userId: number, limit = 5): Promise<Array<{ role: "user" | "assistant"; text: string; time: number }>> {
        const userSession = this.getUserSession(userId);
        if (!userSession) return [];

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            const result = await client.session.messages({
                sessionID: userSession.sessionId,
                limit: Math.min(limit, 20),
            });

            if (!result.data) return [];

            return result.data.map((msg: any) => {
                const role: "user" | "assistant" = msg.info?.role === "user" ? "user" : "assistant";
                // Extract text from parts
                const textParts = (msg.parts ?? [])
                    .filter((p: any) => p.type === "text" && p.text)
                    .map((p: any) => (p.text as string).substring(0, 200));
                const text = textParts.join(" ").trim() || "(no text)";
                return { role, text, time: msg.info?.time?.created ?? 0 };
            });
        } catch (error) {
            console.error(`Failed to get session history for user ${userId}:`, error);
            return [];
        }
    }

    // ─────────────────────────────────────────────
    // Agents
    // ─────────────────────────────────────────────

    async getAvailableAgents(userId: number): Promise<Array<{ name: string; mode?: string; description?: string }>> {
        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            const result = await client.app.agents();
            if (!result.data) return [];

            const internalAgents = ['compaction', 'title', 'summary'];
            return result.data
                .filter((agent: any) => {
                    if (agent.hidden === true) return false;
                    if (agent.mode === "subagent") return false;
                    if (internalAgents.includes(agent.name)) return false;
                    return agent.mode === "primary" || agent.mode === "all";
                })
                .map((agent: any) => ({
                    name: agent.name || "unknown",
                    mode: agent.mode,
                    description: agent.description,
                }));
        } catch (error) {
            console.error("Failed to get available agents:", error);
            return [];
        }
    }

    async cycleToNextAgent(userId: number): Promise<{ success: boolean; currentAgent?: string }> {
        const userSession = this.getUserSession(userId);
        if (!userSession) return { success: false };

        try {
            const agents = await this.getAvailableAgents(userId);
            if (agents.length === 0) return { success: false };

            const currentAgent = userSession.currentAgent || agents[0].name;
            const currentIndex = agents.findIndex(a => a.name === currentAgent);
            const nextIndex = (currentIndex + 1) % agents.length;
            const nextAgent = agents[nextIndex].name;

            userSession.currentAgent = nextAgent;
            return { success: true, currentAgent: nextAgent };
        } catch (error) {
            console.error(`Failed to cycle agent for user ${userId}:`, error);
            return { success: false };
        }
    }

    // ─────────────────────────────────────────────
    // Sessions & projects listing
    // ─────────────────────────────────────────────

    async getSessions(userId: number, limit = 10): Promise<Array<{ id: string; title: string; created: number; updated: number }>> {
        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            const result = await client.session.list();
            if (!result.data) return [];

            return result.data
                .sort((a: any, b: any) => b.time.updated - a.time.updated)
                .slice(0, limit)
                .map((session: any) => ({
                    id: session.id,
                    title: session.title,
                    created: session.time.created,
                    updated: session.time.updated,
                }));
        } catch (error) {
            console.error("Failed to get sessions:", error);
            return [];
        }
    }

    async getAllSessions(userId: number): Promise<Array<{ id: string; title: string; created: number; updated: number }>> {
        return this.getSessions(userId, 9999);
    }

    async updateSessionTitle(userId: number, title: string): Promise<{ success: boolean; message?: string }> {
        const userSession = this.getUserSession(userId);
        if (!userSession) return { success: false, message: "No active session found" };

        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            await client.session.update({ sessionID: userSession.sessionId, title });
            return { success: true };
        } catch (error) {
            console.error(`Failed to update session title for user ${userId}:`, error);
            return { success: false, message: "Failed to update session title" };
        }
    }

    async getProjects(userId: number): Promise<Array<{ id: string; worktree: string }>> {
        const baseUrl = this.getBaseUrl(userId);
        const client = createOpencodeClient({ baseUrl });

        try {
            const result = await client.project.list();
            if (!result.data) return [];
            return result.data.map((project: any) => ({ id: project.id, worktree: project.worktree }));
        } catch (error) {
            console.error("Failed to get projects:", error);
            return [];
        }
    }
}
