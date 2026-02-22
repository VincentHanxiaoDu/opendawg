import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─────────────────────────────────────────────────────────────────────────────
// VoiceProvider interface
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscribeOptions {
    /** MIME type hint, e.g. "audio/ogg", "audio/mpeg" */
    mimeType?: string;
    /** Language hint (BCP-47), e.g. "zh", "en" */
    language?: string;
}

export interface SynthesizeOptions {
    /** Voice ID / name, provider-dependent */
    voice?: string;
    /** Model name, provider-dependent */
    model?: string;
    /** Speed multiplier (1.0 = normal) */
    speed?: number;
}

export interface VoiceProvider {
    /** Speech-to-Text: convert audio buffer to transcript string */
    transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<string>;
    /** Text-to-Speech: convert text to MP3 audio buffer */
    synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI provider
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIVoiceProvider implements VoiceProvider {
    private readonly apiKey: string;
    private readonly defaultSttModel: string;
    private readonly defaultTtsModel: string;
    private readonly defaultVoice: string;

    constructor(config: {
        apiKey: string;
        sttModel?: string;
        ttsModel?: string;
        voice?: string;
    }) {
        this.apiKey = config.apiKey;
        this.defaultSttModel = config.sttModel ?? "whisper-1";
        this.defaultTtsModel = config.ttsModel ?? "tts-1";
        this.defaultVoice = config.voice ?? "alloy";
    }

    async transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<string> {
        // Determine file extension from MIME type
        const ext = mimeToExt(options?.mimeType ?? "audio/ogg");
        const tmpFile = path.join(os.tmpdir(), `voice_stt_${Date.now()}${ext}`);

        try {
            fs.writeFileSync(tmpFile, audioBuffer);

            const formData = new FormData();
            const blob = new Blob([audioBuffer], { type: options?.mimeType ?? "audio/ogg" });
            formData.append("file", blob, `audio${ext}`);
            formData.append("model", this.defaultSttModel);
            if (options?.language) {
                formData.append("language", options.language);
            }

            const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                },
                body: formData,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`OpenAI STT API error ${response.status}: ${errText}`);
            }

            const result = await response.json() as { text: string };
            return result.text ?? "";
        } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    }

    async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
        const model = options?.model ?? this.defaultTtsModel;
        const voice = options?.voice ?? this.defaultVoice;
        const speed = options?.speed ?? 1.0;

        const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                input: text,
                voice,
                speed,
                response_format: "mp3",
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI TTS API error ${response.status}: ${errText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Azure OpenAI provider
// ─────────────────────────────────────────────────────────────────────────────

export class AzureVoiceProvider implements VoiceProvider {
    private readonly apiKey: string;
    private readonly endpoint: string;        // e.g. https://my-resource.openai.azure.com
    private readonly apiVersion: string;      // e.g. 2024-06-01
    private readonly sttDeployment: string;   // whisper deployment name
    private readonly ttsDeployment: string;   // tts deployment name
    private readonly defaultVoice: string;

    constructor(config: {
        apiKey: string;
        endpoint: string;
        apiVersion?: string;
        sttDeployment?: string;
        ttsDeployment?: string;
        voice?: string;
    }) {
        this.apiKey = config.apiKey;
        this.endpoint = config.endpoint.replace(/\/$/, "");
        this.apiVersion = config.apiVersion ?? "2024-06-01";
        this.sttDeployment = config.sttDeployment ?? "whisper";
        this.ttsDeployment = config.ttsDeployment ?? "tts";
        this.defaultVoice = config.voice ?? "alloy";
    }

    async transcribe(audioBuffer: Buffer, options?: TranscribeOptions): Promise<string> {
        const ext = mimeToExt(options?.mimeType ?? "audio/ogg");
        const tmpFile = path.join(os.tmpdir(), `voice_stt_${Date.now()}${ext}`);

        try {
            fs.writeFileSync(tmpFile, audioBuffer);

            const url = `${this.endpoint}/openai/deployments/${this.sttDeployment}/audio/transcriptions?api-version=${this.apiVersion}`;
            const formData = new FormData();
            const blob = new Blob([audioBuffer], { type: options?.mimeType ?? "audio/ogg" });
            formData.append("file", blob, `audio${ext}`);
            // Azure STT does not require a model field (deployment name is in the URL)
            if (options?.language) {
                formData.append("language", options.language);
            }

            const response = await fetch(url, {
                method: "POST",
                headers: { "api-key": this.apiKey },
                body: formData,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Azure STT API error ${response.status}: ${errText}`);
            }

            const result = await response.json() as { text: string };
            return result.text ?? "";
        } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    }

    async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
        const voice = options?.voice ?? this.defaultVoice;
        const speed = options?.speed ?? 1.0;

        const url = `${this.endpoint}/openai/deployments/${this.ttsDeployment}/audio/speech?api-version=${this.apiVersion}`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "api-key": this.apiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                input: text,
                voice,
                speed,
                response_format: "mp3",
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Azure TTS API error ${response.status}: ${errText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Cloud provider (skeleton — not implemented)
// ─────────────────────────────────────────────────────────────────────────────

export class GoogleVoiceProvider implements VoiceProvider {
    constructor(_config: { apiKey?: string; credentialsPath?: string }) {
        // TODO: initialize Google Cloud STT/TTS clients when implementing
    }

    async transcribe(_audioBuffer: Buffer, _options?: TranscribeOptions): Promise<string> {
        throw new Error("GoogleVoiceProvider is not yet implemented. Set VOICE_PROVIDER=openai to use OpenAI.");
    }

    async synthesize(_text: string, _options?: SynthesizeOptions): Promise<Buffer> {
        throw new Error("GoogleVoiceProvider is not yet implemented. Set VOICE_PROVIDER=openai to use OpenAI.");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceProviderConfig {
    provider?: string;          // "openai" | "azure" | "google"  (default: "openai")
    // OpenAI
    openaiApiKey?: string;
    sttModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
    // Azure OpenAI
    azureApiKey?: string;
    azureEndpoint?: string;
    azureApiVersion?: string;
    azureSttDeployment?: string;
    azureTtsDeployment?: string;
    // Google Cloud
    googleApiKey?: string;
    googleCredentialsPath?: string;
}

export function createVoiceProvider(config: VoiceProviderConfig): VoiceProvider {
    const providerName = (config.provider ?? "openai").toLowerCase();

    switch (providerName) {
        case "openai": {
            const apiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "";
            if (!apiKey) {
                throw new Error(
                    "OPENAI_API_KEY is not set. Please set it in your environment to use voice features."
                );
            }
            return new OpenAIVoiceProvider({
                apiKey,
                sttModel: config.sttModel,
                ttsModel: config.ttsModel,
                voice: config.ttsVoice,
            });
        }
        case "azure": {
            const apiKey = config.azureApiKey ?? process.env.AZURE_OPENAI_API_KEY ?? "";
            const endpoint = config.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? "";
            if (!apiKey) {
                throw new Error(
                    "AZURE_OPENAI_API_KEY is not set. Please set it in your environment to use Azure voice features."
                );
            }
            if (!endpoint) {
                throw new Error(
                    "AZURE_OPENAI_ENDPOINT is not set. Example: https://my-resource.openai.azure.com"
                );
            }
            return new AzureVoiceProvider({
                apiKey,
                endpoint,
                apiVersion: config.azureApiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
                sttDeployment: config.azureSttDeployment ?? process.env.AZURE_VOICE_STT_DEPLOYMENT,
                ttsDeployment: config.azureTtsDeployment ?? process.env.AZURE_VOICE_TTS_DEPLOYMENT,
                voice: config.ttsVoice,
            });
        }
        case "google": {
            return new GoogleVoiceProvider({
                apiKey: config.googleApiKey,
                credentialsPath: config.googleCredentialsPath,
            });
        }
        default: {
            console.warn(
                `[VoiceService] Unknown VOICE_PROVIDER="${providerName}", falling back to "openai"`
            );
            const apiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "";
            if (!apiKey) {
                throw new Error(
                    "OPENAI_API_KEY is not set. Please set it in your environment to use voice features."
                );
            }
            return new OpenAIVoiceProvider({
                apiKey,
                sttModel: config.sttModel,
                ttsModel: config.ttsModel,
                voice: config.ttsVoice,
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TTS text chunking utility
// ─────────────────────────────────────────────────────────────────────────────

const TTS_MAX_CHARS = 4000;

/**
 * Split text into chunks suitable for TTS APIs (≤ TTS_MAX_CHARS chars each).
 * Splits on sentence boundaries where possible.
 */
export function splitForTts(text: string): string[] {
    if (text.length <= TTS_MAX_CHARS) return [text];

    const chunks: string[] = [];
    // Split on sentence-ending punctuation followed by space or end-of-string
    const sentences = text.split(/(?<=[。！？.!?\n])\s*/);

    let current = "";
    for (const sentence of sentences) {
        if (!sentence) continue;

        if ((current + sentence).length > TTS_MAX_CHARS) {
            if (current) {
                chunks.push(current.trim());
                current = "";
            }
            // If a single sentence is longer than max, hard-split it
            if (sentence.length > TTS_MAX_CHARS) {
                for (let i = 0; i < sentence.length; i += TTS_MAX_CHARS) {
                    chunks.push(sentence.slice(i, i + TTS_MAX_CHARS));
                }
            } else {
                current = sentence;
            }
        } else {
            current += sentence;
        }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(c => c.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
        "audio/ogg": ".ogg",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/webm": ".webm",
    };
    const base = mimeType.split(";")[0].trim().toLowerCase();
    return map[base] ?? ".ogg";
}
