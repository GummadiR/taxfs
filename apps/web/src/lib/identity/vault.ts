/**
 * The identity vault — BROWSER ONLY (§5 / N8). Names, SSNs, DOBs and the
 * address live in IndexedDB on this device, encrypted with a key derived
 * from the operator's passphrase (Argon2id → AES-256-GCM). Per workspace.
 * Nothing in this module can run server-side (indexedDB/crypto.subtle are
 * browser APIs), and no server code imports it — the server has no identity
 * fields to receive, which is the whole guarantee.
 */
import { argon2id } from 'hash-wasm';
import type { FilingIdentity } from '@taxfs/forms/identity';

const DB_NAME = 'taxfs-identity';
const STORE = 'profiles';

// OWASP-recommended Argon2id floor (m=19 MiB, t=2, p=1) — interactive-use
// friendly on modest hardware while far above PBKDF2-class cost.
const ARGON2 = { parallelism: 1, iterations: 2, memorySize: 19 * 1024, hashLength: 32 };

interface StoredProfile {
  workspace_id: string;
  salt_b64: string;
  iv_b64: string;
  ciphertext_b64: string;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id({ password: passphrase, salt, ...ARGON2, outputType: 'binary' });
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'workspace_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export async function saveIdentity(workspaceId: string, passphrase: string, identity: FilingIdentity): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(identity));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const record: StoredProfile = {
    workspace_id: workspaceId,
    salt_b64: b64(salt),
    iv_b64: b64(iv),
    ciphertext_b64: b64(ciphertext),
  };
  await idb('readwrite', (store) => store.put(record));
}

/** null = no profile stored for this workspace. A wrong passphrase throws
 *  (AES-GCM authentication fails) — never a silently-wrong identity. */
export async function loadIdentity(workspaceId: string, passphrase: string): Promise<FilingIdentity | null> {
  const record = (await idb<StoredProfile | undefined>('readonly', (store) => store.get(workspaceId))) ?? null;
  if (!record) return null;
  const key = await deriveKey(passphrase, unb64(record.salt_b64));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(record.iv_b64) as Uint8Array<ArrayBuffer> },
    key,
    unb64(record.ciphertext_b64) as Uint8Array<ArrayBuffer>,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as FilingIdentity;
}

export async function deleteIdentity(workspaceId: string): Promise<void> {
  await idb('readwrite', (store) => store.delete(workspaceId));
}
