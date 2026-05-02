---
applyTo: '**/packages/website/**'
description: Instructions for the website package, including API documentation generation.
---

# Website Instructions

Agents working on the website package must adhere to the following guidelines to maintain consistency, branding, and functionality.

## Branding Compliance

- **Always follow the BRANDBOOK.md**: All content, design, and visual elements must strictly adhere to the SOAT brand system defined in the BRANDBOOK.md file. This includes color palettes, typography, visual language, and tone of voice.
- **Brand Consistency**: Ensure all new content, pages, and components align with the infrastructure-for-AI-apps positioning and the Vector Galaxy logo concept.

## Documentation Structure

- **Read README.md for Website Details**: Before making any changes, thoroughly read the packages/website/README.md file to understand the current website structure, navbar organization, and sidebar conventions.
- **Maintain Structure**: When adding new documentation, follow the established structure outlined in the README.md, including the navbar sections (Platform, Resources, MCP, API, Blog) and sidebar organization for resources.

## Content Guidelines

- **Tone and Voice**: Write in a technical, confident, and concise manner as specified in the BRANDBOOK.md. Avoid unnecessary jargon while maintaining technical accuracy.
- **Navigation**: Ensure all new pages and sections are properly integrated into the navigation system and sidebars.

## Module Documentation

Module docs live at `packages/website/docs/modules/<module>.md`. Each page must describe:

- What the module does (overview)
- Key concepts and data model
- Any roles or access rules that apply

**Canonical section order:**

```
# Module Name
{one-sentence description}
## Overview
## Data Model           [always]
## Key Concepts         [optional — omit if trivial]
## Configuration        [only if the module requires env vars]
## Examples             [always]
```

Do **not** add a `## Permissions` section to module docs. Instead, add this line at the end of the overview or as a callout:

> See the [Permissions Reference](./permissions.md) for the IAM action strings for this module.

### Permission actions are now auto-generated

Permission action strings live in `packages/server/src/permissions/<module>.json`, one file per module. The Permissions Reference page (`packages/website/docs/modules/permissions.md`) is auto-generated from those JSON files by running:

```bash
pnpm --filter @soat/website generate-permissions-page
```

When a new permission action is added to the server:

1. Add an entry to `packages/server/src/permissions/<module>.json`.
2. Regenerate the page: `pnpm --filter @soat/website generate-permissions-page`.
3. Do **not** manually edit `permissions.md` — it will be overwritten.

`iam.md` explains the `resource:Action` format and wildcards but does **not** list individual actions — it links to the Permissions Reference page instead.

## Technical Requirements

- **API Documentation**: When generating or updating API documentation, ensure it is comprehensive and follows the standards outlined in the website package.
- **Build and Deployment**: Verify that changes do not break the build process and maintain compatibility with the Docusaurus framework used for the website.
