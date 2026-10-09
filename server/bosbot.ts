// Entry point for the `bosbot` command (see cli.ts).
import { main } from "./cli.ts";
import { exitAfterFlush } from "./exit.ts";

main().then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
