import * as React from 'react';

import { apiFetch, apiFetchMultipart } from '@/api/client';
import { useAuth } from '@/auth/authContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { FieldEditor } from './fieldEditor';
import {
  buildMultipartFormData,
  buildRequestBody,
  getOpRequestSchema,
  initFormData,
  isMultipartOp,
} from './formHelpers';
import { MethodBadge } from './methodBadge';
import { useNavigation } from './navigationContext';
import {
  actionLabel,
  buildUrl,
  extractPathParams,
  humanizeKey,
} from './specUtils';
import { StatusBadge } from './statusBadge';
import type {
  JsonObject,
  ModuleInfo,
  ModuleOp,
  OpenApiSchema,
  OpenApiSpec,
} from './types';

const findAction = (
  module: ModuleInfo,
  operationId: string
): ModuleOp | undefined => {
  return module.actions?.find((a) => {
    return a.operation.operationId === operationId;
  });
};

const formFields = (
  schema: OpenApiSchema | undefined
): { properties: Record<string, OpenApiSchema>; required: Set<string> } => {
  return {
    properties: schema?.properties ?? {},
    required: new Set(schema?.required ?? []),
  };
};

type MissingParamInputsProps = {
  names: string[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
};

const MissingParamInputs = ({
  names,
  values,
  onChange,
}: MissingParamInputsProps) => {
  return names.map((name) => {
    return (
      <div key={name} className="flex flex-col gap-1">
        <Label htmlFor={`param-${name}`}>
          {humanizeKey(name)}
          <span className="text-destructive">{' *'}</span>
        </Label>
        <Input
          id={`param-${name}`}
          value={values[name] ?? ''}
          onChange={(e) => {
            return onChange(name, e.target.value);
          }}
        />
      </div>
    );
  });
};

const CompletionLine = ({ result }: { result: JsonObject }) => {
  const status = typeof result.status === 'string' ? result.status : undefined;
  const id = typeof result.id === 'string' ? result.id : undefined;
  if (!status && !id) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      {status && <StatusBadge status={status} />}
      {id && <span className="font-mono text-muted-foreground">{id}</span>}
    </div>
  );
};

const ActionResultPanel = ({ result }: { result: JsonObject }) => {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-muted-foreground">
        {'Result'}
      </span>
      <CompletionLine result={result} />
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-3 font-mono text-xs">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
};

const useActionSubmit = (args: {
  actionOp: ModuleOp;
  schema: OpenApiSchema | undefined;
  pathParams: Record<string, string>;
  paramValues: Record<string, string>;
  formData: Record<string, string>;
  fileData: Record<string, File>;
  token: string;
}) => {
  const {
    actionOp,
    schema,
    pathParams,
    paramValues,
    formData,
    fileData,
    token,
  } = args;
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<JsonObject | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    const url = buildUrl(actionOp.pathTemplate, {
      ...pathParams,
      ...paramValues,
    });
    let res;
    if (isMultipartOp(actionOp)) {
      const fd = buildMultipartFormData(formData, fileData, schema);
      res = await apiFetchMultipart<JsonObject>({ url, formData: fd, token });
    } else {
      const bodyResult = buildRequestBody(formData, schema);
      if (!bodyResult.ok) {
        setError(bodyResult.error);
        setSubmitting(false);
        return;
      }
      res = await apiFetch<JsonObject>({
        url,
        method: 'POST',
        body: bodyResult.body,
        token,
      });
    }
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setResult(res.data);
  };

  return { submitting, error, result, handleSubmit };
};

type ActionViewProps = {
  module: ModuleInfo;
  spec: OpenApiSpec;
  pathParams: Record<string, string>;
  operationId: string;
};

export const ActionView = ({
  module,
  spec,
  pathParams,
  operationId,
}: ActionViewProps) => {
  const { state } = useAuth();
  const { navigate } = useNavigation();
  const actionOp = findAction(module, operationId);
  const schema = getOpRequestSchema(actionOp, spec);
  const [formData, setFormData] = React.useState<Record<string, string>>(() => {
    return initFormData(schema, {});
  });
  const [fileData, setFileData] = React.useState<Record<string, File>>({});
  const [paramValues, setParamValues] = React.useState<Record<string, string>>(
    {}
  );

  const handleFileChange = (name: string, file: File | null) => {
    setFileData((prev) => {
      if (!file) {
        const next = { ...prev };
        delete next[name];
        return next;
      }
      return { ...prev, [name]: file };
    });
  };

  const token = state.status === 'authenticated' ? state.token : '';
  const { submitting, error, result, handleSubmit } = useActionSubmit({
    actionOp: actionOp!,
    schema,
    pathParams,
    paramValues,
    formData,
    fileData,
    token,
  });

  const handleBack = () => {
    return navigate(null);
  };

  if (!actionOp) {
    return (
      <div className="text-muted-foreground text-sm">
        {'Action not found in spec.'}
      </div>
    );
  }

  const missingParams = extractPathParams(actionOp.pathTemplate).filter((p) => {
    return !pathParams[p];
  });
  const { properties, required } = formFields(schema);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
        onClick={handleBack}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={actionLabel(actionOp)}
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col gap-6 overflow-y-auto rounded-lg border bg-background/80 p-6 shadow-glow-violet-md backdrop-blur-lg"
      >
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">{actionLabel(actionOp)}</h2>
            <div className="flex items-center gap-2">
              <MethodBadge method="POST" />
              <span className="font-mono text-xs text-muted-foreground">
                {actionOp.pathTemplate}
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={handleBack}
          >
            {'✕'}
          </Button>
        </div>

        {actionOp.operation.summary && (
          <p className="text-sm text-muted-foreground">
            {actionOp.operation.summary}
          </p>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <MissingParamInputs
            names={missingParams}
            values={paramValues}
            onChange={(name, value) => {
              return setParamValues((prev) => {
                return { ...prev, [name]: value };
              });
            }}
          />
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
                onFileChange={
                  fieldSchema.format === 'binary'
                    ? (file) => {
                        return handleFileChange(name, file);
                      }
                    : undefined
                }
              />
            );
          })}

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Running…' : 'Run'}
            </Button>
            <Button type="button" variant="outline" onClick={handleBack}>
              {'Cancel'}
            </Button>
          </div>
        </form>

        {result && <ActionResultPanel result={result} />}
      </div>
    </div>
  );
};
