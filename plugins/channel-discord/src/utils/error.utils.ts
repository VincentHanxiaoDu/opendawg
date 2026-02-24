/**
 * Utility class for error formatting and handling
 */
export class ErrorUtils {
    static formatError(error: unknown): string {
        return error instanceof Error ? error.message : 'Unknown error';
    }

    static createErrorMessage(action: string, error: unknown): string {
        return `Failed to ${action}.\n\nError: ${ErrorUtils.formatError(error)}`;
    }
}
