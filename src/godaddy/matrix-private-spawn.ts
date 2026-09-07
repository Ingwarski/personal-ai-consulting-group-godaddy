/** The synchronous spawn inherits a private mask. Restore the Node host's mask
 * before yielding; never change existing files or relax the inherited mask. */
export function withMatrixPrivateUmask<T>(spawn: () => T): T {
  const previous = process.umask();
  process.umask(previous | 0o077);
  try { return spawn(); } finally { process.umask(previous); }
}
