# Insrc theme (dark + light)

## Context

Replicate the odr-website samaanta palette (navy background, blue accents)
across the IDE and insrc-specific panes. Ship as two bundled themes:

- **Insrc Dark** (fork default) -- dark navy chrome, blue `#56a0ff` accents,
  the website's translucent / backdrop-blurred / softly-glowing look.
- **Insrc Light** -- light mode derived from the same blue family; keeps
  the blue accent, swaps the darks for a subtle blue-tinted white.

Users can switch back to any VS Code default via
`Preferences > Color Theme`. Fonts are out of scope.

> Supersedes an earlier draft of this file that targeted an INSORS green
> design system. The project is now on the blue samaanta palette from
> `odr-website/styles.css`.

## Palette source (odr-website)

From `/home/subho/work/dev/insors/odr-website/styles.css .samaanta-page`:

| Role             | Dark (navy)                 | Light (derived)              |
|------------------|-----------------------------|------------------------------|
| `--bg`           | `#080f19`                   | `#f4f7fd`                    |
| `--bg-soft`      | `#101927`                   | `#e8eef8`                    |
| `--surface`      | `rgba(8,14,25,0.72)` + blur | `#ffffff`                    |
| `--surface-strong`| `#bcd4f5`                  | `#1d2e52`                    |
| `--text`         | `#e3eaf6`                   | `#131921`                    |
| `--muted`        | `#b0b8c4`                   | `#5b6479`                    |
| `--line`         | `rgba(156,190,243,0.2)`     | `rgba(86,110,255,0.18)`      |
| `--accent`       | `#56a0ff`                   | `#2f6fcc`                    |
| `--accent-deep`  | `#566eff`                   | `#3a4fd9`                    |

Background blob gradients (dark only, used for `editor.background`
where practical and for the pre-theme `_INITIAL_COLORS` flash):

```
radial-gradient(circle at 14% 14%, rgba(86,110,255,0.16), transparent 24%),
radial-gradient(circle at 86% 10%, rgba(86,160,255,0.12), transparent 22%),
linear-gradient(180deg, #070d14 0%, #0b1420 30%, #101927 100%);
```

Light variant uses no radial blobs -- flat `#f4f7fd` body background
with a very subtle 1% blue tint gradient.

## Delivery

Two theme JSONs shipped inside the existing `extensions/theme-defaults/`
bundle:

- `extensions/theme-defaults/themes/insrc_dark.json`  -- extends
  `dark_modern.json` via `"include": "./dark_modern.json"`, then
  overrides the palette tokens.
- `extensions/theme-defaults/themes/insrc_light.json` -- same against
  `light_modern.json`.

Both registered in `extensions/theme-defaults/package.json`
`contributes.themes`. **Insrc Dark** is the fork's default by
updating `ThemeSettingDefaults` in
`src/vs/workbench/services/themes/common/workbenchThemeService.ts:47-53`
(and the matching `_INITIAL_COLORS` constants so the pre-theme flash
is already blue/navy).

## Token mapping (high-level)

The theme JSON's `colors` map covers ~400 tokens. Rather than listing
them all, this is the pattern:

- **Backgrounds** (`editor.background`, `sideBar.background`,
  `titleBar.activeBackground`, `activityBar.background`,
  `statusBar.background`, `panel.background`, `terminal.background`,
  `quickInput.background`, `editorWidget.background`) -> `--bg`,
  `--bg-soft`, or the translucent `rgba(8,14,25,0.72)` where
  appropriate. VS Code theme JSON can't set `backdrop-filter`; blur
  stays in CSS on the elements that have it today.
- **Foregrounds** (`foreground`, `editor.foreground`,
  `sideBar.foreground`, `statusBar.foreground`, `tab.*Foreground`,
  `editorLineNumber.foreground`) -> `--text` (primary) or
  `--muted` (secondary).
- **Accents** (`focusBorder`, `button.background`,
  `activityBar.activeBorder`, `editorLink.activeForeground`,
  `progressBar.background`, `badge.background`, `textLink.foreground`,
  `editorCursor.foreground`, `editor.selectionBackground`) ->
  `--accent` or `--accent-deep`.
- **Hover / active** states on nav / menus / list items -> translucent
  accent tint `rgba(86,160,255,0.12)` (matches the website's nav-hover).
- **Borders** (`contrastBorder`, `focusBorder`, `panel.border`,
  `tab.border`, `sideBar.border`) -> `--line`.
- **Syntax (`tokenColors`)** -- inherit `dark_modern`'s defaults,
  then recolor the main categories to the blue family:
  - keywords / storage: `#56a0ff`
  - strings:            `#bcd4f5`
  - comments:           `#6b7a8f`
  - types / classes:    `#566eff`
  - functions:          `#80b6ff`
  - numbers:            `#a0c4ff`

  Light variant uses the same families, darkened to meet
  contrast against the light surface.

Exact values tuned against a TS/JS/Python/Markdown sample at
implementation time.

## Insrc pane CSS -- audit & refactor

The three insrc CSS files (chat, setupWizard, brainstorm -- ~1600
lines total) already reference `var(--vscode-*)` but ship **hardcoded
fallback colors**:

- `chat.css` -- `rgba(255,255,255,0.1)`, `rgba(128,128,128,0.3)`,
  `#333`, `#555`, `rgba(255,255,255,0.03)`.
- `setupWizard.css` -- `rgba(128,128,128,0.2)`.
- `brainstorm.css` -- `#3794ff`, `#fff` (verdict badges).

Plus hardcoded colors inline in `.ts` files:

- `modelProvidersPane.ts:79` cost-banner block -- `#bb8a0c`,
  `rgba(200,150,0,0.08)`, etc.

Scope:

1. Replace every hardcoded hex / rgba fallback with a `var(--vscode-*)`
   reference (preferring existing core tokens like
   `--vscode-widget-border`, `--vscode-descriptionForeground`,
   `--vscode-errorForeground`, `--vscode-editorWarning-background`).
2. Where no VS Code token fits, introduce custom tokens in the insrc
   theme JSONs under an `insrc.*` namespace (e.g. `insrc.hero.glow`,
   `insrc.chip.background`). VS Code auto-exposes them to CSS as
   `var(--vscode-insrc-hero-glow)`.
3. Move inline `.style.X = '#hex'` assignments in the `.ts` files
   (notably `modelProvidersPane.ts`) into CSS classes so the theme
   can retint them without a compile.

## Website treatment on custom panes

These are the visual flourishes unique to insrc panes (chat, Model
Providers, setup wizard, brainstorm, prompt notepad):

1. **Rounded corners**
   - Cards / panels: `18px` (matches website `.card`, `.stage-card`).
   - Buttons: `18px`; chips / pills: `999px`.
   - Inputs: `8px` (VS Code stock is square; small polish).
2. **Backdrop blur on translucent surfaces**
   - Hero panel headers / sticky toolbars inside panes --
     `backdrop-filter: blur(12px)` + `rgba(bg, 0.72)`.
   - Editor tabs, sidebar chrome, status bar stay stock (blur on
     large scrolling surfaces tanks scrolling perf in Electron).
3. **Radial glow accent `::before`** (the "soft glow")
   - Model Providers top banner and Setup Wizard first panel get a
     `.stage-shell::before`-equivalent: absolutely-positioned,
     accent-tinted radial gradient, `filter: blur(12px)`, behind
     content.
   - Chat toolbar gets a subdued version; brainstorm card widget
     gets a per-card glow on hover.
4. **Cost-guard banner** on cloud provider tabs exists already --
   retint from `#bb8a0c` amber to a theme-aware warning tone.
5. **Floating chips** (key status, vision default, active-provider
   indicator) adopt the website's `.floating-chip` style -- pill
   shape, backdrop blur, translucent border.

## Chrome polish (light pass)

Stock VS Code chrome (activity bar, sidebar, tabs, panel) is retinted
entirely via the theme JSON -- no CSS changes. The only non-JSON
touches:

1. **Command palette + quick input** backdrop-blur already on by
   default; confirm it reads well over the new palette.
2. **Notifications** similar -- token only.
3. **No rounding changes to editor tabs**. The website's 18px radius
   on tabs looks wrong; stock square tabs stay.

## Files to create / modify

### New files

| File                                                     | Purpose                                                                 |
|----------------------------------------------------------|-------------------------------------------------------------------------|
| `extensions/theme-defaults/themes/insrc_dark.json`       | Dark theme (includes dark_modern, overrides palette)                    |
| `extensions/theme-defaults/themes/insrc_light.json`      | Light theme (includes light_modern, overrides palette)                  |

### Modified files

| File                                                                                                   | Change                                                                                                    |
|--------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `extensions/theme-defaults/package.json`                                                               | Register the two Insrc themes in `contributes.themes`                                                     |
| `extensions/theme-defaults/package.nls.json`                                                           | Localization strings for theme labels                                                                     |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts:47-53, 59-111`                       | `COLOR_THEME_DARK = 'Insrc Dark'` / `COLOR_THEME_LIGHT = 'Insrc Light'`; update `_INITIAL_COLORS`          |
| `src/vs/workbench/contrib/insrc/browser/chat/media/chat.css`                                           | Remove hardcoded hex / rgba fallbacks; token-only                                                         |
| `src/vs/workbench/contrib/insrc/browser/setup/media/setupWizard.css`                                   | Token adoption; add backdrop-filter + radial-glow hero treatment                                          |
| `src/vs/workbench/contrib/insrc/browser/brainstorm/media/brainstorm.css`                               | Token adoption; card corner radius + hover glow                                                           |
| `src/vs/workbench/contrib/insrc/browser/models/modelProvidersPane.ts`                                  | Move inline styles into `setupWizard.css` classes; retint cost banner                                     |

## Implementation order

1. **Stage A -- Theme JSONs**
   - Author `insrc_dark.json` and `insrc_light.json`, register in
     `package.json`, verify selectable via `Preferences > Color Theme`
     without being the default yet. Tune palette against samples.

2. **Stage B -- Default swap**
   - Point `workbenchThemeService.ts:COLOR_THEME_DARK/LIGHT` at the
     Insrc themes; update `_INITIAL_COLORS` so the pre-load flash is
     blue/navy.
   - Migration: do nothing for existing users (their
     `workbench.colorTheme` stays whatever they picked). Fresh
     profiles pick up the new default.

3. **Stage C -- Insrc CSS token adoption**
   - Strip hardcoded fallbacks out of `chat.css`, `setupWizard.css`,
     `brainstorm.css`. Move `modelProvidersPane.ts` inline styles
     into CSS classes.

4. **Stage D -- Website treatment**
   - Add backdrop-blur, rounded corners, radial-glow pseudo-elements
     to custom panes -- the "full treatment" for insrc-specific UI
     only.

5. **Stage E -- Editor syntax highlighting**
   - Tune `tokenColors` in both themes against TS, JS, Python, and
     Markdown samples until they read well.

Each stage commits cleanly; the fork stays shippable between stages
(the IDE looks like stock VS Code until Stage B lands).

## Verification

1. After Stage A -> pick "Insrc Dark" from the theme picker ->
   editor + chrome retints blue/navy; Insrc panes still show
   hardcoded fallbacks (intentional -- Stage C fixes).
2. After Stage B -> fresh profile launches into Insrc Dark
   automatically; existing users' theme preference is preserved.
3. After Stage C + D -> open Model Providers pane -> cost banner,
   tabs, cards, buttons all inherit from the active theme; switching
   Dark <-> Light re-skins the pane live.
4. Perf -- open a 10k+ line file with Insrc Dark; verify no scroll
   jank from any backdrop-filter rule.

## Out of scope

- **Welcome walkthrough branding** (insrc-specific Get Started page).
  Would live at `extensions/welcome-insrc/`. Deferred -- call out
  separately if wanted.
- **Font changes**. Locked out per user direction.
- **Icon theme** (file icons). Stock VS Code icons ship.
- **Product logo / splash / title bar branding**. Handled by
  `product.json` separately -- not a theme concern.
