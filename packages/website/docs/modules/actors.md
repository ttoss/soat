# Actors Module

The Actors module represents entities (people, bots, or other participants) that interact within a project. A common use case is storing WhatsApp contacts, where `externalId` holds the phone number.

## Overview

An Actor belongs to a project and has a display name, an optional type, and an optional `externalId`. The `externalId` is unique within a project and is designed for correlating actors with external systems — for example, mapping a WhatsApp phone number to a known contact.

Actors are identified by `publicId` prefixed with `act_`. The internal database primary key is never returned.

## Data Model

| Field        | Type   | Description                                                                          |
| ------------ | ------ | ------------------------------------------------------------------------------------ |
| `id`         | string | Public identifier prefixed with `act_`                                               |
| `projectId`  | string | Public ID of the owning project                                                      |
| `name`       | string | Display name of the actor                                                            |
| `type`       | string | Optional actor type (e.g. `customer`, `agent`)                                       |
| `externalId` | string | Optional external identifier (e.g. WhatsApp phone number). Unique within the project |
| `createdAt`  | string | ISO 8601 creation timestamp                                                          |
| `updatedAt`  | string | ISO 8601 last-updated timestamp                                                      |

## Key Concepts

### externalId

`externalId` is a free-form string that lets you correlate an Actor with a record in an external system. It is enforced unique per project at the database level — two actors in the same project cannot share the same `externalId`. Across different projects, the same `externalId` value is allowed.

A `null` / absent `externalId` is never considered a duplicate — PostgreSQL's NULL semantics are preserved.

### Filtering

`GET /actors` accepts an optional `externalId` query parameter. This lets you look up an actor by their external identifier (e.g. resolve a WhatsApp number to an Actor record) without knowing their `act_` ID.

## Permissions

Actor operations are governed by per-project policies. Grant the following permissions:

| Action          | Permission string    |
| --------------- | -------------------- |
| List actors     | `actors:ListActors`  |
| Get actor by ID | `actors:GetActor`    |
| Create actor    | `actors:CreateActor` |
| Delete actor    | `actors:DeleteActor` |
