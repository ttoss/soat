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
import { MethodBadge } from './methodBadge';
import { useNavigation } from './navigationContext';
import { buildUrl } from './specUtils';
import type {
  JsonObject,
  ModuleInfo,
  ModuleOp,
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

const submitForm = async (args: {
  op: ModuleOp;
  formData: Record<string, string>;
  schema: OpenApiSchema | undefined;
  pathParams: Record<string, string>;
  mode: 'create' | 'edit';
  token: string;
}): Promise<string | null> => {
  const { op, formData, schema, pathParams, mode, token } = args;
  const bodyResult = buildRequestBody(formData, schema);
  if (!bodyResult.ok) return bodyResult.error;
  const url = buildUrl(op.pathTemplate, pathParams);
  const method = mode === 'create' ? 'POST' : 'PUT';
  const result = await apiFetch<JsonObject>({
    url,
    method,
    body: bodyResult.body,
    token,
  });
  if (!result.ok) return result.error.message;
  return null;
};

type FormActionsProps = {
  submitting: boolean;
  mode: 'create' | 'edit';
  onCancel: () => void;
};

const FormActions = ({ submitting, mode, onCancel }: FormActionsProps) => {
  const label = submitting ? 'Saving…' : mode === 'create' ? 'Create' : 'Save';
  return (
    <div className="flex gap-2 pt-2">
      <Button type="submit" disabled={submitting}>
        {label}
      </Button>
      <Button type="button" variant="outline" onClick={onCancel}>
        {'Cancel'}
      </Button>
    </div>
  );
};

const FormHeader = ({
  title,
  method,
  endpointPath,
  onCancel,
}: {
  title: string;
  method: string;
  endpointPath: string;
  onCancel: () => void;
}) => {
  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          <MethodBadge method={method} />
          <span className="font-mono text-xs text-muted-foreground">
            {endpointPath}
          </span>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onCancel}>
        {'Cancel'}
      </Button>
    </div>
  );
};

const useFormSubmit = (args: {
  op: ModuleOp | undefined;
  schema: OpenApiSchema | undefined;
  pathParams: Record<string, string>;
  mode: 'create' | 'edit';
  token: string;
  formData: Record<string, string>;
  onSuccess: () => void;
}) => {
  const { op, schema, pathParams, mode, token, formData, onSuccess } = args;
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!op || !token) return;
    setSubmitting(true);
    setError(null);
    const err = await submitForm({
      op,
      formData,
      schema,
      pathParams,
      mode,
      token,
    });
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    onSuccess();
  };

  return { submitting, error, handleSubmit };
};

type FormBodyProps = {
  title: string;
  httpMethod: string;
  endpointPath: string;
  error: string | null;
  properties: Record<string, OpenApiSchema>;
  required: Set<string>;
  formData: Record<string, string>;
  setFormData: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  submitting: boolean;
  mode: 'create' | 'edit';
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
};

const FormBody = ({
  title,
  httpMethod,
  endpointPath,
  error,
  properties,
  required,
  formData,
  setFormData,
  submitting,
  mode,
  onSubmit,
  onCancel,
}: FormBodyProps) => {
  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <FormHeader
        title={title}
        method={httpMethod}
        endpointPath={endpointPath}
        onCancel={onCancel}
      />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
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

        <FormActions submitting={submitting} mode={mode} onCancel={onCancel} />
      </form>
    </div>
  );
};

const getFormModeValues = (
  mode: 'create' | 'edit',
  module: ModuleInfo
): { op: ModuleOp | undefined; title: string; httpMethod: string } => {
  const isCreate = mode === 'create';
  return {
    op: isCreate ? module.createOp : module.updateOp,
    title: isCreate ? `Create ${module.label}` : `Edit ${module.label}`,
    httpMethod: isCreate ? 'POST' : 'PUT',
  };
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
  prefill,
}: FormViewProps) => {
  const { state } = useAuth();
  const { navigate } = useNavigation();
  const schema = getRequestSchema(module, mode, spec);
  const resolvedPrefill = prefill ?? {};
  const [formData, setFormData] = React.useState<Record<string, string>>(() => {
    return initFormData(schema, resolvedPrefill);
  });

  const token = state.status === 'authenticated' ? state.token : '';
  const { op, title, httpMethod } = getFormModeValues(mode, module);
  const { submitting, error, handleSubmit } = useFormSubmit({
    op,
    schema,
    pathParams,
    mode,
    token,
    formData,
    onSuccess: () => {
      navigate(null);
    },
  });

  if (!schema?.properties) {
    return (
      <div className="text-muted-foreground text-sm">
        {'No form schema available for this operation.'}
      </div>
    );
  }

  return (
    <FormBody
      title={title}
      httpMethod={httpMethod}
      endpointPath={op ? op.pathTemplate : ''}
      error={error}
      properties={schema.properties}
      required={new Set(schema.required ?? [])}
      formData={formData}
      setFormData={setFormData}
      submitting={submitting}
      mode={mode}
      onSubmit={handleSubmit}
      onCancel={() => {
        navigate(null);
      }}
    />
  );
};
