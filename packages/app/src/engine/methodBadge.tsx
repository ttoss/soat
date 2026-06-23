// HTTP method palette per soat-design: GET Electric Blue, POST green,
// PUT info-blue, PATCH orange, DELETE red.
const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  POST: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  PUT: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  PATCH:
    'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
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
