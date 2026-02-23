import { Client, GatewayIntentBits, REST, Routes, Events } from "discord.js";
import { ConfigService } from "./services/config.service.js";
import { ServerRegistry } from "./services/server-registry.service.js";
import { OpenCodeService } from "./features/opencode/opencode.service.js";
import { DiscordBot } from "./features/opencode/opencode.bot.js";
import { AccessControlMiddleware } from "./middleware/access-control.middleware.js";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

console.log("[DiscordCoder] Starting bot...");

dotenv.config();

// Initialize config service
const configService = new ConfigService();

try {
    configService.validate();
    console.log("[DiscordCoder] Configuration loaded successfully");
    console.log(configService.getDebugInfo());
} catch (error) {
    console.error("[DiscordCoder] Configuration error:", error);
    process.exit(1);
}

// Create Discord client with required intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
    ],
});

// Initialize server registry (SQLite-backed, falls back to memory)
const serverRegistry = new ServerRegistry(configService.getDefaultServers());

// Initialize services
const opencodeService = new OpenCodeService(undefined, serverRegistry);

// Set up access control
AccessControlMiddleware.setConfigService(configService);
AccessControlMiddleware.setClient(client);

// Initialize the Discord bot handler
const discordBot = new DiscordBot(opencodeService, configService, serverRegistry);

// Register event handlers
discordBot.registerHandlers(client);

// Global error handler
client.on("error", (error) => {
    console.error("[DiscordCoder] Client error:", error);
});

async function startBot() {
    try {
        console.log("[DiscordCoder] Starting initialization...");

        // Clean up media directory if configured
        if (configService.shouldCleanUpMediaDir()) {
            const botMediaPath = path.join(configService.getMediaTmpLocation(), "bot-1");
            if (fs.existsSync(botMediaPath)) {
                console.log(`[DiscordCoder] Cleaning up media directory: ${botMediaPath}`);
                fs.rmSync(botMediaPath, { recursive: true, force: true });
                console.log("[DiscordCoder] Media directory cleaned");
            }
        }

        // Register slash commands via REST API
        const rest = new REST().setToken(configService.getDiscordBotToken());
        const commands = discordBot.getSlashCommands();

        console.log(`[DiscordCoder] Registering ${commands.length} slash commands...`);

        if (configService.getDiscordAppId()) {
            await rest.put(
                Routes.applicationCommands(configService.getDiscordAppId()),
                { body: commands }
            );
            console.log("[DiscordCoder] Slash commands registered globally");
        } else {
            console.warn("[DiscordCoder] DISCORD_APP_ID not set — slash commands will not be registered. Set DISCORD_APP_ID in your .env");
        }

        // Log in to Discord
        client.once(Events.ClientReady, (readyClient) => {
            console.log(`[DiscordCoder] Bot info: ${readyClient.user.tag}`);
            console.log("[DiscordCoder] Bot started successfully");
        });

        await client.login(configService.getDiscordBotToken());

    } catch (error) {
        console.error("[DiscordCoder] Failed to start:", error);
        process.exit(1);
    }
}

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        console.log("[DiscordCoder] Shutdown already in progress...");
        return;
    }

    shuttingDown = true;
    console.log(`[DiscordCoder] Received ${signal}, shutting down gracefully...`);

    try {
        opencodeService.stopAllEventStreams();
        serverRegistry.close();
        client.destroy();

        console.log("[DiscordCoder] Shutdown complete");
        process.exit(0);
    } catch (error) {
        console.error("[DiscordCoder] Error during shutdown:", error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
    console.error("[DiscordCoder] Unhandled Rejection at:", promise, "reason:", reason);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
    console.error("[DiscordCoder] Uncaught Exception:", error);
    gracefulShutdown("UNCAUGHT_EXCEPTION");
});

// Start the bot
startBot().catch((error) => {
    console.error("[DiscordCoder] Fatal error:", error);
    process.exit(1);
});
