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
import { resetQuestionState, getQuestionCallback } from "./event-handlers/message-part-updated/tool-part.handler.js";
import { getPermissionCallback } from "./event-handlers/permission.updated.handler.js";
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
    const diff = Math.floor(Date.now() / 1000) - ts;
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

        // Handle keyboard button presses
        bot.hears("⏹️ ESC", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.hears("⇥ TAB", AccessControlMiddleware.requireAccess, this.handleTab.bind(this));

        // Handle inline button callbacks
        bot.callbackQuery("esc", AccessControlMiddleware.requireAccess, this.handleEscButton.bind(this));
        bot.callbackQuery("tab", AccessControlMiddleware.requireAccess, this.handleTabButton.bind(this));

        // Handle permission response buttons (short IDs like p0, p1, p2, ...)
        // Handle question response buttons (short IDs like q0, q1, q2, ...)
        bot.on("callback_query:data", AccessControlMiddleware.requireAccess, async (ctx) => {
            const data = ctx.callbackQuery.data;
            if (/^p\d+$/.test(data)) {
                await this.handlePermissionResponse(ctx, data);
            } else if (/^q\d+$/.test(data)) {
                await this.handleQuestionResponse(ctx, data);
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
                '/endsession - End current session (auto-switches to next if available)',
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

    private async handleSessions(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const text = ctx.message?.text || "";
            const showAll = text.includes("--all");
            const limit = showAll ? 9999 : 10;

            const userState = this.opencodeService.getUserState(userId);
            const serverSessions = await this.opencodeService.getSessions(userId, limit);

            if (serverSessions.length === 0) {
                const m = await ctx.reply("💬 No sessions found. Use /opencode to start one.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const activeServer = this.serverRegistry.getActive(userId);
            const serverName = activeServer?.name ?? "Unknown";

            const attachedIds = new Set(userState?.sessions.keys() ?? []);
            const activeId = userState?.activeSessionId;

            const lines = serverSessions.map(s => {
                let flag: string;
                if (s.id === activeId) flag = "●";
                else if (attachedIds.has(s.id)) flag = "○";
                else flag = "·";

                const attached = userState?.sessions.get(s.id);
                let statusIcon = "";
                if (attached) {
                    statusIcon = attached.serverStatus === "busy" ? " ⚡busy"
                        : attached.serverStatus === "error" ? " ❌error"
                            : " ✅idle";
                }

                const shortId = s.id.substring(0, 8);
                const title = escapeHtml(s.title || "Untitled").substring(0, 30);
                const agent = attached?.currentAgent ? ` ${attached.currentAgent}` : "";
                const time = timeAgo(s.updated);
                return `${flag} <code>${shortId}</code>  <b>${title}</b>${escapeHtml(agent)}  ${time}${statusIcon}`;
            });

            const attachedCount = attachedIds.size;
            const header = `💬 <b>Sessions — ${escapeHtml(serverName)}</b> (${attachedCount} attached)\n\n`;
            const legend = `\n● active  ○ attached  · history only\n/session &lt;id&gt; to switch`;

            const fullText = header + lines.join("\n") + legend;

            // Send as file if too long
            if (fullText.length > 3800) {
                const plain = serverSessions.map(s => {
                    const flag = s.id === activeId ? "●" : attachedIds.has(s.id) ? "○" : "·";
                    return `${flag} ${s.id.substring(0, 8)}  ${s.title || "Untitled"}  ${timeAgo(s.updated)}`;
                }).join("\n");
                const buf = Buffer.from(plain, "utf-8");
                const m = await ctx.replyWithDocument(new InputFile(buf, "sessions.txt"));
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                const m = await ctx.reply(fullText, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
            }
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
                const session = this.opencodeService.getUserSession(userId)!;
                const m = await ctx.reply(
                    `✅ Switched to: <b>${escapeHtml(session.session.title || "Untitled")}</b>\n` +
                    `Agent: ${escapeHtml(session.currentAgent || "build")} | Verbosity: ${session.verbosity} | Stream: ${session.stream ? "on" : "off"}\n` +
                    `Last active: ${timeAgo(session.session.time.updated)}\n` +
                    `Use /history to see recent messages`,
                    { parse_mode: "HTML" }
                );
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
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
                const m = await ctx.reply(
                    `✅ Attached to: <b>${escapeHtml(result.session.session.title || "Untitled")}</b>\n` +
                    `Agent: ${escapeHtml(result.session.currentAgent || "build")} | Verbosity: ${result.session.verbosity}\n` +
                    `Last active: ${timeAgo(result.session.session.time.updated)}\n` +
                    `Use /history to see recent messages`,
                    { parse_mode: "HTML" }
                );
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
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

            const history = await this.opencodeService.getSessionHistory(userId, n);

            if (history.length === 0) {
                const m = await ctx.reply("📜 No messages yet in this session.");
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const session = this.opencodeService.getUserSession(userId)!;
            const title = escapeHtml(session.session.title || "Untitled");
            const lines = history.map(msg => {
                const prefix = msg.role === "user" ? "[You]" : "[AI] ";
                const t = new Date(msg.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                return `<b>${prefix}</b> <i>${t}</i>\n${escapeHtml(msg.text)}`;
            });

            const fullText = `📜 <b>Last ${history.length} messages — ${title}</b>\n\n${lines.join("\n\n")}`;

            if (fullText.length > 3800) {
                const plain = history.map(m =>
                    `[${m.role === "user" ? "You" : "AI"}] ${new Date(m.time * 1000).toLocaleTimeString()}\n${m.text}`
                ).join("\n\n");
                const buf = Buffer.from(plain, "utf-8");
                const sent = await ctx.replyWithDocument(new InputFile(buf, "history.txt"));
                await MessageUtils.scheduleMessageDeletion(ctx, sent.message_id, this.configService.getMessageDeleteTimeout());
            } else {
                const m = await ctx.reply(fullText, { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
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
                let msg = "✅ OpenCode session ended.";
                if (result.switchedTo) {
                    const title = escapeHtml(result.switchedTo.session.title || result.switchedTo.sessionId.substring(0, 8));
                    msg += ` Switched to: <b>${title}</b>`;
                } else {
                    msg += " Use /opencode to start a new session.";
                }
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

    private async handleServers(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            const servers = this.serverRegistry.listByUserWithDefaults(userId);

            if (servers.length === 0) {
                const m = await ctx.reply("🖥️ No servers configured. Use /server add &lt;url&gt; [name]", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
                return;
            }

            const lines = servers.map(s => {
                const flag = s.isActive ? "●" : "·";
                return `${flag} <code>${s.id}</code>  <b>${escapeHtml(s.name)}</b>\n   ${escapeHtml(s.url)}`;
            });

            const msg = `🖥️ <b>Servers (${servers.length})</b>\n\n${lines.join("\n\n")}\n\n● active\n/server use &lt;id&gt; to switch\n/server add &lt;url&gt; [name] to add`;
            const m = await ctx.reply(msg, { parse_mode: "HTML" });
            await MessageUtils.scheduleMessageDeletion(ctx, m.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list servers", error));
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
                    "/server add &lt;url&gt; [name] — add server\n" +
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
            await ctx.reply("❌ Usage: /server add &lt;url&gt; [name]", { parse_mode: "HTML" });
            return;
        }

        // Parse "url name with spaces" or just "url"
        const spaceIdx = args.indexOf(" ");
        const url = spaceIdx > 0 ? args.substring(0, spaceIdx).trim() : args.trim();
        const name = spaceIdx > 0 ? args.substring(spaceIdx + 1).trim() : undefined;

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

        const record = this.serverRegistry.add(userId, url, name);
        const m = await ctx.reply(
            `✅ Server added: <b>${escapeHtml(record.name)}</b>\nURL: ${escapeHtml(record.url)}\nID: <code>${record.id}</code>`,
            { parse_mode: "HTML" }
        );
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
    // Message & prompt handling
    // ─────────────────────────────────────────────

    private async handleMessageAsPrompt(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) { await ctx.reply("❌ Unable to identify user"); return; }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No active OpenCode session. Use /opencode to start a session first.");
                return;
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

            if (promptText.startsWith("/")) {
                const spaceIndex = promptText.indexOf(" ");
                const commandName = spaceIndex > 0 ? promptText.substring(1, spaceIndex) : promptText.substring(1);
                const commandArgs = spaceIndex > 0 ? promptText.substring(spaceIndex + 1).trim() : "";
                if (commandName) {
                    await this.sendCommandToOpenCode(ctx, userId, commandName, commandArgs, promptText);
                }
            } else {
                const mentions = this.fileMentionService.parseMentions(promptText);
                if (mentions.length > 0 && this.fileMentionService.isEnabled()) {
                    await this.handlePromptWithMentions(ctx, userId, promptText, mentions);
                } else {
                    await this.sendPromptToOpenCode(ctx, userId, promptText);
                }
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
        }
    }

    private async handlePromptWithMentions(ctx: Context, userId: number, promptText: string, mentions: any[]): Promise<void> {
        try {
            const searchMessage = await this.fileMentionUI.showSearching(ctx, mentions.length);
            const matches = await this.fileMentionService.searchMentions(mentions);
            await ctx.api.deleteMessage(searchMessage.chat.id, searchMessage.message_id).catch(() => { });
            const selectedFiles = await this.fileMentionUI.confirmAllMatches(ctx, matches);
            if (!selectedFiles) { await ctx.reply("❌ File selection cancelled"); return; }
            const resolved = await this.fileMentionService.resolveMentions(mentions, selectedFiles, true);
            const fileContext = this.fileMentionService.formatForPrompt(resolved);
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
            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
            const client = createOpencodeClient({ baseUrl });

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
    // File upload
    // ─────────────────────────────────────────────

    private async handleFileUpload(ctx: Context): Promise<void> {
        try {
            const message = ctx.message;
            if (!message) return;

            let fileId: string | undefined;
            let fileName: string | undefined;
            let fileType = "file";

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
            } else if (message.voice) {
                fileId = message.voice.file_id;
                fileName = `voice_${Date.now()}.ogg`;
                fileType = "voice";
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

            const saveDir = this.configService.getMediaTmpLocation();
            if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

            const savePath = path.join(saveDir, fileName);
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(savePath, buffer);

            const confirmMessage = await ctx.reply(
                `✅ <b>File saved!</b>\n\nPath: <code>${savePath}</code>\n\nTap the path to copy it.`,
                { parse_mode: "HTML" }
            );
            await MessageUtils.scheduleMessageDeletion(ctx, confirmMessage.message_id, this.configService.getMessageDeleteTimeout());
            console.log(`✓ File saved: ${savePath} (${fileType}, ${buffer.length} bytes)`);

            const caption = message.caption?.trim();
            if (caption) {
                const userId = ctx.from?.id;
                if (!userId) return;
                if (!this.opencodeService.hasActiveSession(userId)) {
                    await ctx.reply("❌ No active OpenCode session. Use /opencode to start a session first.");
                    return;
                }
                const promptText = `[Attached file: ${savePath}]\n\n${caption}`;
                await this.sendPromptToOpenCode(ctx, userId, promptText);
            }
        } catch (error) {
            console.error("Error handling file upload:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("save file", error));
        }
    }
}
