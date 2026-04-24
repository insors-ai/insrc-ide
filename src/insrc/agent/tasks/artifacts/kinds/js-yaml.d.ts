// Ambient module declaration for js-yaml.
//
// The daemon already depends on js-yaml transitively (runtime resolves
// fine), but no @types/js-yaml is installed. We only call `load` and
// `loadAll` from the artifact pipeline, so this narrow declaration is
// enough -- a full pull of the upstream types would be overkill.

declare module 'js-yaml' {
	export function load(input: string): unknown;
	export function loadAll(input: string): unknown[];
}
