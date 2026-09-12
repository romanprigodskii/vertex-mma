import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where user avatars are written.
 *
 * They used to go into a Supabase storage bucket. That project was deleted, and
 * the replacement is deliberately smaller than a storage service: the app and
 * the static nginx in `ops/photos` share one directory on the host, the app
 * writes into it, nginx serves it at /avatars/. Nothing has to authenticate,
 * because nothing crosses a network boundary.
 *
 * AVATAR_DIR is the app's side of that bind mount. When it is unset — a dev box
 * with no mount — an upload fails with a clear message rather than writing
 * somewhere nobody serves.
 */
const PUBLIC_PREFIX = "/avatars";

export class AvatarStoreError extends Error {}

function storeRoot(): string {
  const dir = process.env.AVATAR_DIR;
  if (!dir) {
    throw new AvatarStoreError(
      "AVATAR_DIR is not set — avatar uploads have nowhere to go. See ops/photos/README.md.",
    );
  }
  return path.resolve(dir);
}

/**
 * Write one avatar and return the URL it will be served at.
 *
 * `relativePath` is built from the session (`<auth user id>/avatar.<ext>`),
 * never from client input — that is the authorization boundary. The containment
 * check below is the belt to that braces: whatever the caller passes, nothing
 * lands outside the store.
 */
export async function putAvatar(
  relativePath: string,
  bytes: Buffer,
): Promise<string> {
  const root = storeRoot();
  const dest = path.resolve(root, relativePath);
  if (!dest.startsWith(root + path.sep)) {
    throw new AvatarStoreError(
      `refusing to write outside the avatar store: ${relativePath}`,
    );
  }

  await mkdir(path.dirname(dest), { recursive: true });
  // Write beside the target and rename: nginx serves this directory live, so a
  // reader must never catch a half-written file.
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  const site = (
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://vertexmma.com"
  ).replace(/\/$/, "");
  return `${site}${PUBLIC_PREFIX}/${relativePath}`;
}
