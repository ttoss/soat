---
sidebar_position: 2
---

# Getting Started

The fastest way to run SOAT is using Docker Compose. This ensures you have the SOAT API Server and the vector-enabled PostgreSQL database running together correctly.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine installed.
- `git` (optional, for cloning the repo).

## Quick Start

1.  **Clone the Repository**

    ```bash
    git clone https://github.com/ttoss/soat.git
    cd soat
    ```

2.  **Start the Services**

    We provide a standard `docker-compose.yml` configuration (create this file in your root folder if it doesn't exist, based on the example below).

    Create a `docker-compose.yml` in the root of your project:

    ```yaml
    services:
      database:
        image: pgvector/pgvector:0.8.1-pg18-trixie
        container_name: soat-database
        environment:
          POSTGRES_DB: soat_db
          POSTGRES_USER: soat_user
          POSTGRES_PASSWORD: soat_password
        ports:
          - '5432:5432'
        volumes:
          - postgres_data:/var/lib/postgresql/data
        healthcheck:
          test: ['CMD-SHELL', 'pg_isready -U soat_user -d soat_db']
          interval: 10s
          timeout: 5s
          retries: 5

      server:
        image: ghcr.io/ttoss/soat-server:latest # Assuming a published image, or build locally
        # For local development, you might build from ./packages/server
        # build: ./packages/server
        container_name: soat-server
        ports:
          - '3000:3000'
        environment:
          DATABASE_URL: postgres://soat_user:soat_password@database:5432/soat_db
          PORT: 3000
        depends_on:
          database:
            condition: service_healthy

    volumes:
      postgres_data:
    ```

    > **Note:** If you are running from source, you may need to build the server package locally.

3.  **Run Docker Compose**

    ```bash
    docker-compose up -d
    ```

    Your SOAT Server should now be running at `http://localhost:3000`.

4.  **Verify Installation**

    You can test if the server is running by checking the health endpoint or documentation (if enabled):

    ```bash
    curl http://localhost:3000/health
    ```

## Environment Variables

The server behaves differently based on configuration. Important variables include:

- `DATABASE_URL`: Connection string for PostgreSQL.
- `OPENAI_API_KEY`: Required if you are using OpenAI for embeddings (default).
- `OLLAMA_HOST`: (Optional) URL for local Ollama instance if using local embeddings.

## Next Steps

Now that your server is running, let's **[Connect an Agent](./tutorials/connect-mcp.md)** to it!
