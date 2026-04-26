// THIS FILE IS AUTO-GENERATED. DO NOT EDIT MANUALLY.
// Run `pnpm generate` to regenerate.

export interface paths {
    "/actors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List actors
         * @description Returns all actors the caller has access to. If projectId is provided, returns only actors in that project. project keys are scoped to a single project automatically. JWT users without projectId receive actors across all their accessible projects.
         */
        get: operations["listActors"];
        put?: never;
        /**
         * Create an actor
         * @description Creates a new actor. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
         */
        post: operations["createActor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actors/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an actor by ID
         * @description Returns an actor by its ID
         */
        get: operations["getActor"];
        put?: never;
        post?: never;
        /**
         * Delete an actor
         * @description Deletes an actor by its ID
         */
        delete: operations["deleteActor"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent tools
         * @description Returns all agent tools in the project.
         */
        get: operations["listAgentTools"];
        put?: never;
        /**
         * Create an agent tool
         * @description Creates a new agent tool in the project.
         */
        post: operations["createAgentTool"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/tools/{toolId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an agent tool
         * @description Returns a single agent tool by ID.
         */
        get: operations["getAgentTool"];
        /**
         * Update an agent tool
         * @description Updates an existing agent tool.
         */
        put: operations["updateAgentTool"];
        post?: never;
        /**
         * Delete an agent tool
         * @description Deletes an agent tool by ID.
         */
        delete: operations["deleteAgentTool"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/traces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent traces
         * @description Returns all traces for the project.
         */
        get: operations["listAgentTraces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/traces/{traceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a trace
         * @description Returns a single trace by ID.
         */
        get: operations["getAgentTrace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agents
         * @description Returns all agents in the project.
         */
        get: operations["listAgents"];
        put?: never;
        /**
         * Create an agent
         * @description Creates a new agent bound to an AI provider.
         */
        post: operations["createAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an agent
         * @description Returns a single agent by ID.
         */
        get: operations["getAgent"];
        /**
         * Update an agent
         * @description Updates an existing agent.
         */
        put: operations["updateAgent"];
        post?: never;
        /**
         * Delete an agent
         * @description Deletes an agent by ID.
         */
        delete: operations["deleteAgent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run an agent generation
         * @description Sends messages to the agent, resolves its tools, and runs the AI model loop. Supports streaming via `stream: true`. Client tools pause the generation and return `requires_action`.
         */
        post: operations["createAgentGeneration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/generate/{generationId}/tool-outputs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit tool outputs for a paused generation
         * @description Resumes a generation that was paused due to client tool calls. Provide tool outputs for each pending tool call.
         */
        post: operations["submitAgentToolOutputs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ai-providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List AI providers
         * @description Returns a list of AI provider configurations for a project
         */
        get: operations["listAiProviders"];
        put?: never;
        /**
         * Create an AI provider
         * @description Creates a new LLM provider configuration
         */
        post: operations["createAiProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ai-providers/{aiProviderId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an AI provider
         * @description Returns a specific AI provider configuration
         */
        get: operations["getAiProvider"];
        put?: never;
        post?: never;
        /**
         * Delete an AI provider
         * @description Deletes an AI provider configuration
         */
        delete: operations["deleteAiProvider"];
        options?: never;
        head?: never;
        /**
         * Update an AI provider
         * @description Updates an AI provider configuration
         */
        patch: operations["updateAiProvider"];
        trace?: never;
    };
    "/api-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an API key
         * @description Creates a new API key for the authenticated user. - If `project_id` is provided, the key is scoped to that project. - If `policy_ids` is provided, the key's effective permissions are the intersection of the user's policies and the key's policies. - If neither is provided, the key inherits the user's full permissions.
         */
        post: operations["createApiKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api-keys/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an API key
         * @description Returns details of an API key. Only the owner or an admin can access it.
         */
        get: operations["getApiKey"];
        /**
         * Update an API key
         * @description Updates an API key's name, project scope, or policies. Only the owner or an admin can update it.
         */
        put: operations["updateApiKey"];
        post?: never;
        /**
         * Delete an API key
         * @description Deletes an API key. Only the owner or an admin can delete it.
         */
        delete: operations["deleteApiKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List chats
         * @description Returns all chats in the project.
         */
        get: operations["listChats"];
        put?: never;
        /**
         * Create a chat
         * @description Creates a new chat resource bound to an AI provider.
         */
        post: operations["createChat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats/{chatId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a chat
         * @description Returns a single chat by ID.
         */
        get: operations["getChat"];
        put?: never;
        post?: never;
        /**
         * Delete a chat
         * @description Deletes a chat by ID.
         */
        delete: operations["deleteChat"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats/{chatId}/completions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a chat completion for a stored chat
         * @description Runs a completion using the AI provider and settings stored in the chat. Pass `stream: true` for SSE streaming. A system message in `messages` overrides the chat's stored system message for this call only. Messages may use `documentId` instead of `content`.
         */
        post: operations["createChatCompletionForChat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats/completions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a chat completion (stateless)
         * @description OpenAI Chat Completions-compatible endpoint. Resolves the AI provider from `aiProviderId`, decrypts its secret, and calls the appropriate Vercel AI SDK provider. Falls back to Ollama when `aiProviderId` is omitted.
         */
        post: operations["createChatCompletion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversations
         * @description Returns all conversations the caller has access to. If projectId is provided, returns only conversations in that project. project keys are scoped to a single project automatically.
         */
        get: operations["listConversations"];
        put?: never;
        /**
         * Create a conversation
         * @description Creates a new conversation. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
         */
        post: operations["createConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a conversation by ID
         * @description Returns a conversation by its ID
         */
        get: operations["getConversation"];
        put?: never;
        post?: never;
        /**
         * Delete a conversation
         * @description Deletes a conversation by its ID
         */
        delete: operations["deleteConversation"];
        options?: never;
        head?: never;
        /**
         * Update a conversation
         * @description Updates the status of a conversation
         */
        patch: operations["updateConversation"];
        trace?: never;
    };
    "/conversations/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversation messages
         * @description Returns all messages (documents) attached to a conversation, ordered by position
         */
        get: operations["listConversationMessages"];
        put?: never;
        /**
         * Add a message to a conversation
         * @description Creates a document from the message text and attaches it to the conversation at the given position. If position is omitted, it is appended at the end.
         */
        post: operations["addConversationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Generate the next message in a conversation
         * @description Generates the next message using the specified actor's linked agent or chat.
         *     On `completed`, the reply is persisted as a new ConversationMessage authored
         *     by that actor. On `requires_action`, nothing is persisted; the caller must
         *     submit tool outputs via the Agents module and re-invoke generate.
         */
        post: operations["generateConversationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/actors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List actors in a conversation
         * @description Returns all distinct actors who have sent at least one message in the conversation
         */
        get: operations["listConversationActors"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/messages/{documentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a message from a conversation
         * @description Removes a document from a conversation
         */
        delete: operations["removeConversationMessage"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List documents
         * @description Returns all documents the caller has access to. If projectId is provided, returns only documents in that project. project keys are scoped to a single project automatically. JWT users without projectId receive documents across all their accessible projects.
         */
        get: operations["listDocuments"];
        put?: never;
        /**
         * Create a document
         * @description Creates a new text document and generates an embedding vector for semantic search. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
         */
        post: operations["createDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a document by ID
         * @description Returns a document with its text content
         */
        get: operations["getDocument"];
        put?: never;
        post?: never;
        /**
         * Delete a document
         * @description Deletes a document and its underlying file
         */
        delete: operations["deleteDocument"];
        options?: never;
        head?: never;
        /**
         * Update a document
         * @description Updates document content, title, path, metadata, or tags. Supplying `path` moves the document to a new logical path within the project.
         */
        patch: operations["updateDocument"];
        trace?: never;
    };
    "/documents/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Semantic search over documents
         * @description Embeds the query text and returns the most similar documents using cosine distance. If projectId is omitted, searches across all projects the caller has access to.
         */
        post: operations["searchDocuments"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all files
         * @description Returns a list of all stored files
         */
        get: operations["listFiles"];
        put?: never;
        /**
         * Create a file
         * @description Creates a new file record in the system
         */
        post: operations["createFile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload a file
         * @description Uploads a file to the server and stores it in the configured storage directory
         */
        post: operations["uploadFile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a file by ID
         * @description Returns the data and metadata of a specific file
         */
        get: operations["getFile"];
        put?: never;
        post?: never;
        /**
         * Delete a file
         * @description Removes a file from the system by ID
         */
        delete: operations["deleteFile"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/{id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download a file
         * @description Streams the file content to the client
         */
        get: operations["downloadFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/{id}/metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update file metadata
         * @description Updates the metadata field of a file
         */
        patch: operations["updateFileMetadata"];
        trace?: never;
    };
    "/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all policies
         * @description Returns a list of all global policies. Requires admin role.
         */
        get: operations["listPolicies"];
        put?: never;
        /**
         * Create a policy
         * @description Creates a new global policy. Requires admin role.
         */
        post: operations["createPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/policies/{policyId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a policy
         * @description Returns details of a specific policy. Requires admin role.
         */
        get: operations["getPolicy"];
        /**
         * Update a policy
         * @description Updates an existing global policy. Requires admin role.
         */
        put: operations["updatePolicy"];
        post?: never;
        /**
         * Delete a policy
         * @description Deletes a global policy. Requires admin role.
         */
        delete: operations["deletePolicy"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a project
         * @description Creates a new project. Requires admin role.
         */
        post: operations["createProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{projectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a project
         * @description Returns details of a specific project.
         */
        get: operations["getProject"];
        put?: never;
        post?: never;
        /**
         * Delete a project
         * @description Deletes a project. Requires admin role.
         */
        delete: operations["deleteProject"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List secrets
         * @description Returns a list of secrets for a project
         */
        get: operations["listSecrets"];
        put?: never;
        /**
         * Create a secret
         * @description Creates a new encrypted secret in a project
         */
        post: operations["createSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/secrets/{secretId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a secret
         * @description Returns a specific secret
         */
        get: operations["getSecret"];
        put?: never;
        post?: never;
        /**
         * Delete a secret
         * @description Deletes a secret
         */
        delete: operations["deleteSecret"];
        options?: never;
        head?: never;
        /**
         * Update a secret
         * @description Updates a secret's name and/or value
         */
        patch: operations["updateSecret"];
        trace?: never;
    };
    "/agents/{agentId}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List sessions
         * @description Returns sessions for the specified agent, optionally filtered by actorId and status.
         */
        get: operations["listSessions"];
        put?: never;
        /**
         * Create a session
         * @description Creates a new session for the specified agent. Internally creates a conversation and two actors (agent + user) so the caller only needs this single call to start interacting with the agent.
         */
        post: operations["createSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a session
         * @description Returns details of a single session.
         */
        get: operations["getSession"];
        put?: never;
        post?: never;
        /**
         * Delete a session
         * @description Deletes the session and its underlying conversation and actors.
         */
        delete: operations["deleteSession"];
        options?: never;
        head?: never;
        /**
         * Update a session
         * @description Updates the session name and/or status.
         */
        patch: operations["updateSession"];
        trace?: never;
    };
    "/agents/{agentId}/sessions/{sessionId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List session messages
         * @description Returns messages in the session with simplified roles (user/assistant) instead of raw actor IDs.
         */
        get: operations["listSessionMessages"];
        put?: never;
        /**
         * Add a user message
         * @description Saves a user message to the session. When autoGenerate is enabled on the session and no generation is currently in progress, generation is triggered automatically and the response mirrors GenerateSessionResponse. Otherwise returns the saved user message.
         */
        post: operations["addSessionMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/sessions/{sessionId}/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Trigger agent generation
         * @description Triggers the agent to generate a response based on the current conversation. Returns the assistant reply or a requires_action status if the agent needs client tool outputs. Pass ?async=true for a 202 accepted response when you do not need to wait for the result.
         */
        post: operations["generateSessionResponse"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/sessions/{sessionId}/tool-outputs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit tool outputs
         * @description Submits client tool outputs for a generation that returned requires_action. The agent continues its loop and returns the final or next requires_action result.
         */
        post: operations["submitSessionToolOutputs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/sessions/{sessionId}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get session tags
         * @description Returns the session's tags object.
         */
        get: operations["getSessionTags"];
        /**
         * Replace session tags
         * @description Replaces all tags on the session.
         */
        put: operations["replaceSessionTags"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Merge session tags
         * @description Merges the provided tags into the session's existing tags.
         */
        patch: operations["mergeSessionTags"];
        trace?: never;
    };
    "/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all users
         * @description Returns a list of all users
         */
        get: operations["listUsers"];
        put?: never;
        /**
         * Create a user
         * @description Creates a new user in the system
         */
        post: operations["createUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a user by ID
         * @description Returns the data of a specific user
         */
        get: operations["getUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the first admin user
         * @description Creates the first admin user. Returns 409 if any user already exists.
         */
        post: operations["bootstrapUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/{userId}/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get policies attached to a user
         * @description Returns the list of policies attached to a user. Requires admin role.
         */
        get: operations["getUserPolicies"];
        /**
         * Attach policies to a user
         * @description Replaces the user's policy list with the provided policy IDs. Requires admin role.
         */
        put: operations["attachUserPolicies"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{projectId}/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List webhooks for a project */
        get: operations["listWebhooks"];
        put?: never;
        /** Create a webhook */
        post: operations["createWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{projectId}/webhooks/{webhookId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a webhook */
        get: operations["getWebhook"];
        /** Update a webhook */
        put: operations["updateWebhook"];
        post?: never;
        /** Delete a webhook */
        delete: operations["deleteWebhook"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{projectId}/webhooks/{webhookId}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List deliveries for a webhook */
        get: operations["listWebhookDeliveries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{projectId}/webhooks/{webhookId}/deliveries/{deliveryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a delivery */
        get: operations["getWebhookDelivery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{projectId}/webhooks/{webhookId}/rotate-secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate webhook secret */
        post: operations["rotateWebhookSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ActorRecord: {
            /**
             * @description Actor ID
             * @example act_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /** @example Alice */
            name?: string;
            /**
             * @description Actor type (e.g. 'customer', 'agent')
             * @example customer
             */
            type?: string | null;
            /**
             * @description External identifier (e.g. WhatsApp phone number)
             * @example +15551234567
             */
            external_id?: string | null;
            /** @description Persona-specific instructions composed into the effective system prompt during conversation generation. */
            instructions?: string | null;
            /** @description Agent this actor is linked to (mutually exclusive with chatId). */
            agent_id?: string | null;
            /** @description Chat this actor is linked to (mutually exclusive with agentId). */
            chat_id?: string | null;
            tags?: {
                [key: string]: string;
            };
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        ErrorResponse: {
            /** @example Actor not found */
            error?: string;
        };
        AgentTool: {
            /**
             * @description Public ID of the agent tool
             * @example agt_tool_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Public ID of the owning project
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /**
             * @description Tool name
             * @example get-weather
             */
            name?: string;
            /**
             * @description Tool type
             * @example http
             * @enum {string}
             */
            type?: "http" | "client" | "mcp" | "soat";
            /** @description What the tool does (sent to the model) */
            description?: string | null;
            /** @description JSON Schema for tool input */
            parameters?: Record<string, never> | null;
            /** @description Execution config for http tools. Supported fields: `url` (required), `method` (default `POST`), and `headers`. The `url` may contain `{paramName}` placeholders (e.g. `/users/{userId}`) that are replaced at call time with the corresponding tool argument value (URL-encoded). Arguments consumed as path parameters are excluded from the query string and request body. */
            execute?: Record<string, never> | null;
            /** @description MCP server config (url, headers) */
            mcp?: Record<string, never> | null;
            /** @description SOAT platform actions to expose */
            actions?: string[] | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        CreateAgentToolRequest: {
            /** @description Public ID of the project */
            project_id?: string;
            /** @description Tool name */
            name: string;
            /**
             * @description Tool type (default http)
             * @enum {string}
             */
            type?: "http" | "client" | "mcp" | "soat";
            /** @description What the tool does */
            description?: string;
            /** @description JSON Schema for tool input */
            parameters?: Record<string, never>;
            /** @description Execution config for http tools. Supported fields: `url` (required), `method` (default `POST`), and `headers`. The `url` may contain `{paramName}` placeholders (e.g. `/users/{userId}`) that are replaced at call time with the corresponding tool argument value (URL-encoded). Arguments consumed as path parameters are excluded from the query string and request body. */
            execute?: Record<string, never>;
            /** @description MCP server config (url, headers) */
            mcp?: Record<string, never>;
            /** @description SOAT platform actions */
            actions?: string[];
        };
        UpdateAgentToolRequest: {
            name?: string;
            /** @enum {string} */
            type?: "http" | "client" | "mcp" | "soat";
            description?: string | null;
            parameters?: Record<string, never> | null;
            /** @description Execution config for http tools. Supported fields: `url` (required), `method` (default `POST`), and `headers`. The `url` may contain `{paramName}` placeholders (e.g. `/users/{userId}`) that are replaced at call time with the corresponding tool argument value (URL-encoded). Arguments consumed as path parameters are excluded from the query string and request body. */
            execute?: Record<string, never> | null;
            mcp?: Record<string, never> | null;
            actions?: string[] | null;
        };
        Agent: {
            /**
             * @description Public ID of the agent
             * @example agt_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @description Public ID of the owning project */
            project_id?: string;
            /** @description Public ID of the AI provider */
            ai_provider_id?: string;
            /** @description Display name */
            name?: string | null;
            /** @description System instructions guiding behavior */
            instructions?: string | null;
            /** @description Model identifier */
            model?: string | null;
            /** @description Public IDs of attached agent tools */
            tool_ids?: string[] | null;
            /** @description Maximum reasoning steps */
            max_steps?: number | null;
            /** @description Tool choice strategy */
            tool_choice?: Record<string, never> | null;
            /** @description Stop conditions */
            stop_conditions?: Record<string, never>[] | null;
            /** @description Subset of toolIds active per step */
            active_tool_ids?: string[] | null;
            /** @description Per-step overrides */
            step_rules?: Record<string, never>[] | null;
            /** @description Allowed/denied SOAT actions */
            boundary_policy?: Record<string, never> | null;
            /** @description Sampling temperature */
            temperature?: number | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        CreateAgentRequest: {
            /** @description Public ID of the project */
            project_id?: string;
            /** @description Public ID of the AI provider */
            ai_provider_id: string;
            name?: string;
            instructions?: string;
            model?: string;
            tool_ids?: string[];
            max_steps?: number;
            tool_choice?: Record<string, never>;
            stop_conditions?: Record<string, never>[];
            active_tool_ids?: string[];
            step_rules?: Record<string, never>[];
            boundary_policy?: Record<string, never>;
            temperature?: number;
        };
        UpdateAgentRequest: {
            ai_provider_id?: string;
            name?: string | null;
            instructions?: string | null;
            model?: string | null;
            tool_ids?: string[] | null;
            max_steps?: number | null;
            tool_choice?: Record<string, never> | null;
            stop_conditions?: Record<string, never>[] | null;
            active_tool_ids?: string[] | null;
            step_rules?: Record<string, never>[] | null;
            boundary_policy?: Record<string, never> | null;
            temperature?: number | null;
        };
        CreateAgentGenerationRequest: {
            messages: {
                /** @enum {string} */
                role: "system" | "user" | "assistant";
                content: string;
            }[];
            /**
             * @description When true the response is an SSE stream
             * @default false
             */
            stream: boolean;
            /** @description Optional trace ID to group generations */
            trace_id?: string;
            /**
             * @description Maximum nested agent-call depth; 0 short-circuits with a depth-guard response
             * @default 10
             */
            max_call_depth: number;
            /** @description Key-value pairs injected as context headers into all tool call requests made during this generation. */
            tool_context?: {
                [key: string]: string;
            } | null;
        };
        SubmitToolOutputsRequest: {
            tool_outputs: {
                /** @description ID of the tool call to respond to */
                tool_call_id: string;
                /** @description Result of the tool execution */
                output: unknown;
            }[];
        };
        AgentGenerationResponse: {
            /**
             * @description Public ID of the generation
             * @example agt_gen_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Generation status
             * @enum {string}
             */
            status?: "completed" | "requires_action";
            /** @description Final text output (when completed) */
            text?: string | null;
            /** @description Pending tool calls (when requires_action) */
            tool_calls?: {
                tool_call_id?: string;
                tool_name?: string;
                args?: Record<string, never>;
            }[] | null;
        };
        AgentTrace: {
            /**
             * @description Public ID of the trace
             * @example agt_trace_V1StGXR8Z5jdHi6B
             */
            id?: string;
            project_id?: string;
            agent_id?: string;
            generations?: Record<string, never>[];
            /** Format: date-time */
            created_at?: string;
        };
        ApiKeyRecord: {
            /**
             * @description Public API key ID (key_ prefix)
             * @example key_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @example CI/CD Pipeline */
            name?: string;
            /**
             * @description First 8 characters of the raw key for identification
             * @example sk_a1b2c3
             */
            key_prefix?: string;
            /**
             * @description Owner user public ID
             * @example usr_V1StGXR8Z5jdHi6B
             */
            user_id?: string;
            /**
             * @description Optional project scope
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string | null;
            /**
             * @description Public IDs of policies attached to this key
             * @example [
             *       "pol_V1StGXR8Z5jdHi6B"
             *     ]
             */
            policy_ids?: string[];
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            created_at?: string;
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            updated_at?: string;
        };
        ApiKeyCreated: components["schemas"]["ApiKeyRecord"] & {
            /**
             * @description The raw API key value (only returned once at creation). Use as Bearer token.
             * @example sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
             */
            key?: string;
        };
        Chat: {
            /**
             * @description Public ID of the chat
             * @example cht_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Public ID of the owning project
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /**
             * @description Public ID of the AI provider
             * @example aip_V1StGXR8Z5jdHi6B
             */
            ai_provider_id?: string;
            /**
             * @description Optional human-readable name
             * @example Support Bot
             */
            name?: string | null;
            /**
             * @description Optional system message sent with every completion
             * @example You are a helpful support assistant.
             */
            system_message?: string | null;
            /**
             * @description Optional model override for this chat
             * @example gpt-4o
             */
            model?: string | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        CreateChatRequest: {
            /**
             * @description Public ID of the AI provider
             * @example aip_V1StGXR8Z5jdHi6B
             */
            ai_provider_id: string;
            /**
             * @description Public ID of the project. Required when the user belongs to multiple projects and no project key is used.
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /**
             * @description Optional human-readable name
             * @example Support Bot
             */
            name?: string;
            /**
             * @description Optional system message applied to all completions on this chat
             * @example You are a helpful support assistant.
             */
            system_message?: string;
            /**
             * @description Optional default model override
             * @example gpt-4o
             */
            model?: string;
        };
        ChatMessageInput: {
            /**
             * @example user
             * @enum {string}
             */
            role: "system" | "user" | "assistant";
            /**
             * @description Text content of the message (mutually exclusive with documentId)
             * @example What can you help me with?
             */
            content?: string;
            /**
             * @description Public ID of a document whose content is used as the message body (mutually exclusive with content). Only valid for user/assistant roles.
             * @example doc_V1StGXR8Z5jdHi6B
             */
            document_id?: string;
        };
        ChatCompletionForChatRequest: {
            messages: components["schemas"]["ChatMessageInput"][];
            /**
             * @description Override the chat's default model for this call
             * @example gpt-4o-mini
             */
            model?: string;
            /**
             * @description When `true` the response is an SSE stream.
             * @default false
             */
            stream: boolean;
        };
        ChatMessage: {
            /**
             * @description Role of the message author
             * @example user
             * @enum {string}
             */
            role: "system" | "user" | "assistant";
            /**
             * @description Text content of the message
             * @example Hello, how are you?
             */
            content: string;
        };
        ChatCompletionRequest: {
            /**
             * @description Public ID of the AI provider to use. When omitted the server falls back to Ollama.
             * @example aip_V1StGXR8Z5jdHi6B
             */
            ai_provider_id?: string;
            /**
             * @description Model identifier. Overrides the provider's `defaultModel` when specified.
             * @example gpt-4o
             */
            model?: string;
            /** @description Ordered list of chat messages */
            messages: components["schemas"]["ChatMessage"][];
            /**
             * @description When `true` the response is an SSE stream of delta chunks. When `false` (default) a single JSON object is returned.
             * @default false
             */
            stream: boolean;
        };
        ChatCompletionResponseMessage: {
            /** @example assistant */
            role?: string;
            /** @example Hello! I am doing well, thank you. */
            content?: string;
        };
        ChatCompletionChoice: {
            /** @example 0 */
            index?: number;
            message?: components["schemas"]["ChatCompletionResponseMessage"];
            /** @example stop */
            finish_reason?: string;
        };
        ChatCompletionResponse: {
            /** @example chat.completion */
            object?: string;
            /** @example gpt-4o */
            model?: string;
            choices?: components["schemas"]["ChatCompletionChoice"][];
        };
        ConversationRecord: {
            /**
             * @description Conversation ID
             * @example conv_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /** @description Optional human-readable name for the conversation. */
            name?: string | null;
            /**
             * @description Conversation status
             * @example open
             * @enum {string}
             */
            status?: "open" | "closed";
            /**
             * Format: date-time
             * @description Creation timestamp
             */
            created_at?: string;
            /**
             * Format: date-time
             * @description Last update timestamp
             */
            updated_at?: string;
            /**
             * @description Actor ID associated with this conversation
             * @example act_V1StGXR8Z5jdHi6B
             */
            actor_id?: string | null;
        };
        ConversationMessageRecord: {
            /**
             * @description Document ID
             * @example doc_V1StGXR8Z5jdHi6B
             */
            document_id?: string;
            /**
             * @description Actor ID who sent this message
             * @example act_V1StGXR8Z5jdHi6B
             */
            actor_id?: string;
            /**
             * @description Zero-based position in the conversation
             * @example 0
             */
            position?: number;
            /**
             * @description Optional structured metadata attached to the message
             * @example {
             *       "phone": "5511999998888",
             *       "channel": "whatsapp"
             *     }
             */
            metadata?: {
                [key: string]: unknown;
            } | null;
            /** @description Full text content of the message */
            content?: string | null;
        };
        ConversationActorRecord: {
            /**
             * @description Actor ID
             * @example act_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /**
             * @description Actor name
             * @example Alice
             */
            name?: string;
            /**
             * @description Actor type
             * @example human
             */
            type?: string;
            /**
             * @description External identifier
             * @example ext_123
             */
            external_id?: string;
            /**
             * Format: date-time
             * @description Creation timestamp
             */
            created_at?: string;
            /**
             * Format: date-time
             * @description Last update timestamp
             */
            updated_at?: string;
        };
        GenerateConversationMessageResponse: {
            /**
             * @description Indicates generation finished successfully.
             * @enum {string}
             */
            status: "completed";
            /**
             * @description The AI-generated text of the reply. This is the canonical field for the assistant's response text.
             * @example Hello! How can I help you today?
             */
            content: string;
            message: components["schemas"]["ConversationMessageRecord"];
            /**
             * @description ID of the underlying generation record.
             * @example gen_V1StGXR8Z5jdHi6B
             */
            generation_id?: string;
            /**
             * @description Trace ID for observability.
             * @example trc_V1StGXR8Z5jdHi6B
             */
            trace_id?: string;
            /**
             * @description Model used for generation.
             * @example gpt-4o
             */
            model?: string;
        } | {
            /**
             * @description Indicates the agent requires tool-call outputs before it can produce a reply. No message is persisted yet.
             * @enum {string}
             */
            status: "requires_action";
            /**
             * @description ID of the paused generation. Pass to the tool-outputs endpoint.
             * @example gen_V1StGXR8Z5jdHi6B
             */
            generation_id?: string;
            /**
             * @description Trace ID for observability.
             * @example trc_V1StGXR8Z5jdHi6B
             */
            trace_id?: string;
            /** @description Tool-call information the client must resolve. */
            required_action?: Record<string, never>;
        };
        DocumentRecord: {
            /**
             * @description Document ID
             * @example doc_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Underlying file ID
             * @example file_V1StGXR8Z5jdHi6B
             */
            file_id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            project_id?: string;
            /**
             * @description Logical path of the document within the project (e.g. /reports/q1.txt)
             * @example /reports/q1.txt
             */
            path?: string | null;
            /**
             * @description Original filename
             * @example my-doc.txt
             */
            filename?: string;
            /**
             * @description File size in bytes
             * @example 42
             */
            size?: number;
            /**
             * @description Text content (only present on getDocument)
             * @example The quick brown fox jumps over the lazy dog.
             */
            content?: string | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /** @description Stored file metadata */
        FileRecord: {
            /**
             * @description Unique file identifier
             * @example abc123
             */
            id?: string;
            /**
             * @description Logical path of the file within the project (e.g. /images/logo.png)
             * @example /images/logo.png
             */
            path?: string | null;
            /**
             * @description Name of the file
             * @example document.pdf
             */
            filename?: string;
            /**
             * @description MIME type of the file
             * @example application/pdf
             */
            contentType?: string;
            /**
             * @description File size in bytes
             * @example 1024
             */
            size?: number;
            /**
             * @description Storage backend type
             * @example local
             * @enum {string}
             */
            storage_type?: "local" | "s3" | "gcs";
            /**
             * @description Path where the file is stored
             * @example /uploads/document.pdf
             */
            storage_path?: string;
            /**
             * @description JSON string with additional metadata
             * @example {"author":"John"}
             */
            metadata?: string;
            /**
             * Format: date-time
             * @description Creation timestamp
             */
            created_at?: string;
            /**
             * Format: date-time
             * @description Last update timestamp
             */
            updated_at?: string;
        };
        PolicyStatement: {
            /**
             * @example Allow
             * @enum {string}
             */
            effect: "Allow" | "Deny";
            /**
             * @example [
             *       "files:ListFiles",
             *       "files:CreateFile"
             *     ]
             */
            action: string[];
            /**
             * @example [
             *       "soat:proj_abc:files:*"
             *     ]
             */
            resource?: string[];
        };
        PolicyDocument: {
            statement: components["schemas"]["PolicyStatement"][];
        };
        PolicyRecord: {
            /**
             * @description Public policy ID (pol_ prefix)
             * @example pol_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @example ReadOnlyAccess */
            name?: string;
            description?: string;
            document?: components["schemas"]["PolicyDocument"];
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            created_at?: string;
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            updated_at?: string;
        };
        ProjectRecord: {
            /**
             * @description Public project ID (proj_ prefix)
             * @example proj_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @example My Project */
            name?: string;
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            created_at?: string;
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            updated_at?: string;
        };
        SessionRecord: {
            /**
             * @description Session public ID
             * @example sess_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Agent public ID
             * @example agt_V1StGXR8Z5jdHi6B
             */
            agent_id?: string;
            /**
             * @description Underlying conversation public ID
             * @example conv_V1StGXR8Z5jdHi6B
             */
            conversation_id?: string;
            /**
             * @example open
             * @enum {string}
             */
            status?: "open" | "closed";
            /** @example Support chat */
            name?: string | null;
            /**
             * @description Public ID of the user actor
             * @example actr_V1StGXR8Z5jdHi6B
             */
            actor_id?: string | null;
            tags?: {
                [key: string]: string;
            };
            /**
             * @description When true, automatically triggers generation after each user message (if no generation is in progress).
             * @default false
             */
            auto_generate: boolean;
            /**
             * Format: date-time
             * @description Timestamp when the current generation started, or null if not generating.
             */
            generating_at?: string | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
            /** @description Key-value pairs injected as context headers into all tool call requests made during this session. */
            tool_context?: {
                [key: string]: string;
            } | null;
        };
        SessionMessage: {
            /** @enum {string} */
            role?: "user" | "assistant" | "unknown";
            content?: string;
            document_id?: string | null;
            position?: number;
            metadata?: Record<string, never> | null;
        };
        CreateSessionRequest: {
            /**
             * @description Optional session name
             * @example Support chat
             */
            name?: string;
            /**
             * @description Optional public ID of an existing actor to use as the user actor
             * @example actr_V1StGXR8Z5jdHi6B
             */
            actor_id?: string;
            /**
             * @description When true, automatically triggers generation after each user message.
             * @default false
             */
            auto_generate: boolean;
            /** @description Key-value pairs injected as context headers into all tool call requests made during this session. */
            tool_context?: {
                [key: string]: string;
            } | null;
        };
        UpdateSessionRequest: {
            /** @description Session name (set to null to clear) */
            name?: string | null;
            /**
             * @description Session status
             * @enum {string}
             */
            status?: "open" | "closed";
            /** @description Enable or disable automatic generation after user messages. */
            auto_generate?: boolean;
            /** @description Key-value pairs injected as context headers into all tool call requests made during this session. */
            tool_context?: {
                [key: string]: string;
            } | null;
        };
        AddSessionMessageRequest: {
            /**
             * @description User message text
             * @example Hello, how can I deploy my app?
             */
            message: string;
            /** @description Key-value pairs injected as context headers into all tool call requests made during this generation. */
            tool_context?: {
                [key: string]: string;
            } | null;
        };
        AddSessionMessageResponse: {
            /** @enum {string} */
            role?: "user";
            content?: string;
        } | components["schemas"]["GenerateSessionResponse"];
        GenerateSessionRequest: {
            /**
             * @description Optional model override
             * @example gpt-4o
             */
            model?: string;
            /** @description Key-value pairs injected as context headers into all tool call requests made during this generation. */
            tool_context?: {
                [key: string]: string;
            } | null;
        };
        GenerateSessionResponse: {
            /** @enum {string} */
            status?: "completed" | "requires_action";
            message?: {
                role?: string;
                content?: string;
                model?: string;
            };
            generation_id?: string;
            trace_id?: string;
            /** @description Present when status is requires_action */
            required_action?: {
                tool_calls?: {
                    id?: string;
                    name?: string;
                    arguments?: Record<string, never>;
                }[];
            };
        };
        SendSessionMessageRequest: {
            /**
             * @description User message text
             * @example Hello, how can I deploy my app?
             */
            message: string;
            /**
             * @description Optional model override
             * @example gpt-4o
             */
            model?: string;
        };
        SendSessionMessageResponse: {
            /** @enum {string} */
            status?: "completed" | "requires_action";
            message?: {
                role?: string;
                content?: string;
                model?: string;
            };
            generation_id?: string;
            trace_id?: string;
            /** @description Present when status is requires_action */
            required_action?: {
                tool_calls?: {
                    id?: string;
                    name?: string;
                    arguments?: Record<string, never>;
                }[];
            };
        };
        SubmitSessionToolOutputsRequest: {
            /** @description The generation ID from the requires_action response */
            generation_id: string;
            tool_outputs: {
                tool_call_id: string;
                /** @description The tool output value */
                output: unknown;
            }[];
        };
        UserRecord: {
            /**
             * @description Public user ID (usr_ prefix)
             * @example usr_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @example johndoe */
            username?: string;
            /**
             * @example user
             * @enum {string}
             */
            role?: "admin" | "user";
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            created_at?: string;
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            updated_at?: string;
        };
        Webhook: {
            id?: string;
            project_id?: string;
            policy_id?: string | null;
            name?: string;
            description?: string | null;
            url?: string;
            events?: string[];
            active?: boolean;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        WebhookWithSecret: components["schemas"]["Webhook"] & {
            secret?: string;
        };
        CreateWebhookRequest: {
            name: string;
            description?: string;
            url: string;
            events: string[];
            policy_id?: string;
        };
        UpdateWebhookRequest: {
            name?: string;
            description?: string;
            url?: string;
            events?: string[];
            active?: boolean;
            policy_id?: string | null;
        };
        Delivery: {
            id?: string;
            event_type?: string;
            payload?: Record<string, never>;
            /** @enum {string} */
            status?: "pending" | "success" | "failed";
            status_code?: number | null;
            attempts?: number;
            /** Format: date-time */
            last_attempt_at?: string | null;
            response_body?: string | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at?: string;
        };
        DeliveryListResponse: {
            data?: components["schemas"]["Delivery"][];
            total?: number;
            limit?: number;
            offset?: number;
        };
    };
    responses: {
        /** @description Authentication required */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Insufficient permissions */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /** @example File not found */
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Not found */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: {
        /** @description Agent public ID */
        AgentId: string;
        /** @description Session public ID */
        SessionId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listActors: {
        parameters: {
            query?: {
                /** @description Project ID (optional) */
                project_id?: string;
                /** @description External ID to filter by (e.g. WhatsApp phone number) */
                external_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of actors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createActor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID. Required for JWT auth; omit when using an project key.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /** @example Alice */
                    name: string;
                    /**
                     * @description Optional actor type (e.g. 'customer', 'agent')
                     * @example customer
                     */
                    type?: string;
                    /**
                     * @description Optional external identifier (e.g. WhatsApp phone number). If provided and an actor with this externalId already exists in the project, the existing actor is returned (idempotent — 200 OK).
                     * @example +15551234567
                     */
                    external_id?: string;
                };
            };
        };
        responses: {
            /** @description Actor already exists — returned when externalId matches an existing actor in this project (idempotent) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"];
                };
            };
            /** @description Actor created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getActor: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Actor ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Actor found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteActor: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Actor ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Actor deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAgentTools: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                project_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of agent tools */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentToolRequest"];
            };
        };
        responses: {
            /** @description Agent tool created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                toolId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent tool */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                toolId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateAgentToolRequest"];
            };
        };
        responses: {
            /** @description Agent tool updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                toolId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAgentTraces: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                project_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of traces */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTrace"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getAgentTrace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                traceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Trace details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTrace"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAgents: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                project_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of agents */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createAgent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentRequest"];
            };
        };
        responses: {
            /** @description Agent created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateAgentRequest"];
            };
        };
        responses: {
            /** @description Agent updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createAgentGeneration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentGenerationRequest"];
            };
        };
        responses: {
            /** @description Generation result or SSE stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentGenerationResponse"];
                    "text/event-stream": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Agent or AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    submitAgentToolOutputs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
                generationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubmitToolOutputsRequest"];
            };
        };
        responses: {
            /** @description Generation result after resuming */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentGenerationResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Agent or generation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAiProviders: {
        parameters: {
            query?: {
                /** @description Project ID (required if not using project key auth) */
                project_id?: string;
                /** @description Number of results per page */
                limit?: number;
                /** @description Number of results to skip */
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of AI providers */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id?: string;
                        name?: string;
                        /** @enum {string} */
                        provider?: "openai" | "anthropic" | "google" | "cohere" | "mistral";
                        default_model?: string;
                        project_id?: string;
                        /** Format: date-time */
                        created_at?: string;
                    }[];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createAiProvider: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID (required if not using project key auth)
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /**
                     * @description Provider configuration name
                     * @example OpenAI Production
                     */
                    name: string;
                    /**
                     * @description LLM provider
                     * @example openai
                     * @enum {string}
                     */
                    provider: "openai" | "anthropic" | "google" | "cohere" | "mistral";
                    /**
                     * @description Default model to use
                     * @example gpt-4
                     */
                    default_model: string;
                    /**
                     * @description Secret ID containing API credentials
                     * @example secret_V1StGXR8Z5jdHi6B
                     */
                    secret_id?: string;
                    /** @description Custom base URL for the provider */
                    base_url?: string;
                    /** @description Additional provider-specific configuration */
                    config?: Record<string, never>;
                };
            };
        };
        responses: {
            /** @description AI provider created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id?: string;
                        name?: string;
                        provider?: string;
                        default_model?: string;
                        project_id?: string;
                        /** Format: date-time */
                        created_at?: string;
                    };
                };
            };
            /** @description Bad request (invalid provider or missing fields) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getAiProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description AI Provider ID */
                aiProviderId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description AI provider details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id?: string;
                        name?: string;
                        provider?: string;
                        default_model?: string;
                        project_id?: string;
                        secret_id?: string;
                        base_url?: string;
                        config?: Record<string, never>;
                        /** Format: date-time */
                        created_at?: string;
                    };
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteAiProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description AI Provider ID */
                aiProviderId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description AI provider deleted successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateAiProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description AI Provider ID */
                aiProviderId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    default_model?: string;
                    secret_id?: string;
                    base_url?: string;
                    config?: Record<string, never>;
                };
            };
        };
        responses: {
            /** @description AI provider updated successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Key name for identification
                     * @example CI/CD Pipeline
                     */
                    name: string;
                    /**
                     * @description Optional project ID to scope this key to a specific project
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /**
                     * @description Optional list of policy IDs to attach. Key permissions become the intersection of user policies and these policies.
                     * @example [
                     *       "pol_V1StGXR8Z5jdHi6B"
                     *     ]
                     */
                    policy_ids?: string[];
                };
            };
        };
        responses: {
            /** @description API key created successfully. The raw key value is only returned once. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeyCreated"];
                };
            };
            /** @description Bad request (missing name, invalid project or policy IDs) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description API key public ID (key_ prefix) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description API key details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeyRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (not the key owner or admin) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description API key not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description API key public ID (key_ prefix) */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example Updated Key Name */
                    name?: string;
                    /**
                     * @description Set to null to remove project scope
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string | null;
                    /**
                     * @description Replace the key's policy list (empty array removes all)
                     * @example [
                     *       "pol_V1StGXR8Z5jdHi6B"
                     *     ]
                     */
                    policy_ids?: string[];
                };
            };
        };
        responses: {
            /** @description API key updated successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeyRecord"];
                };
            };
            /** @description Bad request (invalid project or policy IDs) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (not the key owner or admin) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description API key not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description API key public ID (key_ prefix) */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description API key deleted successfully */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (not the key owner or admin) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description API key not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listChats: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                project_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of chats */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Chat"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createChat: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateChatRequest"];
            };
        };
        responses: {
            /** @description Chat created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Chat"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getChat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                chatId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Chat record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Chat"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Chat not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteChat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                chatId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Chat deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Chat not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createChatCompletionForChat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                chatId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatCompletionForChatRequest"];
            };
        };
        responses: {
            /** @description Chat completion result (JSON or SSE stream) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChatCompletionResponse"];
                    "text/event-stream": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Chat or AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createChatCompletion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatCompletionRequest"];
            };
        };
        responses: {
            /** @description Chat completion result (JSON or SSE stream) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChatCompletionResponse"];
                    "text/event-stream": string;
                };
            };
            /** @description Bad Request — `messages` is missing or empty */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized — missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listConversations: {
        parameters: {
            query?: {
                /** @description Project ID (optional) */
                project_id?: string;
                /** @description Filter by actor ID */
                actor_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of conversations */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createConversation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID. Required for JWT auth; omit when using an project key.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /**
                     * @description Initial conversation status
                     * @default open
                     * @enum {string}
                     */
                    status?: "open" | "closed";
                    /** @description Optional name for the conversation */
                    name?: string | null;
                    /**
                     * @description Actor ID to associate with this conversation
                     * @example act_V1StGXR8Z5jdHi6B
                     */
                    actor_id?: string | null;
                };
            };
        };
        responses: {
            /** @description Conversation created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conversation found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conversation deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description New conversation status
                     * @enum {string}
                     */
                    status: "open" | "closed";
                };
            };
        };
        responses: {
            /** @description Conversation updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listConversationMessages: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of messages */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationMessageRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    addConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Message text content to add to the conversation
                     * @example Hello, how can I help you?
                     */
                    message: string;
                    /**
                     * @description Actor ID who is sending this message
                     * @example act_V1StGXR8Z5jdHi6B
                     */
                    actor_id: string;
                    /**
                     * @description Zero-based position. Defaults to MAX+1 (append).
                     * @example 0
                     */
                    position?: number;
                    /**
                     * @description Optional structured metadata to attach to the message (e.g. phone number, channel). Stored as-is and injected into the AI prompt context.
                     * @example {
                     *       "phone": "5511999998888",
                     *       "channel": "whatsapp"
                     *     }
                     */
                    metadata?: {
                        [key: string]: unknown;
                    } | null;
                };
            };
        };
        responses: {
            /** @description Message added */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationMessageRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation or actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    generateConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description ID of the actor that will produce the next message. Must have `agentId` or `chatId` set. */
                    actor_id: string;
                    /** @description Optional model override. Only honored for chat-backed actors. */
                    model?: string;
                    /** @description If true, stream tokens via SSE. NOT IMPLEMENTED in v1 — returns 501. */
                    stream?: boolean;
                    /** @description Key-value pairs injected as context headers into all tool call requests made during this generation. */
                    tool_context?: {
                        [key: string]: string;
                    } | null;
                };
            };
        };
        responses: {
            /** @description Generation completed or requires action */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerateConversationMessageResponse"];
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation or actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Streaming not implemented */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listConversationActors: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of actors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationActorRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    removeConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
                /** @description Document ID */
                documentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Message removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation or message not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listDocuments: {
        parameters: {
            query?: {
                /** @description Project ID (optional) */
                project_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of documents */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createDocument: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID. Required for JWT auth; omit when using an project key.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /** @example The quick brown fox jumps over the lazy dog. */
                    content: string;
                    /**
                     * @description Logical path within the project (e.g. /reports/q1.txt). Defaults to /filename if omitted.
                     * @example /reports/q1.txt
                     */
                    path?: string;
                    /** @example my-doc.txt */
                    filename?: string;
                };
            };
        };
        responses: {
            /** @description Document created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Document ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Document not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Document ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Document not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Document ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description New text content */
                    content?: string;
                    /** @description New title */
                    title?: string;
                    /**
                     * @description Logical path within the project (e.g. /reports/q1.txt). Pass null to clear.
                     * @example /reports/q1.txt
                     */
                    path?: string | null;
                    /** @description Arbitrary metadata object */
                    metadata?: Record<string, never>;
                    /** @description Key-value tags */
                    tags?: {
                        [key: string]: string;
                    };
                };
            };
        };
        responses: {
            /** @description Document updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Document not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    searchDocuments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID (optional). Omit to search across all accessible projects.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /** @example What is the capital of France? */
                    query: string;
                    /** @example 5 */
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description Search results */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"][];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listFiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of files returned successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"][];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createFile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Logical path within the project (e.g. /images/logo.png). Defaults to /filename if omitted.
                     * @example /images/logo.png
                     */
                    path?: string;
                    /**
                     * @description Name of the file
                     * @example document.pdf
                     */
                    filename?: string;
                    /**
                     * @description MIME type of the file
                     * @example application/pdf
                     */
                    contentType?: string;
                    /**
                     * @description File size in bytes
                     * @example 1024
                     */
                    size?: number;
                    /**
                     * @description Storage backend type
                     * @example local
                     * @enum {string}
                     */
                    storage_type: "local" | "s3" | "gcs";
                    /**
                     * @description Path where the file is stored
                     * @example /uploads/document.pdf
                     */
                    storage_path: string;
                    /**
                     * @description JSON string with additional metadata
                     * @example {"author":"John"}
                     */
                    metadata?: string;
                };
            };
        };
        responses: {
            /** @description File created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    uploadFile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /**
                     * Format: binary
                     * @description File content
                     */
                    file: string;
                    /**
                     * @description Project ID to associate the file with
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id: string;
                    /**
                     * @description Additional metadata as a JSON string
                     * @example {"author":"John"}
                     */
                    metadata?: string;
                };
            };
        };
        responses: {
            /** @description File uploaded successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            /** @description Missing file or invalid project */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    getFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description File ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description ID of the file to delete */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File deleted successfully */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    downloadFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description File ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File content */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateFileMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description File ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description New metadata as a JSON string
                     * @example {"author":"Jane","tags":["report"]}
                     */
                    metadata?: string;
                    /**
                     * @description New filename for the file
                     * @example renamed-file.txt
                     */
                    filename?: string;
                };
            };
        };
        responses: {
            /** @description Metadata updated successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listPolicies: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of policies */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example ReadOnlyAccess */
                    name?: string;
                    /** @example Allows read-only access to all resources */
                    description?: string;
                    document: components["schemas"]["PolicyDocument"];
                };
            };
        };
        responses: {
            /** @description Policy created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyRecord"];
                };
            };
            /** @description Bad request (invalid policy document) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Policy public ID (pol_ prefix) */
                policyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Policy details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Policy not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updatePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Policy public ID (pol_ prefix) */
                policyId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    description?: string;
                    document: components["schemas"]["PolicyDocument"];
                };
            };
        };
        responses: {
            /** @description Policy updated successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyRecord"];
                };
            };
            /** @description Bad request (invalid policy document) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Policy not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deletePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Policy public ID (pol_ prefix) */
                policyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Policy deleted successfully */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Policy not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createProject: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example My Project */
                    name: string;
                };
            };
        };
        responses: {
            /** @description Project created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example proj_V1StGXR8Z5jdHi6B */
                        id?: string;
                        name?: string;
                        /** Format: date-time */
                        created_at?: string;
                    };
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project public ID (proj_ prefix) */
                projectId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Project not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project public ID (proj_ prefix) */
                projectId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project deleted successfully */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Project not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listSecrets: {
        parameters: {
            query?: {
                /** @description Project ID (required if not using project key auth) */
                project_id?: string;
                /** @description Number of results per page */
                limit?: number;
                /** @description Number of results to skip */
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of secrets */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id?: string;
                        name?: string;
                        project_id?: string;
                        /** Format: date-time */
                        created_at?: string;
                    }[];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createSecret: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID (required if not using project key auth)
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    project_id?: string;
                    /**
                     * @description Secret name
                     * @example DATABASE_PASSWORD
                     */
                    name: string;
                    /**
                     * @description Secret value (will be encrypted)
                     * @example supersecretpassword
                     */
                    value: string;
                };
            };
        };
        responses: {
            /** @description Secret created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id?: string;
                        name?: string;
                        project_id?: string;
                        /** Format: date-time */
                        created_at?: string;
                    };
                };
            };
            /** @description Bad request (missing required fields) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Secret ID */
                secretId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Secret details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id?: string;
                        name?: string;
                        /** @description Decrypted secret value */
                        value?: string;
                        project_id?: string;
                        /** Format: date-time */
                        created_at?: string;
                    };
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Secret not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Secret ID */
                secretId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Secret deleted successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Secret not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Secret ID */
                secretId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description New secret name */
                    name?: string;
                    /** @description New secret value */
                    value?: string;
                };
            };
        };
        responses: {
            /** @description Secret updated successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Secret not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listSessions: {
        parameters: {
            query?: {
                /** @description Filter by actor public ID */
                actor_id?: string;
                /** @description Filter by session status (open or closed) */
                status?: "open" | "closed";
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paginated list of sessions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data?: components["schemas"]["SessionRecord"][];
                        total?: number;
                        limit?: number;
                        offset?: number;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CreateSessionRequest"];
            };
        };
        responses: {
            /** @description Session created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionRecord"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionRecord"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    updateSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["UpdateSessionRequest"];
            };
        };
        responses: {
            /** @description Updated session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionRecord"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listSessionMessages: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paginated list of messages */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data?: components["schemas"]["SessionMessage"][];
                        total?: number;
                        limit?: number;
                        offset?: number;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    addSessionMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddSessionMessageRequest"];
            };
        };
        responses: {
            /** @description User message saved */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AddSessionMessageResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    generateSessionResponse: {
        parameters: {
            query?: {
                /** @description When true, generation runs in the background and 202 is returned immediately */
                async?: boolean;
            };
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["GenerateSessionRequest"];
            };
        };
        responses: {
            /** @description Agent reply or requires_action */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerateSessionResponse"];
                };
            };
            /** @description Generation accepted (async mode) */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status?: "accepted";
                        session_id?: string;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Generation already in progress */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    submitSessionToolOutputs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubmitSessionToolOutputsRequest"];
            };
        };
        responses: {
            /** @description Generation result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SendSessionMessageResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getSessionTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session tags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    replaceSessionTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: string;
                };
            };
        };
        responses: {
            /** @description Updated tags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    mergeSessionTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent public ID */
                agentId: components["parameters"]["AgentId"];
                /** @description Session public ID */
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: string;
                };
            };
        };
        responses: {
            /** @description Updated tags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listUsers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of users returned successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"][];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example johndoe */
                    username: string;
                    /**
                     * Format: password
                     * @example supersecret
                     */
                    password: string;
                    /**
                     * @example user
                     * @enum {string}
                     */
                    role?: "admin" | "user";
                };
            };
        };
        responses: {
            /** @description User created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description User found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"];
                };
            };
            /** @description User not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    bootstrapUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example admin */
                    username: string;
                    /**
                     * Format: password
                     * @example supersecret
                     */
                    password: string;
                };
            };
        };
        responses: {
            /** @description Admin user created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"];
                };
            };
            /** @description Users already exist */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getUserPolicies: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User public ID (usr_ prefix) */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of policies attached to the user */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example pol_V1StGXR8Z5jdHi6B */
                        id?: string;
                        name?: string;
                        description?: string;
                    }[];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description User not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    attachUserPolicies: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User public ID (usr_ prefix) */
                userId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description List of policy public IDs to attach (replaces existing)
                     * @example [
                     *       "pol_V1StGXR8Z5jdHi6B"
                     *     ]
                     */
                    policy_ids: string[];
                };
            };
        };
        responses: {
            /** @description Policies attached successfully */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad request (policy_ids must be an array) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden (non-admin user) */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description User or policy not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A list of webhooks */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateWebhookRequest"];
            };
        };
        responses: {
            /** @description Webhook created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookWithSecret"];
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Webhook details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Webhook not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateWebhookRequest"];
            };
        };
        responses: {
            /** @description Webhook updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Webhook"];
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Webhook not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Webhook deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Webhook not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listWebhookDeliveries: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                projectId: string;
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A list of deliveries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryListResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Webhook not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getWebhookDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
                webhookId: string;
                deliveryId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Delivery details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Delivery"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Delivery not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    rotateWebhookSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: string;
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Secret rotated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookWithSecret"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Webhook not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
