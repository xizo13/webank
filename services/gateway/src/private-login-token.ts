import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

export function requiredLoginTokenPath(name: string): string {
  const path = process.env[name];
  if (!path || !isAbsolute(path))
    throw new Error(`${name} must be an absolute path to a new private file`);
  return path;
}

export async function writePrivateLoginToken(
  path: string,
  token: string,
): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let identity: { dev: number; ino: number } | undefined;
  try {
    await file.writeFile(`${token}\n`, "utf8");
    await file.sync();
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
      throw new Error("Login token file must be a regular mode 0600 file");
    identity = { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    await file.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  await file.close();
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.dev !== identity?.dev ||
    metadata.ino !== identity?.ino
  )
    throw new Error("Login token file must be a regular mode 0600 file");
}
