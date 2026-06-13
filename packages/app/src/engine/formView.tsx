import * as React from 'react';

import { apiFetch } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';

import { FieldEditor } from './fieldEditor';
import {
  buildRequestBody,
  getOpRequestSchema,
  initFormData,
} from './formHelpers';
import { useNavigation } from './navigationContext';
import { buildUrl } from './specUtils';
import type {
  JsonObject,
  ModuleInfo,
  OpenApiSchema,
  OpenApiSpec,
} from './types';

const getRequestSchema = (
  module: ModuleInfo,
  mode: 'create' | 'edit',
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  return getOpRequestSchema(
    mode === 'create' ? module.createOp : module.updateOp,
    spec
  );
};

type FormActionsProps = {
  submitting: boolean;
  mode: 'create' | 'edit';
  onCancel: () => void;
};

const FormActions = ({ submitting, mode, onCancel }: FormActionsProps) => {
  return (
    <div className="flex gap-2 pt-2">
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
      </Button>
      <Button type="button" variant="outline" onClick={onCancel}>
        {'Cancel'}
      </Button>
    </div>
  );
};

type FormViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
  mode: 'create' | 'edit';
  prefill?: JsonObject;
};

export const FormView = ({
  module,
  spec,
  pathParams,
  mode,
  prefill = {},
}: FormViewProps) => {
  const { state } = useAuth();
  const { navigate } = useNavigation();
  const schema = getRequestSchema(module, mode, spec);
  const [formData, setFormData] = React.useState<Record<string, string>>(() => {
    return initFormData(schema, prefill);
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const token = state.status === 'authenticated' ? state.token : '';
  const op = mode === 'create' ? module.createOp : module.updateOp;
  const title =
    mode === 'create' ? `Create ${module.label}` : `Edit ${module.label}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!op || !token) return;
    setSubmitting(true);
    setError(null);

    const bodyResult = buildRequestBody(formData, schema);
    if (!bodyResult.ok) {
      setError(bodyResult.error);
      setSubmitting(false);
      return;
    }

    const url = buildUrl(op.pathTemplate, pathParams);
    const method = mode === 'create' ? 'POST' : 'PUT';
    const result = await apiFetch<JsonObject>({
      url,
      method,
      body: bodyResult.body,
      token,
    });

    setSubmitting(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    navigate(null);
  };

  if (!schema?.properties) {
    return (
      <div className="text-muted-foreground text-sm">
        {'No form schema available for this operation.'}
      </div>
    );
  }

  const properties = schema.properties;
  const required = new Set(schema.required ?? []);

  const handleCancel = () => {
    return navigate(null);
  };

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{title}</h2>
        <Button variant="outline" size="sm" onClick={handleCancel}>
          {'Cancel'}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {Object.entries(properties).map(([name, fieldSchema]) => {
          return (
            <FieldEditor
              key={name}
              name={name}
              schema={fieldSchema}
              value={formData[name] ?? ''}
              onChange={(v) => {
                return setFormData((prev) => {
                  return { ...prev, [name]: v };
                });
              }}
              required={required.has(name)}
            />
          );
        })}

        <FormActions
          submitting={submitting}
          mode={mode}
          onCancel={handleCancel}
        />
      </form>
    </div>
  );
};
