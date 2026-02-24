import * as esbuild from "esbuild";
import { existsSync, rmSync, mkdirSync } from "fs";

const isProd = process.env.NODE_ENV === "production";

async function build() {
  try {
    console.log("Building channel-discord plugin...");
    console.log(`Mode: ${isProd ? "production" : "development"}\n`);

    if (existsSync("dist")) {
      rmSync("dist", { recursive: true, force: true });
    }
    mkdirSync("dist", { recursive: true });

    await esbuild.build({
      entryPoints: ["src/app.ts"],
      outfile: "dist/app.js",
      bundle: true,
      platform: "node",
      target: "node18",
      format: "esm",
      sourcemap: !isProd,
      minify: isProd,
      treeShaking: true,
        external: [
        "node:*", "http", "https", "fs", "path", "os", "crypto", "stream",
        "util", "events", "buffer", "child_process", "url", "readline",
        "net", "tls", "zlib",
        "better-sqlite3", "nanoid",
        "discord.js", "@discordjs/rest", "@discordjs/ws",
        "@discordjs/voice", "@discordjs/opus", "opusscript", "prism-media",
        "dotenv",
      ],
      banner: { js: "" },
    });
    console.log("Built app.js");
    console.log("\nBuild complete!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
