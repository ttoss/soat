import * as React from 'react';

import { EngineView } from '@/engine/engineView';
import { useSpec } from '@/engine/specContext';
import type { ModuleInfo, OpenApiSpec } from '@/engine/types';
import { cn } from '@/lib/utils';

type IamTabId = 'users' | 'policies' | 'ai-providers';

const TAG_TO_TAB: Record<string, IamTabId> = {
  Users: 'users',
  Policies: 'policies',
  'Ai Providers': 'ai-providers',
  AiProviders: 'ai-providers',
  'AI Providers': 'ai-providers',
};

const TAB_TAGS: Record<IamTabId, string[]> = {
  users: ['Users'],
  policies: ['Policies'],
  'ai-providers': ['Ai Providers', 'AiProviders', 'AI Providers'],
};

const TAB_LABELS: Record<IamTabId, string> = {
  users: 'Users',
  policies: 'Policies',
  'ai-providers': 'AI Providers',
};

const TAB_ORDER: IamTabId[] = ['users', 'policies', 'ai-providers'];

const findModuleForTab = (
  modules: ModuleInfo[],
  tabId: IamTabId
): ModuleInfo | undefined => {
  const tags = TAB_TAGS[tabId];
  return modules.find((m) => {
    return tags.includes(m.tag);
  });
};

type IamScreenProps = {
  modules: ModuleInfo[];
  spec: OpenApiSpec;
  initialTag?: string;
};

export const IamScreen = ({
  modules,
  spec,
  initialTag,
}: IamScreenProps): React.ReactElement => {
  const [activeTab, setActiveTab] = React.useState<IamTabId>(() => {
    if (initialTag && TAG_TO_TAB[initialTag]) {
      return TAG_TO_TAB[initialTag];
    }
    return 'users';
  });

  const activeModule = findModuleForTab(modules, activeTab);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          {'Administration'}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {'Manage users, policies, and AI provider integrations.'}
        </p>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-1">
          {TAB_ORDER.map((tabId) => {
            const isActive = tabId === activeTab;
            return (
              <button
                key={tabId}
                onClick={() => {
                  setActiveTab(tabId);
                }}
                className={cn(
                  'px-4 py-2 text-sm font-medium transition-colors',
                  'border-b-2 focus-visible:outline-none',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
                )}
              >
                {TAB_LABELS[tabId]}
              </button>
            );
          })}
        </nav>
      </div>

      <div>
        {activeModule ? (
          <EngineView
            key={activeTab}
            descriptor={{
              tag: activeModule.tag,
              operationId: activeModule.listOp?.operation.operationId ?? '',
              pathParams: {},
              mode: 'list',
            }}
            modules={modules}
            spec={spec}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {'This module is not available.'}
          </p>
        )}
      </div>
    </div>
  );
};

export const IamScreenContainer = ({
  initialTag,
}: {
  initialTag?: string;
}): React.ReactElement => {
  const { modules, spec } = useSpec();
  return <IamScreen modules={modules} spec={spec!} initialTag={initialTag} />;
};
