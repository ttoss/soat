# SOAT Website

## Local Development

```bash
pnpm run dev
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Website Structure

The SOAT website is organized around a main navigation bar (navbar) and structured sidebars for resource-specific documentation. This structure ensures easy navigation and comprehensive coverage of project information.

### Navbar

The navbar provides top-level access to key sections of the documentation:

- **Platform**: Comprehensive documentation about the SOAT project, including getting started guides, project overview, and information about supported deployment platforms. The current recommended platform is Docker self-hosted deployment, with platform-specific setup guides available in this section.
- **Resources**: Detailed documentation for SOAT features, organized as separate folders in the sidebar. Each resource section explains the rationale, core concepts, and practical usage. Currently available resources include:
  - **Files**: Explains the Files resource, covering its design principles, usage examples, and integration points within the SOAT ecosystem.
- **MCP**: Documentation for the Model Context Protocol (MCP) server implementation in SOAT, including architecture overview, setup and running instructions, and developer guides for prompts, tools, and extensions.
- **API**: Complete REST API documentation with endpoint specifications, request/response examples, authentication mechanisms, and versioning information.
- **Blog**: Collection of company and project blog posts, announcements, tutorials, and longer-form articles about SOAT developments and best practices.

### Sidebar

Each major section utilizes structured sidebars for organized content navigation:

- **Resource Sections**: Individual resources under "Resources" maintain dedicated sidebar folders with consistent structure:
  - **Overview**: High-level rationale, core concepts, and architectural overview
  - **Getting Started**: Quickstart guides, basic setup, and simple examples
  - **Reference**: Complete API specifications, configuration options, and technical details
  - **Guides**: In-depth walkthroughs, advanced usage patterns, and integration tutorials

This organization ensures that users can quickly find both introductory and advanced content for each aspect of SOAT.
