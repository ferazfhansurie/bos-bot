export function compatEnvironment<T extends Record<string, string | undefined> | undefined>(environment: T): T;
export const compatEnv: NodeJS.ProcessEnv;
export function isBrandEnvName(name: string): boolean;
export function expandEnvNames(names: readonly string[]): string[];
