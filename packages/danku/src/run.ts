import { spawn } from "node:child_process";

import { CliError } from "./error.ts";

/** Runs a command in `cwd`; tests replace it so nothing is spawned. */
export type Run = (command: string, args: string[], cwd: string) => Promise<void>;

/** Runs a command attached to the terminal; rejects when it cannot start or exits non-zero. */
export const spawnRun: Run = (command, args, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new CliError(`${command} was not found; is it installed and on PATH?`)
          : error,
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new CliError(`${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}`),
        );
    });
  });
