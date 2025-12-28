# @soat/server

The SOAT server provides memory management APIs for autonomous agents, offering both MCP (Model Context Protocol) and REST endpoints.

## Features

- **MCP Server**: Full Model Context Protocol support for AI assistant integration
- **REST API**: Simple HTTP endpoints for any application
- **Vector Search**: Semantic similarity search powered by pgvector
- **Local Embeddings**: Uses Ollama for generating embeddings locally

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (for PostgreSQL)
- [Ollama](https://ollama.com/)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/ttoss/soat.git
cd soat/packages/server
pnpm install
```

### 2. Set Up the Database

Start a PostgreSQL container with pgvector:

```bash
docker run -d --name soat-db --shm-size=1g -e POSTGRES_PASSWORD=yourpassword -p 5432:5432 pgvector/pgvector:pg18-trixie
```

Create the `vector` extension:

```bash
docker exec -it soat-db psql -U postgres -d postgres -c "CREATE EXTENSION vector;"
```

Create the memories table:

```bash
docker exec -it soat-db psql -U postgres -d postgres -c "
CREATE TABLE IF NOT EXISTS memories (
    id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    embedding VECTOR(1024) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);"
```

### 3. Install Ollama

Follow the instructions at [Ollama's official website](https://ollama.com/download) to install Ollama.

Pull the embedding model:

```bash
ollama pull qwen3-embedding:0.6b
```

### 4. Start the Server

```bash
pnpm dev
```

The server will be running at `http://localhost:5047`.

## API Reference

### MCP Tools

The server exposes the following MCP tools:

| Tool            | Description                              |
| --------------- | ---------------------------------------- |
| `record-memory` | Stores content with its vector embedding |
| `recall-memory` | Retrieves semantically similar memories  |

### REST Endpoints

#### Record Memory

```http
POST /api/memory/record
Content-Type: application/json

{
  "content": "Text content to store"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Memory recorded successfully"
}
```

#### Recall Memory

```http
POST /api/memory/recall
Content-Type: application/json

{
  "query": "search query",
  "limit": 10
}
```

**Response:**

```json
{
  "success": true,
  "memories": [
    {
      "content": "Similar memory content",
      "distance": 0.1234
    }
  ]
}
```

## Testing

### Using MCP Inspector

Run [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx -y @modelcontextprotocol/inspector
```

Configure the connection:

- **Transport Type**: Streamable HTTP
- **URL**: `http://localhost:5047/mcp`
- **Connection Type**: Direct

### Using curl

**Record a memory:**

```bash
curl -X POST http://localhost:5047/api/memory/record \
     -H "Content-Type: application/json" \
     -d '{"content": "The capital of France is Paris."}'
```

**Recall memories:**

```bash
curl -X POST http://localhost:5047/api/memory/recall \
     -H "Content-Type: application/json" \
     -d '{"query": "What is the capital of France?", "limit": 5}'
```

## Configuration

The server uses the following default configuration:

| Setting         | Default                | Description                 |
| --------------- | ---------------------- | --------------------------- |
| Port            | `5047`                 | HTTP server port            |
| Database        | `postgres`             | PostgreSQL database name    |
| DB Host         | `localhost`            | Database host               |
| DB Port         | `5432`                 | Database port               |
| Embedding Model | `qwen3-embedding:0.6b` | Ollama model for embeddings |

## License

MIT
