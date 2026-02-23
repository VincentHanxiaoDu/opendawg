// ─────────────────────────────────────────────────────────────────────────────
// @opendawg/channel-core — barrel export
// ─────────────────────────────────────────────────────────────────────────────

// Config
export {
    ConfigService,
    type ChannelConfigInit,
    type VoiceConfig,
} from "./config.service.js";

// Server registry
export {
    ServerRegistry,
    type ServerRecord,
    type DefaultServer,
} from "./server-registry.service.js";

// Voice
export {
    createVoiceProvider,
    splitForTts,
    OpenAIVoiceProvider,
    AzureVoiceProvider,
    GoogleVoiceProvider,
    type VoiceProvider,
    type VoiceProviderConfig,
    type TranscribeOptions,
    type SynthesizeOptions,
} from "./voice.service.js";

// Access control
export {
    checkAccess,
    isAdmin,
    isAllowed,
    type AccessResult,
} from "./access-control.js";

// Error utilities
export {
    formatError,
    createErrorMessage,
} from "./error.utils.js";

// Message utilities
export {
    escapeMarkdown,
    splitMessage,
} from "./message.utils.js";

// Pagination
export {
    PAGE_SIZE,
    setPendingJump,
    consumePendingJump,
    buildPageButtons,
    parsePageCallback,
    parseJumpCallback,
    totalPages,
    getPageSlice,
    type PageButton,
} from "./pagination.js";
