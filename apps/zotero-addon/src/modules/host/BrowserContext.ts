export interface BrowserTabSnapshot {
  tabId?: number;
  url: string;
  title: string;
  identifiers: {
    doi?: string;
    arxiv?: string;
    pmid?: string;
    pdfUrl?: string;
  };
  readableText?: string;
}

export class BrowserContextStore {
  snapshot: BrowserTabSnapshot | null = null;

  set(snapshot: BrowserTabSnapshot): void {
    this.snapshot = snapshot;
  }
}
