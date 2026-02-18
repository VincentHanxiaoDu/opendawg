/**
 * UAT Harness for TelegramCoder bot
 *
 * Uses grammY's handleUpdate() to inject fake Telegram Updates and
 * bot.api.config.use(transformer) to intercept all outgoing API calls.
 * No real Telegram network connection is needed.
 */

import { Bot, Context } from "grammy";

export interface CapturedApiCall {
  method: string;
  payload: Record<string, unknown>;
  result?: unknown;
}

export interface TestContext {
  /** All API calls the bot made during this test */
  calls: CapturedApiCall[];
  /** Convenience: all sendMessage / editMessageText texts */
  texts: string[];
  /** Last reply text (sendMessage or editMessageText) */
  lastText: string | undefined;
}

let msgIdCounter = 1000;
function nextMsgId(): number {
  return ++msgIdCounter;
}

/** Install API interceptor on bot. Returns mutable array of captured calls. */
export function installApiInterceptor(bot: Bot): CapturedApiCall[] {
  const calls: CapturedApiCall[] = [];

  bot.api.config.use(async (prev, method, payload, signal) => {
    // Build fake results for common methods so bot code doesn't crash
    let fakeResult: unknown;

    if (method === "sendMessage" || method === "sendDocument") {
      fakeResult = {
        message_id: nextMsgId(),
        chat: (payload as any).chat_id
          ? { id: (payload as any).chat_id }
          : { id: 7930109134 },
        date: Math.floor(Date.now() / 1000),
        text: (payload as any).text || "",
      };
    } else if (method === "editMessageText" || method === "editMessageCaption") {
      fakeResult = {
        message_id: (payload as any).message_id || nextMsgId(),
        chat: { id: (payload as any).chat_id || 7930109134 },
        text: (payload as any).text || "",
      };
    } else if (method === "deleteMessage") {
      fakeResult = true;
    } else if (method === "getMe") {
      fakeResult = {
        id: 99999,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      };
    } else if (method === "setMyCommands") {
      fakeResult = true;
    } else if (method === "answerCallbackQuery") {
      fakeResult = true;
    } else if (method === "sendChatAction") {
      fakeResult = true;
    } else {
      // For unknown methods, try real API, fall back to null
      try {
        return await prev(method, payload, signal);
      } catch {
        fakeResult = null;
      }
    }

    calls.push({ method, payload: payload as Record<string, unknown>, result: fakeResult });
    return { ok: true, result: fakeResult } as any;
  });

  return calls;
}

const UPDATE_ID_COUNTER = { v: 1 };

/** Build a fake text message update from userId */
export function buildTextUpdate(
  userId: number,
  text: string,
  chatId: number = userId
) {
  const msgId = nextMsgId();
  return {
    update_id: UPDATE_ID_COUNTER.v++,
    message: {
      message_id: msgId,
      from: {
        id: userId,
        is_bot: false,
        first_name: "TestUser",
        username: "testuser",
        language_code: "en",
      },
      chat: {
        id: chatId,
        type: "private" as const,
        first_name: "TestUser",
        username: "testuser",
      },
      date: Math.floor(Date.now() / 1000),
      text,
      entities: text.startsWith("/")
        ? [{ offset: 0, length: text.split(" ")[0].length, type: "bot_command" as const }]
        : undefined,
    },
  };
}

/** Build a fake callback_query update */
export function buildCallbackUpdate(
  userId: number,
  data: string,
  messageText: string = "",
  chatId: number = userId
) {
  const msgId = nextMsgId();
  return {
    update_id: UPDATE_ID_COUNTER.v++,
    callback_query: {
      id: String(UPDATE_ID_COUNTER.v),
      from: {
        id: userId,
        is_bot: false,
        first_name: "TestUser",
        username: "testuser",
        language_code: "en",
      },
      message: {
        message_id: msgId,
        from: { id: 99999, is_bot: true, first_name: "TestBot", username: "test_bot" },
        chat: { id: chatId, type: "private" as const },
        date: Math.floor(Date.now() / 1000),
        text: messageText,
      },
      chat_instance: "test_instance",
      data,
    },
  };
}

/** Send a text command/message to the bot and return captured API calls */
export async function send(
  bot: Bot,
  capturedCalls: CapturedApiCall[],
  userId: number,
  text: string
): Promise<TestContext> {
  const before = capturedCalls.length;
  await bot.handleUpdate(buildTextUpdate(userId, text) as any);
  const newCalls = capturedCalls.slice(before);
  return buildTestContext(newCalls);
}

/** Send a callback_query to the bot */
export async function sendCallback(
  bot: Bot,
  capturedCalls: CapturedApiCall[],
  userId: number,
  data: string,
  messageText?: string
): Promise<TestContext> {
  const before = capturedCalls.length;
  await bot.handleUpdate(buildCallbackUpdate(userId, data, messageText) as any);
  const newCalls = capturedCalls.slice(before);
  return buildTestContext(newCalls);
}

function buildTestContext(calls: CapturedApiCall[]): TestContext {
  const texts: string[] = [];
  for (const c of calls) {
    if (c.method === "sendMessage" || c.method === "editMessageText") {
      const t = (c.payload.text as string) || "";
      if (t) texts.push(t);
    }
  }
  return {
    calls,
    texts,
    lastText: texts[texts.length - 1],
  };
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failed++;
    failures.push(message);
  }
}

export function assertContains(text: string | undefined, substring: string, label: string): void {
  assert(!!text && text.includes(substring), `${label} — contains "${substring}" (got: ${JSON.stringify(text?.substring(0, 120))})`);
}

export function assertMatch(text: string | undefined, pattern: RegExp, label: string): void {
  assert(!!text && pattern.test(text), `${label} — matches ${pattern} (got: ${JSON.stringify(text?.substring(0, 120))})`);
}

export function assertApiCalled(calls: CapturedApiCall[], method: string, label: string): void {
  assert(calls.some(c => c.method === method), `${label} — API method "${method}" was called`);
}

export function printSummary(): void {
  console.log("\n" + "═".repeat(60));
  console.log(`UAT RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    failures.forEach(f => console.log(`  • ${f}`));
  }
  console.log("═".repeat(60));
}

export function getExitCode(): number {
  return failed > 0 ? 1 : 0;
}
