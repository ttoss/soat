import type * as React from 'react';

import type { RefResolver } from './crossRef';
import { renderRefLink } from './refLink';
import {
  formatValue,
  humanizeKey,
  isSensitiveKey,
  refLinkContext,
} from './specUtils';
import { StatusBadge } from './statusBadge';
import type { JsonObject, JsonValue } from './types';

const isMultiline = (value: JsonValue): boolean => {
  return (
    typeof value === 'string' && (value.length > 80 || value.includes('\n'))
  );
};

const FieldValue = ({
  fieldKey,
  value,
  refResource,
  context,
  resolveRef,
}: {
  fieldKey: string;
  value: JsonValue;
  refResource?: string;
  context: Record<string, string>;
  resolveRef?: RefResolver;
}) => {
  if (isSensitiveKey(fieldKey)) {
    return (
      <span className="text-sm text-muted-foreground italic">{'[hidden]'}</span>
    );
  }
  if (fieldKey === 'status' && typeof value === 'string' && value) {
    return <StatusBadge status={value} />;
  }
  if (fieldKey === 'error' && value) {
    return <StatusBadge error />;
  }
  const refLink = renderRefLink({
    refResource,
    value,
    context,
    resolveRef,
    className:
      'self-start font-mono text-sm text-primary underline-offset-4 hover:underline',
  });
  if (refLink) return refLink;
  const display = formatValue(fieldKey, value);
  return (
    <span className="text-sm">
      {display || <span className="text-muted-foreground">{'—'}</span>}
    </span>
  );
};

const SectionCard = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/40 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
};

const MonoCard = ({
  fieldKey,
  value,
}: {
  fieldKey: string;
  value: JsonValue;
}) => {
  const display = isSensitiveKey(fieldKey)
    ? '[hidden]'
    : formatValue(fieldKey, value);
  return (
    <SectionCard label={humanizeKey(fieldKey)}>
      <pre className="whitespace-pre-wrap wrap-break-word rounded-md border bg-muted/30 p-3 font-mono text-sm leading-relaxed">
        {display}
      </pre>
    </SectionCard>
  );
};

type DetailSectionsProps = {
  item: JsonObject;
  fields: string[];
  refFields?: Record<string, string>;
  pathParams?: Record<string, string>;
  resolveRef?: RefResolver;
};

/**
 * Group an item's fields into section cards: a primary "Overview" grid for
 * scalar fields, and a dedicated mono/`<pre>` card per long or multiline string
 * field (e.g. `instructions`, `description`).
 */
export const DetailSections = ({
  item,
  fields,
  refFields = {},
  pathParams = {},
  resolveRef,
}: DetailSectionsProps) => {
  const context = refLinkContext(item, pathParams);
  const overviewKeys = fields.filter((k) => {
    return !isMultiline(item[k]);
  });
  const longKeys = fields.filter((k) => {
    return isMultiline(item[k]);
  });

  return (
    <div className="flex flex-col gap-4">
      {overviewKeys.length > 0 && (
        <SectionCard label="Overview">
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {overviewKeys.map((key) => {
              return (
                <div key={key} className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {humanizeKey(key)}
                  </span>
                  <FieldValue
                    fieldKey={key}
                    value={item[key]}
                    refResource={refFields[key]}
                    context={context}
                    resolveRef={resolveRef}
                  />
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
      {longKeys.map((key) => {
        return <MonoCard key={key} fieldKey={key} value={item[key]} />;
      })}
    </div>
  );
};
