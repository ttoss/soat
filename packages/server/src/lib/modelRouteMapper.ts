import type { db } from '../db';
import type { ModelRouteErrorClass } from './modelRouteErrors';
import type { ModelRouteTarget } from './modelRouteValidation';

export type ModelRouteInstance = InstanceType<(typeof db)['ModelRoute']>;

/** Every failover-eligible class — the default when `retry_on` is omitted. */
export const MODEL_ROUTE_DEFAULT_RETRY_ON: readonly ModelRouteErrorClass[] = [
  'provider_error',
  'timeout',
  'rate_limited',
];

// ── Mapping ──────────────────────────────────────────────────────────────

/**
 * The runtime-relevant subset of a route: everything `buildRoutedModel` needs
 * and nothing that requires the project join.
 */
export type ModelRouteConfig = {
  id: string;
  targets: ModelRouteTarget[];
  retry_on: ModelRouteErrorClass[];
  failure_threshold: number;
  cooldown_seconds: number;
};

export type MappedModelRoute = ModelRouteConfig & {
  project_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
};

export const mapModelRouteConfig = (
  route: ModelRouteInstance
): ModelRouteConfig => {
  return {
    id: route.publicId,
    // Stored in the wire shape already, so the target list is copied as a
    // value — nothing walks the keys authors wrote inside it.
    targets: route.targets as ModelRouteTarget[],
    retry_on: route.retryOn as ModelRouteErrorClass[],
    failure_threshold: route.failureThreshold,
    cooldown_seconds: route.cooldownSeconds,
  };
};

export const mapModelRoute = (
  route: ModelRouteInstance & { project: { publicId: string } }
): MappedModelRoute => {
  return {
    ...mapModelRouteConfig(route),
    project_id: route.project.publicId,
    name: route.name,
    created_at: route.createdAt,
    updated_at: route.updatedAt,
  };
};
