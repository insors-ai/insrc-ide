/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P1 stub -- Ajv JSON schema for AnalyzeContextBundle.
 *
 * Phase 1 of plans/analyze-context-builder.md owns this module. The
 * schema must:
 *   - cover every AnalyzeContextBundle field
 *   - carry a `schemaVersion` constant (used in cache key composition)
 *   - validate `meta.emptyLayers` only references known layer names
 *
 * Bumping SCHEMA_VERSION invalidates every cached bundle. Do not
 * touch without coordinating cache + driver.
 */

export const SCHEMA_VERSION = 1;
