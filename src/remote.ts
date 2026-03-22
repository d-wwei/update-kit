import type {
  AuditRecord,
  AuditWriter,
  UpdateLockHandle,
  UpdateLockManager,
  UpdateState,
  UpdateStateStore
} from "./types.js";
import { renderTemplate } from "./utils.js";

type HttpBackendBaseOptions = {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  token?: string;
  tokenEnv?: string;
};

export type HttpStateStoreOptions = HttpBackendBaseOptions & {
  readUrl: string;
  writeUrl: string;
};

export type HttpAuditWriterOptions = HttpBackendBaseOptions & {
  appendUrl: string;
  listUrl: string;
};

export type HttpLockManagerOptions = HttpBackendBaseOptions & {
  acquireUrl: string;
  releaseUrlTemplate: string;
};

export class HttpStateStore implements UpdateStateStore {
  constructor(private readonly options: HttpStateStoreOptions) {}

  async read(): Promise<UpdateState | undefined> {
    const response = await this.fetch(this.options.readUrl, { method: "GET" });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Remote state read failed: ${response.status}`);
    return await response.json() as UpdateState;
  }

  async write(state: UpdateState): Promise<void> {
    const response = await this.fetch(this.options.writeUrl, {
      method: "PUT",
      body: JSON.stringify(state)
    });
    if (!response.ok) throw new Error(`Remote state write failed: ${response.status}`);
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return fetchImpl(url, {
      ...init,
      headers: buildHeaders(this.options)
    });
  }
}

export class HttpAuditWriter implements AuditWriter {
  constructor(private readonly options: HttpAuditWriterOptions) {}

  async append(record: AuditRecord): Promise<void> {
    const response = await this.fetch(this.options.appendUrl, {
      method: "POST",
      body: JSON.stringify(record)
    });
    if (!response.ok) throw new Error(`Remote audit append failed: ${response.status}`);
  }

  async list(options: { limit?: number } = {}): Promise<AuditRecord[]> {
    const url = new URL(this.options.listUrl);
    if (options.limit) url.searchParams.set("limit", String(options.limit));
    const response = await this.fetch(url.toString(), { method: "GET" });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Remote audit list failed: ${response.status}`);
    return await response.json() as AuditRecord[];
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return fetchImpl(url, {
      ...init,
      headers: buildHeaders(this.options)
    });
  }
}

export class HttpLockManager implements UpdateLockManager {
  constructor(private readonly options: HttpLockManagerOptions) {}

  async acquire(metadata: Record<string, unknown> = {}): Promise<UpdateLockHandle> {
    const response = await this.fetch(this.options.acquireUrl, {
      method: "POST",
      body: JSON.stringify({ metadata })
    });

    if (response.status === 409) {
      throw new Error(`Could not acquire remote update lock at ${this.options.acquireUrl}: conflict`);
    }
    if (!response.ok) {
      throw new Error(`Could not acquire remote update lock at ${this.options.acquireUrl}: ${response.status}`);
    }

    const payload = await response.json().catch(() => ({})) as { leaseId?: string };
    const leaseId = payload.leaseId ?? "default";
    return {
      release: async () => {
        const releaseUrl = renderTemplate(this.options.releaseUrlTemplate, { leaseId });
        const releaseResponse = await this.fetch(releaseUrl, { method: "DELETE" });
        if (!releaseResponse.ok) {
          throw new Error(`Could not release remote update lock at ${releaseUrl}: ${releaseResponse.status}`);
        }
      }
    };
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return fetchImpl(url, {
      ...init,
      headers: buildHeaders(this.options)
    });
  }
}

export function createHttpStateStore(options: HttpStateStoreOptions): UpdateStateStore {
  return new HttpStateStore(options);
}

export function createHttpAuditWriter(options: HttpAuditWriterOptions): AuditWriter {
  return new HttpAuditWriter(options);
}

export function createHttpLockManager(options: HttpLockManagerOptions): UpdateLockManager {
  return new HttpLockManager(options);
}

function buildHeaders(options: HttpBackendBaseOptions): HeadersInit {
  const token = options.token ?? (options.tokenEnv ? process.env[options.tokenEnv] : undefined);
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers ?? {})
  };
}
