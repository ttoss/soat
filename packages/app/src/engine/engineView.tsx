import type * as React from 'react';

import { ActionView } from './actionView';
import { DetailView } from './detailView';
import { FormView } from './formView';
import { ListView } from './listView';
import type { ModuleInfo, OpenApiSpec, ViewDescriptor } from './types';

type EngineViewProps = {
  descriptor: ViewDescriptor;
  modules: ModuleInfo[];
  spec: OpenApiSpec;
};

const findModule = (
  modules: ModuleInfo[],
  tag: string
): ModuleInfo | undefined => {
  return modules.find((m) => {
    return m.tag === tag;
  });
};

export const EngineView = ({
  descriptor,
  modules,
  spec,
}: EngineViewProps): React.ReactElement | null => {
  const module = findModule(modules, descriptor.tag);

  if (!module) {
    return (
      <div className="text-muted-foreground text-sm p-4">
        {`Module "${descriptor.tag}" not found in spec.`}
      </div>
    );
  }

  if (descriptor.mode === 'list') {
    return (
      <ListView
        module={module}
        spec={spec}
        pathParams={descriptor.pathParams}
      />
    );
  }

  if (descriptor.mode === 'detail') {
    return (
      <DetailView
        module={module}
        spec={spec}
        pathParams={descriptor.pathParams}
        modules={modules}
      />
    );
  }

  if (descriptor.mode === 'create') {
    return (
      <FormView
        module={module}
        spec={spec}
        pathParams={descriptor.pathParams}
        mode="create"
      />
    );
  }

  if (descriptor.mode === 'edit') {
    return (
      <FormView
        module={module}
        spec={spec}
        pathParams={descriptor.pathParams}
        mode="edit"
      />
    );
  }

  if (descriptor.mode === 'action') {
    return (
      <ActionView
        module={module}
        spec={spec}
        pathParams={descriptor.pathParams}
        operationId={descriptor.operationId}
      />
    );
  }

  return null;
};
