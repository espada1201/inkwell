import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const KEY = 'tremor.sk';
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** This browser's node identity: a Nostr keypair generated once and kept in localStorage. */
export function loadIdentity(store: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
  let hex = store?.getItem(KEY) ?? '';
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    hex = toHex(generateSecretKey());
    store?.setItem(KEY, hex);
  }
  const sk = fromHex(hex);
  return { sk, pubkey: getPublicKey(sk) };
}

/** This browser's localStorage, or null where it is blocked. A write it refuses, when full or locked down, is dropped. */
export function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  let store: Storage | undefined;
  try {
    store = globalThis.localStorage;
  } catch {
    return null;
  }
  if (!store) return null;
  return {
    getItem: (k) => store.getItem(k),
    setItem: (k, v) => {
      try {
        store.setItem(k, v);
      } catch {}
    },
  };
}
