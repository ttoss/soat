---
sidebar_position: 1
---

# Introduction

**SOAT (Source of Agentic Truth)** is an open-source framework designed to give AI agents **Persistent Memory**.

In the evolving landscape of AI, agents are becoming more autonomous and capable. However, they often suffer from "amnesia" between sessions or have limited context windows. SOAT solves this by providing a dedicated memory server that allows agents to store and retrieve information semantically.

## Why SOAT?

- **🧠 Persistent Memory**: Agents can store text, files, and structured data that survives across sessions.
- **🔎 Semantic Search**: Built on `pgvector`, SOAT enables agents to find information not just by keywords, but by _meaning_.
- **🔌 MCP Native**: Full support for the **Model Context Protocol (MCP)**, allowing seamless integration with Claude Desktop, Cursor, and other MCP-compliant tools.
- **⚡ Simple API**: A standardized REST API for building custom integrations.

## Core Concepts

### Memory & Embeddings

When you send text to SOAT, it doesn't just save the string. It generates a **vector embedding**—a mathematical representation of the text's meaning. This allows the system to calculate similarity between different pieces of information.

### The MCP Server

The Model Context Protocol (MCP) is a standard for connecting AI models to external data. SOAT acts as an MCP Server, exposing tools like `add_memory` and `search_memory` that agents can discover and use automatically.

## Next Steps

- **[Getting Started](./getting-started.md)**: Spin up your own SOAT server in minutes using Docker.
- **[Connect with MCP](./tutorials/connect-mcp.md)**: Learn how to connect Claude Desktop to your new memory bank.
- **[Storing Memory](./tutorials/storing-memory.md)**: A guide to the memory tools available to your agents.
