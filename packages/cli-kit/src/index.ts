import { type Command, CommanderError } from "commander";

export class CliError extends Error {}

export async function runProgram(program: Command, argv: string[]): Promise<number> {
  const configure = (command: Command) => {
    command
      .allowExcessArguments(false)
      // Throw instead of calling process.exit(), so the exit code is returned below.
      .exitOverride()
      .configureOutput({
        writeOut: (text) => console.log(text.trimEnd()),
        writeErr: (text) => console.error(text.trimEnd()),
      });
    command.commands.forEach(configure);
  };
  configure(program);

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
