import { Bot, Context, InputFile } from "grammy";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCodeService, setMessageDeleteTimeout } from "./opencode.service.js";
import { ConfigService } from "../../services/config.service.js";
import { ServerRegistry } from "../../services/server-registry.service.js";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { MessageUtils } from "../../utils/message.utils.js";
import { ErrorUtils } from "../../utils/error.utils.js";
import { formatAsHtml, escapeHtml, startTypingIndicator, stopTypingIndicator } from "./event-handlers/utils.js";
import { FileMentionService, FileMentionUI } from "../file-mentions/index.js";
import { resetQuestionState, getQuestionCallback, getActiveQuestionCallId } from "./event-handlers/message-part-updated/tool-part.handler.js";
import { getPermissionCallback } from "./event-handlers/permission.updated.handler.js";
import {
    buildPageKeyboard, parsePageCallback, parseJumpCallback,
    setPendingJump, consumePendingJump,
    totalPages, getPageSlice, PAGE_SIZE,
} from "../../utils/pagination.js";
import { createVoiceProvider, splitForTts, type VoiceProvider } from "../../services/voice.service.js";
import { setVoiceProvider as setIdleVoiceProvider } from "./event-handlers/session.idle.handler.js";
import * as fs from "fs";
import * as path from "path";

const pendingQuestionAnswers = new Map<number, { callId: string; qIdx: number; expiresAt: number }>();

const QUESTION_ANSWER_TTL_MS = 5 * 60 * 1000;

function setPendingQuestion(userId: number, callId: string, qIdx: number): void {
    pendingQuestionAnswers.set(userId, { callId, qIdx, expiresAt: Date.now() + QUESTION_ANSWER_TTL_MS });
}

function getPendingQuestion(userId: number): { callId: string; qIdx: number } | undefined {
    const entry = pendingQuestionAnswers.get(userId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        pendingQuestionAnswers.delete(userId);
        return undefined;
    }
    return entry;
}

function timeAgo(ts: number): string {
    // ts may be seconds or milliseconds — normalise to seconds
    const tsSeconds = ts > 1e10 ? Math.floor(ts / 1000) : ts;
    const diff = Math.floor(Date.now() / 1000) - tsSeconds;
    if (diff < 0) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

export class OpenCodeBot {
    private opencodeService: OpenCodeService;
    private configService: ConfigService;
    private serverRegistry: ServerRegistry;
    private fileMentionService: FileMentionService;
    private fileMentionUI: FileMentionUI;
    private voiceProvider: VoiceProvider | null = null;

    constructor(
        opencodeService: OpenCodeService,
        configService: ConfigService,
        serverRegistry: ServerRegistry
    ) {
        this.opencodeService = opencodeService;
        this.configService = configService;
        this.serverRegistry = serverRegistry;
        this.fileMentionService = new FileMentionService();
        this.fileMentionUI = new FileMentionUI();

        // Pass messageDeleteTimeout to service layer for background notifications
        setMessageDeleteTimeout(configService.getMessageDeleteTimeout());

        // Initialize voice provider if voice features are enabled
        if (configService.isVoiceEnabled()) {
            try {
                this.voiceProvider = createVoiceProvider({
                    provider: configService.getVoiceProvider(),
                    openaiApiKey: process.env.OPENAI_API_KEY,
                    sttModel: configService.getVoiceSttModel(),
                    ttsModel: configService.getVoiceTtsModel(),
                    ttsVoice: configService.getVoiceTtsVoice(),
                    azureApiKey: process.env.AZURE_OPENAI_API_KEY,
                    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
                    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION,
                    azureSttDeployment: process.env.AZURE_VOICE_STT_DEPLOYMENT,
                    azureTtsDeployment: process.env.AZURE_VOICE_TTS_DEPLOYMENT,
                    azureSpeechApiKey: process.env.AZURE_SPEECH_API_KEY || process.env.AZURE_OPENAI_API_KEY,
                    azureSpeechRegion: process.env.AZURE_SPEECH_REGION,
                    azureSpeechVoice: process.env.AZURE_SPEECH_VOICE,
                    azureSpeechLanguage: process.env.AZURE_SPEECH_LANGUAGE,
                });
                // Register with session.idle handler for TTS delivery
                setIdleVoiceProvider(this.voiceProvider);
                console.log(`[Voice] Provider initialized: ${configService.getVoiceProvider()}`);
            } catch (err) {
                console.warn(`[Voice] Failed to initialize voice provider: ${err instanceof Error ? err.message : err}`);
            }
        }
    }

    registerHandlers(bot: Bot): void {
        bot.command("start", AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("help", AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("opencode", AccessControlMiddleware.requireAccess, this.handleOpenCode.bind(this));
        bot.command("esc", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.command("endsession", AccessControlMiddleware.requireAccess, this.handleEndSession.bind(this));
        bot.command("rename", AccessControlMiddleware.requireAccess, this.handleRename.bind(this));
        bot.command("projects", AccessControlMiddleware.requireAccess, this.handleProjects.bind(this));
        bot.command("sessions", AccessControlMiddleware.requireAccess, this.handleSessions.bind(this));
        bot.command("session", AccessControlMiddleware.requireAccess, this.handleSession.bind(this));
        bot.command("history", AccessControlMiddleware.requireAccess, this.handleHistory.bind(this));
        bot.command("detach", AccessControlMiddleware.requireAccess, this.handleDetach.bind(this));
        bot.command("undo", AccessControlMiddleware.requireAccess, this.handleUndo.bind(this));
        bot.command("redo", AccessControlMiddleware.requireAccess, this.handleRedo.bind(this));
        bot.command("verbosity", AccessControlMiddleware.requireAccess, this.handleVerbosity.bind(this));
        bot.command("servers", AccessControlMiddleware.requireAccess, this.handleServers.bind(this));
        bot.command("server", AccessControlMiddleware.requireAccess, this.handleServer.bind(this));
        bot.command("status", AccessControlMiddleware.requireAccess, this.handleStatus.bind(this));
        bot.command("model", AccessControlMiddleware.requireAccess, this.handleModel.bind(this));
        bot.command("tts", AccessControlMiddleware.requireAccess, this.handleTts.bind(this));

        // Handle keyboard button presses
        bot.hears("⏹️ ESC", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.hears("⇥ TAB", AccessControlMiddleware.requireAccess, this.handleTab.bind(this));

        // Handle inline button callbacks
        bot.callbackQuery("esc", AccessControlMiddleware.requireAccess, this.handleEscButton.bind(this));
        bot.callbackQuery("tab", AccessControlMiddleware.requireAccess, this.handleTabButton.bind(this));

        // Handle permission response buttons (short IDs like p0, p1, p2, ...)
        // Handle question response buttons (short IDs like q0, q1, q2, ...)
        // Handle pagination buttons (pg:*, pgj:*, pg_noop)
        bot.on("callback_query:data", AccessControlMiddleware.requireAccess, async (ctx) => {
            const data = ctx.callbackQuery.data;
            if (/^p\d+$/.test(data)) {
                await this.handlePermissionResponse(ctx, data);
            } else if (/^q\d+$/.test(data)) {
                await this.handleQuestionResponse(ctx, data);
            } else if (data === "pg_noop") {
                await ctx.answerCallbackQuery();
            } else if (data.startsWith("sw:")) {
                await this.handleSessionSwitchButton(ctx, data.slice(3));
            } else if (data.startsWith("su:")) {
                await this.handleServerUseButton(ctx, data.slice(3));
            } else if (data.startsWith("ml:")) {
                await this.handleModelListProvider(ctx, data.slice(3));
            } else if (data.startsWith("ms:")) {
                await this.handleModelSelect(ctx, data.slice(3));
            } else if (parsePageCallback(data)) {
                await this.handlePageTurn(ctx, data);
            } else if (parseJumpCallback(data)) {
                await this.handlePageJumpPrompt(ctx, data);
            }
        });

        // Handle file uploads (documents, photos, videos, audio, etc.)
        bot.on("message:document", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:photo", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:video", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:audio", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:voice", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:video_note", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));

        bot.on("message:text", AccessControlMiddleware.requireAccess, async (ctx, next) => {
            if (ctx.message?.text === "⏹️ ESC" || ctx.message?.text === "⇥ TAB") {
                return next();
            }
            // Check if this is a page-jump reply (user typed a page number)
            const userId = ctx.from?.id;
            if (userId) {
                const listId = consumePendingJump(userId);
                if (listId) {
                    await this.handlePageJumpReply(ctx, listId);
                    return;
                }
            }
            await this.handleMessageAsPrompt(ctx);
        });
    }

    // ─────────────────────────────────────────────
    // Help
    // ─────────────────────────────────────────────

    private async handleStart(ctx: Context): Promise<void> {
        try {
            const helpMessage = [
                '👋 <b>Welcome to TelegramCoder!</b>',
                '',
                '🎯 <b>Session Commands:</b>',
                '/opencode [title] - Start a new OpenCode AI session (old one moves to background)',
                '/sessions - List sessions with status flags (● active ○ attached · history)',
                '/session &lt;id&gt; - Switch to or attach a session by short ID',
                '/history [n] - Show last N messages of current session (default 5)',
                '/detach - Detach from current session (keeps it in background)',
                '/rename &lt;title&gt; - Rename current session',
                '/endsession - End and delete current session',
                '',
                '🖥️ <b>Server Commands:</b>',
                '/servers - List configured opencode servers',
                '/server add &lt;url&gt; [name] - Add a server',
                '/server remove &lt;id&gt; - Remove a server',
                '/server use &lt;id&gt; - Switch active server',
                '',
                '⚡️ <b>Control Commands:</b>',
                '/esc - Abort the current AI operation',
                '/undo - Revert the last message/change',
                '/redo - Restore a previously undone change',
                '/verbosity [0-3] [0/1] - Set detail level &amp; streaming',
                '⇥ TAB button - Cycle between agents (build ↔ plan)',
                '⏹️ ESC button - Same as /esc command',
                '',
                '📋 <b>Info Commands:</b>',
                '/projects - List available projects',
                '/start /help - Show this help message',
                '',
                '💬 <b>How to Use:</b>',
                '1. Start: /opencode My Project',
                '2. Chat: Just send messages directly',
                '3. Multi-session: /opencode again creates a new session, old moves to background',
                '4. Switch: /sessions then /session &lt;id&gt;',
                '5. Multi-server: /server add &lt;url&gt; then /server use &lt;id&gt;',
                '6. Upload: Send any file — saved to /tmp/telegramCoder',
                '7. End: /endsession when done',
                '',
                '🚀 <b>Get started:</b> /opencode'
            ].join('\n');

            await ctx.reply(helpMessage, { parse_mode: "HTML" });
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage('show help message', error));
        }
    }

    // ─────────────────────────────────────────────
    // Session management
    // ─────────────────────────────────────────────

    private async handleOpenCode(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const text = ctx.message?.text || "";
            const title = text.replace("/opencode", "").trim() || undefined;

            const statusMessage = await ctx.reply("🔄 Starting OpenCode session...");
            const chatId = statusMessage.chat.id;

            try {
                const existingActive = this.opencodeService.getUserSession(userId);
                const userSession = await this.opencodeService.createSession(userId, title);

                const prevNote = existingActive
                    ? `\nPrevious session moved to background.`
                    : "";

                const successMessage = await ctx.api.editMessageText(
                    chatId,
                    statusMessage.message_id,
                    `✅ Session started: <b>${escapeHtml(userSession.session.title || "Untitled")}</b>${escapeHtml(prevNote)}`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [[
                                { text: "⏹️ ESC", callback_data: "esc" },
                                { text: "⇥ TAB", callback_data: "tab" }
                            ]]
                        }
                    }
                );

                const messageId = (typeof successMessage === "object" && successMessage && "message_id" in successMessage)
                    ? (successMessage as any).message_id
                    : statusMessage.message_id;

                await MessageUtils.scheduleMessageDeletion(ctx, messageId, this.configService.getMessageDeleteTimeout());
                this.opencodeService.updateSessionContext(userId, chatId, messageId);
                this.opencodeService.startEventStream(userId, ctx).catch(error => {
                    console.error("Event stream error:", error);
                });
            } catch (error) {
                await ctx.api.editMessageText(chatId, statusMessage.message_id,
                    ErrorUtils.createErrorMessage("start OpenCode session", error));
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("start OpenCode session", error));
        }
    }

    // ─── Sessions list builder (shared by /sessions command and page-turn) ────

    private async buildSessionsPage(
        userId: number,
        page: number,
    ): Promise<{ text: string; reply_markup: any } | null> {
        const userState = this.opencodeService.getUserState(userId);
        const allServerSessions = await this.opencodeService.getSessions(userId, 9999);

        if (allServerSessions.length === 0) return null;

        const activeServer = this.serverRegistry.getActive(userId);
        const serverName = activeServer?.name ?? "Unknown";
        const attachedIds = new Set(userState?.sessions.keys() ?? []);
        const activeId = userState?.activeSessionId;
        const allIds = allServerSessions.map(s => s.id);

        // Compute minimum unique prefix against the full list
        const uniquePrefix = (id: string): string => {
            for (let len = 8; len <= id.length; len++) {
                const prefix = id.substring(0, len);
                if (allIds.filter(other => other.startsWith(prefix)).length === 1) return prefix;
            }
            return id;
        };

        const nPages = totalPages(allServerSessions.length);
        const safePage = Math.max(0, Math.min(page, nPages - 1));
        const pageItems = getPageSlice(allServerSessions, safePage);

        const lines: string[] = [];
        const switchButtons: Array<{ text: string; callback_data: string }> = [];

        pageItems.forEach((s, idx) => {
            const flag = s.id === activeId ? "●" : attachedIds.has(s.id) ? "○" : "·";
            const attached = userState?.sessions.get(s.id);
            const statusIcon = attached
                ? (attached.serverStatus === "busy" ? "⚡" : attached.serverStatus === "error" ? "❌" : "✅")
                : "";
            const shortId = uniquePrefix(s.id);
            const title = escapeHtml(s.title || "Untitled").substring(0, 28);
            const agent = attached?.currentAgent ? ` ${escapeHtml(attached.currentAgent)}` : "";
            const time = timeAgo(s.updated);
            const lineNum = safePage * PAGE_SIZE + idx + 1;
            lines.push(`${lineNum}. ${flag} <code>${shortId}</code>  <b>${title}</b>${agent}  ${time}${statusIcon ? " " + statusIcon : ""}`);

            // Switch button — label is truncated title, callback uses unique prefix (≤64 bytes)
            const btnLabel = (s.title || "Untitled").substring(0, 18) + (s.id === activeId ? " ●" : "");
            switchButtons.push({ text: btnLabel, callback_data: `sw:${shortId}` });
        });

        const attachedCount = attachedIds.size;
        const header = `💬 <b>Sessions — ${escapeHtml(serverName)}</b> (${allServerSessions.length} total, ${attachedCount} attached)\n\n`;
        const legend = `\n● active  ○ attached  · history`;
        const text = header + lines.join("\n") + legend;

        // Build keyboard: session switch buttons (2 per row) + pagination row
        const btnRows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < switchButtons.length; i += 2) {
            btnRows.push(switchButtons.slice(i, i + 2));
        }
        const pageKb = buildPageKeyboard("sessions", safePage, nPages);
        if (pageKb) btnRows.push(pageKb.inline_keyboard[0]);

        const reply_markup = btnRows.length > 0 ? { inline_keyboard: btnRows } : undefined;
        return { text, reply_markup };
    }

    private async handleSessions(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const result = await this.buildSessionsPage(userId, 0);
            if (!result) {
                const m = await ctx.reply("💬 No sessions found. Use /opencode to start one.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const m = await ctx.reply(result.text, {
                parse_mode: "HTML",
                reply_markup: result.reply_markup,
            });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list sessions", error));
        }
    }

    private async handleSession(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const text = ctx.message?.text || "";
            const sessionIdArg = text.replace("/session", "").trim();

            if (!sessionIdArg) {
                // No arg: show current session info
                const session = this.opencodeService.getUserSession(userId);
                if (!session) {
                    const m = await ctx.reply("ℹ️ No active session. Use /sessions to list, or /opencode to start one.");
                    await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                    return;
                }
                const m = await ctx.reply(
                    `💬 <b>Current session:</b> ${escapeHtml(session.session.title || "Untitled")}\n` +
                    `ID: <code>${session.sessionId.substring(0, 8)}</code>\n` +
                    `Agent: ${escapeHtml(session.currentAgent || "build")} | Verbosity: ${session.verbosity} | Stream: ${session.stream ? "on" : "off"}\n` +
                    `Last active: ${timeAgo(session.session.time.updated)}`,
                    { parse_mode: "HTML" }
                );
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            if (sessionIdArg.length < 4) {
                await ctx.reply("❌ Session ID must be at least 4 characters.");
                return;
            }

            // Check if it's already in local state
            const userState = this.opencodeService.getUserState(userId);
            let alreadyAttached = false;
            let targetSessionId: string | null = null;

            if (userState) {
                for (const [sid] of userState.sessions) {
                    if (sid.startsWith(sessionIdArg)) {
                        targetSessionId = sid;
                        alreadyAttached = true;
                        break;
                    }
                }
            }

            if (alreadyAttached && targetSessionId) {
                // Switch to it
                this.opencodeService.switchSession(userId, targetSessionId);
                // Ensure SSE stream is running and chatId is set so errors can be delivered
                if (!this.opencodeService.hasEventStream(userId)) {
                    this.opencodeService.startEventStream(userId, ctx).catch(e => console.error("Event stream error:", e));
                }
                if (ctx.chat?.id) {
                    this.opencodeService.updateSessionContext(userId, ctx.chat.id, 0);
                }
                const session = this.opencodeService.getUserSession(userId)!;
                const m = await ctx.reply(
                    `✅ Switched to: <b>${escapeHtml(session.session.title || "Untitled")}</b>\n` +
                    `Agent: ${escapeHtml(session.currentAgent || "build")} | Verbosity: ${session.verbosity} | Stream: ${session.stream ? "on" : "off"}\n` +
                    `Last active: ${timeAgo(session.session.time.updated)}`,
                    { parse_mode: "HTML" }
                );
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                await this.sendHistoryAfterSwitch(ctx, userId);
                return;
            }

            // Attach from server
            try {
                const result = await this.opencodeService.attachSession(userId, sessionIdArg);
                if (!result) {
                    const m = await ctx.reply(`❌ Session not found: <code>${escapeHtml(sessionIdArg)}</code>`, { parse_mode: "HTML" });
                    await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                    return;
                }

                // Switch to it now
                this.opencodeService.switchSession(userId, result.session.sessionId);
                // Ensure SSE stream is running and chatId is set so errors can be delivered
                if (!this.opencodeService.hasEventStream(userId)) {
                    this.opencodeService.startEventStream(userId, ctx).catch(e => console.error("Event stream error:", e));
                }
                if (ctx.chat?.id) {
                    this.opencodeService.updateSessionContext(userId, ctx.chat.id, 0);
                }
                const m = await ctx.reply(
                    `✅ Attached to: <b>${escapeHtml(result.session.session.title || "Untitled")}</b>\n` +
                    `Agent: ${escapeHtml(result.session.currentAgent || "build")} | Verbosity: ${result.session.verbosity}\n` +
                    `Last active: ${timeAgo(result.session.session.time.updated)}`,
                    { parse_mode: "HTML" }
                );
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                await this.sendHistoryAfterSwitch(ctx, userId);
            } catch (err: any) {
                if (err?.message === "AMBIGUOUS" && err?.matches) {
                    const matchList = (err.matches as string[]).map((id: string) => `<code>${id.substring(0, 8)}</code>`).join(", ");
                    await ctx.reply(`⚠️ Multiple sessions match: ${matchList}\nPlease provide more characters.`, { parse_mode: "HTML" });
                } else {
                    throw err;
                }
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("switch session", error));
        }
    }

    private async handleHistory(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                const m = await ctx.reply("❌ No active session. Use /session &lt;id&gt; to attach one.", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const text = ctx.message?.text || "";
            const nStr = text.replace("/history", "").trim();
            const n = nStr ? Math.min(Math.max(1, parseInt(nStr, 10) || 5), 20) : 5;

            const session = this.opencodeService.getUserSession(userId)!;
            const history = await this.opencodeService.getSessionHistory(userId, n, session.verbosity);

            if (history.length === 0) {
                const m = await ctx.reply("📜 No messages yet in this session.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }
            const title = escapeHtml(session.session.title || "Untitled");
            const timeout = this.configService.getMessageDeleteTimeout();

            // Send header
            const header = await ctx.reply(`📜 <b>Last ${history.length} messages — ${title}</b>`, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, header.message_id, timeout);

            // Replay each message individually
            for (const msg of history) {
                const prefix = msg.role === "user" ? "👤 <b>You</b>" : "🤖 <b>AI</b>";
                const t = new Date(msg.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const bodyHtml = escapeHtml(msg.text);
                const msgText = `${prefix} <i>${t}</i>\n${bodyHtml}`;

                let sent;
                if (msgText.length > 4000) {
                    const buf = Buffer.from(`[${msg.role === "user" ? "You" : "AI"}] ${new Date(msg.time * 1000).toLocaleTimeString()}\n${msg.text}`, "utf-8");
                    sent = await ctx.replyWithDocument(new InputFile(buf, `msg_${t.replace(":", "-")}.txt`));
                } else {
                    sent = await ctx.reply(msgText, { parse_mode: "HTML" });
                }
                await MessageUtils.scheduleMessageDeletion(ctx, sent.message_id, timeout);
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("fetch history", error));
        }
    }

    private async handleDetach(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const detached = this.opencodeService.detachSession(userId);
            if (!detached) {
                const m = await ctx.reply("ℹ️ No active session to detach from.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const title = escapeHtml(detached.session.title || detached.sessionId.substring(0, 8));
            const m = await ctx.reply(
                `✅ Detached from <b>${title}</b>. Session remains in background.\n/sessions to manage.`,
                { parse_mode: "HTML" }
            );
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("detach session", error));
        }
    }

    private async handleEndSession(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ No active session. Use /opencode to start one.");
                return;
            }

            const result = await this.opencodeService.deleteSession(userId);

            if (result.success) {
                const msg = "✅ OpenCode session ended. Use /opencode to start a new session or /sessions to attach an existing one.";
                const sentMessage = await ctx.reply(msg, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, sentMessage.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                await ctx.reply("⚠️ Failed to end session. It may have already been closed.");
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("end OpenCode session", error));
        }
    }

    // ─────────────────────────────────────────────
    // Server management
    // ─────────────────────────────────────────────

    // ─── Servers list builder (shared by /servers and page-turn) ─────────────

    private buildServersPage(
        userId: number,
        page: number,
    ): { text: string; reply_markup?: any } | null {
        const servers = this.serverRegistry.listByUserWithDefaults(userId);
        if (servers.length === 0) return null;

        const nPages = totalPages(servers.length);
        const safePage = Math.max(0, Math.min(page, nPages - 1));
        const pageItems = getPageSlice(servers, safePage);

        const lines: string[] = [];
        const useButtons: Array<{ text: string; callback_data: string }> = [];

        pageItems.forEach((s, idx) => {
            const flag = s.isActive ? "●" : "·";
            const authBadge = s.username ? " 🔐" : "";
            const lineNum = safePage * PAGE_SIZE + idx + 1;
            lines.push(`${lineNum}. ${flag} <code>${s.id}</code>  <b>${escapeHtml(s.name)}</b>${authBadge}\n   ${escapeHtml(s.url)}`);
            const btnLabel = (s.isActive ? "● " : "↩ ") + s.name.substring(0, 20);
            useButtons.push({ text: btnLabel, callback_data: `su:${s.id}` });
        });

        const text = `🖥️ <b>Servers (${servers.length})</b>\n\n${lines.join("\n\n")}\n\n● active  🔐 auth configured\n/server add &lt;url&gt; [name] [username] [password] to add`;

        const btnRows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < useButtons.length; i += 2) {
            btnRows.push(useButtons.slice(i, i + 2));
        }
        const pageKb = buildPageKeyboard("servers", safePage, nPages);
        if (pageKb) btnRows.push(pageKb.inline_keyboard[0]);

        const reply_markup = btnRows.length > 0 ? { inline_keyboard: btnRows } : undefined;
        return { text, reply_markup };
    }

    private async handleServers(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const result = this.buildServersPage(userId, 0);
            if (!result) {
                const m = await ctx.reply("🖥️ No servers configured. Use /server add &lt;url&gt; [name]", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const m = await ctx.reply(result.text, {
                parse_mode: "HTML",
                reply_markup: result.reply_markup,
            });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list servers", error));
        }
    }

    // ─────────────────────────────────────────────
    // Pagination callbacks
    // ─────────────────────────────────────────────

    /** User clicked ◀ or ▶ — edit the existing message in place */
    private async handlePageTurn(ctx: Context, data: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const parsed = parsePageCallback(data);
            if (!parsed) return;
            const userId = ctx.from?.id;
            if (!userId) return;

            const { listId, page } = parsed;
            let result: { text: string; reply_markup?: any } | null = null;

            if (listId === "sessions") {
                result = await this.buildSessionsPage(userId, page);
            } else if (listId === "servers") {
                result = this.buildServersPage(userId, page);
            }

            if (!result) return;

            await ctx.editMessageText(result.text, {
                parse_mode: "HTML",
                reply_markup: result.reply_markup,
            });
        } catch (error) {
            console.error("Page turn error:", error);
        }
    }

    /** User clicked the centre "N/M" button — ask them to type a page number */
    private async handlePageJumpPrompt(ctx: Context, data: string): Promise<void> {
        try {
            const listId = parseJumpCallback(data);
            if (!listId) { await ctx.answerCallbackQuery(); return; }
            const userId = ctx.from?.id;
            if (!userId) { await ctx.answerCallbackQuery(); return; }

            setPendingJump(userId, listId);
            await ctx.answerCallbackQuery("Type a page number and send it");
            await ctx.reply("📄 Type the page number to jump to:", {
                reply_markup: { force_reply: true, selective: true },
            });
        } catch (error) {
            console.error("Page jump prompt error:", error);
        }
    }

    /** User replied with a page number after clicking the centre button */
    private async handlePageJumpReply(ctx: Context, listId: string): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) return;

            const text = ctx.message?.text?.trim() || "";
            const page = parseInt(text, 10) - 1; // convert 1-indexed to 0-indexed

            if (isNaN(page) || page < 0) {
                const m = await ctx.reply("❌ Invalid page number.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            let result: { text: string; reply_markup?: any } | null = null;
            if (listId === "sessions") {
                result = await this.buildSessionsPage(userId, page);
            } else if (listId === "servers") {
                result = this.buildServersPage(userId, page);
            }

            if (!result) {
                const m = await ctx.reply("❌ Nothing to show.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const m = await ctx.reply(result.text, {
                parse_mode: "HTML",
                reply_markup: result.reply_markup,
            });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            console.error("Page jump reply error:", error);
        }
    }

    private async handleServer(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const text = (ctx.message?.text || "").replace("/server", "").trim();
            const spaceIdx = text.indexOf(" ");
            const subCmd = spaceIdx > 0 ? text.substring(0, spaceIdx).toLowerCase() : text.toLowerCase();
            const rest = spaceIdx > 0 ? text.substring(spaceIdx + 1).trim() : "";

            if (!subCmd) {
                const m = await ctx.reply(
                    "🖥️ <b>Server commands:</b>\n" +
                    "/server add &lt;url&gt; [name] [username] [password] — add server\n" +
                    "/server remove &lt;id&gt; — remove server\n" +
                    "/server use &lt;id&gt; — switch active server\n" +
                    "/servers — list all servers",
                    { parse_mode: "HTML" }
                );
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            switch (subCmd) {
                case "add": await this.handleServerAdd(ctx, userId, rest); break;
                case "remove": case "rm": await this.handleServerRemove(ctx, userId, rest); break;
                case "use": case "switch": await this.handleServerUse(ctx, userId, rest); break;
                default:
                    await ctx.reply(`❌ Unknown subcommand: ${escapeHtml(subCmd)}. Try /server add, /server remove, /server use.`, { parse_mode: "HTML" });
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("server command", error));
        }
    }

    private async handleServerAdd(ctx: Context, userId: number, args: string): Promise<void> {
        if (!args) {
            await ctx.reply("❌ Usage: /server add &lt;url&gt; [name] [username] [password]", { parse_mode: "HTML" });
            return;
        }

        // Parse positional tokens: url [name] [username] [password]
        const tokens = args.trim().split(/\s+/);
        const url = tokens[0];
        const name = tokens[1] || undefined;
        const username = tokens[2] || undefined;
        const password = tokens[3] || undefined;

        // Validate URL
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            await ctx.reply("❌ Invalid URL. Must start with http:// or https://");
            return;
        }

        // Check duplicate
        const existing = this.serverRegistry.findByUrl(userId, url);
        if (existing) {
            const m = await ctx.reply(
                `⚠️ Server with this URL already exists: <b>${escapeHtml(existing.name)}</b> (<code>${existing.id}</code>)`,
                { parse_mode: "HTML" }
            );
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            return;
        }

        const record = this.serverRegistry.add(userId, url, name, false, username, password);
        let replyText = `✅ Server added: <b>${escapeHtml(record.name)}</b>\nURL: ${escapeHtml(record.url)}\nID: <code>${record.id}</code>`;
        if (record.username) {
            replyText += `\n🔐 Auth: ${escapeHtml(record.username)} / ***`;
        }
        const m = await ctx.reply(replyText, { parse_mode: "HTML" });
        await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
    }

    private async handleServerRemove(ctx: Context, userId: number, serverId: string): Promise<void> {
        if (!serverId) {
            await ctx.reply("❌ Usage: /server remove &lt;id&gt;", { parse_mode: "HTML" });
            return;
        }

        const record = this.serverRegistry.getById(userId, serverId);
        if (!record) {
            const m = await ctx.reply(`❌ Server not found: <code>${escapeHtml(serverId)}</code>`, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            return;
        }

        if (record.isActive) {
            const m = await ctx.reply("❌ Cannot remove active server. Use /server use &lt;id&gt; to switch first.", { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            return;
        }

        this.serverRegistry.remove(userId, record.id);
        const m = await ctx.reply(`✅ Server removed: <b>${escapeHtml(record.name)}</b>`, { parse_mode: "HTML" });
        await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
    }

    private async handleServerUse(ctx: Context, userId: number, serverId: string): Promise<void> {
        if (!serverId) {
            await ctx.reply("❌ Usage: /server use &lt;id&gt;", { parse_mode: "HTML" });
            return;
        }

        const record = this.serverRegistry.getById(userId, serverId);
        if (!record) {
            const m = await ctx.reply(`❌ Server not found: <code>${escapeHtml(serverId)}</code>`, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            return;
        }

        if (record.isActive) {
            const m = await ctx.reply(`ℹ️ Already using server: <b>${escapeHtml(record.name)}</b>`, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            return;
        }

        const statusMsg = await ctx.reply(`🔄 Switching to <b>${escapeHtml(record.name)}</b>...`, { parse_mode: "HTML" });

        await this.opencodeService.switchServer(userId, record.id, ctx);

        await ctx.api.editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            `✅ Switched to server: <b>${escapeHtml(record.name)}</b>\n${escapeHtml(record.url)}\nSessions cleared. Use /sessions to list available sessions.`,
            { parse_mode: "HTML" }
        );
        await MessageUtils.scheduleMessageDeletion(ctx, statusMsg.message_id, this.configService.getMessageDeleteTimeout());
    }

    // ─────────────────────────────────────────────
    // Inline button handlers for session/server lists
    // ─────────────────────────────────────────────

    /** Send the last 5 history messages after switching to a session */
    private async sendHistoryAfterSwitch(ctx: Context, userId: number): Promise<void> {
        try {
            const session = this.opencodeService.getUserSession(userId);
            if (!session) return;
            const history = await this.opencodeService.getSessionHistory(userId, 5, session.verbosity);
            if (history.length === 0) return;
            const timeout = this.configService.getMessageDeleteTimeout();
            for (const msg of history) {
                const prefix = msg.role === "user" ? "👤 <b>You</b>" : "🤖 <b>AI</b>";
                const t = new Date(msg.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const bodyHtml = escapeHtml(msg.text);
                const msgText = `${prefix} <i>${t}</i>\n${bodyHtml}`;
                let sent;
                if (msgText.length > 4000) {
                    const buf = Buffer.from(`[${msg.role === "user" ? "You" : "AI"}] ${new Date(msg.time * 1000).toLocaleTimeString()}\n${msg.text}`, "utf-8");
                    sent = await ctx.replyWithDocument(new InputFile(buf, `msg_${t.replace(":", "-")}.txt`));
                } else {
                    sent = await ctx.reply(msgText, { parse_mode: "HTML" });
                }
                await MessageUtils.scheduleMessageDeletion(ctx, sent.message_id, timeout);
            }
        } catch {
            // Non-fatal: history is best-effort
        }
    }

    /** Called when user taps a session switch button in /sessions list */
    private async handleSessionSwitchButton(ctx: Context, prefix: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            // Check if already attached (exact or prefix match)
            const userState = this.opencodeService.getUserState(userId);
            let targetSessionId: string | null = null;

            if (userState) {
                // Exact match first
                for (const [sid] of userState.sessions) {
                    if (sid === prefix) { targetSessionId = sid; break; }
                }
                // Prefix match
                if (!targetSessionId) {
                    for (const [sid] of userState.sessions) {
                        if (sid.startsWith(prefix)) { targetSessionId = sid; break; }
                    }
                }
            }

            if (targetSessionId) {
                // Already attached — just switch
                this.opencodeService.switchSession(userId, targetSessionId);
            } else {
                // Attach from server
                const result = await this.opencodeService.attachSession(userId, prefix);
                if (!result) {
                    await ctx.reply(`❌ Session not found: <code>${escapeHtml(prefix)}</code>`, { parse_mode: "HTML" });
                    return;
                }
                targetSessionId = result.session.sessionId;
                this.opencodeService.switchSession(userId, targetSessionId);
            }

            // Ensure SSE stream running and chatId is set
            if (!this.opencodeService.hasEventStream(userId)) {
                this.opencodeService.startEventStream(userId, ctx).catch(e => console.error("Event stream error:", e));
            }
            const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
            if (chatId) {
                this.opencodeService.updateSessionContext(userId, chatId, 0);
            }

            const session = this.opencodeService.getUserSession(userId)!;
            const title = escapeHtml(session.session.title || "Untitled");
            const m = await ctx.reply(
                `✅ Switched to: <b>${title}</b>\nAgent: ${escapeHtml(session.currentAgent || "build")} | Verbosity: ${session.verbosity}\nLast active: ${timeAgo(session.session.time.updated)}`,
                { parse_mode: "HTML" }
            );
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            await this.sendHistoryAfterSwitch(ctx, userId);
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("switch session", error));
        }
    }

    /** Called when user taps a "↩ use" button in /servers list */
    private async handleServerUseButton(ctx: Context, serverId: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const record = this.serverRegistry.getById(userId, serverId);
            if (!record) {
                await ctx.reply(`❌ Server not found: <code>${escapeHtml(serverId)}</code>`, { parse_mode: "HTML" });
                return;
            }

            if (record.isActive) {
                const m = await ctx.reply(`ℹ️ Already using server: <b>${escapeHtml(record.name)}</b>`, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const statusMsg = await ctx.reply(`🔄 Switching to <b>${escapeHtml(record.name)}</b>...`, { parse_mode: "HTML" });
            await this.opencodeService.switchServer(userId, record.id, ctx);
            await ctx.api.editMessageText(
                statusMsg.chat.id,
                statusMsg.message_id,
                `✅ Switched to server: <b>${escapeHtml(record.name)}</b>\n${escapeHtml(record.url)}\nSessions cleared. Use /sessions to list available sessions.`,
                { parse_mode: "HTML" }
            );
            await MessageUtils.scheduleMessageDeletion(ctx, statusMsg.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("switch server", error));
        }
    }

    // ─────────────────────────────────────────────
    // /status command
    // ─────────────────────────────────────────────

    private async handleStatus(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const activeServer = this.serverRegistry.getActive(userId);
            const userState = this.opencodeService.getUserState(userId);
            const session = this.opencodeService.getUserSession(userId);
            const sseRunning = this.opencodeService.hasEventStream(userId);

            const lines: string[] = ["📊 <b>Status</b>", ""];

            // Server
            if (activeServer) {
                lines.push(`🖥️ <b>Server:</b> ${escapeHtml(activeServer.name)}`);
                lines.push(`   ${escapeHtml(activeServer.url)}`);
            } else {
                lines.push(`🖥️ <b>Server:</b> (default) ${escapeHtml(process.env.OPENCODE_SERVER_URL || "http://localhost:4096")}`);
            }

            lines.push("");

            // Session
            if (session) {
                const shortId = session.sessionId.substring(0, 8);
                lines.push(`💬 <b>Session:</b> <code>${shortId}</code> — <b>${escapeHtml(session.session.title || "Untitled")}</b>`);
                lines.push(`   Agent: ${escapeHtml(session.currentAgent || "build")} | Verbosity: ${session.verbosity} | Stream: ${session.stream ? "on" : "off"}`);
                lines.push(`   Last active: ${timeAgo(session.session.time.updated)}`);
                if (session.serverStatus === "error" && session.lastError) {
                    lines.push(`   ❌ Error: ${escapeHtml(session.lastError)}`);
                }
            } else {
                lines.push(`💬 <b>Session:</b> None (use /opencode to start)`);
            }

            lines.push("");

            // SSE
            lines.push(`📡 <b>Event stream:</b> ${sseRunning ? "✅ connected" : "⚠️ not running"}`);

            // Attached sessions count
            const attachedCount = userState?.sessions.size ?? 0;
            lines.push(`📎 <b>Attached sessions:</b> ${attachedCount}`);

            const m = await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("show status", error));
        }
    }

    // ─────────────────────────────────────────────
    // /model command — browse providers → models → select
    // ─────────────────────────────────────────────

    private async handleModel(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const text = (ctx.message?.text || "").replace("/model", "").trim();
            const client = this.opencodeService.createClientForUser(userId);

            // If arg provided directly (e.g. /model anthropic/claude-opus-4-5) → set immediately
            if (text && text.includes("/")) {
                await this.setModel(ctx, userId, text);
                return;
            }

            // No arg → show current model + connected providers as buttons
            const [configResp, providerResp] = await Promise.all([
                client.config.get(),
                client.provider.list(),
            ]);

            const cfg = (configResp as any)?.data ?? configResp;
            const currentModel: string = cfg?.model || cfg?.default?.model || "not set";
            const smallModel: string | undefined = cfg?.small_model || cfg?.default?.small_model;

            const provData = (providerResp as any)?.data ?? providerResp;
            const allProviders: any[] = provData?.all ?? [];
            const connected: string[] = provData?.connected ?? [];

            const lines = [
                "🤖 <b>Model Selection</b>",
                "",
                `<b>Current:</b> <code>${escapeHtml(currentModel)}</code>`,
            ];
            if (smallModel) {
                lines.push(`<b>Small model:</b> <code>${escapeHtml(smallModel)}</code>`);
            }
            lines.push("", "Tap a provider to browse its models:");

            // Build provider buttons — connected first, then others
            const connectedProviders = allProviders.filter(p => connected.includes(p.id));
            const otherProviders = allProviders.filter(p => !connected.includes(p.id));
            const ordered = [...connectedProviders, ...otherProviders];

            const btnRows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < ordered.length; i += 2) {
                const row = ordered.slice(i, i + 2).map(p => {
                    const label = (connected.includes(p.id) ? "✅ " : "") + p.name.substring(0, 20);
                    return { text: label, callback_data: `ml:${p.id}` };
                });
                btnRows.push(row);
            }

            if (btnRows.length === 0) {
                lines.push("", "⚠️ No providers found. Check server configuration.");
            }

            const m = await ctx.reply(lines.join("\n"), {
                parse_mode: "HTML",
                reply_markup: btnRows.length > 0 ? { inline_keyboard: btnRows } : undefined,
            });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("model command", error));
        }
    }

    /** User tapped a provider button → show its models */
    private async handleModelListProvider(ctx: Context, providerID: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const client = this.opencodeService.createClientForUser(userId);

            const providerResp = await client.provider.list();
            const provData = (providerResp as any)?.data ?? providerResp;
            const allProviders: any[] = provData?.all ?? [];
            const connected: string[] = provData?.connected ?? [];

            const provider = allProviders.find(p => p.id === providerID);
            if (!provider) {
                await ctx.reply(`❌ Provider not found: <code>${escapeHtml(providerID)}</code>`, { parse_mode: "HTML" });
                return;
            }

            const models: Array<{ id: string; name: string; status?: string }> = Object.values(provider.models ?? {});
            // Filter out deprecated, sort by name
            const active = models
                .filter(m => m.status !== "deprecated")
                .sort((a, b) => a.name.localeCompare(b.name));

            if (active.length === 0) {
                await ctx.reply(`⚠️ No active models found for ${escapeHtml(provider.name)}.`);
                return;
            }

            const isConnected = connected.includes(providerID);
            const header = `🤖 <b>${escapeHtml(provider.name)} models</b>${isConnected ? " ✅" : " (not authenticated)"}\n\nTap to select:`;

            // Show up to 20 models as buttons (2 per row)
            const displayed = active.slice(0, 20);
            const btnRows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < displayed.length; i += 2) {
                const row = displayed.slice(i, i + 2).map(m => {
                    // callback_data: ms:<providerID>/<modelID>  — keep under 64 bytes
                    const cbData = `ms:${providerID}/${m.id}`;
                    const label = m.name.substring(0, 22);
                    return { text: label, callback_data: cbData.substring(0, 64) };
                });
                btnRows.push(row);
            }

            if (active.length > 20) {
                btnRows.push([{ text: `… ${active.length - 20} more — use /model <id>`, callback_data: "pg_noop" }]);
            }

            await ctx.editMessageText(header, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: btnRows },
            });
        } catch (error) {
            console.error("handleModelListProvider error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("list models", error));
        }
    }

    /** User tapped a model button → set it */
    private async handleModelSelect(ctx: Context, providerModel: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;
            await this.setModel(ctx, userId, providerModel);
        } catch (error) {
            console.error("handleModelSelect error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("set model", error));
        }
    }

    /** Shared helper: call config.update to set the model */
    private async setModel(ctx: Context, userId: number, providerModel: string): Promise<void> {
        const client = this.opencodeService.createClientForUser(userId);
        try {
            await (client.config as any).update({ model: providerModel });
            const text = `✅ Model set to: <code>${escapeHtml(providerModel)}</code>`;
            // If we're in a callback query, edit the message; otherwise reply
            if (ctx.callbackQuery) {
                await ctx.editMessageText(text, { parse_mode: "HTML" });
            } else {
                const m = await ctx.reply(text, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            }
        } catch (err: any) {
            const errText = `❌ Failed to set model: ${escapeHtml(err?.message || String(err))}`;
            if (ctx.callbackQuery) {
                await ctx.editMessageText(errText, { parse_mode: "HTML" });
            } else {
                await ctx.reply(errText, { parse_mode: "HTML" });
            }
        }
    }

    // ─────────────────────────────────────────────
    // Message & prompt handling
    // ─────────────────────────────────────────────

    private async handleMessageAsPrompt(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                // Try to restore last active session from persistent storage
                const restored = await this.opencodeService.restoreLastSession(userId);
                if (restored) {
                    await ctx.reply(
                        `✅ Restored session: <b>${escapeHtml(restored.session.title || restored.sessionId)}</b>\nAgent: ${restored.currentAgent} | Verbosity: ${restored.verbosity} | Stream: ${restored.stream ? "on" : "off"}\nUse /history to see recent messages`,
                        { parse_mode: "HTML" }
                    );
                    // Store chatId so background session notifications work too.
                    if (ctx.chat?.id && ctx.message?.message_id) {
                        this.opencodeService.updateSessionContext(userId, ctx.chat.id, ctx.message.message_id);
                    }
                    // Resume SSE event stream so responses come back to Telegram.
                    // After a bot restart the stream is gone — restart it now.
                    // Use waitForConnect=true so we await the connection before
                    // falling through to sendPromptToOpenCode; otherwise the prompt
                    // fires before the stream is ready and the AI reply events are missed.
                    if (!this.opencodeService.hasEventStream(userId)) {
                        await this.opencodeService.startEventStream(userId, ctx, true);
                    }
                } else {
                    await ctx.reply("❌ No active OpenCode session. Use /opencode to start a session first.");
                    return;
                }
            }

            let promptText = ctx.message?.text?.trim() || "";
            if (!promptText) return;

            if (promptText.startsWith("//")) {
                promptText = promptText.substring(1);
            }

            const pendingQuestion = getPendingQuestion(userId);
            if (pendingQuestion) {
                pendingQuestionAnswers.delete(userId);
                try {
                    const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
                    const res = await fetch(`${baseUrl}/question/${pendingQuestion.callId}/reply`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ answers: [[promptText]] }),
                    });
                    if (res.ok) {
                        await ctx.reply(`✅ Answer sent: <b>${escapeHtml(promptText)}</b>`, { parse_mode: "HTML" });
                    } else {
                        await ctx.reply("❌ Failed to send answer");
                    }
                } catch {
                    await ctx.reply("❌ Failed to send answer");
                }
                return;
            }

            // Fallback: if this session has an active unanswered question (question message
            // was displayed but user never tapped a button — e.g. inline keyboard wasn't
            // rendered on their client), treat any free-text input as a custom answer.
            // This unblocks the AI session without requiring button interaction.
            const userSession = this.opencodeService.getUserSession(userId);
            if (userSession?.sessionId) {
                const activeQ = getActiveQuestionCallId(userSession.sessionId);
                if (activeQ) {
                    try {
                        const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
                        const res = await fetch(`${baseUrl}/question/${activeQ.callID}/reply`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ answers: [[promptText]] }),
                        });
                        if (res.ok) {
                            resetQuestionState(userSession.sessionId);
                            await ctx.reply(`✅ Answer sent: <b>${escapeHtml(promptText)}</b>`, { parse_mode: "HTML" });
                        } else {
                            // Question reply failed (already answered / expired) — fall through to normal prompt
                            resetQuestionState(userSession.sessionId);
                            await this.sendPromptToOpenCode(ctx, userId, promptText);
                        }
                    } catch {
                        resetQuestionState(userSession.sessionId);
                        await ctx.reply("❌ Failed to send answer");
                    }
                    return;
                }
            }

            if (promptText.startsWith("/")) {
                const spaceIndex = promptText.indexOf(" ");
                const commandName = spaceIndex > 0 ? promptText.substring(1, spaceIndex) : promptText.substring(1);
                const commandArgs = spaceIndex > 0 ? promptText.substring(spaceIndex + 1).trim() : "";
                if (commandName) {
                    await this.sendCommandToOpenCode(ctx, userId, commandName, commandArgs, promptText);
                }
            } else {
                const fmService = this.getFileMentionService(userId);
                const mentions = fmService.parseMentions(promptText);
                if (mentions.length > 0 && fmService.isEnabled()) {
                    await this.handlePromptWithMentions(ctx, userId, promptText, mentions, fmService);
                } else {
                    await this.sendPromptToOpenCode(ctx, userId, promptText);
                }
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
        }
    }

    /** Return a FileMentionService configured with the user's active server credentials. */
    private getFileMentionService(userId: number): FileMentionService {
        const server = this.serverRegistry.getActive(userId);
        if (server?.username && server?.password) {
            return new FileMentionService(server.url, undefined, server.username, server.password);
        }
        // Fall back to shared instance (uses env URL / no auth)
        return this.fileMentionService;
    }

    private async handlePromptWithMentions(ctx: Context, userId: number, promptText: string, mentions: any[], fmService?: FileMentionService): Promise<void> {
        try {
            const svc = fmService ?? this.getFileMentionService(userId);
            const searchMessage = await this.fileMentionUI.showSearching(ctx, mentions.length);
            const matches = await svc.searchMentions(mentions);
            await ctx.api.deleteMessage(searchMessage.chat.id, searchMessage.message_id).catch(() => { });
            const selectedFiles = await this.fileMentionUI.confirmAllMatches(ctx, matches);
            if (!selectedFiles) { await ctx.reply("❌ File selection cancelled"); return; }
            const resolved = await svc.resolveMentions(mentions, selectedFiles, true);
            const fileContext = svc.formatForPrompt(resolved);
            await this.sendPromptToOpenCode(ctx, userId, promptText, fileContext);
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("process file mentions", error));
        }
    }

    private async sendCommandToOpenCode(ctx: Context, userId: number, command: string, args: string, fullText: string): Promise<void> {
        try {
            const session = this.opencodeService.getUserSession(userId);
            if (ctx.chat?.id && session) {
                startTypingIndicator(session.sessionId, ctx.api, ctx.chat.id);
            }
            const resolved = await this.opencodeService.sendCommand(userId, command, args);
            if (!resolved) {
                await this.sendPromptToOpenCode(ctx, userId, fullText);
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("execute command", error));
        }
    }

    private async sendPromptToOpenCode(ctx: Context, userId: number, promptText: string, fileContext?: string): Promise<void> {
        try {
            const session = this.opencodeService.getUserSession(userId);
            if (ctx.chat?.id && session) {
                startTypingIndicator(session.sessionId, ctx.api, ctx.chat.id);
            }
            await this.opencodeService.sendPrompt(userId, promptText, fileContext);
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
        }
    }

    // ─────────────────────────────────────────────
    // ESC / TAB / Buttons
    // ─────────────────────────────────────────────

    private async handleEsc(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ No active OpenCode session. Use /opencode to start one.");
                return;
            }

            const session = this.opencodeService.getUserSession(userId);
            if (session) stopTypingIndicator(session.sessionId);
            const success = await this.opencodeService.abortSession(userId);

            if (success) {
                await ctx.reply("⏹️ Current operation aborted successfully.");
            } else {
                await ctx.reply("⚠️ Failed to abort operation. Please try again.");
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("abort OpenCode operation", error));
        }
    }

    private async handleTab(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ No active OpenCode session. Use /opencode to start one.");
                return;
            }

            const result = await this.opencodeService.cycleToNextAgent(userId);
            if (result.success && result.currentAgent) {
                const message = await ctx.reply(`⇥ <b>${result.currentAgent}</b>`, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                const errorMsg = await ctx.reply("⚠️ Failed to cycle agent. Please try again.");
                await MessageUtils.scheduleMessageDeletion(ctx, errorMsg.message_id, this.configService.getMessageDeleteTimeout());
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("handle TAB", error));
        }
    }

    private async handleEscButton(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            await this.handleEsc(ctx);
        } catch (error) {
            await ctx.answerCallbackQuery("Error handling ESC");
        }
    }

    private async handleTabButton(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            await this.handleTab(ctx);
        } catch (error) {
            await ctx.answerCallbackQuery("Error handling TAB");
        }
    }

    // ─────────────────────────────────────────────
    // Permission & Question callbacks
    // ─────────────────────────────────────────────

    private async handlePermissionResponse(ctx: Context, shortId: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const cbData = getPermissionCallback(shortId);
            if (!cbData) {
                await ctx.editMessageText("❌ Permission expired. Please try again.");
                return;
            }

            const { permissionID, reply } = cbData;
            const userId = ctx.from?.id;
            const client = userId
                ? this.opencodeService.createClientForUser(userId)
                : createOpencodeClient({ baseUrl: process.env.OPENCODE_SERVER_URL || "http://localhost:4096" });

            await client.permission.reply({
                requestID: permissionID,
                reply: reply as "once" | "always" | "reject",
            });

            const labels: Record<string, string> = {
                once: "✅ Allowed (once)",
                always: "✅ Allowed (always)",
                reject: "❌ Denied",
            };

            await ctx.editMessageText(
                `${ctx.callbackQuery?.message?.text || "Permission"}\n\n${labels[reply]}`,
                { parse_mode: "HTML" }
            );
        } catch (error) {
            console.error("Error handling permission response:", error);
            try { await ctx.editMessageText("❌ Failed to respond to permission request"); } catch { }
        }
    }

    private async handleQuestionResponse(ctx: Context, shortId: string): Promise<void> {
        const userId = ctx.from?.id;
        const userSession = userId ? this.opencodeService.getUserSession(userId) : undefined;
        const sid = userSession?.sessionId || "";

        try {
            await ctx.answerCallbackQuery();
            const cbData = getQuestionCallback(shortId);
            if (!cbData) {
                await ctx.editMessageText("❌ Question expired. Please try again.");
                resetQuestionState(cbData?.sessionID || sid);
                return;
            }

            const { sessionID, callID, qIdx, action, label } = cbData;
            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

            if (action === "skip") {
                const res = await fetch(`${baseUrl}/question/${callID}/reject`, { method: "POST" });
                if (!res.ok) console.log("Question reject failed:", res.status);
                await ctx.editMessageText("⏭ Question skipped");
                resetQuestionState(sessionID);
                return;
            }

            if (action === "custom") {
                await ctx.editMessageText(
                    `${ctx.callbackQuery?.message?.text || ""}\n\n✍️ Type your answer and send it as a message.`,
                    { parse_mode: "HTML" }
                );
                if (userId) setPendingQuestion(userId, callID, qIdx);
                resetQuestionState(sessionID);
                return;
            }

            const selectedLabel = label || `Option ${parseInt(action, 10) + 1}`;
            const res = await fetch(`${baseUrl}/question/${callID}/reply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ answers: [[selectedLabel]] }),
            });
            if (!res.ok) console.log("Question reply failed:", res.status, await res.text());

            await ctx.editMessageText(
                `${ctx.callbackQuery?.message?.text || ""}\n\n✅ Selected: <b>${escapeHtml(selectedLabel)}</b>`,
                { parse_mode: "HTML" }
            );
            resetQuestionState(sessionID);
        } catch (error) {
            console.error("Error handling question response:", error);
            try { await ctx.editMessageText("❌ Failed to respond to question"); } catch { }
            resetQuestionState(sid);
        }
    }

    // ─────────────────────────────────────────────
    // Rename, Projects, Undo/Redo, Verbosity
    // ─────────────────────────────────────────────

    private async handleRename(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No active session. Use /opencode to start one first.");
                return;
            }

            const text = ctx.message?.text || "";
            const newTitle = text.replace("/rename", "").trim();

            if (!newTitle) {
                await ctx.reply("❌ Please provide a new title.\n\nUsage: /rename <new title>");
                return;
            }

            const result = await this.opencodeService.updateSessionTitle(userId, newTitle);
            if (result.success) {
                const message = await ctx.reply(`✅ Session renamed to: <b>${escapeHtml(newTitle)}</b>`, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                await ctx.reply(`❌ ${result.message || "Failed to rename session"}`);
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("rename session", error));
        }
    }

    private async handleProjects(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const projects = await this.opencodeService.getProjects(userId);

            if (projects.length === 0) {
                const message = await ctx.reply("📂 No projects found");
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const projectList = projects.map((project, index) => `${index + 1}. ${project.worktree}`).join("\n");
            const message = await ctx.reply(`📂 <b>Available Projects:</b>\n\n${projectList}`, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list projects", error));
        }
    }

    private async handleUndo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const result = await this.opencodeService.undoLastMessage(userId);
            if (result.success) {
                const message = await ctx.reply("↩️ <b>Undone</b> - Last message reverted", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                const message = await ctx.reply(`❌ ${result.message || "Failed to undo last message"}`);
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("undo", error));
        }
    }

    private async handleRedo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const result = await this.opencodeService.redoLastMessage(userId);
            if (result.success) {
                const message = await ctx.reply("↪️ <b>Redone</b> - Change restored", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                const message = await ctx.reply(`❌ ${result.message || "Failed to redo last message"}`);
                await MessageUtils.scheduleMessageDeletion(ctx, message.message_id, this.configService.getMessageDeleteTimeout());
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("redo", error));
        }
    }

    private async handleVerbosity(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const userSession = this.opencodeService.getUserSession(userId);
        if (!userSession) {
            await ctx.reply("❌ No active session. Use /opencode first.");
            return;
        }

        const text = ctx.message?.text || "";
        const args = text.replace("/verbosity", "").trim().split(/\s+/);

        if (args[0] === "" || args[0] === undefined) {
            const levels = [
                "0 = quiet (final text only)",
                "1 = normal (+ tool names, thinking indicator)",
                "2 = verbose (+ tool args, persistent indicators)",
                "3 = debug (+ tool output, full detail)",
            ];
            const msg = [
                `📊 <b>Verbosity:</b> ${userSession.verbosity}`,
                `📡 <b>Stream:</b> ${userSession.stream ? "on" : "off"}`,
                "",
                `<b>Levels:</b>`,
                ...levels,
                "",
                `Usage: /verbosity [0-3] [stream:0/1]`,
            ].join("\n");
            const m = await ctx.reply(msg, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            return;
        }

        const level = parseInt(args[0], 10);
        if (isNaN(level) || level < 0 || level > 3) {
            await ctx.reply("❌ Level must be 0-3");
            return;
        }

        userSession.verbosity = level as 0 | 1 | 2 | 3;
        if (args[1] !== undefined) {
            userSession.stream = args[1] === "1";
        }

        const m = await ctx.reply(
            `✅ Verbosity: <b>${userSession.verbosity}</b> | Stream: <b>${userSession.stream ? "on" : "off"}</b>`,
            { parse_mode: "HTML" }
        );
        await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
    }

    // ─────────────────────────────────────────────
    // TTS toggle command
    // ─────────────────────────────────────────────

    private async handleTts(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        if (!this.voiceProvider) {
            await ctx.reply(
                "❌ Voice features are not available.\n\nPlease set <code>OPENAI_API_KEY</code> in your environment to enable TTS/STT.",
                { parse_mode: "HTML" }
            );
            return;
        }

        const userSession = this.opencodeService.getUserSession(userId);
        if (!userSession) {
            await ctx.reply("❌ No active session. Use /opencode to start one.");
            return;
        }

        const arg = ctx.match?.toString().trim().toLowerCase();
        if (arg === "on") {
            userSession.ttsEnabled = true;
        } else if (arg === "off") {
            userSession.ttsEnabled = false;
        } else {
            // Toggle
            userSession.ttsEnabled = !userSession.ttsEnabled;
        }

        const status = userSession.ttsEnabled ? "✅ TTS <b>enabled</b>" : "🔇 TTS <b>disabled</b>";
        const hint = userSession.ttsEnabled
            ? "\n\nAI replies will be sent as voice messages."
            : "\n\nAI replies will be sent as text.";

        const m = await ctx.reply(`${status}${hint}`, { parse_mode: "HTML" });
        await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
    }

    // ─────────────────────────────────────────────
    // File upload
    // ─────────────────────────────────────────────

    private async handleFileUpload(ctx: Context): Promise<void> {
        try {
            const message = ctx.message;
            if (!message) return;

            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            // Restore last session on first interaction after restart (same as text messages)
            if (!this.opencodeService.hasActiveSession(userId)) {
                const restored = await this.opencodeService.restoreLastSession(userId);
                if (restored) {
                    if (ctx.chat?.id) {
                        this.opencodeService.updateSessionContext(userId, ctx.chat.id, ctx.message?.message_id ?? 0);
                    }
                    if (!this.opencodeService.hasEventStream(userId)) {
                        await this.opencodeService.startEventStream(userId, ctx, true);
                    }
                }
            }

            let fileId: string | undefined;
            let fileName: string | undefined;
            let fileType = "file";
            let isAudioType = false;
            let audioMimeType = "audio/ogg";

            if (message.document) {
                fileId = message.document.file_id;
                fileName = message.document.file_name || `document_${Date.now()}`;
                fileType = "document";
            } else if (message.photo && message.photo.length > 0) {
                const photo = message.photo[message.photo.length - 1];
                fileId = photo.file_id;
                fileName = `photo_${Date.now()}.jpg`;
                fileType = "photo";
            } else if (message.video) {
                fileId = message.video.file_id;
                fileName = message.video.file_name || `video_${Date.now()}.mp4`;
                fileType = "video";
            } else if (message.audio) {
                fileId = message.audio.file_id;
                fileName = message.audio.file_name || `audio_${Date.now()}.mp3`;
                fileType = "audio";
                isAudioType = true;
                audioMimeType = message.audio.mime_type || "audio/mpeg";
            } else if (message.voice) {
                fileId = message.voice.file_id;
                fileName = `voice_${Date.now()}.ogg`;
                fileType = "voice";
                isAudioType = true;
                audioMimeType = "audio/ogg";
            } else if (message.video_note) {
                fileId = message.video_note.file_id;
                fileName = `video_note_${Date.now()}.mp4`;
                fileType = "video_note";
            }

            if (!fileId || !fileName) {
                await ctx.reply("❌ Unable to process this file type");
                return;
            }

            const file = await ctx.api.getFile(fileId);
            if (!file.file_path) { await ctx.reply("❌ Unable to get file path from Telegram"); return; }

            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            if (!response.ok) { await ctx.reply("❌ Failed to download file from Telegram"); return; }

            const buffer = Buffer.from(await response.arrayBuffer());

            // ── STT path: transcribe voice/audio if voice provider is available ──
            if (isAudioType && this.voiceProvider) {

                await ctx.replyWithChatAction("typing");
                try {
                    const transcript = await this.voiceProvider.transcribe(buffer, { mimeType: audioMimeType });

                    if (!transcript.trim()) {
                        const m = await ctx.reply("🔇 Could not transcribe audio — please try again or send text.");
                        await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                        return;
                    }

                    console.log(`✓ STT transcribed: "${transcript.slice(0, 80)}..." (${fileType}, ${buffer.length} bytes)`);

                    // Check if there's a pending question awaiting a custom answer
                    const pendingQuestion = getPendingQuestion(userId);
                    if (pendingQuestion) {
                        pendingQuestionAnswers.delete(userId);
                        try {
                            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
                            const res = await fetch(`${baseUrl}/question/${pendingQuestion.callId}/reply`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ answers: [[transcript]] }),
                            });
                            if (res.ok) {
                                await ctx.reply(`✅ Answer sent: <b>${escapeHtml(transcript)}</b>`, { parse_mode: "HTML" });
                            } else {
                                await ctx.reply("❌ Failed to send answer");
                            }
                        } catch {
                            await ctx.reply("❌ Failed to send answer");
                        }
                        return;
                    }

                    if (this.opencodeService.hasActiveSession(userId)) {
                        const caption = message.caption?.trim();
                        const promptText = caption
                            ? `${transcript}\n\n${caption}`
                            : transcript;
                        await this.sendPromptToOpenCode(ctx, userId, promptText);
                    } else {
                        // No active session — show transcript so user can use it
                        const m = await ctx.reply(
                            `🎙 <b>Transcript:</b>\n\n${escapeHtml(transcript)}\n\n<i>No active session. Use /opencode to start one, then send your voice message.</i>`,
                            { parse_mode: "HTML" }
                        );
                        await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout() * 3);
                    }
                } catch (err) {
                    console.error("STT transcription error:", err);
                    const m = await ctx.reply(
                        `❌ <b>Transcription failed:</b> ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
                        { parse_mode: "HTML" }
                    );
                    await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                }
                return;
            }

            // ── Non-audio path: save to disk and forward file path ──
            const saveDir = this.configService.getMediaTmpLocation();
            if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

            const savePath = path.join(saveDir, fileName);
            fs.writeFileSync(savePath, buffer);

            const confirmMessage = await ctx.reply(
                `✅ <b>File saved!</b>\n\nPath: <code>${savePath}</code>\n\nTap the path to copy it.`,
                { parse_mode: "HTML" }
            );
            await MessageUtils.scheduleMessageDeletion(ctx, confirmMessage.message_id, this.configService.getMessageDeleteTimeout());
            console.log(`✓ File saved: ${savePath} (${fileType}, ${buffer.length} bytes)`);

            // Always forward uploaded files to the agent (with or without caption)
            if (this.opencodeService.hasActiveSession(userId)) {
                const caption = message.caption?.trim();
                const promptText = caption
                    ? `[Attached file: ${savePath}]\n\n${caption}`
                    : `[Attached file: ${savePath}]`;
                await this.sendPromptToOpenCode(ctx, userId, promptText);
            }
        } catch (error) {
            console.error("Error handling file upload:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("save file", error));
        }
    }
}
