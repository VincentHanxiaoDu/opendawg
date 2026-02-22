import {
    Client,
    type Interaction,
    type Message,
    type ChatInputCommandInteraction,
    type ButtonInteraction,
    type ModalSubmitInteraction,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    AttachmentBuilder,
    REST,
    Routes,
    GatewayIntentBits,
    Events,
} from "discord.js";
import { OpenCodeService, setMessageDeleteTimeout } from "./opencode.service.js";
import { ConfigService } from "../../services/config.service.js";
import { ServerRegistry } from "../../services/server-registry.service.js";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { MessageUtils } from "../../utils/message.utils.js";
import { ErrorUtils } from "../../utils/error.utils.js";
import { escapeMarkdown, startTypingIndicator, stopTypingIndicator, resolveChannel } from "./event-handlers/utils.js";
import { getPermissionData, clearPermissionData, getQuestionData, clearQuestionData } from "./opencode.event-handlers.js";
import {
    buildPageButtons, parsePageCallback, parseJumpCallback,
    setPendingJump, consumePendingJump,
    totalPages, getPageSlice, PAGE_SIZE,
} from "../../utils/pagination.js";
import { createVoiceProvider, splitForTts, type VoiceProvider } from "../../services/voice.service.js";
import { setVoiceProvider as setIdleVoiceProvider, setVoiceConnectionsRef } from "./opencode.event-handlers.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function timeAgo(ts: number): string {
    const tsSeconds = ts > 1e10 ? Math.floor(ts / 1000) : ts;
    const diff = Math.floor(Date.now() / 1000) - tsSeconds;
    if (diff < 0) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

export class DiscordBot {
    private opencodeService: OpenCodeService;
    private configService: ConfigService;
    private serverRegistry: ServerRegistry;
    private voiceProvider: VoiceProvider | null = null;
    /** guildId → VoiceConnection (dynamic import, typed as any to avoid hard dep at compile time) */
    private voiceConnections: Map<string, any> = new Map();

    constructor(
        opencodeService: OpenCodeService,
        configService: ConfigService,
        serverRegistry: ServerRegistry
    ) {
        this.opencodeService = opencodeService;
        this.configService = configService;
        this.serverRegistry = serverRegistry;

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
                });
                // Register with event handlers for TTS delivery
                setIdleVoiceProvider(this.voiceProvider);
                setVoiceConnectionsRef(this.voiceConnections);
                console.log(`[Voice] Provider initialized: ${configService.getVoiceProvider()}`);
            } catch (err) {
                console.warn(`[Voice] Failed to initialize voice provider: ${err instanceof Error ? err.message : err}`);
            }
        }
    }

    /**
     * Build the slash command definitions for registration.
     */
    getSlashCommands(): any[] {
        return [
            new SlashCommandBuilder().setName('help').setDescription('Show help message'),
            new SlashCommandBuilder().setName('opencode').setDescription('Start a new OpenCode session')
                .addStringOption(opt => opt.setName('title').setDescription('Session title').setRequired(false)),
            new SlashCommandBuilder().setName('sessions').setDescription('List sessions with status flags'),
            new SlashCommandBuilder().setName('session').setDescription('Switch to or attach a session')
                .addStringOption(opt => opt.setName('id').setDescription('Session ID or prefix').setRequired(false)),
            new SlashCommandBuilder().setName('detach').setDescription('Detach from current session'),
            new SlashCommandBuilder().setName('endsession').setDescription('End current session'),
            new SlashCommandBuilder().setName('rename').setDescription('Rename current session')
                .addStringOption(opt => opt.setName('title').setDescription('New session title').setRequired(true)),
            new SlashCommandBuilder().setName('esc').setDescription('Abort current AI operation'),
            new SlashCommandBuilder().setName('history').setDescription('Show recent messages in current session')
                .addIntegerOption(opt => opt.setName('count').setDescription('Number of messages (1-20)').setRequired(false)),
            new SlashCommandBuilder().setName('undo').setDescription('Undo the last message'),
            new SlashCommandBuilder().setName('redo').setDescription('Redo a previously undone message'),
            new SlashCommandBuilder().setName('verbosity').setDescription('Set detail level and streaming')
                .addIntegerOption(opt => opt.setName('level').setDescription('Verbosity level (0-3)').setRequired(false)
                    .addChoices({ name: '0 - Minimal', value: 0 }, { name: '1 - Normal', value: 1 }, { name: '2 - Detailed', value: 2 }, { name: '3 - Full', value: 3 }))
                .addBooleanOption(opt => opt.setName('stream').setDescription('Enable streaming mode').setRequired(false)),
            new SlashCommandBuilder().setName('servers').setDescription('List configured opencode servers'),
            new SlashCommandBuilder().setName('server').setDescription('Manage servers')
                .addSubcommand(sub => sub.setName('add').setDescription('Add a server')
                    .addStringOption(opt => opt.setName('url').setDescription('Server URL').setRequired(true))
                    .addStringOption(opt => opt.setName('name').setDescription('Server name').setRequired(false))
                    .addStringOption(opt => opt.setName('username').setDescription('HTTP Basic Auth username (OPENCODE_SERVER_USERNAME)').setRequired(false))
                    .addStringOption(opt => opt.setName('password').setDescription('HTTP Basic Auth password (OPENCODE_SERVER_PASSWORD)').setRequired(false)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Remove a server')
                    .addStringOption(opt => opt.setName('id').setDescription('Server ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('use').setDescription('Switch active server')
                    .addStringOption(opt => opt.setName('id').setDescription('Server ID').setRequired(true))),
            new SlashCommandBuilder().setName('status').setDescription('Show full status'),
            new SlashCommandBuilder().setName('tts').setDescription('Toggle AI voice replies on or off (requires OPENAI_API_KEY)')
                .addStringOption(opt => opt
                    .setName('mode')
                    .setDescription('Enable or disable TTS voice replies')
                    .setRequired(false)
                    .addChoices(
                        { name: 'on  — AI replies as voice messages', value: 'on' },
                        { name: 'off — AI replies as text (default)', value: 'off' },
                    )),
            new SlashCommandBuilder().setName('join-voice').setDescription('Join your current voice channel and enable real-time speech input'),
            new SlashCommandBuilder().setName('leave-voice').setDescription('Leave the voice channel and stop listening'),
        ].map(cmd => cmd.toJSON());
    }

    /**
     * Register all event handlers on the Discord client.
     */
    registerHandlers(client: Client): void {
        client.on(Events.InteractionCreate, async (interaction: Interaction) => {
            try {
                if (interaction.isChatInputCommand()) {
                    await this.handleSlashCommand(interaction);
                } else if (interaction.isButton()) {
                    await this.handleButtonInteraction(interaction);
                } else if (interaction.isModalSubmit()) {
                    await this.handleModalSubmit(interaction);
                }
            } catch (error) {
                console.error("Interaction handler error:", error);
            }
        });

        // Handle plain text messages as prompts
        client.on(Events.MessageCreate, async (message: Message) => {
            if (message.author.bot) return;
            if (!message.content && message.attachments.size === 0) return;

            const userId = message.author.id;

            // Access control
            if (!AccessControlMiddleware.isAllowed(userId)) {
                await AccessControlMiddleware.checkAccess(userId, undefined, message);
                return;
            }

            // Handle file uploads
            if (message.attachments.size > 0) {
                await this.handleFileUpload(message);
                return;
            }

            // Handle text messages
            await this.handleMessageAsPrompt(message);
        });
    }

    // ─── Slash command dispatcher ────────────────────────────────────────────

    private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        // Access control
        const allowed = await AccessControlMiddleware.checkAccess(userId, interaction);
        if (!allowed) return;

        const cmd = interaction.commandName;

        switch (cmd) {
            case 'help': await this.handleHelp(interaction); break;
            case 'opencode': await this.handleOpenCode(interaction); break;
            case 'sessions': await this.handleSessions(interaction); break;
            case 'session': await this.handleSession(interaction); break;
            case 'detach': await this.handleDetach(interaction); break;
            case 'endsession': await this.handleEndSession(interaction); break;
            case 'rename': await this.handleRename(interaction); break;
            case 'esc': await this.handleEsc(interaction); break;
            case 'history': await this.handleHistory(interaction); break;
            case 'undo': await this.handleUndo(interaction); break;
            case 'redo': await this.handleRedo(interaction); break;
            case 'verbosity': await this.handleVerbosity(interaction); break;
            case 'servers': await this.handleServers(interaction); break;
            case 'server': await this.handleServer(interaction); break;
            case 'status': await this.handleStatus(interaction); break;
            case 'tts': await this.handleTts(interaction); break;
            case 'join-voice': await this.handleJoinVoice(interaction); break;
            case 'leave-voice': await this.handleLeaveVoice(interaction); break;
            default:
                await interaction.reply({ content: `Unknown command: ${cmd}`, ephemeral: true });
        }
    }

    // ─── Help ────────────────────────────────────────────────────────────────

    private async handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
        const helpMessage = [
            '**Welcome to DiscordCoder!**',
            '',
            '**Session Commands:**',
            '`/opencode [title]` - Start a new OpenCode AI session',
            '`/sessions` - List sessions with status flags',
            '`/session <id>` - Switch to or attach a session',
            '`/history [count]` - Show recent messages',
            '`/detach` - Detach from current session',
            '`/rename <title>` - Rename current session',
            '`/endsession` - End and delete current session',
            '',
            '**Server Commands:**',
            '`/servers` - List configured servers',
            '`/server add <url> [name]` - Add a server',
            '`/server remove <id>` - Remove a server',
            '`/server use <id>` - Switch active server',
            '',
            '**Control Commands:**',
            '`/esc` - Abort the current AI operation',
            '`/undo` - Revert the last message',
            '`/redo` - Restore a previously undone change',
            '`/verbosity [0-3] [stream]` - Set detail level & streaming',
            '`/status` - Show full status',
            '',
            '**How to Use:**',
            '1. Start: `/opencode My Project`',
            '2. Chat: Just send messages directly',
            '3. Switch: `/sessions` then `/session <id>`',
            '4. End: `/endsession` when done',
        ].join('\n');

        await interaction.reply({ content: helpMessage, ephemeral: true });
    }

    // ─── Session management ──────────────────────────────────────────────────

    private async handleOpenCode(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        const title = interaction.options.getString('title') || undefined;

        await interaction.deferReply();

        try {
            const existingActive = this.opencodeService.getUserSession(userId);
            const userSession = await this.opencodeService.createSession(userId, title);

            const prevNote = existingActive ? '\nPrevious session moved to background.' : '';

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('esc').setLabel('ESC').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('tab').setLabel('TAB').setStyle(ButtonStyle.Secondary),
            );

            const reply = await interaction.editReply({
                content: `Session started: **${userSession.session.title || "Untitled"}**${prevNote}`,
                components: [row],
            });

            this.opencodeService.updateSessionContext(userId, interaction.channelId, reply.id);
            this.opencodeService.startEventStream(userId, interaction.client).catch(error => {
                console.error("Event stream error:", error);
            });
        } catch (error) {
            await interaction.editReply(ErrorUtils.createErrorMessage("start OpenCode session", error));
        }
    }

    private async handleSessions(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        await interaction.deferReply({ ephemeral: true });

        try {
            const result = await this.buildSessionsPage(userId, 0);
            if (!result) {
                await interaction.editReply('No sessions found. Use `/opencode` to start one.');
                return;
            }

            await interaction.editReply({
                content: result.text,
                components: result.components,
            });
        } catch (error) {
            await interaction.editReply(ErrorUtils.createErrorMessage("list sessions", error));
        }
    }

    private async buildSessionsPage(
        userId: string,
        page: number,
    ): Promise<{ text: string; components: any[] } | null> {
        const userState = this.opencodeService.getUserState(userId);
        const allServerSessions = await this.opencodeService.getSessions(userId, 9999);

        if (allServerSessions.length === 0) return null;

        const activeServer = this.serverRegistry.getActive(userId);
        const serverName = activeServer?.name ?? "Unknown";
        const attachedIds = new Set(userState?.sessions.keys() ?? []);
        const activeId = userState?.activeSessionId;
        const allIds = allServerSessions.map(s => s.id);

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
        const switchButtons: ButtonBuilder[] = [];

        pageItems.forEach((s, idx) => {
            const flag = s.id === activeId ? "●" : attachedIds.has(s.id) ? "○" : "·";
            const attached = userState?.sessions.get(s.id);
            const statusIcon = attached
                ? (attached.serverStatus === "busy" ? "⚡" : attached.serverStatus === "error" ? "❌" : "✅")
                : "";
            const shortId = uniquePrefix(s.id);
            const title = (s.title || "Untitled").substring(0, 28);
            const agent = attached?.currentAgent ? ` ${attached.currentAgent}` : "";
            const time = timeAgo(s.updated);
            const lineNum = safePage * PAGE_SIZE + idx + 1;
            lines.push(`${lineNum}. ${flag} \`${shortId}\`  **${title}**${agent}  ${time}${statusIcon ? " " + statusIcon : ""}`);

            const btnLabel = (s.title || "Untitled").substring(0, 18) + (s.id === activeId ? " ●" : "");
            switchButtons.push(
                new ButtonBuilder()
                    .setCustomId(`sw:${shortId}`)
                    .setLabel(btnLabel)
                    .setStyle(s.id === activeId ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        });

        const header = `**Sessions — ${serverName}** (${allServerSessions.length} total, ${attachedIds.size} attached)\n\n`;
        const legend = `\n● active  ○ attached  · history`;
        const text = header + lines.join("\n") + legend;

        const components: any[] = [];
        // Session switch buttons (max 5 per row)
        for (let i = 0; i < switchButtons.length; i += 5) {
            components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...switchButtons.slice(i, i + 5)));
        }
        // Pagination row
        const pageRow = buildPageButtons("sessions", safePage, nPages);
        if (pageRow && components.length < 5) components.push(pageRow);

        return { text, components };
    }

    private async handleSession(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        const sessionIdArg = interaction.options.getString('id') || '';

        await interaction.deferReply({ ephemeral: true });

        try {
            if (!sessionIdArg) {
                const session = this.opencodeService.getUserSession(userId);
                if (!session) {
                    await interaction.editReply('No active session. Use `/sessions` to list, or `/opencode` to start one.');
                    return;
                }
                await interaction.editReply(
                    `**Current session:** ${session.session.title || "Untitled"}\n` +
                    `ID: \`${session.sessionId.substring(0, 8)}\`\n` +
                    `Agent: ${session.currentAgent || "build"} | Verbosity: ${session.verbosity} | Stream: ${session.stream ? "on" : "off"}\n` +
                    `Last active: ${timeAgo(session.session.time.updated)}`
                );
                return;
            }

            if (sessionIdArg.length < 4) {
                await interaction.editReply('Session ID must be at least 4 characters.');
                return;
            }

            // Check if already attached
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
                this.opencodeService.switchSession(userId, targetSessionId);
                if (!this.opencodeService.hasEventStream(userId)) {
                    this.opencodeService.startEventStream(userId, interaction.client).catch(e => console.error("Event stream error:", e));
                }
                this.opencodeService.updateSessionContext(userId, interaction.channelId);
                const session = this.opencodeService.getUserSession(userId)!;
                await interaction.editReply(
                    `Switched to: **${session.session.title || "Untitled"}**\n` +
                    `Agent: ${session.currentAgent || "build"} | Verbosity: ${session.verbosity}\n` +
                    `Use \`/history\` to see recent messages`
                );
                return;
            }

            // Attach from server
            try {
                const result = await this.opencodeService.attachSession(userId, sessionIdArg);
                if (!result) {
                    await interaction.editReply(`Session not found: \`${sessionIdArg}\``);
                    return;
                }

                this.opencodeService.switchSession(userId, result.session.sessionId);
                if (!this.opencodeService.hasEventStream(userId)) {
                    this.opencodeService.startEventStream(userId, interaction.client).catch(e => console.error("Event stream error:", e));
                }
                this.opencodeService.updateSessionContext(userId, interaction.channelId);
                await interaction.editReply(
                    `Attached to: **${result.session.session.title || "Untitled"}**\n` +
                    `Agent: ${result.session.currentAgent || "build"} | Verbosity: ${result.session.verbosity}\n` +
                    `Use \`/history\` to see recent messages`
                );
            } catch (err: any) {
                if (err?.message === "AMBIGUOUS" && err?.matches) {
                    const matchList = (err.matches as string[]).map((id: string) => `\`${id.substring(0, 8)}\``).join(", ");
                    await interaction.editReply(`Multiple sessions match: ${matchList}\nPlease provide more characters.`);
                } else {
                    throw err;
                }
            }
        } catch (error) {
            await interaction.editReply(ErrorUtils.createErrorMessage("switch session", error));
        }
    }

    private async handleDetach(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        const detached = this.opencodeService.detachSession(userId);
        if (!detached) {
            await interaction.reply({ content: 'No active session to detach from.', ephemeral: true });
            return;
        }

        const title = detached.session.title || detached.sessionId.substring(0, 8);
        await interaction.reply({ content: `Detached from **${title}**. Session remains in background.\nUse \`/sessions\` to manage.`, ephemeral: true });
    }

    private async handleEndSession(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        if (!this.opencodeService.hasActiveSession(userId)) {
            await interaction.reply({ content: 'No active session. Use `/opencode` to start one.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const result = await this.opencodeService.deleteSession(userId);
        if (result.success) {
            await interaction.editReply('Session ended. Use `/opencode` to start a new session or `/sessions` to attach an existing one.');
        } else {
            await interaction.editReply('Failed to end session. It may have already been closed.');
        }
    }

    private async handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        const newTitle = interaction.options.getString('title', true);

        if (!this.opencodeService.hasActiveSession(userId)) {
            await interaction.reply({ content: 'No active session to rename.', ephemeral: true });
            return;
        }

        const result = await this.opencodeService.updateSessionTitle(userId, newTitle);
        if (result.success) {
            await interaction.reply({ content: `Session renamed to: **${newTitle}**`, ephemeral: true });
        } else {
            await interaction.reply({ content: result.message || 'Failed to rename session.', ephemeral: true });
        }
    }

    private async handleEsc(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        if (!this.opencodeService.hasActiveSession(userId)) {
            await interaction.reply({ content: 'No active session.', ephemeral: true });
            return;
        }

        const success = await this.opencodeService.abortSession(userId);
        await interaction.reply({ content: success ? 'Operation aborted.' : 'Failed to abort.', ephemeral: true });
    }

    private async handleHistory(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        if (!this.opencodeService.hasActiveSession(userId)) {
            await interaction.reply({ content: 'No active session.', ephemeral: true });
            return;
        }

        const count = interaction.options.getInteger('count') ?? 5;
        const n = Math.min(Math.max(1, count), 20);

        await interaction.deferReply({ ephemeral: true });

        const history = await this.opencodeService.getSessionHistory(userId, n);

        if (history.length === 0) {
            await interaction.editReply('No messages yet in this session.');
            return;
        }

        const session = this.opencodeService.getUserSession(userId)!;
        const title = session.session.title || "Untitled";

        // Send header as the deferred reply
        await interaction.editReply(`**📜 Last ${history.length} messages — ${title}**`);

        // Replay each message individually as follow-ups
        for (const msg of history) {
            const prefix = msg.role === "user" ? "👤 **You**" : "🤖 **AI**";
            const t = new Date(msg.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const msgText = `${prefix} *${t}*\n${msg.text}`;

            if (msgText.length > 1900) {
                const buf = Buffer.from(`[${msg.role === "user" ? "You" : "AI"}] ${new Date(msg.time * 1000).toLocaleTimeString()}\n${msg.text}`, "utf-8");
                const attachment = new AttachmentBuilder(buf, { name: `msg_${t.replace(":", "-")}.txt` });
                await interaction.followUp({ files: [attachment], ephemeral: true });
            } else {
                await interaction.followUp({ content: msgText, ephemeral: true });
            }
        }
    }

    private async handleUndo(interaction: ChatInputCommandInteraction): Promise<void> {
        const result = await this.opencodeService.undoLastMessage(interaction.user.id);
        await interaction.reply({ content: result.success ? 'Undone.' : (result.message || 'Failed to undo.'), ephemeral: true });
    }

    private async handleRedo(interaction: ChatInputCommandInteraction): Promise<void> {
        const result = await this.opencodeService.redoLastMessage(interaction.user.id);
        await interaction.reply({ content: result.success ? 'Redone.' : (result.message || 'Failed to redo.'), ephemeral: true });
    }

    private async handleVerbosity(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        const session = this.opencodeService.getUserSession(userId);

        if (!session) {
            await interaction.reply({ content: 'No active session.', ephemeral: true });
            return;
        }

        const level = interaction.options.getInteger('level');
        const streamOpt = interaction.options.getBoolean('stream');

        if (level !== null) {
            session.verbosity = Math.max(0, Math.min(3, level)) as any;
        }
        if (streamOpt !== null) {
            session.stream = streamOpt;
        }

        await interaction.reply({
            content: `Verbosity: **${session.verbosity}** | Stream: **${session.stream ? "on" : "off"}**`,
            ephemeral: true,
        });
    }

    // ─── Server management ───────────────────────────────────────────────────

    private async handleServers(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        const result = this.buildServersPage(userId, 0);
        if (!result) {
            await interaction.reply({ content: 'No servers configured. Use `/server add <url> [name]`', ephemeral: true });
            return;
        }

        await interaction.reply({
            content: result.text,
            components: result.components,
            ephemeral: true,
        });
    }

    private buildServersPage(
        userId: string,
        page: number,
    ): { text: string; components: any[] } | null {
        const servers = this.serverRegistry.listByUserWithDefaults(userId);
        if (servers.length === 0) return null;

        const nPages = totalPages(servers.length);
        const safePage = Math.max(0, Math.min(page, nPages - 1));
        const pageItems = getPageSlice(servers, safePage);

        const lines: string[] = [];
        const useButtons: ButtonBuilder[] = [];

        pageItems.forEach((s, idx) => {
            const flag = s.isActive ? "●" : "·";
            const authBadge = s.username ? " 🔐" : "";
            const lineNum = safePage * PAGE_SIZE + idx + 1;
            lines.push(`${lineNum}. ${flag} \`${s.id}\`  **${s.name}**${authBadge}\n   ${s.url}`);
            const btnLabel = (s.isActive ? "● " : "↩ ") + s.name.substring(0, 20);
            useButtons.push(
                new ButtonBuilder()
                    .setCustomId(`su:${s.id}`)
                    .setLabel(btnLabel)
                    .setStyle(s.isActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        });

        const text = `**Servers (${servers.length})**\n\n${lines.join("\n\n")}\n\n● active  🔐 auth configured\n\`/server add <url> [name] [username] [password]\` to add`;

        const components: any[] = [];
        for (let i = 0; i < useButtons.length; i += 5) {
            components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...useButtons.slice(i, i + 5)));
        }
        const pageRow = buildPageButtons("servers", safePage, nPages);
        if (pageRow && components.length < 5) components.push(pageRow);

        return { text, components };
    }

    private async handleServer(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        const subCmd = interaction.options.getSubcommand();

        switch (subCmd) {
            case 'add': {
                const url = interaction.options.getString('url', true);
                const name = interaction.options.getString('name') || undefined;
                const username = interaction.options.getString('username') || undefined;
                const password = interaction.options.getString('password') || undefined;

                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    await interaction.reply({ content: 'Invalid URL. Must start with http:// or https://', ephemeral: true });
                    return;
                }

                const existing = this.serverRegistry.findByUrl(userId, url);
                if (existing) {
                    await interaction.reply({ content: `Server with this URL already exists: **${existing.name}** (\`${existing.id}\`)`, ephemeral: true });
                    return;
                }

                const record = this.serverRegistry.add(userId, url, name, false, username, password);
                let replyText = `Server added: **${record.name}**\nURL: ${record.url}\nID: \`${record.id}\``;
                if (record.username) {
                    replyText += `\n🔐 Auth: ${record.username} / ***`;
                }
                await interaction.reply({ content: replyText, ephemeral: true });
                break;
            }
            case 'remove': {
                const serverId = interaction.options.getString('id', true);
                const record = this.serverRegistry.getById(userId, serverId);
                if (!record) {
                    await interaction.reply({ content: `Server not found: \`${serverId}\``, ephemeral: true });
                    return;
                }
                if (record.isActive) {
                    await interaction.reply({ content: 'Cannot remove active server. Use `/server use <id>` to switch first.', ephemeral: true });
                    return;
                }
                this.serverRegistry.remove(userId, record.id);
                await interaction.reply({ content: `Server removed: **${record.name}**`, ephemeral: true });
                break;
            }
            case 'use': {
                const serverId = interaction.options.getString('id', true);
                const record = this.serverRegistry.getById(userId, serverId);
                if (!record) {
                    await interaction.reply({ content: `Server not found: \`${serverId}\``, ephemeral: true });
                    return;
                }
                if (record.isActive) {
                    await interaction.reply({ content: `Already using server: **${record.name}**`, ephemeral: true });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });
                await this.opencodeService.switchServer(userId, record.id, interaction.client);
                await interaction.editReply(`Switched to server: **${record.name}**\n${record.url}\nSessions cleared. Use \`/sessions\` to list available sessions.`);
                break;
            }
        }
    }

    // ─── Status ──────────────────────────────────────────────────────────────

    private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        const activeServer = this.serverRegistry.getActive(userId);
        const userState = this.opencodeService.getUserState(userId);
        const session = this.opencodeService.getUserSession(userId);
        const sseRunning = this.opencodeService.hasEventStream(userId);

        const lines: string[] = ["**Status**", ""];

        if (activeServer) {
            lines.push(`**Server:** ${activeServer.name}`);
            lines.push(`   ${activeServer.url}`);
        } else {
            lines.push(`**Server:** (default) ${process.env.OPENCODE_SERVER_URL || "http://localhost:4096"}`);
        }

        lines.push("");

        if (session) {
            const shortId = session.sessionId.substring(0, 8);
            lines.push(`**Session:** \`${shortId}\` — **${session.session.title || "Untitled"}**`);
            lines.push(`   Agent: ${session.currentAgent || "build"} | Verbosity: ${session.verbosity} | Stream: ${session.stream ? "on" : "off"}`);
            lines.push(`   Last active: ${timeAgo(session.session.time.updated)}`);
            if (session.serverStatus === "error" && session.lastError) {
                lines.push(`   Error: ${session.lastError}`);
            }
        } else {
            lines.push(`**Session:** None (use \`/opencode\` to start)`);
        }

        lines.push("");
        lines.push(`**Event stream:** ${sseRunning ? "connected" : "not running"}`);
        lines.push(`**Attached sessions:** ${userState?.sessions.size ?? 0}`);

        await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }

    // ─── Button interaction handler ──────────────────────────────────────────

    private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
        const userId = interaction.user.id;

        if (!AccessControlMiddleware.isAllowed(userId)) {
            await interaction.reply({ content: 'Access denied.', ephemeral: true });
            return;
        }

        const customId = interaction.customId;

        if (customId === 'esc') {
            const success = await this.opencodeService.abortSession(userId);
            await interaction.reply({ content: success ? 'Operation aborted.' : 'No active session.', ephemeral: true });
            return;
        }

        if (customId === 'tab') {
            const result = await this.opencodeService.cycleToNextAgent(userId);
            await interaction.reply({
                content: result.success ? `Agent: **${result.currentAgent}**` : 'No agents available.',
                ephemeral: true,
            });
            return;
        }

        if (customId === 'pg_noop') {
            await interaction.deferUpdate();
            return;
        }

        // Permission buttons: perm:<permId>:<action>
        if (customId.startsWith('perm:')) {
            await this.handlePermissionButton(interaction);
            return;
        }

        // Question buttons: q:<questionId>:<index|custom|skip>
        if (customId.startsWith('q:')) {
            await this.handleQuestionButton(interaction);
            return;
        }

        // Session switch: sw:<prefix>
        if (customId.startsWith('sw:')) {
            await this.handleSessionSwitchButton(interaction);
            return;
        }

        // Server use: su:<serverId>
        if (customId.startsWith('su:')) {
            await this.handleServerUseButton(interaction);
            return;
        }

        // Pagination
        const pageData = parsePageCallback(customId);
        if (pageData) {
            await this.handlePageTurn(interaction, pageData);
            return;
        }

        const jumpListId = parseJumpCallback(customId);
        if (jumpListId) {
            await this.handlePageJump(interaction, jumpListId);
            return;
        }

        await interaction.deferUpdate();
    }

    private async handlePermissionButton(interaction: ButtonInteraction): Promise<void> {
        const parts = interaction.customId.split(':');
        if (parts.length < 3) {
            await interaction.reply({ content: 'Invalid permission response.', ephemeral: true });
            return;
        }

        const permId = parts[1];
        const action = parts[2]; // allow, always, deny
        const sessionID = getPermissionData(permId);
        const userId = interaction.user.id;

        if (!sessionID) {
            await interaction.reply({ content: 'Permission request expired.', ephemeral: true });
            return;
        }

        const client = this.opencodeService.createClientForUser(userId);

        let allow = false;
        if (action === 'allow') allow = true;
        else if (action === 'always') allow = true;
        else if (action === 'deny') allow = false;

        try {
            const replyAction = action === 'deny' ? 'reject' : (action === 'always' ? 'always' : 'once');
            await client.permission.reply({ requestID: permId, reply: replyAction });
            clearPermissionData(permId);

            const labels: Record<string, string> = { allow: "Allowed (once)", always: "Always allowed", deny: "Denied" };
            await interaction.update({
                content: `Permission: **${labels[action] || action}**`,
                components: [],
            });
        } catch (error) {
            await interaction.reply({ content: ErrorUtils.createErrorMessage("respond to permission", error), ephemeral: true });
        }
    }

    private async handleQuestionButton(interaction: ButtonInteraction): Promise<void> {
        const parts = interaction.customId.split(':');
        if (parts.length < 3) {
            await interaction.reply({ content: 'Invalid question response.', ephemeral: true });
            return;
        }

        const questionId = parts[1];
        const indexOrAction = parts[2];
        const sessionID = getQuestionData(questionId);
        const userId = interaction.user.id;

        if (!sessionID) {
            await interaction.reply({ content: 'Question expired.', ephemeral: true });
            return;
        }

        if (indexOrAction === 'custom') {
            // Open a modal for custom answer
            const modal = new ModalBuilder()
                .setCustomId(`qmodal:${questionId}`)
                .setTitle('Custom Answer');

            const input = new TextInputBuilder()
                .setCustomId('answer')
                .setLabel('Your Answer')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
            await interaction.showModal(modal);
            return;
        }

        if (indexOrAction === 'skip') {
            // Reject/skip the question
            const baseUrl = this.opencodeService.getServerUrl(userId);
            try {
                await fetch(`${baseUrl}/question/${questionId}/reject`, { method: 'POST' });
                clearQuestionData(questionId);
                await interaction.update({ content: 'Question skipped.', components: [] });
            } catch (error) {
                await interaction.reply({ content: 'Failed to skip question.', ephemeral: true });
            }
            return;
        }

        // Numeric index — select an option
        const optionIndex = parseInt(indexOrAction, 10);
        if (isNaN(optionIndex)) {
            await interaction.reply({ content: 'Invalid selection.', ephemeral: true });
            return;
        }

        const baseUrl = this.opencodeService.getServerUrl(userId);
        try {
            await fetch(`${baseUrl}/question/${questionId}/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answer: optionIndex }),
            });
            clearQuestionData(questionId);
            await interaction.update({ content: `Selected option: **${optionIndex}**`, components: [] });
        } catch (error) {
            await interaction.reply({ content: 'Failed to answer question.', ephemeral: true });
        }
    }

    private async handleSessionSwitchButton(interaction: ButtonInteraction): Promise<void> {
        const prefix = interaction.customId.slice(3);
        const userId = interaction.user.id;

        await interaction.deferReply({ ephemeral: true });

        try {
            const userState = this.opencodeService.getUserState(userId);
            let targetSessionId: string | null = null;

            if (userState) {
                for (const [sid] of userState.sessions) {
                    if (sid === prefix || sid.startsWith(prefix)) {
                        targetSessionId = sid;
                        break;
                    }
                }
            }

            if (targetSessionId) {
                this.opencodeService.switchSession(userId, targetSessionId);
            } else {
                const result = await this.opencodeService.attachSession(userId, prefix);
                if (!result) {
                    await interaction.editReply(`Session not found: \`${prefix}\``);
                    return;
                }
                targetSessionId = result.session.sessionId;
                this.opencodeService.switchSession(userId, targetSessionId);
            }

            if (!this.opencodeService.hasEventStream(userId)) {
                this.opencodeService.startEventStream(userId, interaction.client).catch(e => console.error("Event stream error:", e));
            }
            this.opencodeService.updateSessionContext(userId, interaction.channelId!);

            const session = this.opencodeService.getUserSession(userId)!;
            await interaction.editReply(
                `Switched to: **${session.session.title || "Untitled"}**\n` +
                `Agent: ${session.currentAgent || "build"} | Verbosity: ${session.verbosity}`
            );
        } catch (error) {
            await interaction.editReply(ErrorUtils.createErrorMessage("switch session", error));
        }
    }

    private async handleServerUseButton(interaction: ButtonInteraction): Promise<void> {
        const serverId = interaction.customId.slice(3);
        const userId = interaction.user.id;

        const record = this.serverRegistry.getById(userId, serverId);
        if (!record) {
            await interaction.reply({ content: `Server not found: \`${serverId}\``, ephemeral: true });
            return;
        }

        if (record.isActive) {
            await interaction.reply({ content: `Already using server: **${record.name}**`, ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        await this.opencodeService.switchServer(userId, record.id, interaction.client);
        await interaction.editReply(`Switched to server: **${record.name}**\n${record.url}\nSessions cleared.`);
    }

    private async handlePageTurn(interaction: ButtonInteraction, pageData: { listId: string; page: number }): Promise<void> {
        const userId = interaction.user.id;
        const { listId, page } = pageData;

        let result: { text: string; components: any[] } | null = null;

        if (listId === "sessions") {
            result = await this.buildSessionsPage(userId, page);
        } else if (listId === "servers") {
            result = this.buildServersPage(userId, page);
        }

        if (!result) {
            await interaction.deferUpdate();
            return;
        }

        await interaction.update({ content: result.text, components: result.components });
    }

    private async handlePageJump(interaction: ButtonInteraction, listId: string): Promise<void> {
        const modal = new ModalBuilder()
            .setCustomId(`pgjump:${listId}`)
            .setTitle('Jump to Page');

        const input = new TextInputBuilder()
            .setCustomId('page')
            .setLabel('Page Number')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
    }

    // ─── Modal submit handler ────────────────────────────────────────────────

    private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        const userId = interaction.user.id;

        if (!AccessControlMiddleware.isAllowed(userId)) {
            await interaction.reply({ content: 'Access denied.', ephemeral: true });
            return;
        }

        const customId = interaction.customId;

        // Question custom answer: qmodal:<questionId>
        if (customId.startsWith('qmodal:')) {
            const questionId = customId.slice(7);
            const answer = interaction.fields.getTextInputValue('answer');
            const baseUrl = this.opencodeService.getServerUrl(userId);

            try {
                await fetch(`${baseUrl}/question/${questionId}/reply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ answer }),
                });
                clearQuestionData(questionId);
                await interaction.reply({ content: `Custom answer submitted.`, ephemeral: true });
            } catch (error) {
                await interaction.reply({ content: 'Failed to submit answer.', ephemeral: true });
            }
            return;
        }

        // Page jump: pgjump:<listId>
        if (customId.startsWith('pgjump:')) {
            const listId = customId.slice(7);
            const pageStr = interaction.fields.getTextInputValue('page');
            const page = parseInt(pageStr, 10) - 1;

            if (isNaN(page) || page < 0) {
                await interaction.reply({ content: 'Invalid page number.', ephemeral: true });
                return;
            }

            let result: { text: string; components: any[] } | null = null;
            if (listId === "sessions") {
                result = await this.buildSessionsPage(userId, page);
            } else if (listId === "servers") {
                result = this.buildServersPage(userId, page);
            }

            if (!result) {
                await interaction.reply({ content: 'Nothing to show.', ephemeral: true });
                return;
            }

            await interaction.reply({
                content: result.text,
                components: result.components,
                ephemeral: true,
            });
            return;
        }
    }

    // ─── Plain text message handler ──────────────────────────────────────────

    private async handleMessageAsPrompt(message: Message): Promise<void> {
        const userId = message.author.id;
        const text = message.content;

        if (!this.opencodeService.hasActiveSession(userId)) {
            await message.reply('No active session. Use `/opencode` to start one.');
            return;
        }

        // Update session context to this channel
        this.opencodeService.updateSessionContext(userId, message.channelId, message.id);

        // Ensure SSE stream is running
        if (!this.opencodeService.hasEventStream(userId)) {
            this.opencodeService.startEventStream(userId, message.client).catch(e => console.error("Event stream error:", e));
        }

        // If text starts with /, try as OpenCode command
        if (text.startsWith('/')) {
            const parts = text.substring(1).split(/\s+/);
            const cmdName = parts[0];
            const args = parts.slice(1).join(' ');

            if (cmdName) {
                const sent = await this.opencodeService.sendCommand(userId, cmdName, args);
                if (sent) return;
            }
        }

        // Send as prompt
        const channel = await resolveChannel(message.client, message.channelId);
        if (channel) {
            startTypingIndicator(`user-${userId}`, channel as any);
        }

        try {
            await this.opencodeService.sendPrompt(userId, text);
        } catch (error) {
            await message.reply(ErrorUtils.createErrorMessage("send prompt", error));
        }
    }

    // ─── File upload handler ─────────────────────────────────────────────────

    private async handleFileUpload(message: Message): Promise<void> {
        const userId = message.author.id;

        if (!this.opencodeService.hasActiveSession(userId)) {
            await message.reply('No active session. Use `/opencode` to start one first.');
            return;
        }

        this.opencodeService.updateSessionContext(userId, message.channelId, message.id);

        const mediaDir = path.join(this.configService.getMediaTmpLocation(), 'bot-1');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }

        const audioAttachments: { buffer: Buffer; mimeType: string }[] = [];
        const nonAudioPaths: string[] = [];

        for (const [, attachment] of message.attachments) {
            try {
                const response = await fetch(attachment.url);
                const buffer = Buffer.from(await response.arrayBuffer());
                const contentType = attachment.contentType ?? "";

                // Detect audio attachments for STT
                const isAudio = contentType.startsWith("audio/") ||
                    /\.(ogg|mp3|m4a|wav|aac|webm|flac)$/i.test(attachment.name ?? "");

                if (isAudio && this.voiceProvider) {
                    audioAttachments.push({ buffer, mimeType: contentType || "audio/ogg" });
                } else {
                    // Save non-audio files to disk
                    const filePath = path.join(mediaDir, attachment.name || 'upload');
                    fs.writeFileSync(filePath, buffer);
                    nonAudioPaths.push(filePath);
                }
            } catch (error) {
                await message.reply(ErrorUtils.createErrorMessage("process file upload", error));
            }
        }

        // Handle audio STT
        if (audioAttachments.length > 0 && this.voiceProvider) {
            try {
                const transcripts: string[] = [];
                for (const { buffer, mimeType } of audioAttachments) {
                    const transcript = await this.voiceProvider.transcribe(buffer, { mimeType });
                    if (transcript.trim()) transcripts.push(transcript.trim());
                }

                if (transcripts.length === 0) {
                    await message.reply("🔇 Could not transcribe audio — please try again or send text.");
                    return;
                }

                const caption = message.content?.trim() || "";
                const transcriptText = transcripts.join("\n");
                const promptText = caption ? `${transcriptText}\n\n${caption}` : transcriptText;

                await this.opencodeService.sendPrompt(userId, promptText);
            } catch (err) {
                await message.reply(`❌ Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
        }

        // Handle non-audio file uploads (original behavior)
        const caption = message.content || '';
        for (const filePath of nonAudioPaths) {
            if (caption) {
                await this.opencodeService.sendPrompt(userId, caption, `File uploaded: ${filePath}`);
            } else {
                await message.reply(`File saved: \`${filePath}\``);
            }
        }
    }

    // ─── TTS command ─────────────────────────────────────────────────────────

    private async handleTts(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;

        if (!this.voiceProvider) {
            await interaction.reply({
                content: "❌ Voice features are not available. Please set `OPENAI_API_KEY` in your environment to enable TTS/STT.",
                ephemeral: true,
            });
            return;
        }

        const userSession = this.opencodeService.getUserSession(userId);
        if (!userSession) {
            await interaction.reply({ content: "❌ No active session. Use `/opencode` to start one.", ephemeral: true });
            return;
        }

        const mode = interaction.options.getString('mode');
        if (mode === 'on') {
            userSession.ttsEnabled = true;
        } else if (mode === 'off') {
            userSession.ttsEnabled = false;
        } else {
            // No argument — toggle
            userSession.ttsEnabled = !userSession.ttsEnabled;
        }

        const status = userSession.ttsEnabled ? "✅ TTS **enabled**" : "🔇 TTS **disabled**";
        const hint = userSession.ttsEnabled
            ? "\nAI replies will be sent as voice messages."
            : "\nAI replies will be sent as text.";

        await interaction.reply({ content: `${status}${hint}`, ephemeral: true });
    }

    // ─── Voice channel: join ─────────────────────────────────────────────────

    private async handleJoinVoice(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "❌ This command can only be used in a server.", ephemeral: true });
            return;
        }

        if (!this.voiceProvider) {
            await interaction.reply({
                content: "❌ Voice features are not available. Please set `OPENAI_API_KEY` to enable.",
                ephemeral: true,
            });
            return;
        }

        // Dynamically import @discordjs/voice to avoid hard dep at startup
        let voiceModule: any;
        try {
            voiceModule = await import("@discordjs/voice");
        } catch {
            await interaction.reply({
                content: "❌ Voice support requires `@discordjs/voice` to be installed. Run `npm install @discordjs/voice @discordjs/opus`.",
                ephemeral: true,
            });
            return;
        }

        const guild = interaction.guild;
        const member = guild?.members.cache.get(userId) ?? await guild?.members.fetch(userId).catch(() => null);
        const voiceChannel = (member as any)?.voice?.channel;

        if (!voiceChannel) {
            await interaction.reply({ content: "❌ You must be in a voice channel first.", ephemeral: true });
            return;
        }

        // Disconnect existing connection if any
        if (this.voiceConnections.has(guildId)) {
            try { this.voiceConnections.get(guildId)?.destroy(); } catch {}
            this.voiceConnections.delete(guildId);
        }

        const connection = voiceModule.joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator: guild!.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
        });

        this.voiceConnections.set(guildId, connection);

        // Update active session's guildId for TTS routing
        const userSession = this.opencodeService.getUserSession(userId);
        if (userSession) userSession.guildId = guildId;

        // Start listening for speech from each user
        connection.receiver.speaking.on("start", (speakingUserId: string) => {
            this.startListeningToUser(connection, speakingUserId, guildId, voiceModule);
        });

        connection.on(voiceModule.VoiceConnectionStatus.Disconnected, () => {
            this.voiceConnections.delete(guildId);
        });

        await interaction.reply({
            content: `✅ Joined **${voiceChannel.name}**. Start speaking to send prompts to your active session.`,
            ephemeral: false,
        });
    }

    private startListeningToUser(connection: any, speakingUserId: string, guildId: string, voiceModule: any): void {
        const MAX_RECORDING_MS = 30_000;
        const receiver = connection.receiver;
        const opusStream = receiver.subscribe(speakingUserId, { end: { behavior: voiceModule.EndBehaviorType.AfterSilence, duration: 500 } });

        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => { opusStream.destroy(); }, MAX_RECORDING_MS);

        opusStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        opusStream.on("end", async () => {
            clearTimeout(timeout);
            if (chunks.length === 0 || !this.voiceProvider) return;

            const combined = Buffer.concat(chunks);
            try {
                const transcript = await this.voiceProvider.transcribe(combined, { mimeType: "audio/ogg" });
                if (!transcript.trim()) return;

                console.log(`[Voice] STT for user ${speakingUserId}: "${transcript.slice(0, 80)}..."`);

                // Route to the speaking user's active session
                if (this.opencodeService.hasActiveSession(speakingUserId)) {
                    await this.opencodeService.sendPrompt(speakingUserId, transcript.trim());
                }
            } catch (err) {
                console.error(`[Voice] STT error for user ${speakingUserId}:`, err);
            }
        });

        opusStream.on("error", (err: Error) => {
            clearTimeout(timeout);
            console.error(`[Voice] Stream error for user ${speakingUserId}:`, err);
        });
    }

    // ─── Voice channel: leave ────────────────────────────────────────────────

    private async handleLeaveVoice(interaction: ChatInputCommandInteraction): Promise<void> {
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "❌ This command can only be used in a server.", ephemeral: true });
            return;
        }

        const connection = this.voiceConnections.get(guildId);
        if (!connection) {
            await interaction.reply({ content: "❌ Not currently in a voice channel.", ephemeral: true });
            return;
        }

        try { connection.destroy(); } catch {}
        this.voiceConnections.delete(guildId);

        await interaction.reply({ content: "👋 Left the voice channel.", ephemeral: false });
    }
}
