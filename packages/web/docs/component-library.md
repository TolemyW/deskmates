# Owned component library (2026-10-09)

[ADR-0025](../../../docs/adr/0025-owned-heroui-component-library.md) moves shared
buttons, inputs, pills and empty states to the independently versioned
[`@deskmates/ui`](../../ui/README.md) package, based on HeroUI v3. Task editor fields
use its inputs/text areas. New shared components belong there; application data,
status mappings and API calls stay here. All single-value dropdowns use the owned
`Select`, including its popup; do not style a native select and leave its menu
to the browser. Import the owned public API, never HeroUI
directly. Run `npm run dev:ui` from the repository root for the standalone studio.
The existing local entry points re-export the package for gradual migration.
Radix desktop dialogs/tooltips remain until separately verified. Topic files dated
before this one describe the historical implementation, not completion of a full redesign.
