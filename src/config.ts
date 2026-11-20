/** Reads `--api-key <key>` or `--api-key=<key>`; falls back to SKETCHFAB_API_KEY. */
export function resolveApiKey(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--api-key=")) return arg.slice("--api-key=".length) || undefined;
    if (arg === "--api-key" && argv[i + 1]) return argv[i + 1];
  }
  return env.SKETCHFAB_API_KEY || undefined;
}
