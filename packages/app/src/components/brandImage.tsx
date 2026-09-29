import { BRAND_ASSETS } from '@/lib/brandAssets';

/**
 * A brand master in the variant for the reader's colour scheme. The console
 * follows `prefers-color-scheme` (see `index.css`), so the switch is a
 * `<picture>` source rather than a `dark:` class.
 */
export const BrandImage = (props: {
  variant: keyof typeof BRAND_ASSETS;
  alt: string;
  className?: string;
}) => {
  const sources = BRAND_ASSETS[props.variant];
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={sources.dark} />
      <img
        src={sources.light}
        alt={props.alt}
        aria-hidden={props.alt === '' ? true : undefined}
        className={props.className}
      />
    </picture>
  );
};
