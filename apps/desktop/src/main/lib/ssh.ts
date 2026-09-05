import { spawn } from "node:child_process";

/**
 * Shared `ssh://` plumbing for the agent's `read`/`write`/`edit` tools. Auth,
 * host keys and `~/.ssh/config` aliases are entirely the operator's concern:
 * they are set up externally, same as a person would use `ssh` from a
 * terminal. This only shells out to the `ssh` binary and reads or writes
 * what it does.
 */

/** Single-quotes a value for the POSIX shell `ssh` hands the remote command
 *  to. That is the only quoting `ssh`'s argv-to-command-string join needs. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The path component of an `ssh://` URI, decoded. Every caller needs one,
 *  and a URI with none is not pointed at anything. */
export function sshPath(url: URL): string {
  if (url.pathname.length <= 1) {
    throw new Error(`ssh:// URI is missing a path: ${url}`);
  }
  return decodeURIComponent(url.pathname);
}

/**
 * Runs `remoteCommand` over `ssh` and returns what it printed on stdout.
 * `stdin`, if given, is written to the remote command's stdin and closed.
 * That is how `write`/`edit` get file content there without embedding it in
 * the command line.
 */
export async function runSsh(
  url: URL,
  remoteCommand: string,
  stdin?: Buffer,
): Promise<Buffer> {
  const args: string[] = [];
  if (url.port) args.push("-p", url.port);
  const host = url.username ? `${url.username}@${url.hostname}` : url.hostname;
  args.push("--", host, remoteCommand);

  return await new Promise<Buffer>((settle, reject) => {
    const child = spawn("ssh", args, {
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const { stdout, stderr, stdin: childStdin } = child;
    if (!stdout || !stderr) {
      reject(new Error("ssh spawned without stdout/stderr pipes"));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => out.push(chunk));
    stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(message || `ssh exited with code ${code}`));
        return;
      }
      settle(Buffer.concat(out));
    });
    if (stdin !== undefined) {
      if (!childStdin) {
        reject(new Error("ssh spawned without a stdin pipe"));
        return;
      }
      childStdin.end(stdin);
    }
  });
}
