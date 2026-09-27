export const sharedSearchKinds = ["all", "people", "bots", "files", "links", "results", "pinned"] as const;
export type SharedSearchKind = typeof sharedSearchKinds[number];
