import * as React from 'react';

import { apiFetch } from '@/api/client';

import { extractItems } from './specUtils';
import type { OpenApiSchema } from './types';

export type RefOption = { value: string; label: string };

// Loads picker options for every `x-soat-ref` field in a schema by fetching the
// referenced resource's collection (e.g. policy_ids → GET /api/v1/policies).
// Shared by the create/edit form and the action modal so both render populated
// single-select / multi-select pickers instead of a raw text field.
export const useRefFieldOptions = ({
  schema,
  token,
}: {
  schema: OpenApiSchema | undefined;
  token: string;
}): Record<string, RefOption[]> => {
  const [refOptions, setRefOptions] = React.useState<
    Record<string, RefOption[]>
  >({});

  React.useEffect(() => {
    if (!schema?.properties || !token) return;

    const refFields = Object.entries(schema.properties).filter(
      ([, fieldSchema]) => {
        // Both scalar refs (single-select) and array refs (multi-select chips)
        // need their referenced resource's options fetched.
        return Boolean(fieldSchema['x-soat-ref']);
      }
    );
    if (refFields.length === 0) return;

    Promise.all(
      refFields.map(async ([name, fieldSchema]) => {
        const ref = fieldSchema['x-soat-ref']!;
        const result = await apiFetch<unknown>({
          url: `/api/v1/${ref}`,
          token,
        });
        if (!result.ok) return [name, []] as const;
        // List endpoints return the paginated envelope `{ data, total, … }`;
        // `extractItems` unwraps it (and still handles a bare array).
        const list = extractItems(result.data);
        const options: RefOption[] = list.map((item) => {
          return {
            value: String(item.id ?? ''),
            label: String(item.name ?? item.id ?? ''),
          };
        });
        return [name, options] as const;
      })
    ).then((entries) => {
      setRefOptions(Object.fromEntries(entries));
    });
  }, [schema, token]);

  return refOptions;
};
