import type * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { humanizeKey } from './specUtils';
import type { OpenApiSchema } from './types';

type RefOption = { value: string; label: string };

type FieldEditorProps = {
  name: string;
  schema: OpenApiSchema;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  refOptions?: RefOption[];
  onFileChange?: (file: File | null) => void;
};

const TextareaField = ({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) => {
  return (
    <textarea
      id={id}
      value={value}
      onChange={(e) => {
        return onChange(e.target.value);
      }}
      placeholder={placeholder}
      rows={4}
      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
    />
  );
};

const SelectField = ({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) => {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => {
        return onChange(e.target.value);
      }}
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
    >
      <option value={''}>{'— select —'}</option>
      {options.map((opt) => {
        return (
          <option key={opt} value={opt}>
            {opt}
          </option>
        );
      })}
    </select>
  );
};

const isLongTextSchema = (schema: OpenApiSchema): boolean => {
  return (
    schema.type === 'object' ||
    schema.type === 'array' ||
    (schema.type === 'string' && (schema.description?.length ?? 0) > 60)
  );
};

const getInputType = (schema: OpenApiSchema): 'number' | 'text' => {
  return schema.type === 'integer' || schema.type === 'number'
    ? 'number'
    : 'text';
};

const RefSelectField = ({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: RefOption[];
}) => {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => {
        return onChange(e.target.value);
      }}
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
    >
      <option value={''}>{'— select —'}</option>
      {options.map((opt) => {
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
};

const parseRefList = (value: string): string[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((v) => {
          return String(v);
        })
      : [];
  } catch {
    return [];
  }
};

// Dynamic multi-select for an array of cross-references (e.g. policy_ids).
// Selected values render as removable chips; a dropdown adds more from the
// referenced resource. Stored as a JSON array string so buildRequestBody's
// array handling parses it directly; an empty selection serialises to '' so an
// optional field is omitted from the request.
const MultiRefField = ({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: RefOption[];
}) => {
  const selected = parseRefList(value);
  const setSelected = (next: string[]) => {
    onChange(next.length > 0 ? JSON.stringify(next) : '');
  };
  const labelFor = (v: string) => {
    return (
      options.find((o) => {
        return o.value === v;
      })?.label ?? v
    );
  };
  const available = options.filter((o) => {
    return !selected.includes(o.value);
  });

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => {
            return (
              <span
                key={v}
                className="inline-flex items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
              >
                {labelFor(v)}
                <button
                  type="button"
                  aria-label={`Remove ${labelFor(v)}`}
                  onClick={() => {
                    return setSelected(
                      selected.filter((x) => {
                        return x !== v;
                      })
                    );
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded-full leading-none hover:bg-primary/25"
                >
                  {'×'}
                </button>
              </span>
            );
          })}
        </div>
      )}
      <select
        id={id}
        value={''}
        onChange={(e) => {
          if (e.target.value) setSelected([...selected, e.target.value]);
        }}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value={''}>
          {available.length > 0 ? '— add —' : 'All options selected'}
        </option>
        {available.map((opt) => {
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
      </select>
    </div>
  );
};

const FileField = ({
  id,
  onChange,
}: {
  id: string;
  onChange: (file: File | null) => void;
}) => {
  return (
    <input
      id={id}
      type="file"
      onChange={(e) => {
        return onChange(e.target.files?.[0] ?? null);
      }}
      className="flex w-full text-sm file:mr-2 file:cursor-pointer file:rounded file:border file:border-input file:bg-transparent file:px-2 file:py-1 file:text-xs"
    />
  );
};

type FieldInputProps = {
  id: string;
  schema: OpenApiSchema;
  value: string;
  onChange: (v: string) => void;
  refOptions?: RefOption[];
  onFileChange?: (file: File | null) => void;
};

const FieldInput = ({
  id,
  schema,
  value,
  onChange,
  refOptions,
  onFileChange,
}: FieldInputProps): React.ReactElement => {
  if (schema.format === 'binary') {
    return <FileField id={id} onChange={onFileChange ?? (() => {})} />;
  }
  if (refOptions) {
    if (schema.type === 'array') {
      return (
        <MultiRefField
          id={id}
          value={value}
          onChange={onChange}
          options={refOptions}
        />
      );
    }
    return (
      <RefSelectField
        id={id}
        value={value}
        onChange={onChange}
        options={refOptions}
      />
    );
  }
  if (schema.enum) {
    return (
      <SelectField
        id={id}
        value={value}
        onChange={onChange}
        options={schema.enum}
      />
    );
  }
  if (schema.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => {
            return onChange(e.target.checked ? 'true' : 'false');
          }}
          className="h-4 w-4 rounded border-input"
        />
      </div>
    );
  }
  if (isLongTextSchema(schema)) {
    return (
      <TextareaField
        id={id}
        value={value}
        onChange={onChange}
        placeholder={schema.description}
      />
    );
  }
  return (
    <Input
      id={id}
      type={getInputType(schema)}
      value={value}
      onChange={(e) => {
        return onChange(e.target.value);
      }}
      placeholder={schema.description}
    />
  );
};

export const FieldEditor = ({
  name,
  schema,
  value,
  onChange,
  required,
  refOptions,
  onFileChange,
}: FieldEditorProps): React.ReactElement => {
  const id = `field-${name}`;
  const label = humanizeKey(name);

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-1 text-destructive">{'*'}</span>}
      </Label>
      <FieldInput
        id={id}
        schema={schema}
        value={value}
        onChange={onChange}
        refOptions={refOptions}
        onFileChange={onFileChange}
      />
    </div>
  );
};
