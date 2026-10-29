import { writeSync } from 'node:fs';
import { PinnedResolver, logValue } from '@widedoor/web/egress';
import { runHostedScan } from './agent.js';
import { runVerification } from './verify-check.js';
import {
  CONTACT_URL_ENV,
  ChildJobSchema,
  DEFAULT_CONTACT_URL,
  INPUT_REFUSED,
  PROXY_URL_ENV,
  type JobResult,
} from './protocol.js';

/*
 * The scan child: agent-bin starts it as uid 10001 in the scan machine (the
 * current user elsewhere), with no job token in its environment. It reads one
 * job from stdin (ChildJobSchema), runs it (runHostedScan, or runVerification
 * for a verify job: no browser, no veraPDF, no robots.txt) and writes the
 * result as one JSON line on stdout; agent-bin takes the last line. SIGTERM
 * stops the scan (its browser and veraPDF with it). Its stderr carries only
 * `widedoor event=` lines (agent-bin drops anything else): console output,
 * process warnings and Node's crash printers are silenced, since they could
 * quote a URL, a file name or scanned text. The lines carry no job id:
 * agent-bin adds its own, and drops a child line that names one.
 */

/** Largest job read from stdin: a 25 MiB upload as base64, plus the input. */
const MAX_JOB_BYTES = 40 * 1024 * 1024;

/** All of stdin, or undefined once it passes max bytes. */
async function readStdin(max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).length;
    if (total > max) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const write = (result: JobResult) =>
  new Promise<void>((done) => process.stdout.write(`${JSON.stringify(result)}\n`, () => done()));

/** Ends the child after a crash: one event line naming the error's constructor, never its message. */
function crash(e: unknown): never {
  const name = (e as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
  writeSync(2, `widedoor event=agent_child_crash error=${logValue(String(name ?? 'unknown'))}\n`);
  process.exit(70);
}

async function main(): Promise<number> {
  // stdout carries only the result; console output and process warnings go nowhere.
  for (const level of ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const)
    console[level] = () => {};
  process.removeAllListeners('warning');
  process.on('warning', () => {});
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  const proxyUrl = process.env[PROXY_URL_ENV];
  if (!proxyUrl) {
    await write({ status: 'failed', error: 'the scan machine has no egress proxy' });
    return 0;
  }
  const bytes = await readStdin(MAX_JOB_BYTES);
  let parsed;
  try {
    parsed =
      bytes === undefined ? undefined : ChildJobSchema.safeParse(JSON.parse(bytes.toString()));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    await write({ status: 'failed', error: INPUT_REFUSED });
    return 0;
  }
  const { input, pdf } = parsed.data;
  const shared = {
    proxyUrl,
    resolver: new PinnedResolver(),
    contactUrl: process.env[CONTACT_URL_ENV] || DEFAULT_CONTACT_URL,
    signal: controller.signal,
    log: (line: string) => void process.stderr.write(`${line}\n`),
  };
  const { target } = input;
  await write(
    target.kind === 'verify'
      ? await runVerification({ host: target.host, token: target.token, ...shared })
      : await runHostedScan({
          input,
          ...(pdf !== undefined ? { pdf: Buffer.from(pdf, 'base64') } : {}),
          ...shared,
        }),
  );
  return 0;
}

// Only as a process entry point.
if (import.meta.main) {
  // Node's default printers would write the message and the stack.
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  main().then((code) => process.exit(code), crash);
}
