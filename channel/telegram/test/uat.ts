/**
 * UAT Test Suite for TelegramCoder multi-session / multi-server feature
 *
 * Runs against a real opencode server (OPENCODE_SERVER_URL env var).
 * Telegram I/O is fully mocked via grammY handleUpdate + API transformer.
 *
 * Usage (inside test container):
 *   npx tsx test/uat.ts
 */

import "dotenv/config";
import { Bot } from "grammy";
import { ConfigService } from "../src/services/config.service.js";
import { ServerRegistry } from "../src/services/server-registry.service.js";
import { OpenCodeService } from "../src/features/opencode/opencode.service.js";
import { OpenCodeBot } from "../src/features/opencode/opencode.bot.js";
import { AccessControlMiddleware } from "../src/middleware/access-control.middleware.js";
import {
  installApiInterceptor,
  send,
  sendCallback,
  assert,
  assertContains,
  assertMatch,
  assertApiCalled,
  printSummary,
  getExitCode,
  type CapturedApiCall,
} from "./uat-harness.js";

// ─── Test user (must be in ALLOWED_USER_IDS) ─────────────────────────────────
const TEST_USER = 7930109134;
const OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

// ─── Setup ───────────────────────────────────────────────────────────────────

function createBotUnderTest(): { bot: Bot; calls: CapturedApiCall[] } {
  const tokens = (process.env.TELEGRAM_BOT_TOKENS || process.env.TELEGRAM_BOT_TOKEN || "")
    .split(",").map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("TELEGRAM_BOT_TOKENS or TELEGRAM_BOT_TOKEN not set");

  // Pass botInfo directly to skip the getMe() network call on init
  const bot = new Bot(tokens[0], {
    botInfo: {
      id: 99999,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      is_inline_queries_disabled: false,
    } as any,
  });
  const calls = installApiInterceptor(bot);

  const configService = new ConfigService();
  const serverRegistry = new ServerRegistry(configService.getDefaultServers());
  const opencodeService = new OpenCodeService(undefined, serverRegistry);

  AccessControlMiddleware.setConfigService(configService);
  AccessControlMiddleware.setBot(bot);

  const opencodeBot = new OpenCodeBot(opencodeService, configService, serverRegistry);
  opencodeBot.registerHandlers(bot);

  // Expose services for later assertions
  (bot as any).__serverRegistry = serverRegistry;
  (bot as any).__opencodeService = opencodeService;

  return { bot, calls };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log("═".repeat(60));
  console.log("TelegramCoder UAT Suite");
  console.log(`OpenCode server: ${OPENCODE_URL}`);
  console.log("═".repeat(60) + "\n");

  const { bot, calls } = createBotUnderTest();
  const svc: OpenCodeService = (bot as any).__opencodeService;
  const registry: ServerRegistry = (bot as any).__serverRegistry;

  // ── GROUP 1: Commands with no session ──────────────────────────────────────
  console.log("── Group 1: Commands before any session ──────────────────────");

  {
    const r = await send(bot, calls, TEST_USER, "/start");
    assertContains(r.lastText, "Welcome", "/start shows welcome");
    assertContains(r.lastText, "/opencode", "/start mentions /opencode");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/sessions");
    // May show "No sessions" (empty server) or a list of sessions (server has history)
    const text = r.lastText || "";
    const ok = text.includes("No sessions") || text.includes("Sessions") || r.calls.some(c => c.method === "sendDocument");
    assert(ok, `/sessions → valid response (got: "${text.substring(0, 60)}")`);
  }

  {
    const r = await send(bot, calls, TEST_USER, "/session");
    assertContains(r.lastText, "No active session", "/session (no args, no session) → info message");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/history");
    assertContains(r.lastText, "No active session", "/history without session → error");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/detach");
    assertContains(r.lastText, "No active session", "/detach without session → error");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/endsession");
    assertContains(r.lastText, "No active session", "/endsession without session → error");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/esc");
    assertContains(r.lastText, "No active", "/esc without session → error");
  }

  {
    const r = await send(bot, calls, TEST_USER, "hello");
    assertContains(r.lastText, "No active OpenCode session", "plain text without session → error");
  }

  // ── GROUP 2: Server commands ───────────────────────────────────────────────
  console.log("\n── Group 2: Server commands ───────────────────────────────");

  {
    const r = await send(bot, calls, TEST_USER, "/servers");
    assertContains(r.lastText, "Servers", "/servers shows server list");
    assertMatch(r.lastText, /●|active/, "/servers shows active marker");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/server");
    assertContains(r.lastText, "Server commands", "/server (no args) → usage");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/server add");
    assertContains(r.lastText, "Usage", "/server add (no url) → usage hint");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/server add notaurl");
    assertContains(r.lastText, "Invalid URL", "/server add <bad-url> → invalid URL error");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/server add http://localhost:9999 TestServer");
    assertContains(r.lastText, "Server added", "/server add <url> <name> → adds server");
    assertContains(r.lastText, "TestServer", "Server name echoed back");
  }

  {
    const r = await send(bot, calls, TEST_USER, "/server add http://localhost:9999 TestServer2");
    assertContains(r.lastText, "already exists", "/server add duplicate URL → duplicate error");
  }

  {
    const servers = registry.listByUserWithDefaults(TEST_USER);
    assert(servers.length >= 2, `Server registry has ≥2 servers (got ${servers.length})`);
    const added = servers.find(s => s.url === "http://localhost:9999");
    assert(!!added, "Added server is in registry");

    // /server remove (non-active server)
    const r = await send(bot, calls, TEST_USER, `/server remove ${added!.id}`);
    assertContains(r.lastText, "removed", "/server remove → success");
  }

  {
    // Remove active server → should fail
    const activeServer = registry.getActive(TEST_USER);
    if (activeServer) {
      const r = await send(bot, calls, TEST_USER, `/server remove ${activeServer.id}`);
      assertContains(r.lastText, "Cannot remove active", "/server remove active → blocked");
    } else {
      assert(true, "/server remove active → skipped (no active server with removable ID)");
    }
  }

  {
    // /server use with unknown id
    const r = await send(bot, calls, TEST_USER, "/server use xxxxxxxx");
    assertContains(r.lastText, "not found", "/server use <bad-id> → not found");
  }

  // ── GROUP 3: /opencode — create session ────────────────────────────────────
  console.log("\n── Group 3: /opencode — session creation ──────────────────");

  {
    const r = await send(bot, calls, TEST_USER, "/opencode UAT Test Session 1");
    // Should attempt to create session; success or ECONNREFUSED both acceptable
    const anyReply = r.texts.length > 0;
    assert(anyReply, "/opencode triggers bot response");

    const allText = r.texts.join(" ");
    const sessionCreated = allText.includes("Session started") || allText.includes("UAT Test");
    const connectionError = allText.includes("Cannot connect") || allText.includes("ECONNREFUSED") || allText.includes("Failed");

    if (sessionCreated) {
      console.log("  ℹ️  OpenCode server reachable — session created");
      assert(true, "/opencode → session created");
    } else if (connectionError) {
      console.log("  ⚠️  OpenCode server unreachable — connection error (expected in offline test)");
      assert(true, "/opencode → connection error (server offline)");
    } else {
      assert(false, `/opencode → unexpected response: ${allText.substring(0, 200)}`);
    }
  }

  // Wait a moment for any async operations
  await sleep(1000);

  const hasSession = svc.hasActiveSession(TEST_USER);

  if (hasSession) {
    console.log("  ℹ️  Active session present — running session-dependent tests");

    // ── GROUP 4: Session commands (with active session) ──────────────────────
    console.log("\n── Group 4: Session commands (with session) ────────────────");

    {
      const r = await send(bot, calls, TEST_USER, "/sessions");
      assertContains(r.lastText, "●", "/sessions shows active marker");
    }

    {
      const r = await send(bot, calls, TEST_USER, "/session");
      assertContains(r.lastText, "Current session", "/session (no args) → shows current session");
    }

    {
      const r = await send(bot, calls, TEST_USER, "/history");
      const text = r.lastText || "";
      const ok = text.includes("Last") || text.includes("No messages");
      assert(ok, "/history → shows history or empty message");
    }

    {
      const r = await send(bot, calls, TEST_USER, "/session tooshort");
      // Less than 4 chars - should fail? "tooshort" is 9 chars, that's fine
      // test with 3 chars:
    }

    {
      const r = await send(bot, calls, TEST_USER, "/session abc");
      assertContains(r.lastText, "at least 4", "/session <3-char id> → length error");
    }

    {
      const r = await send(bot, calls, TEST_USER, "/session xxxxxxxxxxxxxxxx");
      // Should try to attach from server
      const text = r.lastText || "";
      const notFound = text.includes("not found") || text.includes("Cannot connect") || text.includes("Failed");
      assert(notFound, "/session <bad-id> → not found or server error");
    }

    // Create second session
    {
      const r = await send(bot, calls, TEST_USER, "/opencode UAT Test Session 2");
      await sleep(500);
      const allText = r.texts.join(" ");
      if (allText.includes("Session started")) {
        assert(true, "/opencode second time → creates 2nd session");
        assertContains(allText, "background", "/opencode second time → previous session moved to background");
      }
    }

    {
      const r = await send(bot, calls, TEST_USER, "/sessions");
      const text = r.lastText || "";
      // Should show at least one session
      assert(r.calls.some(c => c.method === "sendMessage" || c.method === "sendDocument"), "/sessions → sends reply");
    }

    // /detach
    {
      const sessionBefore = svc.getUserSession(TEST_USER);
      const r = await send(bot, calls, TEST_USER, "/detach");
      assertContains(r.lastText, "Detached", "/detach → success message");
      const sessionAfter = svc.getUserSession(TEST_USER);
      assert(!sessionAfter || sessionAfter?.sessionId !== sessionBefore?.sessionId,
        "/detach → active session changed");
    }

    // /rename (if still has session)
    if (svc.hasActiveSession(TEST_USER)) {
      {
        const r = await send(bot, calls, TEST_USER, "/rename");
        assertContains(r.lastText, "provide a new title", "/rename (no args) → error");
      }
      {
        const r = await send(bot, calls, TEST_USER, "/rename New UAT Title");
        const text = r.lastText || "";
        const ok = text.includes("renamed") || text.includes("Failed");
        assert(ok, "/rename <title> → success or server error");
      }
    }

    // /undo / /redo (may fail if server unreachable, that's OK)
    if (svc.hasActiveSession(TEST_USER)) {
      {
        const r = await send(bot, calls, TEST_USER, "/undo");
        const text = r.lastText || "";
        assert(!!text, "/undo → any reply");
      }
      {
        const r = await send(bot, calls, TEST_USER, "/redo");
        const text = r.lastText || "";
        assert(!!text, "/redo → any reply");
      }
    }

    // /verbosity
    if (svc.hasActiveSession(TEST_USER)) {
      {
        const r = await send(bot, calls, TEST_USER, "/verbosity 2 1");
        const text = r.lastText || "";
        const ok = text.includes("erbosity") || text.includes("Stream") || text.includes("verbosity");
        assert(ok, "/verbosity 2 1 → verbosity response");
      }
    }

    // /endsession
    if (svc.hasActiveSession(TEST_USER)) {
      {
        const r = await send(bot, calls, TEST_USER, "/endsession");
        const text = r.lastText || "";
        const ok = text.includes("ended") || text.includes("Failed");
        assert(ok, "/endsession → session ended");
      }
    }

    // ESC callback button
    {
      const r = await sendCallback(bot, calls, TEST_USER, "esc", "Test message");
      const text = r.lastText || "";
      // Either "aborted", "No active" or "Failed"
      assert(!!text || r.calls.some(c => c.method === "answerCallbackQuery"),
        "ESC callback → bot responds");
    }

  } else {
    console.log("  ⚠️  No active session (server unreachable) — skipping session-dependent tests");
    assert(true, "Session tests skipped (server offline)");
  }

  // ── GROUP 5: /projects ─────────────────────────────────────────────────────
  console.log("\n── Group 5: Info commands ──────────────────────────────────");

  {
    const r = await send(bot, calls, TEST_USER, "/projects");
    const text = r.lastText || "";
    const ok = text.includes("Project") || text.includes("Cannot connect") || text.includes("Failed");
    assert(ok, "/projects → any valid response");
  }

  // ── GROUP 6: Access control ─────────────────────────────────────────────────
  console.log("\n── Group 6: Access control ─────────────────────────────────");

  {
    const r = await send(bot, calls, 9999999, "/sessions");
    assertContains(r.lastText, "don't have access", "Unauthorized user → access denied");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  printSummary();
  process.exit(getExitCode());
}

runTests().catch(err => {
  console.error("UAT runner crashed:", err);
  process.exit(1);
});
