const snakeToCamel = (str: string): string => {
  return str.replace(/_([a-z])/g, (_, char) => {
    return char.toUpperCase();
  });
};

export const snakeToCamelDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return snakeToCamelDeep(item);
    });
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
        return [snakeToCamel(key), snakeToCamelDeep(nested)];
      })
    );
  }

  return value;
};

export const toMcpText = (value: unknown): string => {
  if (value == null) {
    return 'Deleted successfully.';
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return JSON.stringify(snakeToCamelDeep(parsed));
    } catch {
      return value;
    }
  }

  return JSON.stringify(snakeToCamelDeep(value));
};
