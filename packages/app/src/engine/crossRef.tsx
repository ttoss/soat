// A row-scoped resolver: given the resource a field references and a record id,
// it returns a navigation handler when the target detail view can be reached,
// or null when it cannot (unknown resource, or an unfilled parent id). The
// `context` carries the current path params merged with the row's own fields,
// which is how nested targets recover their parent ids.
export type RefResolver = (
  resource: string,
  id: string,
  context: Record<string, string>
) => (() => void) | null;

export const RefButton = ({
  id,
  onClick,
  className,
}: {
  id: string;
  onClick: () => void;
  className?: string;
}) => {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        className ?? 'font-mono text-primary underline-offset-4 hover:underline'
      }
    >
      {id}
    </button>
  );
};
