---
sidebar_position: 1
---

# Connect with MCP

The **Model Context Protocol (MCP)** is the easiest way to consume SOAT. It allows AI clients (like Claude Desktop) to automatically discover and use the memory tools provided by your server.

## Integrating with Claude Desktop

1.  **Locate your Claude Config**

    Find the `claude_desktop_config.json` file on your machine:
    - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
    - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

2.  **Add SOAT Server**

    Add the following configuration to the `mcpServers` object. We use `stdio` (standard input/output) for local development or `sse` (Server-Sent Events) for remote servers.

    _If you are running the server locally via Docker on port 3000, you will likely use the SSE transport._

    ```json
    {
      "mcpServers": {
        "soat": {
          "command": "node",
          "args": ["path/to/soat/packages/server/dist/index.js"],
          "env": {
            "DATABASE_URL": "postgres://soat_user:soat_password@localhost:5432/soat_db"
          }
        }
      }
    }
    ```

    > **Wait!** The example above assumes you are running the MCP server directly via `node`.
    > If you are using the **Docker container** we set up in "Getting Started", you need an MCP Client that supports HTTP/SSE.
    >
    > _Currently, Claude Desktop creates a local process. You might need to run a local "bridge" script or run the node process directly as shown above._

    **Recommended for Local Source Usage:**
    If you cloned the repo, the easiest way currently is to point Claude directly to the built server file:

    ```bash
    # First, ensure you have built the project
    pnpm install
    pnpm build
    ```

    Then update your config to point to the absolute path of the built file.

3.  **Restart Claude**

    Restart the Claude Desktop application. You should see a 🔌 icon indicating the MCP server is connected.

4.  **Test It**

    Ask Claude: _"Please save this conversation to my memory"_ or _"What do you know about my project SOAT?"_.

## Using with Cursor

Cursor also supports MCP. Go to **Cursor Settings > Features > MCP** and add a new server.
