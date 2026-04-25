/**
 * shadcn/ui classifier.
 *
 * Unlike npm-distributed libraries, shadcn/ui is a copy-paste model:
 * components live under `@/components/ui/*` (or similar) and are
 * versioned in the consuming repo. The classifier matches by import
 * path *suffix* -- if the import source ends with `/components/ui`
 * or `/ui/<file>`, treat it as shadcn.
 *
 * Tag names mirror Radix primitives (Button, Input, Card, Dialog,
 * Sheet, Tabs, etc.) so the catalog is small and well-known.
 */

import type { LibraryClassifier } from './types.js';

export const SHADCN: LibraryClassifier = {
	id: 'shadcn',
	// Import source matching is suffix-based for shadcn (see
	// `matchesShadcn` in the introspect walker).
	importSources: [
		'@/components/ui',
		'~/components/ui',
		'./components/ui',
		'../components/ui',
		'src/components/ui',
		// Radix is the underlying primitive lib shadcn proxies; many
		// shadcn-installed components also re-export Radix names.
		'@radix-ui/react-dialog',
		'@radix-ui/react-tabs',
		'@radix-ui/react-popover',
		'@radix-ui/react-tooltip',
		'@radix-ui/react-dropdown-menu',
	],
	layoutContainers: {
		'Card':        { direction: 'column' },
		'CardHeader':  { direction: 'row', region: 'header' },
		'CardContent': { direction: 'column' },
		'CardFooter':  { direction: 'row', region: 'footer' },
		'Sheet':       { direction: 'column' },
		'SheetContent':{ direction: 'column' },
		'SheetHeader': { direction: 'row', region: 'header' },
		'SheetFooter': { direction: 'row', region: 'footer' },
		'Tabs':        { direction: 'column' },
		'TabsList':    { direction: 'row' },
		'TabsContent': { direction: 'column' },
	},
	semanticElements: {
		'Button':       { kind: 'placeholder', labelPrefix: 'Button' },
		'Input':        { kind: 'placeholder', labelPrefix: 'Input' },
		'Textarea':     { kind: 'placeholder', labelPrefix: 'Input' },
		'Select':       { kind: 'placeholder', labelPrefix: 'Select' },
		'Checkbox':     { kind: 'placeholder', labelPrefix: 'Checkbox' },
		'RadioGroup':   { kind: 'placeholder', labelPrefix: 'Radio' },
		'Switch':       { kind: 'placeholder', labelPrefix: 'Toggle' },
		'Slider':       { kind: 'placeholder', labelPrefix: 'Slider' },
		'Avatar':       { kind: 'placeholder', labelPrefix: 'Avatar' },
		'Badge':        { kind: 'placeholder', labelPrefix: 'Badge' },
		'Label':        { kind: 'placeholder', labelPrefix: 'Label' },
		'Separator':    { kind: 'placeholder', labelPrefix: 'Divider' },
		'Dialog':       { kind: 'placeholder', labelPrefix: 'Dialog' },
		'AlertDialog':  { kind: 'placeholder', labelPrefix: 'Dialog' },
		'Popover':      { kind: 'placeholder', labelPrefix: 'Popover' },
		'Tooltip':      { kind: 'placeholder', labelPrefix: 'Tooltip' },
		'DropdownMenu': { kind: 'placeholder', labelPrefix: 'Menu' },
		'TabsTrigger':  { kind: 'placeholder', labelPrefix: 'Tab' },
		'Toast':        { kind: 'placeholder', labelPrefix: 'Toast' },
		'Alert':        { kind: 'placeholder', labelPrefix: 'Alert' },
		'Form':         { kind: 'placeholder', labelPrefix: 'Form' },
		'FormField':    { kind: 'placeholder', labelPrefix: 'FormField' },
		'FormItem':     { kind: 'placeholder', labelPrefix: 'FormField' },
		'FormLabel':    { kind: 'placeholder', labelPrefix: 'Label' },
		'Table':        { kind: 'placeholder', labelPrefix: 'Table' },
	},
};
