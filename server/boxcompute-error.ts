/** A BoxCompute failure with the HTTP status the harness relays to the agent. */
export class BoxComputeError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
