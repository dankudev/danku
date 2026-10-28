import { Command } from "commander";
import { describe, expect, test, vi } from "vite-plus/test";

import { CliError, runProgram } from "../src/index.ts";

/** Silences and records console output; `restoreMocks` in vite.config.ts undoes it after each test. */
function spyConsole() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

/** A program with a subcommand and a nested subcommand, built the way the danku commands are. */
function program(action: () => void | Promise<void> = () => {}) {
  const root = new Command("tool").description("A test tool").version("1.2.3");
  root.command("plan").description("Plan").action(action);
  root.command("apply").option("--force", "Force").action(action);
  root.command("secrets").command("set").action(action);
  return root;
}

describe("runProgram", () => {
  test("returns 0 after the action ran", async () => {
    const action = vi.fn();
    expect(await runProgram(program(action), ["apply", "--force"])).toBe(0);
    expect(action).toHaveBeenCalledOnce();
  });

  test("--help and --version print to console.log and succeed", async () => {
    const console = spyConsole();
    expect(await runProgram(program(), ["--help"])).toBe(0);
    expect(console.log.mock.calls.flat().join("\n")).toContain("Usage: tool");
    expect(await runProgram(program(), ["--version"])).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith("1.2.3");
  });

  test("subcommands are strict too: unknown options and stray words are errors", async () => {
    const console = spyConsole();
    expect(await runProgram(program(), ["apply", "--forse"])).toBe(1);
    expect(console.error.mock.calls.flat().join("\n")).toContain("(Did you mean --force?)");
    expect(await runProgram(program(), ["plan", "extra"])).toBe(1);
    expect(console.error.mock.lastCall?.[0]).toContain("too many arguments for 'plan'");
    // Nested subcommands get the settings as well.
    expect(await runProgram(program(), ["secrets", "set", "extra"])).toBe(1);
    expect(console.error.mock.lastCall?.[0]).toContain("too many arguments for 'set'");
  });

  test("an unknown command fails with a suggestion; no command prints the help and fails", async () => {
    const console = spyConsole();
    expect(await runProgram(program(), ["aply"])).toBe(1);
    expect(console.error.mock.calls.flat().join("\n")).toContain("(Did you mean apply?)");
    expect(await runProgram(program(), [])).toBe(1);
  });

  test("a CliError prints its message and returns 1", async () => {
    const console = spyConsole();
    const fail = () => {
      throw new CliError("danku/infra.ts not found");
    };
    expect(await runProgram(program(fail), ["plan"])).toBe(1);
    expect(console.error.mock.calls).toEqual([["danku/infra.ts not found"]]);
  });

  test("any other error is a bug and is rethrown", async () => {
    spyConsole();
    const bug = () => {
      throw new TypeError("bug");
    };
    await expect(runProgram(program(bug), ["plan"])).rejects.toThrow(new TypeError("bug"));
  });
});
