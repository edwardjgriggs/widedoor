import { randomBytes } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes dir/name without following a link that sits at that name: the bytes
 * go to a new temp file in the same folder (opened with wx, so it cannot be a
 * planted file or link), which is then renamed over the name. A rename replaces
 * a symbolic link or junction at the target instead of writing through it.
 * The file is always created fresh, so mode always applies.
 */
export async function writeFileReplacing(
  dir: string,
  name: string,
  data: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const file = await open(temp, 'wx', mode);
  try {
    await file.writeFile(data);
  } catch (e) {
    await file.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw e;
  }
  await file.close();
  try {
    // A directory (or a junction, which reads as a link) at the name is not replaced silently.
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isDirectory()) throw new Error(`${name} is a folder`);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}
