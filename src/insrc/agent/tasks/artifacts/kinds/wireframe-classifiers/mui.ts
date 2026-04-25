/**
 * Material UI classifier (`@mui/material`).
 */

import type { LibraryClassifier } from './types.js';

export const MUI: LibraryClassifier = {
	id: 'mui',
	importSources: ['@mui/material', '@mui/joy', '@mui/lab', '@material-ui/core'],
	layoutContainers: {
		'Stack':       { direction: 'column' },          // vertical by default
		'Grid':        { direction: 'grid', colsProp: 'columns', defaultCols: 12 },
		'Grid2':       { direction: 'grid', colsProp: 'columns', defaultCols: 12 },
		'Box':         { direction: 'column' },
		'Container':   { direction: 'column' },
		'Paper':       { direction: 'column' },
		'AppBar':      { direction: 'row', region: 'header' },
		'Toolbar':     { direction: 'row' },
		'Drawer':      { direction: 'column', region: 'sidebar' },
		'Card':        { direction: 'column' },
		'CardContent': { direction: 'column' },
		'CardActions': { direction: 'row' },
		'CardHeader':  { direction: 'row', region: 'header' },
	},
	semanticElements: {
		'Button':       { kind: 'placeholder', labelPrefix: 'Button' },
		'IconButton':   { kind: 'placeholder', labelPrefix: 'Icon' },
		'Fab':          { kind: 'placeholder', labelPrefix: 'Button' },
		'TextField':    { kind: 'placeholder', labelPrefix: 'Input' },
		'OutlinedInput':{ kind: 'placeholder', labelPrefix: 'Input' },
		'FilledInput':  { kind: 'placeholder', labelPrefix: 'Input' },
		'Input':        { kind: 'placeholder', labelPrefix: 'Input' },
		'Select':       { kind: 'placeholder', labelPrefix: 'Select' },
		'Autocomplete': { kind: 'placeholder', labelPrefix: 'Autocomplete' },
		'Checkbox':     { kind: 'placeholder', labelPrefix: 'Checkbox' },
		'Radio':        { kind: 'placeholder', labelPrefix: 'Radio' },
		'Switch':       { kind: 'placeholder', labelPrefix: 'Toggle' },
		'Slider':       { kind: 'placeholder', labelPrefix: 'Slider' },
		'Avatar':       { kind: 'placeholder', labelPrefix: 'Avatar' },
		'Chip':         { kind: 'placeholder', labelPrefix: 'Chip' },
		'Badge':        { kind: 'placeholder', labelPrefix: 'Badge' },
		'Typography':   { kind: 'placeholder', labelPrefix: 'Text' },
		'Link':         { kind: 'placeholder', labelPrefix: 'Link' },
		'Divider':      { kind: 'placeholder', labelPrefix: 'Divider' },
		'List':         { kind: 'placeholder', labelPrefix: 'List' },
		'ListItem':     { kind: 'placeholder', labelPrefix: 'Item' },
		'Table':        { kind: 'placeholder', labelPrefix: 'Table' },
		'DataGrid':     { kind: 'placeholder', labelPrefix: 'Table' },
		'Tabs':         { kind: 'placeholder', labelPrefix: 'Tabs' },
		'Tab':          { kind: 'placeholder', labelPrefix: 'Tab' },
		'Dialog':       { kind: 'placeholder', labelPrefix: 'Dialog' },
		'Snackbar':     { kind: 'placeholder', labelPrefix: 'Toast' },
		'Tooltip':      { kind: 'placeholder', labelPrefix: 'Tooltip' },
		'Menu':         { kind: 'placeholder', labelPrefix: 'Menu' },
		'MenuItem':     { kind: 'placeholder', labelPrefix: 'Item' },
	},
};
