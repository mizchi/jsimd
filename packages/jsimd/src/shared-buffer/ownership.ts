/** Shared lease contract used by exclusive-owner metadata. */
export interface SharedOwnershipBuffer {
  readonly disposed: boolean;
  readonly leaseToken: number;
  isLeaseTokenActive(leaseToken: number): boolean;
}

/** Claims an empty owner word or replaces a token whose Worker generation is no longer active. */
export function tryClaimSharedOwner(
  buffer: SharedOwnershipBuffer,
  owners: Int32Array,
  index: number,
): boolean {
  assertOwnershipBufferAlive(buffer);
  const own = buffer.leaseToken;
  while (true) {
    const current = Atomics.load(owners, index);
    if (current === own) return false;
    if (current !== 0 && buffer.isLeaseTokenActive(current)) return false;
    if (Atomics.compareExchange(owners, index, current, own) === current) return true;
  }
}

export function releaseSharedOwner(
  buffer: SharedOwnershipBuffer,
  owners: Int32Array,
  index: number,
): boolean {
  return Atomics.compareExchange(owners, index, buffer.leaseToken, 0) === buffer.leaseToken;
}

export function assertSharedOwner(
  buffer: SharedOwnershipBuffer,
  owners: Int32Array,
  index: number,
  message: string,
): void {
  assertOwnershipBufferAlive(buffer);
  if (Atomics.load(owners, index) !== buffer.leaseToken) throw new Error(message);
}

function assertOwnershipBufferAlive(buffer: SharedOwnershipBuffer): void {
  if (buffer.disposed) throw new Error("shared worker lease has been disposed or reclaimed");
}
