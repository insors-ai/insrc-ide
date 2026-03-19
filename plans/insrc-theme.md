# insrc Theme Plan

> VS Code theme based on the INSORS design system (`odr-ui/app/src/theme.css`)
> Brand: Poppins font, Phthalo Green family, Wintergreen Dream accent
> Both light and dark variants

## Source of truth

`/home/subho/work/dev/insors/odr-ui/app/src/theme.css` -- the canonical design system.
All colors below are derived directly from that file.

## Named brand colors

| Name | Hex | Role |
|------|-----|------|
| Phthalo Green | `#102D1A` | Primary dark, text on light, topbar bg |
| Wintergreen Dream | `#4B9988` | Primary accent (light mode) |
| Iguana Green | `#6AB489` | Primary accent (dark mode) |
| Dark Sea Green | `#92CD87` | Secondary text (dark mode), accent hover (dark) |
| Crayola | `#C2E484` | Topbar text (light mode) |
| Pear | `#D1E736` | Topbar text (dark mode), brand highlight |

## Design system tokens

### Light mode

```
Surfaces:     bg #f0f7f2 | surface #f8fbf9 | surface-2 #eef6f1 | surface-3 #e4f0e8
Panel:        #eef6f1
Hover:        #daeae0
Borders:      #c2d9ca | strong #9ebfaa
Text:         primary #102D1A | secondary #2d5c3e | muted #6a9478 | on-accent #ffffff
Accent:       #4B9988 | hover #3d8070 | soft rgba(75,153,136,0.16) | subtle #e4f2f0
Highlight:    #102d1a
Chrome:       topbar-bg #102D1A | topbar-text #C2E484 | topbar-muted #6AB489
              sidebar-bg #f8fbf9 | sidebar-active #e4f2f0 | sidebar-active-border #4B9988
```

### Dark mode

```
Surfaces:     bg #081510 | surface #102D1A | surface-2 #163820 | surface-3 #1c4228
Panel:        #163820
Hover:        #224e30
Borders:      #2a5c38 | strong #3a7248
Text:         primary #e8f5ee | secondary #92CD87 | muted #4B9988 | on-accent #102D1A
Accent:       #6AB489 | hover #92CD87 | soft rgba(75,153,136,0.2) | subtle #142a1c
Highlight:    #c2e484
Chrome:       topbar-bg #081510 | topbar-text #D1E736 | topbar-muted #4B9988
              sidebar-bg #102D1A | sidebar-active #142a1c | sidebar-active-border #6AB489
```

### Semantic colors (both modes use same hue, different intensity)

| Role | Light | Dark | Note |
|------|-------|------|------|
| success | `#4B9988` | `#6AB489` | same as accent |
| warning | `#5a7a00` (deep olive) | `#88b800` (bright olive) | cool-toned, not amber |
| danger | `#5c3090` (muted violet) | `#9060d0` (bright violet) | cool-toned, not red |
| purple | `#5a7a6a` | `#4B9988` | |
| teal | `#4B9988` | `#4B9988` | |
| orange | `#4838a0` (medium violet) | `#7858c8` | severity bridge |

Note: This design system intentionally avoids warm reds/oranges for semantic states.
Warnings are olive-green, errors are violet/plum. This is a deliberate brand choice.

### Mismatch (diff/conflict)

| | Light | Dark |
|--|-------|------|
| bg | `#eeeafc` | `#10081e` |
| border | `#9080c8` | `#8060c0` |
| text | `#2e1a60` | `#c8a8f0` |

## Font

Primary: `Poppins` (weights: 400, 500, 600, 700, 800)
Fallback: `system-ui, -apple-system, "Segoe UI", sans-serif`

Poppins will be bundled as local woff2 files (no Google Fonts CDN).

## Theme: "insrc Light"

### Workbench colors

| Scope | Color | Source |
|-------|-------|--------|
| **Title bar** | | |
| `titleBar.activeBackground` | `#102D1A` | topbar-bg |
| `titleBar.activeForeground` | `#C2E484` | topbar-text (Crayola) |
| `titleBar.border` | `#102D1A` | topbar-bg |
| `titleBar.inactiveBackground` | `#102D1A` | topbar-bg |
| `titleBar.inactiveForeground` | `#6AB489` | topbar-muted (Iguana Green) |
| **Activity bar** | | |
| `activityBar.background` | `#102D1A` | topbar-bg (Phthalo Green) |
| `activityBar.foreground` | `#C2E484` | topbar-text (Crayola) |
| `activityBar.activeBorder` | `#4B9988` | accent (Wintergreen Dream) |
| `activityBar.inactiveForeground` | `#6AB489` | topbar-muted |
| `activityBarBadge.background` | `#4B9988` | accent |
| `activityBarBadge.foreground` | `#ffffff` | text-on-accent |
| **Sidebar** | | |
| `sideBar.background` | `#f8fbf9` | sidebar-bg / surface |
| `sideBar.foreground` | `#102D1A` | text |
| `sideBar.border` | `#c2d9ca` | border |
| `sideBarTitle.foreground` | `#102D1A` | text |
| `sideBarSectionHeader.background` | `#eef6f1` | surface-2 |
| `sideBarSectionHeader.foreground` | `#2d5c3e` | text-secondary |
| **Editor** | | |
| `editor.background` | `#f8fbf9` | surface |
| `editor.foreground` | `#102D1A` | text |
| `editor.lineHighlightBackground` | `#e4f0e84d` | surface-3 @ 30% |
| `editor.selectionBackground` | `#daeae080` | hover @ 50% |
| `editor.wordHighlightBackground` | `#e4f2f080` | accent-subtle @ 50% |
| `editorCursor.foreground` | `#4B9988` | accent |
| `editorLineNumber.foreground` | `#6a9478` | muted |
| `editorLineNumber.activeForeground` | `#4B9988` | accent |
| `editorIndentGuide.background` | `#c2d9ca` | border |
| `editorIndentGuide.activeBackground` | `#9ebfaa` | border-strong |
| `editorBracketMatch.background` | `#e4f2f080` | accent-subtle @ 50% |
| `editorBracketMatch.border` | `#4B9988` | accent |
| **Editor groups & tabs** | | |
| `editorGroupHeader.tabsBackground` | `#eef6f1` | surface-2 |
| `tab.activeBackground` | `#f8fbf9` | surface |
| `tab.activeForeground` | `#102D1A` | text |
| `tab.activeBorderTop` | `#4B9988` | tab-active-border / accent |
| `tab.inactiveBackground` | `#eef6f1` | surface-2 |
| `tab.inactiveForeground` | `#2d5c3e` | text-secondary |
| `tab.border` | `#c2d9ca` | border |
| **Status bar** | | |
| `statusBar.background` | `#102D1A` | topbar-bg (matches title bar) |
| `statusBar.foreground` | `#C2E484` | topbar-text |
| `statusBar.border` | `#102D1A` | topbar-bg |
| `statusBar.debuggingBackground` | `#5c3090` | danger (violet) |
| `statusBar.debuggingForeground` | `#ffffff` | |
| `statusBar.noFolderBackground` | `#6a9478` | muted |
| `statusBarItem.hoverBackground` | `#6AB48940` | Iguana Green @ 25% |
| `statusBarItem.prominentBackground` | `#4B9988` | accent |
| **Panel (terminal, output)** | | |
| `panel.background` | `#eef6f1` | panel / surface-2 |
| `panel.border` | `#c2d9ca` | border |
| `panelTitle.activeBorder` | `#4B9988` | accent |
| `panelTitle.activeForeground` | `#102D1A` | text |
| `panelTitle.inactiveForeground` | `#6a9478` | muted |
| **Inputs** | | |
| `input.background` | `#f8fbf9` | surface |
| `input.border` | `#c2d9ca` | border |
| `input.foreground` | `#102D1A` | text |
| `input.placeholderForeground` | `#6a9478` | muted |
| `inputOption.activeBorder` | `#4B9988` | accent |
| `focusBorder` | `#4B9988` | accent |
| **Buttons** | | |
| `button.background` | `#4B9988` | accent |
| `button.foreground` | `#ffffff` | text-on-accent |
| `button.hoverBackground` | `#3d8070` | accent-hover |
| `button.secondaryBackground` | `#e4f2f0` | accent-subtle |
| `button.secondaryForeground` | `#102D1A` | text |
| `button.secondaryHoverBackground` | `#daeae0` | hover |
| **Lists & trees** | | |
| `list.activeSelectionBackground` | `#e4f2f0` | sidebar-active / accent-subtle |
| `list.activeSelectionForeground` | `#102D1A` | text |
| `list.activeSelectionIconForeground` | `#4B9988` | accent |
| `list.hoverBackground` | `#daeae0` | hover |
| `list.focusBackground` | `#e4f2f0` | accent-subtle |
| `list.focusForeground` | `#102D1A` | text |
| `list.inactiveSelectionBackground` | `#eef6f1` | surface-2 |
| `list.highlightForeground` | `#3d8070` | accent-hover |
| **Badges** | | |
| `badge.background` | `#4B9988` | accent |
| `badge.foreground` | `#ffffff` | text-on-accent |
| **Scrollbar** | | |
| `scrollbarSlider.background` | `#9ebfaa40` | border-strong @ 25% |
| `scrollbarSlider.hoverBackground` | `#9ebfaa80` | border-strong @ 50% |
| `scrollbarSlider.activeBackground` | `#4B998880` | accent @ 50% |
| **Notifications** | | |
| `notifications.background` | `#f8fbf9` | surface |
| `notifications.border` | `#c2d9ca` | border |
| `notificationLink.foreground` | `#4B9988` | accent |
| **Diff editor** | | |
| `diffEditor.insertedTextBackground` | `#e4f2f04d` | accent-subtle @ 30% |
| `diffEditor.removedTextBackground` | `#eeeafc4d` | mismatch-bg @ 30% |
| **Minimap** | | |
| `minimap.selectionHighlight` | `#4B99884d` | accent @ 30% |
| `minimap.findMatchHighlight` | `#5a7a004d` | warning @ 30% |
| **Breadcrumbs** | | |
| `breadcrumb.foreground` | `#2d5c3e` | text-secondary |
| `breadcrumb.focusForeground` | `#102D1A` | text |
| `breadcrumb.activeSelectionForeground` | `#4B9988` | accent |
| **Peek view** | | |
| `peekView.border` | `#4B9988` | accent |
| `peekViewEditor.background` | `#f8fbf9` | surface |
| `peekViewResult.background` | `#eef6f1` | surface-2 |
| `peekViewTitle.background` | `#e4f0e8` | surface-3 |
| **Git decorations** | | |
| `gitDecoration.addedResourceForeground` | `#4B9988` | success / accent |
| `gitDecoration.modifiedResourceForeground` | `#4838a0` | orange (violet) |
| `gitDecoration.deletedResourceForeground` | `#5c3090` | danger (violet) |
| `gitDecoration.untrackedResourceForeground` | `#4B9988` | teal |
| `gitDecoration.conflictingResourceForeground` | `#5a7a00` | warning (olive) |
| `gitDecoration.ignoredResourceForeground` | `#6a9478` | muted |
| **Terminal** | | |
| `terminal.background` | `#102D1A` | Phthalo Green (dark terminal) |
| `terminal.foreground` | `#e8f5ee` | light text on dark bg |
| `terminal.ansiGreen` | `#6AB489` | Iguana Green |
| `terminal.ansiYellow` | `#C2E484` | Crayola |
| `terminal.ansiCyan` | `#4B9988` | Wintergreen Dream |
| `terminal.ansiRed` | `#9060d0` | danger (violet) |

### Token colors (TextMate scopes)

Token colors use the cool-toned semantic palette. No warm reds/oranges.

| Scope | Color | Style | Note |
|-------|-------|-------|------|
| `comment` | `#6a9478` | italic | muted |
| `string` | `#4B9988` | | accent (Wintergreen Dream) |
| `string.regexp` | `#4B9988` | | teal |
| `constant.numeric` | `#5a7a00` | | warning (olive) |
| `constant.language` (true/false/null) | `#5c3090` | | danger (violet) |
| `constant.character.escape` | `#4838a0` | | orange (violet) |
| `keyword` | `#5c3090` | | danger (violet) |
| `keyword.control` (if/else/for/return) | `#5c3090` | bold | danger (violet) |
| `keyword.operator` | `#2d5c3e` | | text-secondary |
| `storage.type` (const/let/var/function/class) | `#4838a0` | | orange (medium violet) |
| `storage.modifier` (async/static/public) | `#4838a0` | italic | |
| `entity.name.function` | `#102D1A` | bold | Phthalo Green |
| `entity.name.type` / `entity.name.class` | `#2d5c3e` | bold | text-secondary |
| `entity.name.tag` (HTML/JSX) | `#3d8070` | | accent-hover |
| `entity.other.attribute-name` | `#4B9988` | | accent |
| `variable` | `#102D1A` | | text |
| `variable.parameter` | `#2d5c3e` | italic | text-secondary |
| `variable.other.property` | `#2d5c3e` | | text-secondary |
| `support.function` (built-in) | `#4B9988` | | accent |
| `support.type` | `#5a7a6a` | | purple (muted green) |
| `meta.decorator` | `#5c3090` | | danger (violet) |
| `punctuation` | `#6a9478` | | muted |
| `markup.heading` | `#102D1A` | bold | Phthalo Green |
| `markup.bold` | `#102D1A` | bold | text |
| `markup.italic` | `#2d5c3e` | italic | text-secondary |
| `markup.inline.raw` / `markup.fenced_code` | `#4B9988` | | accent |
| `markup.underline.link` | `#4B9988` | underline | accent |
| `invalid` | `#5c3090` | | danger (violet) |
| `invalid.deprecated` | `#4838a0` | strikethrough | orange (violet) |

## Theme: "insrc Dark"

### Workbench colors

| Scope | Color | Source |
|-------|-------|--------|
| **Title bar** | | |
| `titleBar.activeBackground` | `#081510` | topbar-bg |
| `titleBar.activeForeground` | `#D1E736` | topbar-text (Pear) |
| `titleBar.border` | `#081510` | topbar-bg |
| **Activity bar** | | |
| `activityBar.background` | `#081510` | topbar-bg |
| `activityBar.foreground` | `#D1E736` | topbar-text (Pear) |
| `activityBar.activeBorder` | `#6AB489` | accent (Iguana Green) |
| `activityBar.inactiveForeground` | `#4B9988` | topbar-muted |
| `activityBarBadge.background` | `#6AB489` | accent |
| `activityBarBadge.foreground` | `#102D1A` | text-on-accent |
| **Sidebar** | | |
| `sideBar.background` | `#102D1A` | sidebar-bg (Phthalo Green) |
| `sideBar.foreground` | `#e8f5ee` | text |
| `sideBar.border` | `#2a5c38` | border |
| `sideBarSectionHeader.background` | `#163820` | surface-2 |
| `sideBarSectionHeader.foreground` | `#92CD87` | text-secondary (Dark Sea Green) |
| **Editor** | | |
| `editor.background` | `#102D1A` | surface (Phthalo Green) |
| `editor.foreground` | `#e8f5ee` | text |
| `editor.lineHighlightBackground` | `#1c42284d` | surface-3 @ 30% |
| `editor.selectionBackground` | `#224e3080` | hover @ 50% |
| `editorCursor.foreground` | `#6AB489` | accent |
| `editorLineNumber.foreground` | `#4B9988` | muted |
| `editorLineNumber.activeForeground` | `#6AB489` | accent |
| `editorIndentGuide.background` | `#2a5c38` | border |
| `editorBracketMatch.border` | `#6AB489` | accent |
| **Tabs** | | |
| `editorGroupHeader.tabsBackground` | `#163820` | surface-2 |
| `tab.activeBackground` | `#102D1A` | surface |
| `tab.activeForeground` | `#e8f5ee` | text |
| `tab.activeBorderTop` | `#6AB489` | tab-active-border / accent |
| `tab.inactiveBackground` | `#163820` | surface-2 |
| `tab.inactiveForeground` | `#92CD87` | text-secondary |
| `tab.border` | `#2a5c38` | border |
| **Status bar** | | |
| `statusBar.background` | `#081510` | topbar-bg |
| `statusBar.foreground` | `#D1E736` | topbar-text (Pear) |
| `statusBar.debuggingBackground` | `#9060d0` | danger (bright violet) |
| **Panel** | | |
| `panel.background` | `#163820` | panel / surface-2 |
| `panel.border` | `#2a5c38` | border |
| `panelTitle.activeBorder` | `#6AB489` | accent |
| **Inputs** | | |
| `input.background` | `#163820` | surface-2 |
| `input.border` | `#2a5c38` | border |
| `input.foreground` | `#e8f5ee` | text |
| `input.placeholderForeground` | `#4B9988` | muted |
| `focusBorder` | `#6AB489` | accent |
| **Buttons** | | |
| `button.background` | `#6AB489` | accent |
| `button.foreground` | `#102D1A` | text-on-accent |
| `button.hoverBackground` | `#92CD87` | accent-hover (Dark Sea Green) |
| **Lists & trees** | | |
| `list.activeSelectionBackground` | `#142a1c` | sidebar-active / accent-subtle |
| `list.activeSelectionForeground` | `#e8f5ee` | text |
| `list.hoverBackground` | `#224e30` | hover |
| `list.focusBackground` | `#142a1c` | accent-subtle |
| **Git decorations** | | |
| `gitDecoration.addedResourceForeground` | `#6AB489` | success |
| `gitDecoration.modifiedResourceForeground` | `#7858c8` | orange (violet) |
| `gitDecoration.deletedResourceForeground` | `#9060d0` | danger (violet) |
| `gitDecoration.untrackedResourceForeground` | `#4B9988` | teal |
| `gitDecoration.conflictingResourceForeground` | `#88b800` | warning (olive) |
| `gitDecoration.ignoredResourceForeground` | `#4B9988` | muted |
| **Terminal** | | |
| `terminal.background` | `#081510` | bg (deep) |
| `terminal.foreground` | `#e8f5ee` | text |
| `terminal.ansiGreen` | `#6AB489` | Iguana Green |
| `terminal.ansiYellow` | `#D1E736` | Pear |
| `terminal.ansiCyan` | `#4B9988` | Wintergreen Dream |
| `terminal.ansiRed` | `#9060d0` | danger (bright violet) |

### Token colors (dark mode)

Same scopes as light, but using brighter variants for dark background contrast:

| Scope | Color | Note |
|-------|-------|------|
| `comment` | `#4B9988` | muted (Wintergreen Dream) |
| `string` | `#6AB489` | Iguana Green |
| `constant.numeric` | `#88b800` | bright olive |
| `constant.language` | `#9060d0` | bright violet |
| `keyword` | `#9060d0` | bright violet |
| `keyword.control` | `#9060d0` | bold |
| `keyword.operator` | `#92CD87` | Dark Sea Green |
| `storage.type` | `#7858c8` | medium violet |
| `entity.name.function` | `#e8f5ee` | bold, text |
| `entity.name.type` | `#92CD87` | bold, Dark Sea Green |
| `entity.name.tag` | `#6AB489` | Iguana Green |
| `entity.other.attribute-name` | `#4B9988` | accent |
| `variable` | `#e8f5ee` | text |
| `variable.parameter` | `#92CD87` | italic |
| `support.function` | `#6AB489` | accent |
| `punctuation` | `#4B9988` | muted |
| `markup.heading` | `#c2e484` | bold, highlight (Crayola) |
| `markup.underline.link` | `#6AB489` | underline |
| `invalid` | `#9060d0` | bright violet |

## Implementation

### File structure

```
src/vs/workbench/contrib/insrc/browser/theme/
  insrcThemeContribution.ts    -- theme registration (light + dark)
  insrc-light.json             -- light theme JSON
  insrc-dark.json              -- dark theme JSON
  fonts/
    poppins-400.woff2
    poppins-500.woff2
    poppins-600.woff2
    poppins-700.woff2
    poppins-800.woff2
```

### Registration

```typescript
// Both themes registered in contribution
Registry.as<IColorThemeRegistry>(ThemeExtensions.ColorThemeRegistry).registerTheme({
  id: 'insrc-light',
  label: 'insrc Light',
  uiTheme: VS_LIGHT_THEME,
  path: './insrc-light.json',
});

Registry.as<IColorThemeRegistry>(ThemeExtensions.ColorThemeRegistry).registerTheme({
  id: 'insrc-dark',
  label: 'insrc Dark',
  uiTheme: VS_DARK_THEME,
  path: './insrc-dark.json',
});
```

### Font bundling

Poppins woff2 files bundled locally. CSS injected when insrc theme is active:

```css
.monaco-workbench {
  font-family: 'Poppins', system-ui, -apple-system, 'Segoe UI', sans-serif;
}
```

### Radius and shadows

VS Code doesn't natively support `border-radius` or `box-shadow` on most workbench elements.
Apply only on insrc-owned views (chat panel, brainstorm) where we control the HTML:
- `--radius-sm: 4px`, `--radius-md: 8px`, `--radius-lg: 12px`
- `--shadow-sm`, `--shadow-md`, `--shadow-lg` from theme.css

## Implementation order

| # | Task | Files |
|---|------|-------|
| 1 | Author `insrc-light.json` (workbench colors + token colors) | `browser/theme/insrc-light.json` |
| 2 | Author `insrc-dark.json` (workbench colors + token colors) | `browser/theme/insrc-dark.json` |
| 3 | Register both themes in contribution | `browser/theme/insrcThemeContribution.ts` |
| 4 | Bundle Poppins font files | `browser/theme/fonts/` |
| 5 | CSS override for Poppins on workbench chrome | `browser/theme/insrcThemeContribution.ts` |
| 6 | Wire into `insrc.contribution.ts` | `browser/insrc.contribution.ts` |
| 7 | Manual validation across languages (TS, Python, Go, Rust, JSON, MD) | - |

## Testing approach

No automated tests. Verify manually:
1. Both themes appear in "Color Theme" picker
2. Light mode: Phthalo Green topbar, Wintergreen Dream accents, warm green surfaces
3. Dark mode: deep green bg, Iguana Green accents, Pear title text
4. Token colors: violet keywords, olive constants, green strings -- no warm reds
5. Poppins renders on sidebar, title bar, status bar
6. Terminal has dark green bg in both modes
7. Git decorations: green adds, violet modifications, violet deletes
8. Focus borders use accent color in both modes
9. No contrast issues (WCAG AA minimum on all text)
10. Switching between light/dark feels cohesive (same hue family)
