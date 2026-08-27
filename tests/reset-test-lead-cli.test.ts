/**
 * Real-process CLI tests for scripts/reset-test-lead.ts -- these actually spawn
 * `node <tsx cli> scripts/reset-test-lead.ts <args>` as a child process (never a real Supabase
 * call: see the env-var notes on each test below), which is the only way to catch the class of
 * bug this file exists to guard against -- a broken `import.meta.url`/`process.argv[1]` entry
 * guard that made the CLI exit silently on Windows without ever calling main() (see
 * scripts/reset-test-lead.ts's header comment for the full root-cause explanation).
 *
 * Every test here either fails before any Supabase access happens (bad argv, caught by
 * parseArgs) or points SUPABASE_URL at an unreachable local port so that even the dry-run's real
 * network read fails fast -- no test in this file ever reaches a real Supabase project, and none
 * ever pass --confirm, so the RPC-calling code path is never exercised here at all.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/reset-test-lead.ts", import.meta.url));

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

/** Runs the real CLI as a child process. Always resolves (never throws), even on a non-zero exit
 * code, so tests can assert on stdout/stderr/exitCode uniformly. */
async function runCli(args: string[], envOverrides: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [TSX_CLI, SCRIPT, ...args],
      { cwd: PROJECT_ROOT, env: { ...process.env, ...envOverrides }, timeout: 20_000 },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
  }
}

describe("reset-test-lead CLI (real process)", () => {
  it("never exits silently: an invalid --lead-id produces output and a non-zero exit code", async () => {
    // No Supabase env needed: parseArgs throws before main() ever imports supabase-client.js.
    const result = await runCli(["--lead-id", "not-a-uuid", "--conversation-id", UUID_B]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).not.toBe("");
    expect(result.stderr).toContain("not a valid UUID");
  }, 20_000);

  it("never exits silently: a missing --conversation-id produces output and a non-zero exit code", async () => {
    const result = await runCli(["--lead-id", UUID_A]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).not.toBe("");
    expect(result.stderr).toContain("--conversation-id is required");
  }, 20_000);

  it("an unrecognized flag produces output and a non-zero exit code", async () => {
    const result = await runCli(["--lead-id", UUID_A, "--conversation-id", UUID_B, "--wat"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unrecognized argument");
  }, 20_000);

  it("dry run (no --confirm) actually runs main() and prints the DRY RUN banner, proving the entry guard fix works", async () => {
    // Points Supabase at an unreachable local port so the dry-run's real network read fails fast
    // instead of hitting any real project. The DRY RUN banner is printed BEFORE that network
    // call, so it still appears in stdout even though the run ultimately errors out afterward --
    // that's fine, this test only asserts the entrypoint truly executes main() end-to-end up to
    // that point (which the old broken guard prevented entirely: no output, exit code 0).
    const result = await runCli(
      ["--lead-id", UUID_A, "--conversation-id", UUID_B],
      { SUPABASE_URL: "http://127.0.0.1:39999", SUPABASE_SECRET_KEY: "fake-key-for-cli-test" },
    );

    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("no changes will be made");
    // The write-path banner must never appear when --confirm was not passed.
    expect(result.stdout).not.toContain("CONFIRMED RESET");
  }, 20_000);

  it("write logic is never reached without --confirm, even with valid-looking args (asserted via absence of any RPC-path output)", async () => {
    const result = await runCli(
      ["--lead-id", UUID_A, "--conversation-id", UUID_B],
      { SUPABASE_URL: "http://127.0.0.1:39999", SUPABASE_SECRET_KEY: "fake-key-for-cli-test" },
    );

    expect(result.stdout).not.toContain("CONFIRMED RESET");
    expect(result.stdout).not.toContain("Deleted:");
  }, 20_000);
});
