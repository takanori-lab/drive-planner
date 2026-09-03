export const REQUIRED_SECRETS: readonly string[];
export function missingSecrets(entries: Array<{ name: string }>): string[];
