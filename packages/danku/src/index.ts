import { Argument, Command, CommanderError, InvalidArgumentError } from "commander";

import pkg from "../package.json" with { type: "json" };
import { create } from "./create.ts";
import { deploy } from "./deploy.ts";
import { CliError } from "./error.ts";
import { generate } from "./generate.ts";
import { type Run, spawnRun } from "./run.ts";

/**
 * Entry point of `danku`: the only place the program is built and parsed. Returns the exit code
 * instead of exiting; expected failures are printed without a stack trace.
 */
export async function main(argv: string[], run: Run = spawnRun): Promise<number> {
  // Set before any .command(): commander copies these settings to the commands created after.
  const program = new Command("danku")
    .description(pkg.description)
    .version(pkg.version)
    .allowExcessArguments(false)
    // Throw instead of calling process.exit(), so the exit code is returned below.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => console.log(text.trimEnd()),
      writeErr: (text) => console.error(text.trimEnd()),
    });

  program
    .command("create")
    .description("Create a new danku repository in a new folder")
    .addArgument(
      new Argument(
        "<project>",
        "Project name and directory: lowercase letters, digits and dashes",
      ).argParser((project) => {
        // Commander reports this message as an invalid argument.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) {
          throw new InvalidArgumentError("Use lowercase letters, digits and dashes.");
        }
        return project;
      }),
    )
    .addArgument(
      new Argument("<preset>", "What the project is for").choices(["localbusiness", "saas"]),
    )
    .action((project: string, preset: string) => create(project, preset, run));
  program
    .command("deploy")
    .description("Make the cloud match danku/deploy.ts")
    .action(() => deploy(run));
  program
    .command("generate")
    .description("Write the files apps need from danku/deploy.ts, offline")
    .action(() => generate(run));

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    // Commander has already printed its message (or the help, or the version).
    if (error instanceof CommanderError) return error.exitCode;
    // Anything else is a bug: rethrow it so the stack trace is printed.
    if (!(error instanceof CliError)) throw error;
    console.error(error.message);
    return 1;
  }
}
