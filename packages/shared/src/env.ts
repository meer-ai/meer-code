export function applyLegacyT3CodeEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("T3CODE_") || value === undefined) continue;
    const nextKey = `MEER_CODE_${key.slice("T3CODE_".length)}`;
    if (env[nextKey] === undefined) {
      env[nextKey] = value;
    }
  }
}
