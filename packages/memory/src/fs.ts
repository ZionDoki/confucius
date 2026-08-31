/**
 * Minimal async filesystem seam so the store runs in Node tests and inside
 * Zotero (IOUtils) without either side depending on the other's runtime.
 */
export interface MemoryFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  makeDirectory(dir: string): Promise<void>;
}

export class InMemoryFileSystem implements MemoryFileSystem {
  private readonly files = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) {
      this.files.set(path, content);
    }
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listFiles(dir: string): Promise<string[]> {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .sort();
  }

  async makeDirectory(): Promise<void> {
    /* nothing to do */
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}
