/** Public catalog metadata is advisory; IDs and limits can differ at a gateway. */
export interface ModelCatalogEntry {
  providerId: string;
  providerName: string;
  id: string;
  name: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  reasoningBudget?: boolean;
}

export interface ModelCatalogResult {
  source: string;
  models: ModelCatalogEntry[];
  total: number;
}
