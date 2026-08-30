/**
 * Which build is actually running.
 *
 * Born from a real cost: across one long session the operator and I
 * repeatedly could not tell whether a fix had reached their machine, and
 * twice debugged behaviour that a `git pull` had already fixed. The screen
 * should simply say. Read from the checkout at request time (local operator
 * mode runs from the repo); falls back to an env var for hosted builds,
 * and to null when neither is available — never a guess.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BuildInfo {
  /** Short commit sha, e.g. "48a8156". */
  commit: string;
  /** Branch name when the checkout is on one. */
  branch: string | null;
}

function repoRoot(): string {
  const here = process.cwd();
  return existsSync(join(here, 'rules', 'fixtures')) ? here : join(here, '../..');
}

/** Resolve HEAD without shelling out to git (Windows-safe, no spawn). */
function fromGit(dir: string): BuildInfo | null {
  const gitDir = join(dir, '.git');
  if (!existsSync(gitDir)) return null;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref: (.+)$/.exec(head);
    if (!ref) return { commit: head.slice(0, 7), branch: null };
    const branch = ref[1]!.replace(/^refs\/heads\//, '');
    const refPath = join(gitDir, ref[1]!);
    if (existsSync(refPath)) {
      return { commit: readFileSync(refPath, 'utf8').trim().slice(0, 7), branch };
    }
    // Packed refs: the loose file is absent after a gc/clone.
    const packed = join(gitDir, 'packed-refs');
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref[1] && sha) return { commit: sha.slice(0, 7), branch };
      }
    }
    return { commit: 'unknown', branch };
  } catch {
    return null;
  }
}

let cached: BuildInfo | null | undefined;

export function buildInfo(): BuildInfo | null {
  if (cached !== undefined) return cached;
  const env = process.env.TAXFS_BUILD_COMMIT;
  cached = env
    ? { commit: env.slice(0, 7), branch: process.env.TAXFS_BUILD_BRANCH ?? null }
    : fromGit(repoRoot()) ?? fromGit(dirname(dirname(process.cwd())));
  return cached;
}
