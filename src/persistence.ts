import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { config } from "./config.js";

type SnapshotFile = { path: string; data: string };
type Snapshot = { version: 1 | 2 | 3; sessionFormat?: string; createdAt: string; files: SnapshotFile[] };

const ignoredNames = new Set([
  "SingletonCookie", "SingletonLock", "SingletonSocket", "DevToolsActivePort", "LOCK",
]);
const ignoredDirectories = new Set([
  "Cache", "Code Cache", "GPUCache", "Crashpad", "DawnCache", "CacheStorage",
  "ScriptCache", "Media Cache", "ShaderCache", "GrShaderCache", "GraphiteDawnCache",
  "blob_storage", "BrowserMetrics", "component_crx_cache", "optimization_guide_model_store",
]);

function safeDestination(path: string): string | null {
  const destination = resolve(config.persistenceRoot, path);
  const prefix = `${config.persistenceRoot}${sep}`;
  return destination.startsWith(prefix) ? destination : null;
}

async function collect(directory: string, files: SnapshotFile[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (ignoredNames.has(entry.name) || entry.name.endsWith(".tmp")) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await collect(absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolute);
    files.push({ path: relative(config.persistenceRoot, absolute), data: content.toString("base64") });
  }
}

export class BlobPersistence {
  private saving: Promise<void> | null = null;

  async restore(): Promise<boolean> {
    if (!config.persistenceBlobUrl) return false;
    const response = await fetch(config.persistenceBlobUrl, { signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Falha ao restaurar persistencia (${response.status}).`);
    const storedBody = Buffer.from(await response.arrayBuffer());
    const decodedBody = storedBody[0] === 0x1f && storedBody[1] === 0x8b
      ? gunzipSync(storedBody)
      : storedBody;
    const snapshot = JSON.parse(decodedBody.toString("utf8")) as Snapshot;
    if (![1, 2, 3].includes(snapshot.version) || !Array.isArray(snapshot.files)) throw new Error("Snapshot de persistencia invalido.");
    const sessionRoot = relative(config.persistenceRoot, config.sessionDataPath).replaceAll("\\", "/").replace(/\/$/, "");
    const sessionCompatible = snapshot.sessionFormat === config.sessionFormatVersion;
    for (const file of snapshot.files) {
      const normalizedPath = String(file.path || "").replaceAll("\\", "/");
      if (!sessionCompatible && (normalizedPath === sessionRoot || normalizedPath.startsWith(`${sessionRoot}/`))) continue;
      const destination = safeDestination(String(file.path || ""));
      if (!destination) continue;
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, Buffer.from(String(file.data || ""), "base64"), { mode: 0o600 });
    }
    return true;
  }

  save(): Promise<void> {
    if (!config.persistenceBlobUrl) return Promise.resolve();
    if (this.saving) return this.saving;
    this.saving = this.saveNow().finally(() => { this.saving = null; });
    return this.saving;
  }

  private async saveNow(): Promise<void> {
    const files: SnapshotFile[] = [];
    await collect(config.persistenceRoot, files);
    const payload: Snapshot = {
      version: 3,
      sessionFormat: config.sessionFormatVersion,
      createdAt: new Date().toISOString(),
      files,
    };
    const body = gzipSync(JSON.stringify(payload), { level: 6 });
    if (body.byteLength > 256 * 1024 * 1024) throw new Error("Snapshot comprimido de persistencia excedeu o limite seguro.");
    const requestBody = new Uint8Array(body).buffer;
    const response = await fetch(config.persistenceBlobUrl, {
      method: "PUT",
      headers: { "content-type": "application/gzip", "x-ms-blob-type": "BlockBlob" },
      body: requestBody,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Falha ao salvar persistencia (${response.status}).`);
  }
}
