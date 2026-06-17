import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { humanizeKey } from './specUtils';
import { statusTone } from './statusBadge';

const ALL = '__all__';

type FilterChipsProps = {
  statuses: string[];
  selected: string;
  onSelect: (status: string) => void;
};

const FilterChips = ({ statuses, selected, onSelect }: FilterChipsProps) => {
  if (statuses.length === 0) return null;

  const chip = (
    value: string,
    label: string,
    tone: 'neutral' | ReturnType<typeof statusTone>
  ) => {
    const isActive = selected === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => {
          return onSelect(value);
        }}
        className={[
          'rounded-full transition-opacity',
          isActive
            ? 'opacity-100 ring-1 ring-primary'
            : 'opacity-60 hover:opacity-100',
        ].join(' ')}
      >
        <Badge tone={tone}>{label}</Badge>
      </button>
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chip(ALL, 'All', 'neutral')}
      {statuses.map((status) => {
        return chip(status, humanizeKey(status), statusTone(status));
      })}
    </div>
  );
};

type ListToolbarProps = {
  search: string;
  onSearch: (value: string) => void;
  label: string;
  statuses: string[];
  selectedStatus: string;
  onSelectStatus: (status: string) => void;
};

export const ALL_STATUSES = ALL;

export const ListToolbar = ({
  search,
  onSearch,
  label,
  statuses,
  selectedStatus,
  onSelectStatus,
}: ListToolbarProps) => {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Input
        type="search"
        value={search}
        placeholder={`Search ${label.toLowerCase()}…`}
        onChange={(e) => {
          return onSearch(e.target.value);
        }}
        className="sm:max-w-xs"
      />
      <FilterChips
        statuses={statuses}
        selected={selectedStatus}
        onSelect={onSelectStatus}
      />
    </div>
  );
};

type EmptyStateProps = {
  label: string;
  filtered: boolean;
  canCreate: boolean;
  onCreate: () => void;
};

export const EmptyState = ({
  label,
  filtered,
  canCreate,
  onCreate,
}: EmptyStateProps) => {
  const singular = label.replace(/s$/i, '').toLowerCase();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40 text-xl text-muted-foreground">
        {'∅'}
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{'No items found.'}</p>
        <p className="text-sm text-muted-foreground">
          {filtered
            ? 'Try a different search or filter.'
            : `Create your first ${singular} to get started.`}
        </p>
      </div>
      {!filtered && canCreate && (
        <Button variant="gradient" size="sm" onClick={onCreate}>
          {`Create your first ${singular}`}
        </Button>
      )}
    </div>
  );
};
