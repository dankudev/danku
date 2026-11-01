// In its own file so deploy.ts files, which import the resource kinds, never load commander.

/** An expected failure: printed without a stack trace, exit code 1. Anything else is a bug. */
export class CliError extends Error {}
