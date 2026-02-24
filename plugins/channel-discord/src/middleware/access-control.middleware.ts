import { Client, type Interaction, type Message } from "discord.js";
import { ConfigService } from "../services/config.service.js";

export class AccessControlMiddleware {
    private static allowedUserIds: Set<string> | null = null;
    private static adminUserId: string | null = null;
    private static configService: ConfigService | null = null;
    private static client: Client | null = null;

    static setConfigService(config: ConfigService): void {
        AccessControlMiddleware.configService = config;
    }

    static setClient(client: Client): void {
        AccessControlMiddleware.client = client;
    }

    private static initializeAllowedUsers(): Set<string> {
        if (AccessControlMiddleware.allowedUserIds === null) {
            if (!AccessControlMiddleware.configService) {
                throw new Error('ConfigService not set in AccessControlMiddleware');
            }

            const allowedIds = AccessControlMiddleware.configService.getAllowedUserIds();
            AccessControlMiddleware.allowedUserIds = new Set(allowedIds);

            const configAdminId = AccessControlMiddleware.configService.getAdminUserId();
            if (configAdminId) {
                AccessControlMiddleware.adminUserId = configAdminId;
            } else {
                const firstUser = Array.from(AccessControlMiddleware.allowedUserIds)[0];
                if (firstUser) {
                    AccessControlMiddleware.adminUserId = firstUser;
                }
            }

            console.log(`Access Control: ${AccessControlMiddleware.allowedUserIds.size} user(s) allowed`);
            if (AccessControlMiddleware.adminUserId) {
                console.log(`Access Control: Admin user ID: ${AccessControlMiddleware.adminUserId}`);
            }
        }
        return AccessControlMiddleware.allowedUserIds;
    }

    /**
     * Check if a user is allowed. Returns true if allowed, false if denied.
     * For interactions, sends an ephemeral denial. For messages, replies with denial.
     */
    static async checkAccess(userId: string, interaction?: Interaction, message?: Message): Promise<boolean> {
        const allowedUsers = AccessControlMiddleware.initializeAllowedUsers();

        if (allowedUsers.has(userId)) {
            return true;
        }

        console.log(`Unauthorized access attempt from user ${userId}`);

        // Notify admin
        await AccessControlMiddleware.notifyAdminOfUnauthorizedAccess(userId, interaction, message);

        // Auto-kill check
        if (AccessControlMiddleware.isAutoKillEnabled()) {
            const denyMsg = `Unauthorized access detected.\nYour Discord User ID is: ${userId}\nThe bot is shutting down for security reasons.`;

            if (interaction && interaction.isRepliable()) {
                await interaction.reply({ content: denyMsg, ephemeral: true }).catch(() => {});
            } else if (message) {
                await message.reply(denyMsg).catch(() => {});
            }

            console.log(`AUTO_KILL: Unauthorized access from ${userId}. Shutting down...`);
            setTimeout(() => process.exit(1), 1000);
            return false;
        }

        // Standard denial
        const denyMsg = `You don't have access to this bot.\nYour Discord User ID is: ${userId}\nPlease contact the bot administrator to get access.`;

        if (interaction && interaction.isRepliable()) {
            await interaction.reply({ content: denyMsg, ephemeral: true }).catch(() => {});
        } else if (message) {
            await message.reply(denyMsg).catch(() => {});
        }

        return false;
    }

    static isAllowed(userId: string): boolean {
        const allowedUsers = AccessControlMiddleware.initializeAllowedUsers();
        return allowedUsers.has(userId);
    }

    static isAdmin(userId: string): boolean {
        AccessControlMiddleware.initializeAllowedUsers();
        return AccessControlMiddleware.adminUserId === userId;
    }

    static getAllowedUserIds(): string[] {
        const allowedUsers = AccessControlMiddleware.initializeAllowedUsers();
        return Array.from(allowedUsers);
    }

    private static isAutoKillEnabled(): boolean {
        if (!AccessControlMiddleware.configService) return false;
        return AccessControlMiddleware.configService.isAutoKillEnabled();
    }

    private static async notifyAdminOfUnauthorizedAccess(
        userId: string,
        interaction?: Interaction,
        message?: Message
    ): Promise<void> {
        if (!AccessControlMiddleware.client || !AccessControlMiddleware.adminUserId) return;

        try {
            const user = interaction?.user ?? message?.author;
            const username = user?.username ?? 'Unknown';
            const displayName = user?.displayName ?? 'Unknown';
            const action = interaction
                ? (interaction.isChatInputCommand() ? `/${interaction.commandName}` : 'interaction')
                : (message?.content?.substring(0, 100) ?? 'Unknown action');

            const notificationMessage = [
                '**Unauthorized Access Attempt**',
                '',
                '**User Information:**',
                `- Name: ${displayName}`,
                `- Username: ${username}`,
                `- User ID: \`${userId}\``,
                '',
                '**Attempted Action:**',
                `\`${action}\``,
                '',
                `*Time: ${new Date().toLocaleString()}*`
            ].join('\n');

            const adminUser = await AccessControlMiddleware.client.users.fetch(AccessControlMiddleware.adminUserId);
            const sent = await adminUser.send(notificationMessage);

            if (AccessControlMiddleware.configService) {
                const deleteTimeout = AccessControlMiddleware.configService.getMessageDeleteTimeout();
                if (deleteTimeout > 0) {
                    setTimeout(async () => {
                        try { await sent.delete(); } catch {}
                    }, deleteTimeout);
                }
            }

            console.log(`Notified admin ${AccessControlMiddleware.adminUserId} about unauthorized access from ${userId}`);
        } catch (error) {
            console.error('Failed to notify admin of unauthorized access:', error);
        }
    }
}
