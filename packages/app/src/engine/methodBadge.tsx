const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  POST: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  PUT: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  DELETE: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export const MethodBadge = ({ method }: { method: string }) => {
  const upper = method.toUpperCase();
  const colorClass = METHOD_COLORS[upper] ?? 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-xs font-semibold uppercase ${colorClass}`}
    >
      {upper}
    </span>
  );
};
