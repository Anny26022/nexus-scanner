import type { Snapshot } from './snapshotScreen';

export interface PackDescriptor {
  url: string;
  bytes: number;
  sha256: string;
  encoding: 'gzip';
  schemaVersion: 7;
}
export type PublicPackName = 'core' | 'technical' | 'fundamentals';
export type PublicPacks = Record<PublicPackName, PackDescriptor>;

interface PartialSnapshot extends Omit<Snapshot, 'stocks'> { schemaVersion: 7; stocks: Array<Record<string, unknown> & {symbol:string}> }
const memory = new Map<string, Promise<PartialSnapshot>>();
const DB = 'nexus-scanner-packs-v1', STORE = 'packs';

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStored(key: string): Promise<Uint8Array | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? new Uint8Array(request.result) : null);
    request.onerror = () => resolve(null);
  });
}

async function store(key: string, bytes: Uint8Array, revision: string) {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key);
    tx.objectStore(STORE).put(Date.now(), `revision:${revision}`);
    tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
  });
  // Retain only the newest two immutable revisions.
  const revisions: Array<{key:string;time:number}> = [];
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      if (typeof cursor.key === 'string' && cursor.key.startsWith('revision:')) revisions.push({key:cursor.key,time:Number(cursor.value)});
      cursor.continue();
    };
    request.onerror = () => resolve();
  });
  revisions.sort((a,b) => b.time-a.time);
  for (const stale of revisions.slice(2)) {
    const staleRevision = stale.key.slice(9);
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite'), objectStore = tx.objectStore(STORE);
      objectStore.delete(stale.key);
      const cursor = objectStore.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (typeof item.key === 'string' && item.key.startsWith(`${staleRevision}:`)) item.delete();
        item.continue();
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
    });
  }
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2,'0')).join('');
}

async function decode(bytes: Uint8Array): Promise<PartialSnapshot> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Invalid compressed scanner pack');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress scanner packs');
  const stream = new Response(bytes.slice().buffer).body!.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export async function loadPack(revision: string, name: PublicPackName, descriptor: PackDescriptor): Promise<PartialSnapshot> {
  const key = `${revision}:${name}:${descriptor.sha256}`;
  let promise = memory.get(key);
  if (!promise) {
    promise = (async () => {
      let bytes = await getStored(key);
      if (!bytes) {
        const response = await fetch(descriptor.url, {cache:'force-cache'});
        if (!response.ok) throw new Error(`Scanner ${name} pack failed (HTTP ${response.status})`);
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (bytes.byteLength !== descriptor.bytes || await sha256(bytes) !== descriptor.sha256) throw new Error(`Scanner ${name} pack checksum mismatch`);
      const pack = await decode(bytes);
      if (pack.schemaVersion !== 7 || pack.revision !== revision || pack.totalStocks !== pack.stocks.length) throw new Error(`Scanner ${name} pack revision mismatch`);
      void store(key, bytes, revision);
      return pack;
    })().catch(error => { memory.delete(key); throw error; });
    memory.set(key, promise);
  }
  return promise;
}

export async function mergePacks(revision: string, descriptors: PublicPacks, names: PublicPackName[]): Promise<Snapshot> {
  const packs = await Promise.all(names.map(name => loadPack(revision,name,descriptors[name])));
  const base = packs[0];
  if (packs.some(pack => pack.asOfDate !== base.asOfDate || pack.totalStocks !== base.totalStocks)) throw new Error('Scanner packs are not aligned');
  const rows = new Map<string,Record<string,unknown>>();
  for (const pack of packs) for (const row of pack.stocks) rows.set(row.symbol, {...rows.get(row.symbol),...row});
  return {revision,asOfDate:base.asOfDate,totalStocks:base.totalStocks,stocks:[...rows.values()] as unknown as Snapshot['stocks']};
}
