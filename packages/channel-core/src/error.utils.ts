// ─────────────────────────────────────────────────────────────────────────────
// Generic error formatting utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts a readable error message from an unknown error type.
 */
export function formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "Unknown error";
}

/**
 * Creates a standardised error message for failed actions.
 *
 * @param action  Description of the action that failed, e.g. "send to terminal".
 * @param error   The caught error value.
 * @returns A user-facing error string.
 *
 * @example
 * ```ts
 * try { await doSomething(); }
 * catch (err) { await reply(createErrorMessage("send message", err)); }
 * ```
 */
export function createErrorMessage(action: string, error: unknown): string {
    return `Failed to ${action}.\n\nError: ${formatError(error)}`;
}
