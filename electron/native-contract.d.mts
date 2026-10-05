export const NATIVE_CONTRACT_FILE: string;
export interface NativeContract { schema: number; shellCommit: string; sourceSha256: string; resourcesSha256: string }
export function nativeResourceDigest(resources: string): string;
export function nativeSourceDigest(repo: string, commit: string): string;
export function stampNativeContract(resources: string, repo: string, commit: string): NativeContract;
export function assertNativeCompatibility(resources: string, repo: string, commit: string): NativeContract;
