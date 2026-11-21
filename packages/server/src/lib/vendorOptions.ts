/**
 * Vendor options: the `providerOptions` the AI SDK puts on a message and on
 * each of its content parts. A replay needs them (a reasoning signature, an
 * item id, encrypted reasoning, a cache point), and their keys name the vendor,
 * so a stored message keeps them beside it and they are rejoined only where a
 * model call is built. Every other key, tool input included, is untouched.
 */

/** One lifted `providerOptions`: on message `message`, or on its part `part`. */
export type VendorOption = {
  message: number;
  part?: number;
  options: Record<string, unknown>;
};

export type VendorOptions = VendorOption[];

declare const publicShape: unique symbol;

/**
 * Messages with no `providerOptions`: the only shape a stored or served
 * message takes. {@link splitVendorOptions} is its one producer.
 */
export type PublicMessages = unknown[] & { readonly [publicShape]: true };

type Lifted = { value: unknown; options?: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const lift = (value: unknown): Lifted => {
  if (!isRecord(value) || !('providerOptions' in value)) return { value };
  const { providerOptions, ...rest } = value;
  return isRecord(providerOptions)
    ? { value: rest, options: providerOptions }
    : { value: rest };
};

export const splitVendorOptions = (args: {
  messages: readonly unknown[];
}): { messages: PublicMessages; vendorOptions: VendorOptions } => {
  const vendorOptions: VendorOptions = [];
  const messages = args.messages.map((raw, message) => {
    const lifted = lift(raw);
    if (lifted.options)
      vendorOptions.push({ message, options: lifted.options });
    if (!isRecord(lifted.value) || !Array.isArray(lifted.value.content)) {
      return lifted.value;
    }
    const content = lifted.value.content.map((rawPart: unknown, part) => {
      const liftedPart = lift(rawPart);
      if (liftedPart.options) {
        vendorOptions.push({ message, part, options: liftedPart.options });
      }
      return liftedPart.value;
    });
    return { ...lifted.value, content };
  }) as PublicMessages;
  return { messages, vendorOptions };
};

const isVendorOption = (value: unknown): value is VendorOption => {
  return (
    isRecord(value) &&
    typeof value.message === 'number' &&
    (value.part === undefined || typeof value.part === 'number') &&
    isRecord(value.options)
  );
};

/** A stored `vendor_options` value; anything else rejoins nothing. */
export const readVendorOptions = (value: unknown): VendorOptions => {
  return Array.isArray(value) ? value.filter(isVendorOption) : [];
};

const withOptions = (
  value: unknown,
  options: Record<string, unknown> | undefined
): unknown => {
  if (!options || !isRecord(value)) return value;
  return { ...value, providerOptions: options };
};

/** The messages a model call is built from: `vendorOptions` back in place. */
export const joinVendorOptions = (args: {
  messages: readonly unknown[];
  vendorOptions: VendorOptions;
}): unknown[] => {
  if (args.vendorOptions.length === 0) return [...args.messages];
  return args.messages.map((raw, message) => {
    const own = args.vendorOptions.filter((entry) => {
      return entry.message === message;
    });
    if (own.length === 0) return raw;
    const onMessage = own.find((entry) => {
      return entry.part === undefined;
    });
    const joined = withOptions(raw, onMessage?.options);
    if (!isRecord(joined) || !Array.isArray(joined.content)) return joined;
    const content = joined.content.map((rawPart: unknown, part) => {
      const onPart = own.find((entry) => {
        return entry.part === part;
      });
      return withOptions(rawPart, onPart?.options);
    });
    return { ...joined, content };
  });
};
