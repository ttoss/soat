---
applyTo: '**/packages/website/**'
description: Instructions for the website package, including API documentation generation.
---

# Website Instructions

Agents working on the website package must adhere to the following guidelines to maintain consistency, branding, and functionality.

## Branding Compliance

- **Always follow the BRANDBOOK.md**: All content, design, and visual elements must strictly adhere to the SOAT brand system defined in the BRANDBOOK.md file. This includes color palettes, typography, visual language, and tone of voice.
- **Brand Consistency**: Ensure all new content, pages, and components align with the "Semantic Cosmos" metaphor and the Vector Galaxy logo concept.

## Documentation Structure

- **Read README.md for Website Details**: Before making any changes, thoroughly read the packages/website/README.md file to understand the current website structure, navbar organization, and sidebar conventions.
- **Maintain Structure**: When adding new documentation, follow the established structure outlined in the README.md, including the navbar sections (Platform, Resources, MCP, API, Blog) and sidebar organization for resources.

## Content Guidelines

- **Tone and Voice**: Write in a technical, confident, and concise manner as specified in the BRANDBOOK.md. Avoid unnecessary jargon while maintaining technical accuracy.
- **Navigation**: Ensure all new pages and sections are properly integrated into the navigation system and sidebars.

## Module Documentation

- **Permission Actions**: Each module doc owns its permission table in a `## Permissions` section. The table must have four columns: **Action**, **Permission**, **REST Endpoint**, and **MCP Tool**. `iam.md` explains the `resource:Action` format and wildcards but does **not** list individual actions — it links to each module's `## Permissions` section instead.
- **Keep in sync**: When a new permission action is added to the server, add a row to the relevant module doc's permissions table and, if it introduces a new module, add a link in `iam.md`.

## Technical Requirements

- **API Documentation**: When generating or updating API documentation, ensure it is comprehensive and follows the standards outlined in the website package.
- **Build and Deployment**: Verify that changes do not break the build process and maintain compatibility with the Docusaurus framework used for the website.
