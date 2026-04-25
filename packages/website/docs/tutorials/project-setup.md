---
sidebar_position: 1
---

# Project Setup and Access Control

This tutorial walks you through setting up a project with users, policies, and project keys. By the end you will have:

- A project with two policies (full access and read-only)
- A user with full access to the project
- A user with restricted (read-only) access
- A project key with full access
- A project key with restricted access

## Prerequisites

- A running SOAT server (see [Quick Start](/docs/getting-started))
- An admin user already bootstrapped
- `curl` and `jq` installed

Set the base URL for your SOAT server. All commands below use this variable:

```bash
BASE_URL=https://your-soat-server.com/api/v1
```

## 1. Log in as admin

```bash
TOKEN=$(curl -s -X POST $BASE_URL/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

All subsequent commands use this token. See [IAM — User Authentication](/docs/modules/iam#user-authentication) for details.

## 2. Create a project

```bash
PROJECT_ID=$(curl -s -X POST $BASE_URL/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "My Project"}' | jq -r '.id')

echo "Project: $PROJECT_ID"
```

**Response** `201 Created`

```json
{
  "id": "proj_...",
  "name": "My Project",
  "created_at": "2025-01-01T00:00:00.000Z",
  "updated_at": "2025-01-01T00:00:00.000Z"
}
```

See [Projects](/docs/modules/projects) for the full data model.

## 3. Create policies

Policies define what actions are allowed within the project. Every policy belongs to exactly one project — see [IAM — Project Segment and Policy Scoping](/docs/modules/iam#project-segment-and-policy-scoping) for why `resource: ["*"]` is safe to use.

### Full access policy

This policy allows all actions on all resources within the project:

```bash
FULL_POLICY_ID=$(curl -s -X POST $BASE_URL/projects/$PROJECT_ID/policies \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Full Access",
    "description": "Allows all operations within the project",
    "document": {
      "version": "2025-01-01",
      "statement": [
        {
          "effect": "Allow",
          "action": ["*"],
          "resource": ["*"]
        }
      ]
    }
  }' | jq -r '.id')

echo "Full access policy: $FULL_POLICY_ID"
```

### Read-only policy

This policy restricts access to read operations only:

```bash
READONLY_POLICY_ID=$(curl -s -X POST $BASE_URL/projects/$PROJECT_ID/policies \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Read Only",
    "description": "Allows read-only access to documents, files, actors, and conversations",
    "document": {
      "version": "2025-01-01",
      "statement": [
        {
          "effect": "Allow",
          "action": [
            "documents:GetDocument",
            "documents:ListDocuments",
            "documents:SearchDocuments",
            "files:GetFile",
            "files:DownloadFile",
            "actors:ListActors",
            "actors:GetActor",
            "conversations:ListConversations",
            "conversations:GetConversation"
          ],
          "resource": ["*"]
        }
      ]
    }
  }' | jq -r '.id')

echo "Read-only policy: $READONLY_POLICY_ID"
```

See [IAM — Policy Documents](/docs/modules/iam#policy-documents) for the full statement format and [IAM — Examples](/docs/modules/iam#examples) for more policy patterns.

## 4. Create users

Only admins can create users. See [IAM — User Permissions](/docs/modules/iam#user-permissions).

```bash
# User with full access
curl -s -X POST $BASE_URL/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"username": "alice", "password": "Alice1234!", "role": "user"}' | jq .

# User with restricted access
curl -s -X POST $BASE_URL/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"username": "bob", "password": "Bob1234!", "role": "user"}' | jq .
```

At this point, neither Alice nor Bob can access any project resources. They need to be added as members first — see [IAM — Authorization Model](/docs/modules/iam#authorization-model).

## 5. Add users to the project with policies

Adding a user as a member and attaching policies is what grants access. The `policy_ids` array determines what the user can do within the project.

### Alice — full access

```bash
ALICE_ID=$(curl -s $BASE_URL/users \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.username=="alice") | .id')

curl -s -X POST $BASE_URL/projects/$PROJECT_ID/members \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"user_id\": \"$ALICE_ID\", \"policy_ids\": [\"$FULL_POLICY_ID\"]}" | jq .
```

### Bob — read-only access

```bash
BOB_ID=$(curl -s $BASE_URL/users \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.username=="bob") | .id')

curl -s -X POST $BASE_URL/projects/$PROJECT_ID/members \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"user_id\": \"$BOB_ID\", \"policy_ids\": [\"$READONLY_POLICY_ID\"]}" | jq .
```

See [Projects — Membership](/docs/modules/projects#membership) for details on how membership and policies work together.

## 6. Verify user access

### Alice can create a document

```bash
ALICE_TOKEN=$(curl -s -X POST $BASE_URL/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Alice1234!"}' | jq -r '.token')

curl -s -X POST $BASE_URL/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"content\": \"Hello from Alice\", \"filename\": \"hello.txt\"}" | jq .
```

**Expected:** `201 Created`

### Bob can list documents but cannot create

```bash
BOB_TOKEN=$(curl -s -X POST $BASE_URL/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"Bob1234!"}' | jq -r '.token')

# This works — Bob has documents:ListDocuments
curl -s $BASE_URL/documents?project_id=$PROJECT_ID \
  -H "Authorization: Bearer $BOB_TOKEN" | jq .
```

**Expected:** `200 OK` with the document Alice created.

```bash
# This fails — Bob does NOT have documents:CreateDocument
curl -s -X POST $BASE_URL/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -d "{\"project_id\": \"$PROJECT_ID\", \"content\": \"Hello from Bob\", \"filename\": \"bob.txt\"}" | jq .
```

**Expected:** `403 Forbidden`

## 7. Create project keys

Project keys provide programmatic access scoped to a single project. They use **intersection semantics** — both the creating user's membership policy **and** the key's own policy must allow the action. See [Projects — Intersection Authorization](/docs/modules/projects#intersection-authorization).

### Full access project key (created by Alice)

```bash
FULL_KEY=$(curl -s -X POST $BASE_URL/project-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d "{\"name\": \"Full Access Key\", \"project_id\": \"$PROJECT_ID\", \"policy_id\": \"$FULL_POLICY_ID\"}")

FULL_KEY_RAW=$(echo $FULL_KEY | jq -r '.key')
echo "Full access key: $FULL_KEY_RAW"
```

:::warning
The raw key value is returned **only once** at creation time. Store it securely — it cannot be retrieved afterwards.
:::

### Read-only project key (created by Alice)

```bash
READONLY_KEY=$(curl -s -X POST $BASE_URL/project-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d "{\"name\": \"Read Only Key\", \"project_id\": \"$PROJECT_ID\", \"policy_id\": \"$READONLY_POLICY_ID\"}")

READONLY_KEY_RAW=$(echo $READONLY_KEY | jq -r '.key')
echo "Read-only key: $READONLY_KEY_RAW"
```

## 8. Verify project key access

### Full access key can create documents

```bash
curl -s -X POST $BASE_URL/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FULL_KEY_RAW" \
  -d "{\"content\": \"Created via full key\", \"filename\": \"key-doc.txt\"}" | jq .
```

**Expected:** `201 Created`. Note that `project_id` is not required — the key's project is inferred automatically. See [Documents — Project ID Resolution](/docs/modules/documents#project-id-resolution).

### Read-only key can list but not create

```bash
# This works
curl -s $BASE_URL/documents \
  -H "Authorization: Bearer $READONLY_KEY_RAW" | jq .
```

**Expected:** `200 OK`

```bash
# This fails
curl -s -X POST $BASE_URL/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $READONLY_KEY_RAW" \
  -d "{\"content\": \"Should fail\", \"filename\": \"fail.txt\"}" | jq .
```

**Expected:** `403 Forbidden`

## Summary

| Resource        | Policy      | Can read? | Can create? |
| --------------- | ----------- | --------- | ----------- |
| Alice (user)    | Full Access | Yes       | Yes         |
| Bob (user)      | Read Only   | Yes       | No          |
| Full Access Key | Full Access | Yes       | Yes         |
| Read Only Key   | Read Only   | Yes       | No          |

### Key takeaways

- **Users need membership + policies** to access a project. Neither alone is sufficient. See [IAM — Authorization Model](/docs/modules/iam#authorization-model).
- **Policies are project-scoped.** `resource: ["*"]` means "all resources in this project", not globally. See [IAM — Project Segment and Policy Scoping](/docs/modules/iam#project-segment-and-policy-scoping).
- **Project keys use intersection semantics.** The key's policy and the creating user's membership policy must both allow the action. See [Projects — Intersection Authorization](/docs/modules/projects#intersection-authorization).
- **Admin users bypass all checks.** They don't need membership or policies.

## What's next

- [IAM Module](/docs/modules/iam) — Full policy format, conditions, and ABAC
- [Documents Module](/docs/modules/documents) — Semantic search and embedding configuration
- [Agents Module](/docs/modules/agents) — Set up AI assistants with tools
- [API Reference](/docs/api) — Complete endpoint documentation
