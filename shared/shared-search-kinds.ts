export const sharedSearchKinds = ["all", "people", "bots", "files", "links", "results"] as const;
export type SharedSearchKind = typeof sharedSearchKinds[number];
