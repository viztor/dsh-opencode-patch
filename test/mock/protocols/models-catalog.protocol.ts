/**
 * Models Catalog Wire Protocol (/models).
 *
 * Implements the contract for GET /models catalog listing:
 * - Method: GET
 * - Wire authentication: Authorization: Bearer <key>
 * - Model listing JSON envelope and model rows
 *
 * @module test/mock/protocols/models-catalog.protocol
 */

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
} from "../../support/src.ts";

export const CATALOG_PROTOCOL = "models-catalog" as const;
export const CATALOG_KIND = "models" as const;
export const CATALOG_WIRE_HEADER = "authorization" as const;

export type CatalogPlane = "opencode" | "opencode-go";

export interface CatalogModelRow {
  readonly created: number;
  readonly id: string;
  readonly object: "model";
  readonly owned_by: string;
}

export interface CatalogListingPayload {
  readonly data: readonly CatalogModelRow[];
  readonly object: "list";
}

const catalogFor = (
  plane: CatalogPlane
): readonly (typeof OPENCODE_ZEN_CATALOG)[number][] =>
  plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;

/**
 * Generate the /models listing JSON body for a given plane.
 */
export const modelsListing = (plane: CatalogPlane): string => {
  const rows: CatalogModelRow[] = [
    {
      created: 1_700_000_000,
      id: "mock-unknown-model",
      object: "model",
      owned_by: "opencode",
    },
  ];
  const [first] = catalogFor(plane);
  if (first !== undefined) {
    rows.unshift({
      created: 1_700_000_000,
      id: first.id,
      object: "model",
      owned_by: "opencode",
    });
  }
  return JSON.stringify({ data: rows, object: "list" });
};

export const ModelsCatalogProtocol = {
  kind: CATALOG_KIND,
  listing: modelsListing,
  protocol: CATALOG_PROTOCOL,
  wireHeader: CATALOG_WIRE_HEADER,
} as const;
