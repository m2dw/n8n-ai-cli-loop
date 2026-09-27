/**
 * Unit tests for the descriptor-pinned artifact write in
 * src/handlers/agent-isolation.ts (`pinArtifactDir`,
 * `writeContainedArtifactFile`).
 *
 * The guarantee under test is containment of the PARENT components, not of the
 * leaf: `writeArtifactFile`'s `O_NOFOLLOW` refuses a symlinked artifact NAME and
 * says nothing about the directory above it, so validating the directory by path
 * and then opening `<dir>/<name>` leaves a window in which a local actor can
 * replace the directory with a symlink and carry the write out of the session's
 * artifact root. The pinned write closes that window by resolving the parent
 * from a descriptor instead of from the path a second time.
 *
 * The swap here is performed BETWEEN the pin and the write — exactly where the
 * race would land — so the test is deterministic and needs no timing.
 */
import {
  constants as fsConstants,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  IncompleteArtifactWriteError,
  UnsafeArtifactDirError,
  UnsafeArtifactPathError,
  pinArtifactDir,
  writeAllSync,
  writeContainedArtifactFile,
  writeThroughGuardedDir,
} from '../dist/handlers/agent-isolation.js';

let root;
let artifactRoot;
let artifactDir;
let outside;

/**
 * Whether THIS platform can name an open directory descriptor as a path — the
 * same capability the module probes for. Where it can, a write made after the
 * directory was swapped still lands in the pinned directory; where it cannot,
 * the pinned write refuses rather than following the swap. Either way nothing
 * lands outside, which is the property that matters; the probe only lets the
 * test say which of the two answers to expect.
 */
function fdTraversalSupported() {
  const base = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
  if (base === null) return false;
  const fd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const pinned = statSync(root);
    const through = statSync(`${base}/${fd}/.`);
    return through.isDirectory() && through.dev === pinned.dev && through.ino === pinned.ino;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether this platform will also walk `..` OUT of a descriptor name — the
 * capability the containment ascent needs, and the one the module probes for
 * before it trusts a descriptor path with a containment root. A platform that
 * traverses `.` but not `..` falls back to the path-based write, which refuses
 * rather than following; the probe only lets the test say which answer to expect.
 */
function fdAscentSupported() {
  const base = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
  if (base === null) return false;
  // Probed on the artifact ROOT, which every case here keeps in place: a probe on
  // a directory a test has already renamed would answer about the rename.
  const fd = openSync(artifactRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    const pinned = statSync(artifactRoot);
    const through = statSync(`${base}/${fd}/.`);
    if (!through.isDirectory() || through.dev !== pinned.dev || through.ino !== pinned.ino) return false;
    const up = statSync(`${base}/${fd}/..`);
    const parent = statSync(join(artifactRoot, '..'));
    return up.dev === parent.dev && up.ino === parent.ino;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifact-pin-'));
  artifactRoot = join(root, 'artifacts');
  artifactDir = join(artifactRoot, 'runs', 'run-1');
  outside = join(root, 'outside');
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a contained artifact write', () => {
  test('writes the file into the directory it was given', () => {
    writeContainedArtifactFile(artifactDir, 'evidence-raw.txt', 'transcript');
    expect(readFileSync(join(artifactDir, 'evidence-raw.txt'), 'utf8')).toBe('transcript');
    expect(readdirSync(outside)).toEqual([]);
  });

  test('replaces the contents of a file it wrote before', () => {
    writeContainedArtifactFile(artifactDir, 'evidence-raw.txt', 'first attempt, longer');
    writeContainedArtifactFile(artifactDir, 'evidence-raw.txt', 'second');
    expect(readFileSync(join(artifactDir, 'evidence-raw.txt'), 'utf8')).toBe('second');
  });

  test('refuses an artifact directory that is a symlink', () => {
    const linked = join(root, 'linked-run');
    symlinkSync(outside, linked);
    expect(() => writeContainedArtifactFile(linked, 'evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
    expect(readdirSync(outside)).toEqual([]);
  });

  test('refuses a path that does not name a directory', () => {
    const file = join(root, 'not-a-dir');
    writeFileSync(file, '', 'utf8');
    expect(() => writeContainedArtifactFile(file, 'evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
  });

  test('refuses an artifact NAME that is a symlink out of the directory', () => {
    const target = join(outside, 'stolen.txt');
    writeFileSync(target, 'original', 'utf8');
    symlinkSync(target, join(artifactDir, 'evidence-raw.txt'));
    expect(() => writeContainedArtifactFile(artifactDir, 'evidence-raw.txt', 'transcript')).toThrow(
      UnsafeArtifactPathError,
    );
    expect(readFileSync(target, 'utf8')).toBe('original');
  });
});

describe('a directory swapped for a symlink after it was checked', () => {
  /**
   * Stand in for the local actor of the threat model: the artifact directory
   * passes every check the caller can make, and is then replaced — atomically,
   * from another process — with a link pointing out of the session root. In
   * production the swap lands between the containment check and the `open`; here
   * it lands between the pin and the write, which is the same window.
   */
  function swapForSymlink() {
    const moved = join(root, 'moved-run');
    renameSync(artifactDir, moved);
    symlinkSync(outside, artifactDir);
    return moved;
  }

  test('cannot redirect a pinned write out of the artifact root', () => {
    const pin = pinArtifactDir(artifactDir);
    try {
      const moved = swapForSymlink();
      expect(lstatSync(artifactDir).isSymbolicLink()).toBe(true);
      if (fdTraversalSupported()) {
        // The parent components come from the descriptor, so the swapped path is
        // simply not consulted: the bytes land in the very directory that was
        // admitted, wherever its path now points.
        pin.write('evidence-raw.txt', 'transcript');
        expect(readFileSync(join(moved, 'evidence-raw.txt'), 'utf8')).toBe('transcript');
      } else {
        // No descriptor-relative path on this platform: the write refuses rather
        // than following the swap.
        expect(() => pin.write('evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
      }
      // The one thing that must hold on every platform.
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      pin.close();
    }
  });

  test('cannot destroy a file the swapped-in directory already holds', () => {
    const target = join(outside, 'evidence-raw.txt');
    writeFileSync(target, 'somebody else\'s file', 'utf8');
    const pin = pinArtifactDir(artifactDir);
    try {
      swapForSymlink();
      try {
        pin.write('evidence-raw.txt', 'transcript');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsafeArtifactDirError);
      }
      expect(readFileSync(target, 'utf8')).toBe('somebody else\'s file');
    } finally {
      pin.close();
    }
  });

  test('a released pin writes nothing at all', () => {
    const pin = pinArtifactDir(artifactDir);
    pin.close();
    pin.close();
    expect(() => pin.write('evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
    expect(readdirSync(artifactDir)).toEqual([]);
  });
});

/**
 * Pinning the directory's IDENTITY is not by itself containment: the pinned
 * inode can be MOVED. A local actor who renames the admitted directory out of
 * the session artifact root after the pin leaves every later write landing in
 * the same directory as before — now sitting wherever the rename put it, which
 * is the escape the descriptor pin was introduced to prevent. So the root is
 * pinned as well, and the pinned directory has to still be reachable beneath it
 * when the bytes land.
 */
describe('a pinned write with a containment root', () => {
  test('writes into a directory that is inside the root', () => {
    writeContainedArtifactFile(artifactDir, 'evidence-raw.txt', 'transcript', artifactRoot);
    expect(readFileSync(join(artifactDir, 'evidence-raw.txt'), 'utf8')).toBe('transcript');
    expect(readdirSync(outside)).toEqual([]);
  });

  test('refuses a directory that already sits outside the root', () => {
    expect(() => writeContainedArtifactFile(outside, 'evidence-raw.txt', 'transcript', artifactRoot)).toThrow(
      UnsafeArtifactDirError,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  test('refuses a root that is not a directory', () => {
    const file = join(root, 'not-a-root');
    writeFileSync(file, '', 'utf8');
    expect(() => writeContainedArtifactFile(artifactDir, 'evidence-raw.txt', 'transcript', file)).toThrow(
      UnsafeArtifactDirError,
    );
    expect(readdirSync(artifactDir)).toEqual([]);
  });

  test('refuses a pinned directory renamed out of the root after it was pinned', () => {
    const pin = pinArtifactDir(artifactDir, artifactRoot);
    try {
      const moved = join(outside, 'moved-run');
      renameSync(artifactDir, moved);
      expect(() => pin.write('evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
      // Not even the empty file `O_CREAT` would leave behind: the ascent runs
      // before the open, so a directory already outside is never opened into.
      expect(readdirSync(moved)).toEqual([]);
    } finally {
      pin.close();
    }
  });

  test('still writes into the pinned directory when it is moved WITHIN the root', () => {
    const pin = pinArtifactDir(artifactDir, artifactRoot);
    try {
      const moved = join(artifactRoot, 'runs', 'run-1-moved');
      renameSync(artifactDir, moved);
      if (fdAscentSupported()) {
        // Containment is a question about where the directory is, not about the
        // name it is reached by: a move that stays inside the root is not an
        // escape, and the pinned directory is still the one admitted.
        pin.write('evidence-raw.txt', 'transcript');
        expect(readFileSync(join(moved, 'evidence-raw.txt'), 'utf8')).toBe('transcript');
      } else {
        // No usable descriptor-relative path: the write refuses rather than
        // resolving the moved directory through a path that no longer names it.
        expect(() => pin.write('evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
      }
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      pin.close();
    }
  });

  test('refuses a rooted pin whose directory is swapped for a symlink out of the root', () => {
    const pin = pinArtifactDir(artifactDir, artifactRoot);
    try {
      const moved = join(outside, 'moved-run');
      renameSync(artifactDir, moved);
      symlinkSync(outside, artifactDir);
      expect(() => pin.write('evidence-raw.txt', 'transcript')).toThrow(UnsafeArtifactDirError);
      expect(readdirSync(outside)).toEqual(['moved-run']);
      expect(readdirSync(moved)).toEqual([]);
    } finally {
      pin.close();
    }
  });
});

/**
 * The window no ordering of checks can close: the descriptor stays valid across
 * a rename, so a directory moved out of the root AFTER the last containment
 * ascent and BEFORE the bytes land carries the opened file with it, and the
 * write reaches a directory the actor chose. The guard therefore runs once more
 * with the bytes already down, and what it finds outside the root is erased
 * through the descriptor rather than left there.
 *
 * That ordering is a race against the kernel that no test can provoke on a real
 * filesystem, so the GUARD is the stub here — the same reason the short-write
 * cases below stub `write`. What it stubs is only WHEN the escape is noticed;
 * the erasure under test is the module's.
 */
describe('a directory that escapes the root after the bytes have landed', () => {
  test('erases the transcript it wrote outside the root', () => {
    const moved = join(outside, 'moved-run');
    let calls = 0;
    expect(() =>
      writeThroughGuardedDir(artifactDir, 'evidence-raw.txt', 'transcript', () => {
        calls += 1;
        // The first two calls are the pre-open and pre-truncate checks, which a
        // rename this late passes; only the third can see it.
        if (calls < 3) return;
        renameSync(artifactDir, moved);
        throw new UnsafeArtifactDirError('the pinned artifact directory is no longer inside the artifact root');
      }),
    ).toThrow(UnsafeArtifactDirError);
    expect(calls).toBe(3);
    // The file went with the directory — that much a descriptor cannot prevent.
    // What must not survive outside the root is its CONTENT.
    expect(readdirSync(moved)).toEqual(['evidence-raw.txt']);
    expect(readFileSync(join(moved, 'evidence-raw.txt'), 'utf8')).toBe('');
  });

  test('leaves no earlier transcript behind either', () => {
    // The truncate that precedes the write has already destroyed the previous
    // content, so the erasure must not be mistaken for a rollback to it.
    writeFileSync(join(artifactDir, 'evidence-raw.txt'), 'an-earlier-transcript', 'utf8');
    let calls = 0;
    expect(() =>
      writeThroughGuardedDir(artifactDir, 'evidence-raw.txt', 'a-later-transcript', () => {
        calls += 1;
        if (calls < 3) return;
        throw new UnsafeArtifactDirError('the pinned artifact directory is no longer inside the artifact root');
      }),
    ).toThrow(UnsafeArtifactDirError);
    expect(readFileSync(join(artifactDir, 'evidence-raw.txt'), 'utf8')).toBe('');
  });

  test('writes the whole transcript when the directory is still contained afterwards', () => {
    let calls = 0;
    writeThroughGuardedDir(artifactDir, 'evidence-raw.txt', 'transcript', () => {
      calls += 1;
    });
    // Three: before the open, before anything is destroyed, and after the bytes.
    expect(calls).toBe(3);
    expect(readFileSync(join(artifactDir, 'evidence-raw.txt'), 'utf8')).toBe('transcript');
    expect(readdirSync(outside)).toEqual([]);
  });
});

/**
 * `write(2)` may return having written fewer bytes than it was handed, without
 * raising — a filesystem filling up mid-write is the case that matters here,
 * because the caller records a digest and byte count for the FULL content it
 * handed over. A real short write cannot be provoked from a test on a regular
 * file, so the write call itself is the stub: the loop under test is the whole
 * behaviour, and the stub is what makes the two paths deterministic.
 */
describe('an artifact write that the filesystem accepts only in part', () => {
  test('keeps writing until every byte has landed', () => {
    const bytes = Buffer.from('transcript-that-arrives-in-pieces', 'utf8');
    const landed = Buffer.alloc(bytes.length);
    const calls = [];
    // Three bytes per call, the way a kernel is entitled to split a write.
    writeAllSync(-1, bytes, 'evidence-raw.txt', (_fd, buffer, offset, length, position) => {
      const n = Math.min(3, length);
      buffer.copy(landed, position, offset, offset + n);
      calls.push({ offset, length, position });
      return n;
    });
    expect(landed.toString('utf8')).toBe(bytes.toString('utf8'));
    // Each call resumes at the offset the last one reached, in the file and in
    // the buffer alike — a loop that rewrote from 0 would also produce the right
    // bytes here and the wrong ones on a file already partly written.
    expect(calls.map((c) => c.offset)).toEqual(calls.map((c) => c.position));
    expect(calls[0]).toEqual({ offset: 0, length: bytes.length, position: 0 });
    expect(calls[1].offset).toBe(3);
    expect(calls[calls.length - 1].offset + 3).toBeGreaterThanOrEqual(bytes.length);
  });

  test('fails rather than reporting a truncated artifact as written', () => {
    const bytes = Buffer.from('transcript-that-runs-out-of-space', 'utf8');
    let delivered = 0;
    // Accepts a first chunk, then reports no progress — a full disk.
    expect(() =>
      writeAllSync(-1, bytes, 'evidence-raw.txt', (_fd, _buffer, _offset, length) => {
        if (delivered > 0) return 0;
        delivered = Math.min(5, length);
        return delivered;
      }),
    ).toThrow(IncompleteArtifactWriteError);
    expect(delivered).toBe(5);
  });

  test('does not call write at all for empty content', () => {
    let calls = 0;
    writeAllSync(-1, Buffer.alloc(0), 'evidence-raw.txt', () => {
      calls += 1;
      return 0;
    });
    expect(calls).toBe(0);
  });
});
