import type * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { humanizeKey } from './specUtils';
import type { OpenApiSchema } from './types';

type FieldEditorProps = {
  name: string;
  schema: OpenApiSchema;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
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
      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
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
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

type FieldInputProps = {
  id: string;
  schema: OpenApiSchema;
  value: string;
  onChange: (v: string) => void;
};

const FieldInput = ({
  id,
  schema,
  value,
  onChange,
}: FieldInputProps): React.ReactElement => {
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
}: FieldEditorProps): React.ReactElement => {
  const id = `field-${name}`;
  const label = humanizeKey(name);

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-1 text-destructive">{'*'}</span>}
      </Label>
      <FieldInput id={id} schema={schema} value={value} onChange={onChange} />
    </div>
  );
};
