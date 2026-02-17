import { Bot, Context, InputFile } from "grammy";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCodeService } from "./opencode.service.js";
import { ConfigService } from "../../services/config.service.js";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { MessageUtils } from "../../utils/message.utils.js";
import { ErrorUtils } from "../../utils/error.utils.js";
import { formatAsHtml, escapeHtml, startTypingIndicator, stopTypingIndicator } from "./event-handlers/utils.js";
import { FileMentionService, FileMentionUI } from "../file-mentions/index.js";
import { resetQuestionState, getQuestionCallback } from "./event-handlers/message-part-updated/tool-part.handler.js";
import { getPermissionCallback } from "./event-handlers/permission.updated.handler.js";
import * as fs from "fs";
import * as path from "path";

// Track pending custom question answers: userId -> { callId, qIdx }
const pendingQuestionAnswers = new Map<number, { callId: string; qIdx: number }>();

export class OpenCodeBot {
    private opencodeService: OpenCodeService;
    private configService: ConfigService;
    private fileMentionService: FileMentionService;
    private fileMentionUI: FileMentionUI;

    constructor(
        opencodeService: OpenCodeService,
        configService: ConfigService
    ) {
        this.opencodeService = opencodeService;
        this.configService = configService;
        this.fileMentionService = new FileMentionService();
        this.fileMentionUI = new FileMentionUI();
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
        bot.command("undo", AccessControlMiddleware.requireAccess, this.handleUndo.bind(this));
        bot.command("redo", AccessControlMiddleware.requireAccess, this.handleRedo.bind(this));
        bot.command("verbosity", AccessControlMiddleware.requireAccess, this.handleVerbosity.bind(this));
        
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

    private async handleStart(ctx: Context): Promise<void> {
        try {
            const helpMessage = [
                '👋 <b>Welcome to TelegramCoder!</b>',
                '',
                '🎯 <b>Session Commands:</b>',
                '/opencode [title] - Start a new OpenCode AI session',
                '   Example: /opencode Fix login bug',
                '/rename &lt;title&gt; - Rename your current session',
                '   Example: /rename Updated task name',
                '/endsession - End and close your current session',
                '/sessions - View your recent sessions (last 5)',
                '/projects - List available projects',
                '',
                '⚡️ <b>Control Commands:</b>',
                '/esc - Abort the current AI operation',
                '/undo - Revert the last message/change',
                '/redo - Restore a previously undone change',
                '/verbosity [0-3] [0/1] - Set detail level &amp; streaming',
                '⇥ TAB button - Cycle between agents (build ↔ plan)',
                '⏹️ ESC button - Same as /esc command',
                '',
                '📋 <b>Information Commands:</b>',
                '/start - Show this help message',
                '/help - Show this help message',
                '/sessions - View recent sessions with IDs',
                '/projects - List available projects',
                '',
                '💬 <b>How to Use:</b>',
                '1. Start: /opencode My Project',
                '2. Chat: Just send messages directly (no /prompt needed)',
                '3. Upload: Send any file - it saves to /tmp/telegramCoder',
                '4. Control: Use ESC/TAB buttons on session message',
                '5. Rename: /rename New Name (anytime during session)',
                '6. Undo/Redo: /undo or /redo to manage changes',
                '7. End: /endsession when done',
                '',
                '🤖 <b>Agents Available:</b>',
                '• <b>build</b> - Implements code and makes changes',
                '• <b>plan</b> - Plans and analyzes without editing',
                '• Use TAB button to switch between agents',
                '',
                '💡 <b>Tips:</b>',
                '• This help message stays - reference it anytime!',
                '• Send files - they\'re saved to /tmp/telegramCoder',
                '• Tap the file path to copy it to clipboard',
                '• Session messages auto-delete after 10 seconds',
                '• Tab between build/plan agents as needed',
                '• Use descriptive titles for better organization',
                '• All messages go directly to the AI',
                '• Use /undo if AI makes unwanted changes',
                '• Streaming responses limited to last 50 lines',
                '',
                '🚀 <b>Get started:</b> /opencode'
            ].join('\n');

            await ctx.reply(helpMessage, { parse_mode: "HTML" });
            
            // Help message should not auto-delete - users may want to reference it
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage('show help message', error));
        }
    }

    private async handleOpenCode(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Check if user already has an active session
            if (this.opencodeService.hasActiveSession(userId)) {
                const message = await ctx.reply("✅ Session already started", {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "⏹️ ESC", callback_data: "esc" },
                                { text: "⇥ TAB", callback_data: "tab" }
                            ]
                        ]
                    }
                });
                
                // Schedule auto-deletion
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
                return;
            }

            // Extract title from command text (everything after /opencode)
            const text = ctx.message?.text || "";
            const title = text.replace("/opencode", "").trim() || undefined;

            // Create a new session
            const statusMessage = await ctx.reply("🔄 Starting OpenCode session...");

            try {
                // Try to create session with optional title
                const userSession = await this.opencodeService.createSession(userId, title);

                const successMessage = await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMessage.message_id,
                    "✅ Session started",
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "⏹️ ESC", callback_data: "esc" },
                                    { text: "⇥ TAB", callback_data: "tab" }
                                ]
                            ]
                        }
                    }
                );

                // Schedule auto-deletion of the session started message
                const messageId = (typeof successMessage === "object" && successMessage && "message_id" in successMessage) ? (successMessage as any).message_id : statusMessage.message_id;
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    messageId,
                    this.configService.getMessageDeleteTimeout()
                );

                // Store chat context and start event streaming
                this.opencodeService.updateSessionContext(userId, ctx.chat!.id, messageId);

                // Start event streaming in background
                this.opencodeService.startEventStream(userId, ctx).catch(error => {
                    console.error("Event stream error:", error);
                });
            } catch (error) {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMessage.message_id,
                    ErrorUtils.createErrorMessage("start OpenCode session", error)
                );
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("start OpenCode session", error));
        }
    }

    private async handleMessageAsPrompt(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Check if user has an active session
            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No active OpenCode session. Use /opencode to start a session first.");
                return;
            }

            let promptText = ctx.message?.text?.trim() || "";

            if (!promptText) {
                return;
            }

            if (promptText.startsWith("//")) {
                promptText = promptText.substring(1);
            }

            // Check if this is a custom answer to a pending question
            const pendingQuestion = pendingQuestionAnswers.get(userId);
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
                } catch (error) {
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

    private async handlePromptWithMentions(
        ctx: Context,
        userId: number,
        promptText: string,
        mentions: any[]
    ): Promise<void> {
        try {
            // Show searching indicator
            const searchMessage = await this.fileMentionUI.showSearching(ctx, mentions.length);
            
            // Search for files
            const matches = await this.fileMentionService.searchMentions(mentions);
            
            // Delete searching message
            await ctx.api.deleteMessage(searchMessage.chat.id, searchMessage.message_id).catch(() => {});
            
            // Get user confirmation for file selections
            const selectedFiles = await this.fileMentionUI.confirmAllMatches(ctx, matches);
            
            if (!selectedFiles) {
                await ctx.reply("❌ File selection cancelled");
                return;
            }
            
            // Resolve files and get content
            const resolved = await this.fileMentionService.resolveMentions(
                mentions,
                selectedFiles,
                true
            );
            
            // Format file context
            const fileContext = this.fileMentionService.formatForPrompt(resolved);
            
            // Send prompt with file context
            await this.sendPromptToOpenCode(ctx, userId, promptText, fileContext);
            
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("process file mentions", error));
        }
    }

    private async sendCommandToOpenCode(ctx: Context, userId: number, command: string, args: string, fullText: string): Promise<void> {
        try {
            if (ctx.chat?.id) {
                startTypingIndicator(ctx.api, ctx.chat.id);
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
            if (ctx.chat?.id) {
                startTypingIndicator(ctx.api, ctx.chat.id);
            }
            await this.opencodeService.sendPrompt(userId, promptText, fileContext);
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
        }
    }



    private splitIntoChunks(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxLength) {
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                currentChunk = line;
            } else {
                if (currentChunk) {
                    currentChunk += "\n" + line;
                } else {
                    currentChunk = line;
                }
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    private async handleEndSession(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ You don't have an active OpenCode session. Use /opencode to start one.");
                return;
            }

            const success = await this.opencodeService.deleteSession(userId);

            if (success) {
                const sentMessage = await ctx.reply("✅ OpenCode session ended successfully.");
                const deleteTimeout = this.configService.getMessageDeleteTimeout();
                if (deleteTimeout > 0 && sentMessage) {
                    await MessageUtils.scheduleMessageDeletion(
                        ctx,
                        sentMessage.message_id,
                        deleteTimeout
                    );
                }
            } else {
                await ctx.reply("⚠️ Failed to end session. It may have already been closed.");
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("end OpenCode session", error));
        }
    }

    private async handleEsc(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ You don't have an active OpenCode session. Use /opencode to start one.");
                return;
            }

            stopTypingIndicator();
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
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ You don't have an active OpenCode session. Use /opencode to start one.");
                return;
            }

            try {
                // Cycle to next agent
                const result = await this.opencodeService.cycleToNextAgent(userId);

                if (result.success && result.currentAgent) {
                    // Show simple agent name message
                    const message = await ctx.reply(`⇥ <b>${result.currentAgent}</b>`, { parse_mode: "HTML" });
                    
                    // Schedule auto-deletion
                    await MessageUtils.scheduleMessageDeletion(
                        ctx,
                        message.message_id,
                        this.configService.getMessageDeleteTimeout()
                    );
                } else {
                    const errorMsg = await ctx.reply("⚠️ Failed to cycle agent. Please try again.");
                    await MessageUtils.scheduleMessageDeletion(
                        ctx,
                        errorMsg.message_id,
                        this.configService.getMessageDeleteTimeout()
                    );
                }
            } catch (error) {
                const errorMsg = await ctx.reply(ErrorUtils.createErrorMessage("cycle agent", error));
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    errorMsg.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("handle TAB", error));
        }
    }

    private async handleEscButton(ctx: Context): Promise<void> {
        try {
            // Answer the callback query to remove loading state
            await ctx.answerCallbackQuery();
            
            // Call the same handler as the ESC command/keyboard
            await this.handleEsc(ctx);
        } catch (error) {
            await ctx.answerCallbackQuery("Error handling ESC");
            console.error("Error in handleEscButton:", error);
        }
    }

    private async handleTabButton(ctx: Context): Promise<void> {
        try {
            // Answer the callback query to remove loading state
            await ctx.answerCallbackQuery();
            
            // Call the same handler as the TAB keyboard
            await this.handleTab(ctx);
        } catch (error) {
            await ctx.answerCallbackQuery("Error handling TAB");
            console.error("Error in handleTabButton:", error);
        }
    }

    private async handlePermissionResponse(ctx: Context, shortId: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            // Look up the short ID from the callback map
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

            // Update the message to show the result and remove buttons
            await ctx.editMessageText(
                `${ctx.callbackQuery?.message?.text || "Permission"}\n\n${labels[reply]}`,
                { parse_mode: "HTML" }
            );
        } catch (error) {
            console.error("Error handling permission response:", error);
            try {
                await ctx.editMessageText("❌ Failed to respond to permission request");
            } catch {}
        }
    }

    private async handleQuestionResponse(ctx: Context, shortId: string): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            // Look up the short ID from the callback map
            const cbData = getQuestionCallback(shortId);
            if (!cbData) {
                await ctx.editMessageText("❌ Question expired. Please try again.");
                resetQuestionState();
                return;
            }

            const { sessionID, callID, qIdx, action, label } = cbData;
            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

            if (action === "skip") {
                const res = await fetch(`${baseUrl}/question/${callID}/reject`, { method: "POST" });
                if (!res.ok) {
                    console.log("Question reject failed:", res.status);
                }
                await ctx.editMessageText("⏭ Question skipped");
                resetQuestionState();
                return;
            }

            if (action === "custom") {
                await ctx.editMessageText(
                    `${ctx.callbackQuery?.message?.text || ""}\n\n✍️ Type your answer and send it as a message.`,
                    { parse_mode: "HTML" }
                );
                const userId = ctx.from?.id;
                if (userId) {
                    pendingQuestionAnswers.set(userId, { callId: callID, qIdx });
                }
                resetQuestionState();
                return;
            }

            // Regular option selected — use the label stored in the callback map
            const selectedLabel = label || `Option ${parseInt(action, 10) + 1}`;

            const res = await fetch(`${baseUrl}/question/${callID}/reply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ answers: [[selectedLabel]] }),
            });

            if (!res.ok) {
                console.log("Question reply failed:", res.status, await res.text());
            }

            await ctx.editMessageText(
                `${ctx.callbackQuery?.message?.text || ""}\n\n✅ Selected: <b>${escapeHtml(selectedLabel)}</b>`,
                { parse_mode: "HTML" }
            );
            resetQuestionState();
        } catch (error) {
            console.error("Error handling question response:", error);
            try {
                await ctx.editMessageText("❌ Failed to respond to question");
            } catch {}
            resetQuestionState();
        }
    }

    private async handleRename(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Check if user has an active session
            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No active session. Use /opencode to start one first.");
                return;
            }

            // Extract new title from command text
            const text = ctx.message?.text || "";
            const newTitle = text.replace("/rename", "").trim();

            if (!newTitle) {
                await ctx.reply("❌ Please provide a new title.\n\nUsage: /rename <new title>");
                return;
            }

            // Update the session title
            const result = await this.opencodeService.updateSessionTitle(userId, newTitle);

            if (result.success) {
                const message = await ctx.reply(`✅ Session renamed to: <b>${newTitle}</b>`, { parse_mode: "HTML" });
                
                // Schedule auto-deletion
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            } else {
                await ctx.reply(`❌ ${result.message || "Failed to rename session"}`);
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("rename session", error));
        }
    }

    private async handleProjects(ctx: Context): Promise<void> {
        try {
            const projects = await this.opencodeService.getProjects();

            if (projects.length === 0) {
                const message = await ctx.reply("📂 No projects found");
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
                return;
            }

            // Format as numbered list
            const projectList = projects
                .map((project, index) => `${index + 1}. ${project.worktree}`)
                .join("\n");

            const message = await ctx.reply(`📂 <b>Available Projects:</b>\n\n${projectList}`, {
                parse_mode: "HTML"
            });

            // Schedule auto-deletion
            await MessageUtils.scheduleMessageDeletion(
                ctx,
                message.message_id,
                this.configService.getMessageDeleteTimeout()
            );
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list projects", error));
        }
    }

    private async handleSessions(ctx: Context): Promise<void> {
        try {
            const sessions = await this.opencodeService.getSessions(5);

            if (sessions.length === 0) {
                const message = await ctx.reply("💬 No sessions found");
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
                return;
            }

            // Format sessions with title and short ID
            const sessionList = sessions
                .map((session, index) => {
                    const shortId = session.id.substring(0, 8);
                    const title = session.title || "Untitled";
                    const date = new Date(session.updated * 1000).toLocaleString();
                    return `${index + 1}. <b>${title}</b>\n   ID: <code>${shortId}</code>\n   Updated: ${date}`;
                })
                .join("\n\n");

            const message = await ctx.reply(`💬 <b>Recent Sessions (Last 5):</b>\n\n${sessionList}`, {
                parse_mode: "HTML"
            });

            // Schedule auto-deletion
            await MessageUtils.scheduleMessageDeletion(
                ctx,
                message.message_id,
                this.configService.getMessageDeleteTimeout()
            );
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list sessions", error));
        }
    }

    private async handleUndo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const result = await this.opencodeService.undoLastMessage(userId);

            if (result.success) {
                const message = await ctx.reply("↩️ <b>Undone</b> - Last message reverted", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            } else {
                const errorMsg = result.message || "Failed to undo last message";
                const message = await ctx.reply(`❌ ${errorMsg}`);
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
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
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            } else {
                const errorMsg = result.message || "Failed to redo last message";
                const message = await ctx.reply(`❌ ${errorMsg}`);
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
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

    private async handleFileUpload(ctx: Context): Promise<void> {
        try {
            const message = ctx.message;
            if (!message) return;

            let fileId: string | undefined;
            let fileName: string | undefined;
            let fileType: string = "file";

            // Extract file info based on message type
            if (message.document) {
                fileId = message.document.file_id;
                fileName = message.document.file_name || `document_${Date.now()}`;
                fileType = "document";
            } else if (message.photo && message.photo.length > 0) {
                // Get the largest photo
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

            // Get file from Telegram
            const file = await ctx.api.getFile(fileId);
            if (!file.file_path) {
                await ctx.reply("❌ Unable to get file path from Telegram");
                return;
            }

            // Download file
            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            
            if (!response.ok) {
                await ctx.reply("❌ Failed to download file from Telegram");
                return;
            }

            // Ensure directory exists (create if needed)
            const saveDir = "/tmp/telegramCoder";
            if (!fs.existsSync(saveDir)) {
                console.log(`Creating directory: ${saveDir}`);
                fs.mkdirSync(saveDir, { recursive: true });
                console.log(`✓ Directory created: ${saveDir}`);
            }

            // Save file
            const savePath = path.join(saveDir, fileName);
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(savePath, buffer);

            // Send confirmation with clickable filename
            const confirmMessage = await ctx.reply(
                `✅ <b>File saved!</b>\n\nPath: <code>${savePath}</code>\n\nTap the path to copy it.`,
                { parse_mode: "HTML" }
            );

            // Auto-delete after configured timeout
            await MessageUtils.scheduleMessageDeletion(
                ctx,
                confirmMessage.message_id,
                this.configService.getMessageDeleteTimeout()
            );

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
